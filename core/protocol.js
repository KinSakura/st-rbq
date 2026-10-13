/**
 * protocol.js —— 协议层：把 AI 的输出解析成"事实(facts)"或"操作(ops)"
 *
 * 输入：<data> 事实申报
 *
 *     解析成本极低、无需猜测；给手工操作与旧提示词用。
 *
 *  B. `<data>`       新"事实申报"（推荐）
 *     <data>
 *       <character name="左玄" mode="new" race="人类" job="银月骑士团先锋" level="Lv.45"/>
 *       <state name="慕容雪" head="无" outerUpper="深蓝斗篷"/>
 *       <skill used="霜刃" power="7" actor="左玄" target="慕容雪"/>
 *       <departure name="慕容雪" silent="true"/>
 *     </data>
 *     **只写事实，不写定位**：行列下标、主键匹配、列名映射由脚本负责。
 *
 * 属性名同时接受三种写法：英文别名（race/job/level，与旧预设同源）、中文列名（种族/职业）、
 * 以及模糊变体（拼错、大小写、全角）。见 resolveAttr()。
 */

import { getTable, getTables } from './schema.js';
import { normalize, cellStr } from './util.js';
import { resolveAttr } from './alias.js';

export { resolveAttr };

/* ================================================================ 通用工具 */

/** 取某个标签的所有块内容（容忍缺闭合标签：取到下一个同级标签或文本结尾） */
export function extractTagBlocks(text, tagName) {
  const src = String(text ?? '');
  const out = [];
  const openRe = new RegExp(`<${tagName}(\\s[^>]*)?>`, 'gi');
  let m;
  while ((m = openRe.exec(src))) {
    const start = m.index + m[0].length;
    const closeRe = new RegExp(`</${tagName}\\s*>`, 'i');
    const rest = src.slice(start);
    const cm = closeRe.exec(rest);
    if (cm) {
      out.push(rest.slice(0, cm.index));
      openRe.lastIndex = start + cm.index + cm[0].length;
    } else {
      // 没闭合：截到下一个同级开标签或结尾
      const nextOpen = rest.search(new RegExp(`<${tagName}(\\s|>)`, 'i'));
      out.push(nextOpen >= 0 ? rest.slice(0, nextOpen) : rest);
      openRe.lastIndex = start + (nextOpen >= 0 ? nextOpen : rest.length);
    }
  }
  return out;
}

/**
 * 解析元素属性（容忍单/双引号、无引号、换行、全角引号）
 * @returns {Record<string,string>}
 */
export function parseAttrs(attrText) {
  const attrs = {};
  if (!attrText) return attrs;
  const re = /([A-Za-z_:\u4e00-\u9fff][\w\u4e00-\u9fff:.@-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|“([^”]*)”|‘([^’]*)’|([^\s"'>]+))/g;
  let m;
  while ((m = re.exec(attrText))) {
    const key = m[1];
    const val = m[2] ?? m[3] ?? m[4] ?? m[5] ?? m[6] ?? '';
    attrs[key] = val;
  }
  return attrs;
}

/**
 * 扫描出所有"简单元素"：<tag a="1" b='2'/> 或 <tag a="1">文本</tag>
 * 不处理深层嵌套（协议本身也不需要）。
 * @returns {Array<{tag:string, attrs:Record<string,string>, text:string, selfClosing:boolean}>}
 */
export function scanElements(xml, { onlyTopLevel = true } = {}) {
  const src = String(xml ?? '');
  const els = [];
  const re = /<([A-Za-z_\u4e00-\u9fff][\w\u4e00-\u9fff:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  let m;
  const ranges = [];
  while ((m = re.exec(src))) {
    const tag = m[1];
    const attrText = m[2] ?? '';
    const selfClosing = m[3] === '/';
    const start = m.index;
    const end = re.lastIndex;
    let text = '';
    let fullEnd = end;
    if (!selfClosing) {
      const closeRe = new RegExp(`</${tag}\\s*>`, 'i');
      const cm = closeRe.exec(src.slice(end));
      if (cm) {
        text = src.slice(end, end + cm.index);
        fullEnd = end + cm.index + cm[0].length;
        re.lastIndex = fullEnd;
      }
    }
    if (onlyTopLevel) {
      // 跳过落在已有元素区间内的元素（子元素）
      if (ranges.some(([a, b]) => start > a && start < b)) continue;
      ranges.push([start, fullEnd]);
    }
    els.push({ tag, attrs: parseAttrs(attrText), text: text.trim(), selfClosing, start });
  }
  return els;
}


/**
 * 裸引号状态机（移植自「数据库-可定制副本」escapeUnescapedQuotesLayer_ACU 的思路）
 *
 * 问题：LLM 常写出 {"名":"他叫"零""} —— 字符串里带没转义的双引号，正则修不了。
 * 做法：逐字符扫，维护"是否在字符串内" + 容器栈（object/array）与 expecting 状态；
 *      遇到 " 且在字符串内时，看下一个非空白字符：
 *        : → key 的真正闭合    , } ] → 值的真正闭合
 *        其它 → 这是内容里的裸引号，改写成 \"
 */
/* ---- 下面三个状态机按 shukuju 真代码（index_2.beauty.js L23147-23276）重写 ---- */

function getNextNonWhitespaceMeta(text, from) {
  for (let i = from; i < text.length; i++) if (!/\s/.test(text[i])) return { char: text[i], index: i };
  return { char: '', index: -1 };
}

function isLikelyJsonValueStart(ch) {
  return !!ch && (ch === '"' || ch === '{' || ch === '[' || ch === '-' || /\d/.test(ch) || ch === 't' || ch === 'f' || ch === 'n');
}

/** 判断字符串里遇到的 " 到底是"真闭合"还是"内容里的裸引号" */
function isLikelyStringCloser(text, quoteIndex, stringKind, containerType) {
  const meta = getNextNonWhitespaceMeta(text, quoteIndex + 1);
  const next = meta.char;
  if (!next) return stringKind !== 'key';           // 到文件尾：value 可以闭合，key 不能
  if (stringKind === 'key') return next === ':';    // key 后面必须是冒号
  if (next === '}' || next === ']') return true;
  if (next !== ',') return false;
  const after = getNextNonWhitespaceMeta(text, meta.index + 1).char;
  if (!after) return false;
  if (containerType === 'object') return after === '"' || after === '}';
  if (containerType === 'array') return after === ']' || isLikelyJsonValueStart(after);
  return isLikelyJsonValueStart(after) || after === '}' || after === ']';
}

/**
 * 裸引号修复：逐字符扫，维护"是否在字符串内" + 容器栈（object/array）及其 expecting 状态
 * （keyOrEnd → key → colon → value → commaOrEnd），据此判断该转义还是该闭合。
 */
export function escapeUnescapedQuotes(input) {
  const text = String(input ?? '');
  let out = '';
  let inString = false;
  let escaped = false;
  let stringKind = null;
  let fixed = 0;
  const stack = [];
  const top = () => (stack.length ? stack[stack.length - 1] : null);
  const markParentValueCompleted = () => {
    const c = top();
    if (c && (c.type === 'object' || c.type === 'array')) c.expecting = 'commaOrEnd';
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { out += ch; escaped = false; continue; }

    if (inString) {
      if (ch === '\\') { out += ch; escaped = true; continue; }
      if (ch === '"') {
        const c = top();
        if (isLikelyStringCloser(text, i, stringKind, c ? c.type : null)) {
          out += ch;
          inString = false;
          if (stringKind === 'key' && c && c.type === 'object') c.expecting = 'colon';
          else markParentValueCompleted();
          stringKind = null;
        } else { out += '\\"'; fixed++; }
        continue;
      }
      out += ch;
      continue;
    }

    if (ch === '"') {
      out += ch;
      inString = true;
      const c = top();
      stringKind = (!c || c.type !== 'object' || (c.expecting !== 'key' && c.expecting !== 'keyOrEnd')) ? 'value' : 'key';
      continue;
    }
    if (ch === '{') { out += ch; stack.push({ type: 'object', expecting: 'keyOrEnd' }); continue; }
    if (ch === '[') { out += ch; stack.push({ type: 'array', expecting: 'valueOrEnd' }); continue; }
    if (ch === ':') { out += ch; const c = top(); if (c && c.type === 'object') c.expecting = 'value'; continue; }
    if (ch === ',') {
      out += ch;
      const c = top();
      if (c && c.type === 'object') c.expecting = 'key';
      else if (c && c.type === 'array') c.expecting = 'value';
      continue;
    }
    if (ch === '}' || ch === ']') { out += ch; stack.pop(); markParentValueCompleted(); continue; }
    out += ch;
  }
  return { text: out, fixed };
}

/** 字符串内的裸控制字符 → 转义（逐字符，识别字符串状态） */
export function sanitizeControlChars(input) {
  const text = String(input ?? '');
  if (!text) return { text, fixed: 0 };
  let out = '';
  let inString = false;
  let escaped = false;
  let fixed = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { out += ch; escaped = false; continue; }
    if (ch === '\\') { out += ch; if (inString) escaped = true; continue; }
    if (ch === '"') { out += ch; inString = !inString; continue; }
    if (inString) {
      if (ch === '\n') { out += '\\n'; fixed++; continue; }
      if (ch === '\r') { out += '\\r'; fixed++; continue; }
      if (ch === '\t') { out += '\\t'; fixed++; continue; }
      if (ch === '\0') { out += '\\u0000'; fixed++; continue; }
    }
    out += ch;
  }
  return { text: out, fixed };
}

/** 字符串外的尾逗号（, 后面紧接 } 或 ]）→ 删（逐字符，识别字符串状态） */
export function removeTrailingCommas(input) {
  const text = String(input ?? '');
  if (!text) return { text, fixed: 0 };
  let out = '';
  let inString = false;
  let escaped = false;
  let fixed = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { out += ch; escaped = false; continue; }
    if (ch === '\\') { out += ch; if (inString) escaped = true; continue; }
    if (ch === '"') { out += ch; inString = !inString; continue; }
    if (!inString && ch === ',') {
      const next = getNextNonWhitespaceMeta(text, i + 1).char;
      if (next === '}' || next === ']') { fixed++; continue; }
    }
    out += ch;
  }
  return { text: out, fixed };
}

/** 全角冒号 → 半角（只在"看起来是键"的位置改，不碰值里的中文冒号） */
export function normalizeFullwidthColon(input) {
  let n = 0;
  const text = String(input ?? '').replace(/([{,]\s*)("[^"]*"|[\w\u4e00-\u9fff]+)\s*：/g, (m, pre, key) => { n++; return `${pre}${key}:`; });
  return { text, fixed: n };
}


/** 顶层切分：同时计 {} / [] / () 三种深度 + 字符串状态（照 splitTopLevelSegments_ACU L23345） */
export function splitTopLevelDeep(text, delim = ',') {
  const s = String(text ?? '');
  const out = [];
  let cur = '';
  let inString = false;
  let escaped = false;
  let brace = 0; let bracket = 0; let paren = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escaped) { cur += ch; escaped = false; continue; }
    if (ch === '\\') { cur += ch; if (inString) escaped = true; continue; }
    if (ch === '"') { cur += ch; inString = !inString; continue; }
    if (!inString) {
      if (ch === '{') brace++;
      else if (ch === '}') brace = Math.max(0, brace - 1);
      else if (ch === '[') bracket++;
      else if (ch === ']') bracket = Math.max(0, bracket - 1);
      else if (ch === '(') paren++;
      else if (ch === ')') paren = Math.max(0, paren - 1);
      else if (ch === delim && brace === 0 && bracket === 0 && paren === 0) {
        if (cur.trim()) out.push(cur.trim());
        cur = '';
        continue;
      }
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** 找顶层分隔符位置（同样三深度 + 字符串状态，照 findTopLevelDelimiterIndex_ACU L23288） */
export function findTopLevelDeep(text, delim = ':') {
  const s = String(text ?? '');
  let inString = false;
  let escaped = false;
  let brace = 0; let bracket = 0; let paren = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { if (inString) escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') brace++;
    else if (ch === '}') brace = Math.max(0, brace - 1);
    else if (ch === '[') bracket++;
    else if (ch === ']') bracket = Math.max(0, bracket - 1);
    else if (ch === '(') paren++;
    else if (ch === ')') paren = Math.max(0, paren - 1);
    else if (ch === delim && brace === 0 && bracket === 0 && paren === 0) return i;
  }
  return -1;
}


/**
 * 安全剥掉 JSON 里的行注释与块注释，但不碰字符串里的（例如 "http://x"）。
 * 移植自 shukuju naiv1.2（recon/index_2.beauty.js 第 670 行 stripJsonCommentsPreservingStrings_ACU）。
 */
export function stripJsonComments(input) {
  const s = String(input ?? '');
  if (!s) return s;
  let out = '';
  let inString = false;
  let escaped = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const next = s[i + 1] || '';
    if (inLine) { if (c === '\n' || c === '\r') { inLine = false; out += c; } continue; }
    if (inBlock) { if (c === '*' && next === '/') { inBlock = false; i++; } continue; }
    if (escaped) { out += c; escaped = false; continue; }
    if (inString) {
      out += c;
      if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === '/' && next === '/') { inLine = true; i++; continue; }
    if (c === '/' && next === '*') { inBlock = true; i++; continue; }
    out += c;
  }
  return out;
}



/** 五层 JSON 清洗（移植自「数据库-可定制副本」的处理思路，去掉副作用） */
export function sanitizeJson(input) {
  let s = String(input ?? '');
  const applied = [];
  const before = () => s;

  // ① 智能引号 → 直引号
  let t = s.replace(/[“”«»「」『』＂]/g, '"').replace(/[‘’]/g, "'");
  if (t !== s) { applied.push('quotes'); s = t; }

  // ①.5 全角冒号 → 半角（必须在"裸键加引号"之前，否则键识别不出来）
  {
    const r = normalizeFullwidthColon(s);
    if (r.fixed) { applied.push('fullwidth-colon'); s = r.text; }
  }

  // ①.6 字符串内的裸引号 → 转义（手写状态机，正则做不到）
  {
    const r = escapeUnescapedQuotes(s);
    if (r.fixed) { applied.push('unescaped-quote'); s = r.text; }
  }

  // ② 字符串内的裸控制字符 → 转义（逐字符，识别字符串状态）
  {
    const r = sanitizeControlChars(s);
    if (r.fixed) { applied.push('control-chars'); s = r.text; }
  }

  // ③ 字符串外的尾逗号 → 删（逐字符状态机；正则会把字符串内容里的 ", 也删掉）
  {
    const r = removeTrailingCommas(s);
    if (r.fixed) { applied.push('trailing-comma'); s = r.text; }
  }

  // ④ 数字/裸标识符键 → 加引号： {0:"a"} / {种族:"人类"}
  t = s.replace(/([{,]\s*)(-?\d+|[A-Za-z_\u4e00-\u9fff][\w\u4e00-\u9fff]*)(\s*:)/g, '$1"$2"$3');
  if (t !== s) { applied.push('bare-key'); s = t; }

  // ⑤ 单引号包裹的字符串 → 双引号（仅当看起来是 JSON 的 value/key）
  t = s.replace(/'((?:\\.|[^'\\])*)'/g, (mm, inner) => `"${inner.replace(/"/g, '\\"')}"`);
  if (t !== s) { applied.push('single-quote'); s = t; }

  void before;
  return { text: s, applied };
}

/** 尝试解析 JSON 对象，带四级降级 */
export function parseLooseObject(raw) {
  const src = String(raw ?? '').trim().replace(/^[（(]+|[）)]+$/g, '');
  if (!src) return { ok: false, error: 'empty' };

  try { return { ok: true, value: JSON.parse(src), by: 'strict' }; } catch { /* next */ }

  const s1 = sanitizeJson(src);
  try { return { ok: true, value: JSON.parse(s1.text), by: `sanitize:${s1.applied.join('+') || 'none'}` }; } catch { /* next */ }

  // 宽松对象：{a,b} / {0:'x',1:'y'} / {a:1 b:2}
  const body = src.replace(/^\{/, '').replace(/\}$/, '').trim();
  if (!body) return { ok: true, value: {}, by: 'loose-empty' };
  const out = {};
  let auto = 0;
  const segs = splitTopLevelDeep(body, ',');
  for (const seg of segs) {
    const trimmed = seg.trim();
    if (!trimmed) continue;
    // 半角与全角冒号都当作键分隔符（AI 常写全角）
    let colon = findTopLevelDeep(trimmed, ':');
    const full = findTopLevelDeep(trimmed, '：');
    if (full >= 0 && (colon < 0 || full < colon)) colon = full;
    if (colon >= 0) {
      const key = trimmed.slice(0, colon).trim().replace(/^["']|["']$/g, '');
      let val = trimmed.slice(colon + 1).trim();
      val = val.replace(/^["']|["']$/g, '');
      out[key] = tryParseValue(val);
    } else {
      out[String(auto++)] = tryParseValue(trimmed.replace(/^["']|["']$/g, ''));
    }
  }
  if (Object.keys(out).length) return { ok: true, value: out, by: 'loose' };

  // 第 4 级：先走五层清洗，再对清洗结果做宽松行对象（照 coerceLooseRowObject(sanitized) 那一档）
  const s2 = sanitizeJson(src);
  if (s2.text && s2.text !== src) {
    const body2 = s2.text.replace(/^\{/, '').replace(/\}$/, '').trim();
    const out2 = {};
    let auto2 = 0;
    for (const seg of splitTopLevelDeep(body2, ',')) {
      if (!seg) continue;
      let c = findTopLevelDeep(seg, ':');
      const f = findTopLevelDeep(seg, '：');
      if (f >= 0 && (c < 0 || f < c)) c = f;
      if (c >= 0) out2[seg.slice(0, c).trim().replace(/^["']|["']$/g, '')] = tryParseValue(seg.slice(c + 1).trim().replace(/^["']|["']$/g, ''));
      else out2[String(auto2++)] = tryParseValue(seg.replace(/^["']|["']$/g, ''));
    }
    if (Object.keys(out2).length) return { ok: true, value: out2, by: 'sanitize+loose' };
  }

  return { ok: false, error: 'loose-failed' };
}

function tryParseValue(v) {
  const t = String(v).trim();
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null') return null;
  const s = sanitizeJson(t);
  try { return JSON.parse(s.text); } catch { return t; }
}

/** 按顶层分隔符切分（忽略括号/引号内） */
export function splitTopLevel(text, delim) {
  const out = [];
  let depth = 0;
  let quote = null;
  let cur = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      cur += c;
      if (c === '\\') { cur += text[++i] ?? ''; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === '{' || c === '[' || c === '(') { depth++; cur += c; continue; }
    if (c === '}' || c === ']' || c === ')') { depth--; cur += c; continue; }
    if (c === delim && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

function findTopLevel(text, delim) {
  let depth = 0;
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '{' || c === '[' || c === '(') { depth++; continue; }
    if (c === '}' || c === ']' || c === ')') { depth--; continue; }
    if (c === delim && depth === 0) return i;
  }
  return -1;
}


/** 把 {colIndexStr: value} 转成 {列名: value}，供 txn 统一处理 */

/** 多行 / 多指令切分：按 `;` 且在括号深度 0，或按行首指令名 */
/** AI 偶尔写成"人话"而不是指令，形如 [0:全局数据表]- Update: …；必须跳过，否则会被当成指令 */
const NON_STRUCTURED = /^\s*(?:[-*•]\s*)?\[[^\]]+\]\s*[-–—:：]\s*(?:\*\*)?(?:update|insert|delete|更新|新增|删除)/i;


/* ========================================================= B. <data> 事实 */

/** 标签 → 目标表号。这是"AI 说什么 → 落到哪张表"的唯一映射表。 */
export const TAG_TABLE = {
  // 表0 单例：宏观时空与定调
  world: 0, time: 0, weather: 0, present: 0, present_chars: 0, atmosphere: 0, world_law: 0,
  // 表1 地点
  location: 1, place: 1,
  // 表2 角色静态档案
  character: 2, char: 2, npc: 2, char_attr: 2, charattr: 2, character_attr: 2, attr_change: 2, char_status: 2,
  // 表3 生理
  physique: 3, body: 3, appearance: 3, look: 3, basic: 2,   // appearance/basic 是默认模板里的"分节容器"，必须认出它属于哪张表
  // 表4 即时状态 / 离场
  state: 4, status_state: 4, departure: 4, leave: 4,
  // 表5 关系
  relation: 5, relationship: 5,
  // 表6 单例：剧情大纲
  plot: 6, outline: 6,
  // 表7 任务
  task: 7, quest: 7,
  // 表8 buff/debuff
  buff: 8, debuff: 8, effect: 8,
  // 表9 物品
  item: 9, object: 9, asset: 9,
  // 表10 技能定义
  skill_def: 10, skilldef: 10, ability: 10,
  // 表11 派阀/律法
  faction: 11, law: 11, world_law_def: 11,
  // 表12 纪事录
  epoch: 12, chronicle: 12,
  // 表13 角色动态属性（数值）
  status: 13, stats: 13, attr: 13, attributes: 13,
  // 表14 怪物
  monster: 14, enemy: 14, entity: 14,
  // 特殊：战斗申报（由 rules 扩展成数值变化）
  skill: 10, skill_use: 10, attack: 10, combat: 10,
  // 特殊：记忆
  memory: 0, character_memory: 0,
};

/** 归一化标签名 → 表号 */
export function tagToTable(tag) {
  if (!tag) return null;
  const raw = String(tag).trim();
  if (TAG_TABLE[raw] != null) return getTable(TAG_TABLE[raw]);
  const n = normalize(raw).replace(/[^a-z0-9_]/g, '');
  if (TAG_TABLE[n] != null) return getTable(TAG_TABLE[n]);
  for (const [k, v] of Object.entries(TAG_TABLE)) {
    if (normalize(k).replace(/[^a-z0-9_]/g, '') === n) return getTable(v);
  }
  return null;
}






/** 主键属性名（用于从元素属性里取"这一行是谁"） */
const KEY_ATTRS = ['name', 'key', 'id', 'row', 'who', 'target_name', '名称', '角色名称', '实体名称'];

/**
 * 某些"事实标签"的属性名与列别名对不上（为了让模型写起来更自然），在这里补一层。
 * 例：<present chars="A/B"/> —— chars 语义上就是表0 的 present 列。
 */
export const TAG_ATTR_ALIASES = {   // 导出给提示词生成用（与解析器同一张表）
  0: {                       // 表0 宏观时空
    chars: 'present', list: 'present', names: 'present', entities: 'present', present_chars: 'present',
    datetime: 'datetime', world_law_def: 'law',
    time: 'datetime', date: 'datetime', timestamp: 'datetime',
    world_law: 'law', law: 'law', rule: 'law',
  },
  6: {                       // 表6 剧情大纲
    goal: 'grandGoal', grand_goal: 'grandGoal', grand: 'grandGoal',
    progress: 'grandProgress', grand_progress: 'grandProgress',
    chapter_status: 'chapterStatus', focus_feedback: 'focusFeedback', feedback: 'focusFeedback',
  },
  4: { headEquip: "头部装备", headwear: "头部装备", neckAccessory: "颈部附加", neck_accessory: "颈部附加", leg_restraint: "下肢约束", handsHolding: "双手持物", hands_holding: "双手持物", holding: "双手持物", holding_item: "双手持物", restraint_distance: "约束距离", distance: "约束距离", disguise_mark: "伪装标识", subconscious_leak: "潜意识漏出", bodyPose: "躯干姿势", outerUpper: "上装外衣", innerUpper: "上装内层", outerLower: "下装外层", innerLower: "下装内层", legCover: "腿部裹覆", feet: "足部", shoes: "足部", head: "头部装备", headGear: "头部装备", headgear: "头部装备", head_equip: "头部装备", 头部: "头部装备", neck: "颈部附加", neckExtra: "颈部附加", neck_extra: "颈部附加", neckAdd: "颈部附加", lowerRestraint: "下肢约束", lower_restraint: "下肢约束", legRestraint: "下肢约束", restraint: "下肢约束", handsHeld: "双手持物", hands_held: "双手持物", handHeld: "双手持物", restraintDist: "约束距离", restraintDistance: "约束距离", restraint_dist: "约束距离", surfaceMask: "表层面具", surface_mask: "表层面具", mask: "表层面具", facade: "表层面具", subconsciousLeak: "潜意识漏出", subconscious: "潜意识漏出", leak: "潜意识漏出", disguiseMark: "伪装标识", disguise: "伪装标识", coverMark: "伪装标识", posture: "躯干姿势", mood: "表层面具", mentalState: "潜意识漏出", physicalState: "离场状态",                       // 表4 即时状态
    departure: 'departure', leave: 'departure', left: 'departure',
  },
  13: { hpMax: "HP(上限)", mpMax: "MP(上限)", spMax: "SP(上限)", hpCur: "HP(当前)", mpCur: "MP(当前)", spCur: "SP(当前)", intVal: "智力(INT)", strVal: "力量(STR)", conVal: "体质(CON)", dexVal: "敏捷(DEX)", agiVal: "速度(AGI)", loadMax: "负重上限", maxLoad: "负重上限", atkVal: "物理攻击(ATK)", defVal: "物理防御(DEF)", matkVal: "魔法攻击(MATK)", mdefVal: "魔法防御(MDEF)", tempMod: "临时修正", timestamp: "更新时间戳", load: "负重(LOAD)", currentLoad: "负重(LOAD)",                      // 表13 动态属性
    stat: 'hp', attr: 'hp', field: 'hp',
  },
};

/**
 * 解析 `<data>` → facts
 * @returns {{facts:Array, warnings:Array<string>, unknownTags:string[]}}
 */
export function parseDataFacts(text) {
  const facts = [];
  const warnings = [];
  const unknownTags = new Set();
  const blocks = extractTagBlocks(text, 'data');
  if (!blocks.length) return { facts, warnings, unknownTags: [...unknownTags] };

  const block = blocks[blocks.length - 1];
  const els = scanElements(block, { onlyTopLevel: true });
  for (const el of els) {
    const table = tagToTable(el.tag);
    if (!table) { unknownTags.add(el.tag); continue; }
    const attrs = { ...el.attrs };
    if (!Object.keys(attrs).length && el.text) {
      attrs.name = el.text;      // <location>深渊旧哨所</location> 这种简写
    }
    facts.push({ tag: el.tag, no: table.no, tableName: table.name, attrs, text: el.text });
  }
  return { facts, warnings, unknownTags: [...unknownTags] };
}

/** 从属性里取主键（返回 {rowRef, usedAttr}） */
export function factKey(fact) {
  const attrs = fact.attrs ?? {};
  const skip = new Set(['mode', 'change', 'delta', 'by', 'reason', 'field', 'attr_name', '属性']);
  try {
    const tb = getTable(Number(fact.no));
    const cols = (tb?.columns ?? []).map((c) => String(c));
    const keyIdx = (tb?.keyColumns ?? []).map((k) => Number(k)).filter((n) => Number.isFinite(n));
    if (keyIdx.length) {
      const got = [];
      for (const ki of keyIdx) {
        const want = cols[ki];
        let hit = null;
        for (const [attr, raw] of Object.entries(attrs)) {
          if (skip.has(attr)) continue;
          if (raw == null || String(raw).trim() === '') continue;
          let col = null;
          try {
            const extra = (EXTRA_TAG_ALIAS[fact.no] && EXTRA_TAG_ALIAS[fact.no][attr]) || null;
            const tagAlias = (TAG_ATTR_ALIASES && TAG_ATTR_ALIASES[fact.no]) || {};
            let ref = extra || tagAlias[attr] || attr;
            if (extra && !resolveAttr(fact.no, extra)) ref = tagAlias[attr] || attr;
            col = resolveAttr(fact.no, ref);
          } catch (e) { col = null; }
          if (col && String(col.name) === String(want)) { hit = String(raw).trim(); break; }
        }
        got.push(hit);
      }
      if (got.length && got.every(Boolean)) return { rowRef: got.join('|'), usedAttr: 'keys' };
    }
  } catch (e) { /* ignore */ }
  for (const k of KEY_ATTRS) {
    if (attrs[k] != null && String(attrs[k]).trim() !== '') return { rowRef: String(attrs[k]).trim(), usedAttr: k };
  }
  if (fact.no === 5 && attrs.from && attrs.to) return { rowRef: `${attrs.from}|${attrs.to}`, usedAttr: 'from|to' };
  return { rowRef: null, usedAttr: null };
}

/**
 * facts → ops（纯映射部分；战斗/数值增减等派生逻辑在 rules.js 里扩展）
 * @returns {{ops:Array, warnings:Array<string>, unparsed:Array}}
 */
export function factsToOps(facts) {
  const ops = [];
  const warnings = [];
  const unparsed = [];

  for (const fact of facts ?? []) {
    const no = fact.no;
    const { rowRef } = factKey(fact);
    /* 角色类表（角色/生理/即时/关系/数值/怪物）的写入**必须带名字** ——
       否则 txn 会自动造一个「未命名N」行（用户实测报过：表13 多出「未命名1」✗） */
    if ([2, 3, 4, 5, 13, 14].includes(no) && !String(rowRef || "").trim()) {
      warnings.push("表" + no + " 的 <" + fact.tag + "> 没有角色名，已跳过（不建空行）");
      continue;
    }

    // 需要派生计算、交给 rules.js 展开的标签
    if (['skill', 'skill_use', 'attack', 'combat', 'departure', 'leave', 'memory', 'character_memory'].includes(fact.tag)) {
      unparsed.push(fact);
      continue;
    }

    const tagAlias = TAG_ATTR_ALIASES[no] ?? {};
    const values = {};
    const deltas = [];
    const changeRef = fact.attrs?.change ?? fact.attrs?.delta ?? fact.attrs?.by;
    const fieldRef = fact.attrs?.field ?? fact.attrs?.attr_name ?? fact.attrs?.属性;

    for (const [attr, raw] of Object.entries(fact.attrs ?? {})) {
      if (KEY_ATTRS.includes(attr) || attr === 'mode') continue;
      if (['change', 'delta', 'by', 'reason', 'field', 'attr_name', '属性'].includes(attr)) continue;

      const extra = (EXTRA_TAG_ALIAS[no] && EXTRA_TAG_ALIAS[no][attr]) || null;
      // 映射名必须真的能解析才用，否则退回原属性名（不破坏原本能用的）
      let ref = extra || tagAlias[attr] || attr;
      if (extra && !resolveAttr(no, extra)) ref = tagAlias[attr] || attr;
      let col = resolveAttr(no, ref);
      // ② 分节名（模板里的 <basic>/<optional>/<appearance>/<distance>…）不是列 → 静默忽略
      if (!col && /^(basic|optional|appearance|physique|state|position|clothing|holding|distance|extra|advanced|detail|info|measure)$/i.test(String(attr))) continue;
      // ③ 跨表路由：本表认不出 → 去别的表的别名表里找，找到就直接生成那张表的 op
      //    （模板把表6 的 grand_goal/chapter/focus 写在 <world> 里 → 以前整批丢掉 = 表6 永远空）
      if (!col) {
        let hitNo = -1;
        let hitCol = null;
        for (const src of [EXTRA_TAG_ALIAS, TAG_ATTR_ALIASES]) {
          for (const [otherNo, map] of Object.entries(src || {})) {
            if (Number(otherNo) === no) continue;
            const cand = map && map[attr];
            if (!cand) continue;
            const c2 = resolveAttr(Number(otherNo), cand);
            if (c2) { hitNo = Number(otherNo); hitCol = c2; break; }
          }
          if (hitNo >= 0) break;
        }
        /* 路由白名单：跨表路由**只允许进单例表**（0 宏观时空 / 6 剧情大纲）——
           它原本就是为了"模板把表6 的字段写在 <world> 里"而做的；
           放开到所有表会在目标表里用源表的行键建出垃圾行（用户实测：表7 出现「User」「柯尔」两条假任务 ✗，
           表11 出现「未知」「中立」两个假势力 ✗），所以这里收紧 ✓ */
        const ROUTE_OK = [0, 6];
        if (hitNo >= 0 && hitCol && !ROUTE_OK.includes(hitNo)) {
          warnings.push("「" + attr + "」属于表" + hitNo + " 的列，但跨表路由只允许进单例表，已跳过（避免建垃圾行）");
          hitNo = -1; hitCol = null;
        }
        if (hitNo >= 0 && hitCol) {
          const nm = getTable(hitNo)?.columns?.[hitCol.index] ?? hitCol.name;
          ops.push({ op: "upsert", table: hitNo, row: rowRef || undefined, values: { [nm]: cellStr(raw) }, __from: "data", __tag: fact.tag, __routedFrom: no });
          continue;
        }
      }
      if (!col) { warnings.push(`表${no}（${fact.tableName}）没有列「${attr}」——来自 <${fact.tag}>`); continue; }
      const name = getTable(no)?.columns?.[col.index] ?? col.name;
      values[name] = cellStr(raw);
    }

    // 数值增减形式：<status name="X" field="hp" change="-30" reason="…"/>
    if (changeRef != null) {
      const ref = fieldRef ?? Object.keys(values)[0];
      const col = ref ? resolveAttr(no, tagAlias[ref] ?? ref) : null;
      if (!col) { warnings.push(`<${fact.tag}> 的数值增减缺少可识别的 field`); }
      else if (!Number.isFinite(Number(changeRef))) { warnings.push(`<${fact.tag}> 的 change「${changeRef}」不是数字`); }
      else if (rowRef) {
        deltas.push({
          op: 'delta', table: no, row: rowRef, col: col.name, by: Number(changeRef),
          __from: 'data', __tag: fact.tag, __reason: fact.attrs?.reason,
        });
      } else {
        warnings.push(`<${fact.tag}> 的数值增减缺少 name`);
      }
    }

    if (deltas.length) { ops.push(...deltas); continue; }

    if (!Object.keys(values).length) {
      // 没有任何可写入的列 —— 记警告而不是产生一条注定失败的 op
      warnings.push(`<${fact.tag}> 没有解析出任何可写入的列${rowRef ? `（行 ${rowRef}）` : ''}`);
      continue;
    }

    const singleton = !!getTable(no)?.singleton;
    if (singleton) {
      // 单例表：并入第 0 行（单例表的行永远只有一行）
      ops.push({ op: 'upsert', table: no, row: rowRef || 1, values, __from: 'data', __tag: fact.tag, __singleton: true });
      continue;
    }

    if (no === 5) {
      /* 表5 是复合键（发起方A + 承受方B）。
         以前这里硬编码只认 from/to ✗ —— 而 AI 实际写的是 participantA/participantB，
         于是 row 恒为 "|"、两个主键恒为空（真 API 实测 + 审查一直报"表5 第 1 行主键为空"）。
         现在一律以 factKey 的结果为准（它走解析器同款别名链，认 participantA/B、a/b、发起方A/承受方B…），
         from/to 只作兜底。 */
      const cols5 = getTable(5)?.columns ?? [];
      const from = fact.attrs?.from ?? '';
      const to = fact.attrs?.to ?? '';
      if (from) values[cols5[0]] = cellStr(from);
      if (to) values[cols5[1]] = cellStr(to);
      const rr5 = rowRef || (from && to ? `${from}|${to}` : '');
      ops.push({ op: 'upsert', table: 5, row: rr5 || undefined, values, __from: 'data', __tag: fact.tag });
      continue;
    }

    const mode = String(fact.attrs?.mode ?? '').toLowerCase();
    const kind = rowRef ? 'upsert' : 'insert';
    ops.push({
      op: kind,
      table: no,
      row: rowRef ?? undefined,
      values,
      __from: 'data',
      __tag: fact.tag,
      __mode: mode || undefined,
    });
  }

  return { ops, warnings, unparsed };
}

/**
 * 一体化：从一段文本里同时提取两种协议的 ops
 * @returns {{ops:Array, facts:Array, warnings:Array, unparsed:Array, unknownTags:Array}}
 */
export function parseAll(text, { allowFacts = true } = {}) {
  // 嵌套写法（<world><time value="X"/></world>）先摊平成属性，否则字段全读不到
  text = flattenNestedData(text);
  const out = { ops: [], facts: [], warnings: [], unparsed: [], unknownTags: [] };
  if (allowFacts) {
    const r = parseDataFacts(text);
    out.facts = r.facts;
    out.unknownTags = r.unknownTags;
    const m = factsToOps(r.facts);
    out.ops.push(...m.ops);
    out.warnings.push(...m.warnings);
    out.unparsed.push(...m.unparsed);
  }
  return out;
}

export { getTables };
/**
 * 把嵌套写法摊平：<world><time value="X"/></world> → <world time="X"/>
 * 叶子规则：tag 的 value/name 属性，或标签内文本；中间分组标签递归上提。
 * 只处理 <data> 内部，避免动到别的标签。
 */
export function flattenNestedData(text) {
  const src = String(text || "");
  return src.replace(/<data\b[^>]*>([\s\S]*?)<\/data>/gi, (whole, inner) => {
    const flat = rbqFlattenInner(inner);
    return whole.replace(inner, flat);
  });
}

/** 递归把一块 XML 里的叶子提成父标签的属性 */
function flattenBlock(block) {
  const src = String(block || "");
  // 反复处理，直到没有"元素里还套着元素"的父级
  let out = src;
  for (let pass = 0; pass < 6; pass++) {
    let changed = false;
    out = out.replace(/<([A-Za-z_][\w.-]*)((?:\s+[^<>]*?)?)>([\s\S]*?)<\/\1>/g, (m, tag, attrs, inner) => {
      if (inner.indexOf("<") < 0) return m;                  // 里层没有标签：留给后面处理
      const kids = collectLeaves(inner);
      if (!kids.length) return m;
      let a = String(attrs || "").replace(/\s+$/, "");
      for (const kv of kids) a += " " + kv;
      changed = true;
      const rest = stripElements(inner);
      return "<" + tag + a + ">" + rest + "</" + tag + ">";
    });
    if (!changed) break;
  }
  // 收尾：把还没处理的叶子转成属性（父级已经在上一步处理过了）
  return out.replace(/<(\w[\w.-]*)((?:\s+[^<>]*?)?)\/>/g, (m) => m);
}

/** 把一段内部内容里的所有叶子元素转成 key="value" 形式 */
function collectLeaves(inner) {
  const out = [];
  const re = /<([A-Za-z_][\w.-]*)((?:\s+[^<>]*?)?)(?:\/>|>([\s\S]*?)<\/\1>)/g;
  let m = re.exec(inner);
  while (m) {
    const tag = m[1];
    const attrs = String(m[2] || "");
    const text = String(m[3] || "").replace(/<[^>]*>/g, "").trim();
    let val = "";
    const vm = attrs.match(/\b(?:value|val)\s*=\s*"([^"]*)"/i);
    if (vm) val = vm[1];
    else {
      const nm = attrs.match(/\bname\s*=\s*"([^"]*)"/i);
      if (nm) val = nm[1];
    }
    if (!val && text) val = text;
    if (val !== "") out.push(tag + "=\"" + String(val).replace(/"/g, "&quot;") + "\"");
    m = re.exec(inner);
  }
  return out;
}

/** 去掉内部的所有元素，只保留纯文本（防止同一叶子被重复上提） */
function stripElements(inner) {
  return String(inner || "").replace(/<[^>]*>/g, "").replace(/\n{2,}/g, "\n");
}

/**
 * 子标签名 → 列名（嵌套写法里 <time value=…/> 这类，直接给出它对应哪一列）
 * 只在 resolveAttr 认不出来时兜底用。
 */
export const EXTRA_TAG_ALIAS = {
  0: { time: "时空坐标", datetime: "时空坐标", location: "绝对位置名称", place: "绝对位置名称", weather: "环境气象", present_chars: "在场实体名单", present: "在场实体名单", world_law: "世界法则", law: "世界法则", atmosphere: "安全氛围", grand_goal: "终极宏愿", grand_progress: "宏愿进度", chapter: "当前篇章", chapter_status: "篇章状态", focus: "即时焦点", focus_feedback: "焦点反馈", round: "系统轮次" },
  1: { name: "地点名称", region: "所属大区", scale: "物理规模", decor: "常态装潢与环境基调", security: "安保警戒等级", owner: "所有权掌控方", function: "核心职能", func: "核心职能", assets: "不可移动资产", clues: "历史线索痕迹", damage: "损毁状态" },
  2: { ratio: "四维系数(STR|CON|DEX|INT)", attrRatio: "四维系数(STR|CON|DEX|INT)", attr_ratio: "四维系数(STR|CON|DEX|INT)", minefield: "绝对雷区", redline: "绝对雷区", noGoZone: "绝对雷区", pref: "核心偏好", corePreference: "核心偏好", core_preference: "核心偏好", deepWeakness: "深层软肋", softSpot: "深层软肋", growthCoef: "四维系数(STR|CON|DEX|INT)", combatStyle: "四维偏好与战斗风格", style: "四维偏好与战斗风格", fightStyle: "四维偏好与战斗风格", history: "背景履历", bio: "背景履历", coef: "四维系数(STR|CON|DEX|INT)", coefficient: "四维系数(STR|CON|DEX|INT)", 四维系数: "四维系数(STR|CON|DEX|INT)", 系数: "四维系数(STR|CON|DEX|INT)", fourD: "四维系数(STR|CON|DEX|INT)", alive: "存活状态", race: "种族", job: "公开身份/职业", level: "等级", skillPool: "技能池", skill_pool: "技能池", age: "年龄", birthday: "出生日期", personality: "核心性格", taboo: "绝对雷区", preference: "核心偏好", background: "背景履历", weakness: "深层软肋", stat_growth: "四维系数(STR|CON|DEX|INT)", growth: "四维系数(STR|CON|DEX|INT)", stat_preference: "四维偏好与战斗风格" },
  3: { like: "情境偏好", redline: "性雷区", weakness: "特殊体征", special: "特殊体征", context: "情境偏好", ratio: "四维系数(STR|CON|DEX|INT)", attrRatio: "四维系数(STR|CON|DEX|INT)", fetish: "核心性癖", coreFetish: "核心性癖", contextPref: "情境偏好", situationPref: "情境偏好", sexMinefield: "性雷区", sex_minefield: "性雷区", sexualTaboo: "性雷区", specialTrait: "特殊体征", special_trait: "特殊体征", trait: "特殊体征", painThreshold: "痛觉阈值", pleasureThreshold: "快感阈值", exhaustionPerformance: "透支表现", cycle: "生理周期", hairColor: "发色", hairStyle: "发型", bodyHair: "体毛", gender: "性别", sex_experience: "性经验状态", sexual_experience: "性经验状态", virgin: "性经验状态", organ: "性器官特征", anus: "肛门特征", pain_threshold: "痛觉阈值", pleasure_threshold: "快感阈值", stamina: "体能上限", exhaustion_performance: "透支表现", kink: "核心性癖", situation_preference: "情境偏好", sex_taboo: "性雷区", period: "生理周期",特殊体征: "特殊体征", height: "身高", weight: "体重", measures: "三围", overall_figure: "整体体型", shoulder_collarbone: "肩部与锁骨", chest: "胸部", waist: "腰线", hip: "臀部", hands: "手部", legs: "腿部", feet: "足部", hair_color: "发色", hair_style: "发型", body_hair: "体毛", scent: "体香", experience: "性经验状态", meiki: "名器类型", sex_organ: "性器官特征", anus: "肛门特征", period: "生理周期", pain_threshold: "痛觉阈值", pleasure_threshold: "快感阈值", kinks: "核心性癖", context_pref: "情境偏好", sex_taboo: "性雷区", stamina: "体能上限", exhaustion: "透支表现" },
  4: { coord: "微观坐标", departure: "离场状态", head: "头部", outerUpper: "上装外衣", innerUpper: "上装内层", outerLower: "下装外层", innerLower: "下装内层", feet: "足部", holding: "双手持物", neck: "颈部附加" },
  5: { surface: "表面关系", surface_call: "表面称呼", surfaceName: "表面称呼", private: "私密关系", private_call: "私密称呼", privateName: "私密称呼", affection_tone: "好感底色", obedience: "服从结构", possessiveness: "占有欲表现", blindspot: "情报盲区", blind_spot: "情报盲区", guard: "当前防备姿态", memory: "定情回忆", participantA: "发起方A", participantB: "承受方B", participant_a: "发起方A", participant_b: "承受方B", a: "发起方A", b: "承受方B", from: "发起方A", to: "承受方B", surfaceRel: "表面关系", surface_rel: "表面关系", privateRel: "私密关系", private_rel: "私密关系", affection: "好感底色", possess: "占有欲表现", submission: "服从结构", blind: "情报盲区" },
  6: { grandGoal: "终极宏愿", grand_goal: "终极宏愿", goal: "终极宏愿", grandProgress: "宏愿进度", grand_progress: "宏愿进度", progress: "宏愿进度", chapter: "当前篇章", chapterName: "当前篇章", chapterStatus: "篇章状态", chapter_status: "篇章状态", focus: "即时焦点", focus_feedback: "焦点反馈", focusFeedback: "焦点反馈", feedback: "焦点反馈" },
  7: { task: "任务名称", category: "行动类别", target: "物理目标", owner: "挂载角色", giver: "发放方", asset: "关键资产", deadline: "过期死线", rule: "结算规则", status: "推进状态" },
  8: { 异常状态名称: "异常状态名称", name: "异常状态名称", status: "异常状态名称", host: "宿主对象", target: "宿主对象", source: "引发源头", origin: "引发源头", category: "类别界定", effect: "发作表现", symptom: "发作表现", severity: "层数/严重度", level: "层数/严重度", stacks: "层数/严重度", panel: "面板干预", panelOverride: "面板干预", mod: "数值修正", modifier: "数值修正", visible: "显隐性", duration: "剩余持续", remain: "剩余持续", remove_condition: "解除条件", cure: "解除条件" },
  11: { 名称: "名称", name: "名称", faction: "名称", category: "数据分类", type: "数据分类", authority: "权力终端/制定者", terminal: "权力终端/制定者", lawmaker: "权力终端/制定者", region: "辐射辖区", scope: "辐射辖区", prestige: "主角声望/参与度", participation: "主角声望/参与度", reputation: "主角声望/参与度", hostile: "敌对关联", enemy: "敌对关联", benefit: "内部福利/优势", privilege: "内部福利/优势", advantage: "内部福利/优势", taboo: "红线/禁忌", redline: "红线/禁忌", forbidden: "红线/禁忌", surveillance: "监控/探测机制", monitor: "监控/探测机制", detection: "监控/探测机制", penalty: "处罚/后果", punish: "处罚/后果", consequence: "处罚/后果" },
  12: { 纪元封包名: "纪元封包名", 封包名: "纪元封包名", name: "纪元封包名", epochName: "纪元封包名", title: "纪元封包名", range: "时间轴区间", route: "地理迁徙路线", summary: "剧情压缩", compress: "剧情压缩", deaths: "死亡名单", collapse: "派系崩塌与格局重构", trumps: "战略底牌与禁忌物入手", emotion: "情感质变", territory: "版图撕裂", suspense: "继承悬念" },
  9: { item: "物品名称", quantity: "耐久/数量", armor: "基础伤害/护甲值", holder: "当前归属", category: "物理类别", count: "耐久/数量", volume: "碰撞体积", rarity: "稀有度", damage: "基础伤害/护甲值", bonus: "属性加成", legality: "入手合法性", state: "外显状态", hidden: "隐藏属性" },
  10: { learnedBy: "习得方式", learned_by: "习得方式", learn_by: "习得方式", skill: "技能名称", type: "检定类型", desc: "物理描述", description: "物理描述", origin: "觉醒溯源", mastery: "熟练阶层", mpCost: "MP消耗", spCost: "SP消耗", damage: "基础伤害/治疗量", cooldown: "CD冷却", range: "波及范围", threshold: "释放门槛", seal: "封印状态" },
  13: { hp: "HP(当前)", maxHp: "HP(上限)", mp: "MP(当前)", maxMp: "MP(上限)", sp: "SP(当前)", maxSp: "SP(上限)", str: "力量(STR)", con: "体质(CON)", dex: "敏捷(DEX)", int: "智力(INT)", atk: "物理攻击(ATK)", def: "物理防御(DEF)", matk: "魔法攻击(MATK)", mdef: "魔法防御(MDEF)", agi: "速度(AGI)" },
  14: { coef: "四维系数(STR|CON|DEX|INT)", coefficient: "四维系数(STR|CON|DEX|INT)", 四维系数: "四维系数(STR|CON|DEX|INT)", level: "等级", hp: "HP(当前)", maxHp: "HP(上限)", mp: "MP(当前)", maxMp: "MP(上限)", sp: "SP(当前)", maxSp: "SP(上限)", state: "状态", status: "状态", desc: "简要描述" },
};

/* ---- 嵌套摊平（v2）：一律产出自闭合标签，事实解析器才认得 ---- */
function rbqParseEls(block) {
  const out = [];
  const re = /<([A-Za-z_\u4e00-\u9fff][\w\u4e00-\u9fff.-]*)((?:\s+[^<>]*?)?)(?:\/>|>([\s\S]*?)<\/\1>)/g;
  let m = re.exec(String(block || ""));
  while (m) { out.push({ tag: m[1], attrs: String(m[2] || ""), inner: String(m[3] || "") }); m = re.exec(String(block || "")); }
  return out;
}

function rbqLeaves(inner, depth) {
  const d = Number(depth) || 0;
  if (d > 6) return [];
  const out = [];
  for (const el of rbqParseEls(inner)) {
    const kids = rbqParseEls(el.inner);
    if (kids.length) { const sub = rbqLeaves(el.inner, d + 1); for (const x of sub) out.push(x); continue; }
    let val = "";
    const vm = el.attrs.match(/\b(?:value|val)\s*=\s*"([^"]*)"/i);
    if (vm) val = vm[1];
    else { const nm = el.attrs.match(/\bname\s*=\s*"([^"]*)"/i); if (nm) val = nm[1]; }
    if (!val) val = String(el.inner || "").replace(/<[^>]*>/g, "").trim();
    if (val !== "") out.push({ key: el.tag, value: val });
  }
  return out;
}

export function rbqFlattenInner(inner) {   // 导出便于自检
  const parts = [];
  for (const el of rbqParseEls(inner)) {
    const kidsEls = rbqParseEls(el.inner);
    const ownLeaves = [];
    const subParts = [];
    for (const kid of kidsEls) {
      const kidIsContainer = rbqParseEls(kid.inner).length > 0;
      // 子容器自己也有表（appearance/physique/state/plot…）→ 单独成一条，别并到父标签上
      // （以前并上去会导致这批字段按父表的列解析，全部失败被丢掉 —— 表3/表4/表6 一直空的病根）
      if (kidIsContainer && tagToTable(kid.tag)) {
        // 子容器要继承父标签的"这一行是谁"（否则表2/表3 写进去的行没有主键）
        const inherit = (() => {
          const out = [];
          for (const kk of ["name", "id", "key", "who", "名称", "角色名称", "实体名称"]) {
            const m2 = String(el.attrs || "").match(new RegExp("\\b" + kk + "\\s*=\\s*\"([^\"]*)\"", "i"));
            if (m2) out.push(kk + "=\"" + m2[1] + "\"");
          }
          return out.join(" ");
        })();
        subParts.push(rbqFlattenInner("<" + kid.tag + " " + inherit + " " + String(kid.attrs || "").trim() + ">" + kid.inner + "</" + kid.tag + ">"));
        continue;
      }
      // 关键：子元素自己就是一片叶子（<level>Lv.12</level>）→ 必须用【它自己的标签名】当属性名
      const lf = (() => {
        let val = "";
        const vm = String(kid.attrs || "").match(/\b(?:value|val)\s*=\s*"([^"]*)"/i);
        if (vm) val = vm[1];
        else { const nm = String(kid.attrs || "").match(/\bname\s*=\s*"([^"]*)"/i); if (nm) val = nm[1]; }
        if (!val) val = String(kid.inner || "").replace(/<[^>]*>/g, "").trim();
        return val === "" ? null : { key: kid.tag, value: val };
      })();
      if (lf) ownLeaves.push(lf);
      else for (const x of rbqLeaves(kid.inner, 0)) ownLeaves.push(x);
    }
    let attrs = String(el.attrs || "").replace(/\s+$/, "");
    const seen = {};
    const own = attrs.match(/([A-Za-z_][\w.-]*)\s*=/g) || [];
    for (const o of own) seen[String(o).replace(/\s*=$/, "")] = true;
    for (const k of ownLeaves) {
      if (seen[k.key]) continue;
      attrs += " " + k.key + "=\"" + String(k.value).replace(/"/g, "&quot;") + "\"";
    }
    if (kidsEls.length === 0) {
      // 纯文本元素（如 <character_memory>正文</character_memory>）原样保留
      parts.push("<" + el.tag + attrs + ">" + el.inner + "</" + el.tag + ">");
    } else if (attrs.trim() !== "") {
      parts.push("<" + el.tag + attrs + "/>");
    }
    for (const s of subParts) parts.push(s);
  }
  return parts.join(String.fromCharCode(10));
}
