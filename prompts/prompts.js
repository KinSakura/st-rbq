/**
 * prompts.js —— 三个宏的内容生成
 *
 * 关键点（相对现状的实质改进）：
 *   {{tablePrompt}} 里的「标签规范」是**从解析器反向生成**的，不是手写文本。
 *   旧实现里插件的指南与 rbq.js 的解析器各自维护，任一边加标签另一边就漂移；
 *   这里两边同源，永远不会不一致。
 */

import { getTables, getTable } from '../core/schema.js';
import { EXTRA_TAG_ALIAS } from '../core/protocol.js';
import { TAG_ATTR_ALIASES, tagToTable } from '../core/protocol.js';   // 解析器同款的标签→列解析链
import * as sideApi from '../core/sideApi.js';
import { cellS } from '../core/cells.js';
import * as schemaMod from '../core/schema.js';
import * as summary from '../core/summary.js';
import * as recall from '../core/recall.js';   // v2.18.0 预先召回缓存
import * as extras from '../core/extras.js';   // v2.18.0：写 bigSummaryText 变量要用
import { listAttrs, resolveAttr } from '../core/alias.js';
import { GLOBAL_DEFAULTS } from '../core/legacyVars.js';
import { TAG_TABLE } from '../core/protocol.js';
import * as store from '../core/store.js';
import * as memory from '../core/memory.js';
import * as addons from '../core/addons.js';
import { getRows } from '../core/store.js';
import { getColumns } from '../core/schema.js';
/* 取列名的小帮手（scheme 里改表结构时也不会取错 ✓）*/
function store0Cols(no) { try { return (getColumns(no) || []).map((x) => String(x)); } catch (e) { return []; } }
import { chat, ctx } from '../core/ctx.js';

/**
 * 召回用的"当前上下文"。真实实现（v2.18.0 起）：
 *   ① 在场角色名（表0/表2 在场名单 ✓ 走 extras.presentNames ✓ 拿不到时读表0 第一行）
 *   ② 当前焦点（表6「即时焦点」✓ 按列名取 ✓）
 *   ③ 最近几条消息的尾部（限额 800 字 ✓ 原有行为）
 * 为什么加 ①②：光给正文，召回只能靠字面重叠 ✗；把"谁在场""现在要干什么"一起给，
 *   语义与关键词都对得上，召回到的记忆明显更相关 ✓（零接口成本 ✓）
 */
export function recallQuery() {
  /* ① 在场角色（走 extras.presentNames ✓ 拿不到就读表0 在场名单）*/
  const __head = [];
  try {
    let __names = [];
    try { __names = (extras.presentNames() || []).map((x) => String(x || "").trim()).filter(Boolean); } catch (e) { __names = []; }
    if (!__names.length) {
      try {
        const __r0 = (getRows(0, { create: false }) || [])[0] || [];
        const __c0 = store0Cols(0);
        const __i0 = __c0.indexOf("在场实体名单");
        if (__i0 >= 0) __names = String(__r0[__i0] || "").split(/[\/\u3001,\uff0c]/).map((x) => x.trim()).filter(Boolean);
      } catch (e) { /* ignore */ }
    }
    if (__names.length) __head.push("【在场】" + __names.join("\u3001"));
  } catch (e) { /* ignore */ }
  /* ② 当前焦点（表6 即时焦点 ✓ 按列名取）*/
  try {
    const __r6 = (getRows(6, { create: false }) || [])[0] || [];
    const __c6 = store0Cols(6);
    const __i6 = __c6.indexOf("即时焦点");
    const __f = __i6 >= 0 ? String(__r6[__i6] || "").trim() : "";
    if (__f) __head.push("【焦点】" + __f.slice(0, 120));
  } catch (e) { /* ignore */ }
  const c = chat();
  let __prefix = __head.length ? (__head.join(" ") + " ") : "";
  let q = '';
  for (let i = c.length - 1; i >= 0 && q.length < 800; i--) {
    const m = c[i];
    if (!m) continue;
    q += ` ${String(m.mes ?? '').slice(-320)}`;
  }
  return (__prefix + q);
}

/* ------------------------------------------------------------- 标签规范 */

/** 标签 → 表号 的人类可读对照（只列主要标签，避免把提示词撑爆） */
const MAIN_TAGS = [
  ['world / time / weather / present', 0, '宏观时空与在场名单（单例表，永远只有一行）'],
  ['location', 1, '场景档案'],
  ['character', 2, '角色静态档案（新角色必须建）'],
  ['physique', 3, '生理与阈值'],
  ['state', 4, '即时物理状态与着装'],
  ['relation', 5, 'A 对 B 的单向关系（必须双向各一条）'],
  ['plot', 6, '剧情大纲与即时焦点（单例表）'],
  ['task', 7, '任务与契约'],
  ['buff', 8, '增益/减益/异常状态'],
  ['item', 9, '物品与资产'],
  ['skill_def', 10, '技能定义'],
  ['skill', 10, '战斗申报：脚本按 power 结算伤害与消耗'],
  ['faction', 11, '派阀/律法/世界法则'],
  ['epoch', 12, '阶段大总结'],
  ['status', 13, '数值变化（可给绝对值，也可用 change 增减）'],
  ['monster', 14, '怪物与临时实体'],
  ['departure', 4, '角色离场标记'],
];

/**
 * 定义文本清洗（去污染）：
 *   ① 去掉"如 左玄/慕容雪"这类**示例值/人名**（AI 会照着抄，污染数据）
 *   ② 去掉"由系统自动维护 / 由出生日期和当前年份自动计算"这类**对 AI 无用的说明**
 *   ③ 去掉模板块与多余空白
 */
function cleanDef(d) {
  let s = String(d == null ? "" : d);
  try {
    s = s.replace(/<％[-=]?[\s\S]*?％>/g, "").replace(/<%[-=]?[\s\S]*?%>/g, "").replace(/\{\{[^}]*\}\}/g, "");
    // 示例值：如 / 例如 / 比如 + 后面的一串（到标点为止）
    // 只去掉"人名式"示例（如 左玄/慕容雪）—— 保留格式/枚举示例（如 暴风雪/零下25℃、安全区/警戒区/高危区）
    // 人名式示例整串删掉：`如 沈总、队长` / `如 左玄/慕容雪` / `如 开端、进行中、接近尾声`
    // （只删"纯汉字词组"的枚举；带数字/单位/字母的格式示例保留，如 暴风雪/零下25℃）
    // 用户要求：所有"明确的具体值"都是污染（不只是人名）→ 「如/例如/比如」后面整串删掉。
    // 保留「枚举 …」候选词表与「格式 …」说明（那不是具体值）。
    s = s.replace(/(?:如|例如|比如)[:：]?\s*[^，。；\n）)]*/g, "");
    // 预设原文里的废话也清（由……自动维护/计算 这类对 AI 没用）
    s = s.replace(/由[^，。；\n]{0,16}自动(?:维护|计算|生成|更新|处理)[。；，]?/g, "");
    // 清掉被删后留下的空标点
    // 删除后的尾巴：`，。` → `。`；`区间对应 。` 这类空句也去掉
    s = s.replace(/[，,、]\s*(?=[。；;])/g, "").replace(/[，,、]{2,}/g, "，").replace(/。\s*。/g, "。");
    s = s.replace(/[，,、]?\s*[^，。；\n]{0,6}对应\s*[。；]/g, "。");
    s = s.replace(/\s*[（(]\s*[)）]\s*/g, "");
    s = s.replace(/^[，。；、:：\s]+/, "").trim();
    // "由系统自动维护/由……自动计算"这类废话
    s = s.replace(/由[^，。；\n]{0,14}自动(?:维护|计算|生成|更新|处理)[。；，]?/g, "");
    s = s.replace(/系统会?自动[^，。；\n]{0,10}[。；，]?/g, "");
    s = s.replace(/[（(]\s*[)）]/g, "");
    s = s.replace(/\s{2,}/g, " ");
    s = s.replace(/^[，。；、:：\s]+/, "").replace(/[，、\s]+$/, "").trim();
  } catch (e) { /* ignore */ }
  return s;
}

/** 解析表 note 里的逐列定义：`- 0:角色名称：主键，唯一标识。` → { 0: "主键，唯一标识。" } */
/** 给某个任务用：取该表「AI 要写的列」及其定义（自动跳过主键与脚本计算的列） */
/** 表12（大总结）的 <epoch> 写法：骨架 + 逐列定义（给侧路的大总结任务用） */
export function epochWriteSpec() {
  const fallback = '<epoch 封包名="…" 时间轴区间="…" 剧情压缩="…" />';
  try {
    const cols = (getTable(12)?.columns ?? []).map((c) => String(c)).filter(Boolean);
    if (!cols.length) return fallback;
    const attrs = cols.map((c) => c + '="⟨' + c + '⟩"').join(" ");
    const head = "<epoch " + attrs + "/>";
    const defs = columnDefsFor(12).map((x) => "· " + x.name + "：" + x.def).join(String.fromCharCode(10));
    return defs ? (head + String.fromCharCode(10) + defs) : head;
  } catch (e) { return fallback; }
}

export function columnDefsFor(no) {
  const out = [];
  try {
    const tb = getTable(no);
    const cols = (tb?.columns ?? []).map((c) => String(c));
    const keyIdx = new Set((tb?.keyColumns ?? []).map((k) => Number(k)));
    const defs = colDefsOf(no);
    cols.forEach((c, i) => {
      if (keyIdx.has(i)) return;
      const hit = resolveAttr(no, c);
      const alias = hit && hit.aliases && hit.aliases.length ? String(hit.aliases[0]) : "";
      if (alias && MECHANICAL_COLUMNS.includes(alias)) return;
      // 定义被清洗后为空（整句都是示例值）→ 用列名本身当说明：AI 看不到表格，列名就是它需要的指令
      const d0 = defs[i] ? String(defs[i]).trim() : "";
      out.push({ name: c, def: d0 || c });
    });
  } catch (e) { /* ignore */ }
  return out;
}

function colDefsOf(no) {
  const out = {};
  try {
    const note = String(getTable(no)?.note ?? '');
    for (const line of note.split(String.fromCharCode(10))) {
      const m = /^\s*[-*]\s*(\d+)\s*[:：]\s*(.+)$/.exec(line);
      if (!m) continue;
      const body = String(m[2]);
      const k = body.search(/[:：]/);
      const raw = k > 0 ? body.slice(k + 1).trim() : body.trim();
      out[Number(m[1])] = cleanDef(raw);
    }
  } catch (e) { /* ignore */ }
  return out;
}

function attrHintLine(no) {
  const t = getTable(no);
  if (!t) return '';
  const attrs = listAttrs(no);
  // 只列别名（英文）优先，没有别名的用列名
  const parts = attrs.map((a) => (a.aliases.length ? `${a.aliases[0]}(${a.name})` : a.name));
  return `    ${t.name}：${parts.join('、')}`;
}

/** 取 messageTemplate 非空的那个 schema（store 的 override 常为空，真值在 schema.js） */
function schemaNow() {
  const a = (() => { try { return store.getSchema?.() ?? null; } catch { return null; } })();
  const b2 = (() => { try { return schemaMod.getSchema?.() ?? null; } catch { return null; } })();
  const nonEmpty = (x) => !!(x && String(x.messageTemplate ?? '').trim());
  if (nonEmpty(a)) return a;
  if (nonEmpty(b2)) return b2;
  return a ?? b2 ?? null;
}

/**
 * 指南的"卫生处理"：
 *   ① 把酒馆模板块展开成真值（<%- getvar('x') %> / getGlobalVar('x')，支持 || 默认值）
 *      —— 否则 AI 看到的是 <%- getvar(...) %> 这串符号，等于没给
 *   ② 把示例里的**具体人名**换成占位符（示例会被 AI 模仿，污染表格）
 */
function sanitizeGuide(text) {
  let s = String(text ?? '');
  const vget = (fn, key) => {
    // ② 插件自己的默认值（如生理周期词库）——不依赖原脚本是否 setGlobalVar
    const def = GLOBAL_DEFAULTS?.[key];
    const fromDefault = def == null ? '' : String(def);
    try {
      const vars = ctx()?.variables;
      const v = fn === 'getvar' ? vars?.chat?.get?.(key) : vars?.global?.get?.(key);
      const live = v == null ? '' : String(v);
      return live !== '' ? live : fromDefault;   // ① 实时变量优先，② 否则用插件默认值
    } catch { return ''; }
  };
  s = s.replace(/<%[-=]?\s*(getvar|getGlobalVar)\(\s*['"]([\w.]+)['"]\s*\)\s*(?:\|\|\s*['"]([^'"]*)['"])?\s*%>/g,
    (m, fn, key, fallback) => {
      const v = vget(fn, key);
      return v === '' ? String(fallback ?? '') : v;
    });
  // 其它模板块一律去掉（留着只会干扰）
  s = s.replace(/<%[-=]?[\s\S]*?%>/g, '');
  // 具体人名 → 占位符（示例会被模仿）
  s = s.replace(/左玄/g, '⟨角色名⟩')
       .replace(/慕容雪/g, '⟨角色名⟩')
       .replace(/沈总/g, '⟨角色名⟩');
  return s;
}

/** 用户原文《表格数据说明》（操作指南）—— 单独可取，便于侧路复用 */
/**
 * 把列定义「拆开」，逐行插到 XML 示例的对应标签下面（用户明确要求的形式）：
 *     <time value="…"/>
 *     # 表0「时空坐标」：格式 YYYY年-MM月DD日-星期X-HH:MM。
 * 幂等：下面已经有一行 # 就跳过。
 */
export function injectColumnDefs(text) {
  const out = [];
  try {
    const lines = String(text ?? "").split(String.fromCharCode(10));
    /* 认三种写法：<tag …/> 、<tag>值</tag> 、<tag …>值</tag> ——
       以前只认自闭合 → 提示词里大量 <gender>男|女</gender> 这种形式全被跳过（用户截图反馈）。 */
    const isTagLine = (l) => /^\s*<[A-Za-z_][\w:-]*(\s[^>]*)?(\/>|>)/.test(l);
    const AL = (typeof EXTRA_TAG_ALIAS !== "undefined" && EXTRA_TAG_ALIAS) || {};
    /* 列名匹配：精确 → 双向包含（别名表与 schema 列名可能差前后缀/括号） */
    const idxOf = (cols, col) => {
      let k = cols.findIndex((c) => c === col);
      if (k < 0) k = cols.findIndex((c) => c.includes(col) || col.includes(c));
      return k;
    };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      out.push(line);
      if (!isTagLine(line)) continue;
      const m = /^\s*<\s*([A-Za-z_][\w:-]*)/.exec(line);
      if (!m) continue;
      const tag = m[1];
      let hitNo = -1;
      let hitCol = "";
      /* 直接照抄解析器 protocol.js 的规则（脚本能填表就说明它能解析出列）：
           ref = EXTRA_TAG_ALIAS[no][tag]（能解析才用）→ TAG_ATTR_ALIASES[no][tag] → tag
           col = resolveAttr(no, ref)
         表号用解析器自己的 tagToTable(tag)。 */
      try {
        const tbHit = tagToTable(tag);
        if (tbHit) {
          const no2 = Number(tbHit.no);
          const tagAlias = (TAG_ATTR_ALIASES && TAG_ATTR_ALIASES[no2]) || {};
          const extra = (EXTRA_TAG_ALIAS && EXTRA_TAG_ALIAS[no2] && EXTRA_TAG_ALIAS[no2][tag]) || null;
          let ref = extra || tagAlias[tag] || tag;
          if (extra && !resolveAttr(no2, extra)) ref = tagAlias[tag] || tag;
          const col2 = resolveAttr(no2, ref);
          if (col2) { hitNo = no2; hitCol = String(col2.name ?? col2); }
        }
      } catch (e) { /* ignore */ }
      /* 第二兜底：扫所有表的 EXTRA_TAG_ALIAS（解析器链认不出的标签在这里可能认得出，
         例如 <gender>/<measures> 这类"表级标签"下的属性） */
      if (hitNo < 0 || !hitCol) {
        for (const [no3, map3] of Object.entries(EXTRA_TAG_ALIAS || {})) {
          if (!map3 || !map3[tag]) continue;
          const col3 = String(map3[tag]);
          const cols3 = (getTable(Number(no3))?.columns ?? []).map((c) => String(c));
          const k3 = idxOf(cols3, col3);
          if (k3 >= 0) { hitNo = Number(no3); hitCol = cols3[k3]; break; }
        }
      }
      /* 兜底：别名表认不出来时，看这一行里有没有直接出现某张表的列名
         （提示词里的写法是 <surface>⟨表面关系，A在公开场合对B的社会定位⟩</surface> —— 值里就带着列名） */
      if (hitNo < 0 || !hitCol) {
        let best = "";
        for (const tb2 of getTables()) {
          for (const c2 of (tb2.columns ?? []).map((x) => String(x))) {
            if (!c2 || !line.includes(c2)) continue;
            if (c2.length > best.length) { best = c2; hitNo = Number(tb2.no); hitCol = c2; }
          }
        }
        if (!best) { hitNo = -1; hitCol = ""; }
      }
      if (hitNo < 0 || !hitCol) continue;
      const next = lines[i + 1] || "";
      if (/^\s*#/.test(next)) continue;
      const cols2 = (getTable(hitNo)?.columns ?? []).map((c) => String(c));
      const idx = idxOf(cols2, hitCol);
      const defs = colDefsOf(hitNo);
      const def = idx >= 0 && defs[idx] ? String(defs[idx]) : "";
      const def2 = def || hitCol;   // 空了就用列名当说明
      if (!def2) continue;
      const pad = (line.match(/^\s*/) || [""])[0];
      // 前缀"表N「列名」"一律不要 —— AI 根本看不到表格，它只负责输出 <data>，只要那句"该怎么填"就够了
      out.push(pad + "# " + def2);
    }
  } catch (e) { return String(text ?? ""); }
  return out.join(String.fromCharCode(10));
}

export function buildTablePromptGuide() {
  let raw = sanitizeGuide(String(schemaNow()?.messageTemplate ?? '')).trim();
  // 预设原文里也清一遍废话（用户要求：不要"由系统自动维护"这种）
  try { raw = raw.split(String.fromCharCode(10)).map((l) => cleanDef(l)).filter((l) => String(l).trim() !== '' || true).join(String.fromCharCode(10)); } catch (e) { /* ignore */ }
  // 在原示例的基础上，逐行把列定义插到对应标签下面
  try { return injectColumnDefs(raw).trim(); } catch (e) { return raw; }
}

/**
 * 脚本生成的部分：标签速查（+长期记忆）→ 常用属性名 → 数值变化写法 → 当前主键清单
 * withTags/withMemory 控制前两块（主提示词在"侧路接管填表"时会省掉它们）
 */
export function buildTablePromptSpec({ withTags = true, withMemory = true, excludeTables = [], withDefs = false } = {}) {
  const lines = [];
  if (withTags) {
    lines.push('## <data> 标签速查（由脚本同源生成，请照此书写）');
    lines.push('');
    lines.push('**写标签时只申报事实：谁、对谁、做了什么、值是多少。**');
    lines.push('不需要你算行号列号 —— 脚本会自动定位到正确的行与列；名字写错一两个字也能兜住。');
    lines.push('');
    /* 关键：每个标签后面必须附上该表的【完整列清单】与【主键列】。
       只写表名是不够的 —— AI 看不见列名就永远不会生成那些列（用户反馈：表3/4/5 空、四维系数不写）。 */
    const computedAliases = new Set(MECHANICAL_COLUMNS.map((x) => String(x)));
    for (const [tag, no, desc] of MAIN_TAGS) {
      if (excludeTables.includes(Number(no))) continue;   // 例如表12（大总结）由独立任务负责
      lines.push(`- \`<${tag.split(' / ')[0]} …/>\` → 表${no}｜${desc}`);
      try {
        const tb = getTable(no);
        const cols = (tb?.columns ?? []).map((c) => String(c)).filter(Boolean);
        if (cols.length) {
          // 哪些列**不用 AI 写**：主键（脚本按标签 name 补）+ 脚本计算的列（MECHANICAL_COLUMNS）
          // 用户要求：不需要 AI 写的东西，干脆不要出现在提示词里。
          const keyIdx = new Set((tb?.keyColumns ?? []).map((k) => Number(k)));
          const aliasOf = (c) => {
            try { const hit = resolveAttr(no, c); return hit && hit.aliases && hit.aliases.length ? String(hit.aliases[0]) : ''; } catch (e) { return ''; }
          };
          const skipCol = (c, i) => {
            if (keyIdx.has(i)) return true;
            const a = aliasOf(c);
            return !!(a && computedAliases.has(a));
          };
          if (withDefs) {
          // 根治"AI 每次换一个同义词"：直接规定属性名怎么写
          lines.push("    · **属性名请直接用下面列出的名字**（不要自己发明英文名，发明了我这边认不出来就会丢掉这一格）");
          // 就近约束：把"这张表该写几行"写在它自己的列清单前面（真 API 实测：全局要求会被忽略）
          const ROW_RULE = (() => {
            const n = Number(no);
            if (n === 0) return '    · 行数：单例表，只有一行。';
            if (n === 6) return '    · 行数：单例表，只有一行。';
            if (n === 5) return '    · 行数：每个角色对每个角色各一条（A→B 与 B→A 都要，两行内容必须不同）。';
            if (n === 2 || n === 3 || n === 4 || n === 13) return '    · 行数：**每个在场角色都要有自己的一行**（缺谁都不行）。';
            return '';
          })();
          if (ROW_RULE) lines.push(ROW_RULE);
          // 抄 ACU 的 initNode/insertNode/updateNode/deleteNode：每张表说清"什么时候写"
          const WHEN = {
            0: '每轮都要写（时空坐标 / 在场实体名单 / 环境气象 必须反映本轮真实情况）。',
            1: '角色进入**新地点**时新增该地点；地点的规模/装潢/归属/损毁变化时更新。',
            2: '**新角色首次登场必须建档**（这轮正文里出现的新人不能漏）；种族/等级/身份/性格等变化时更新。',
            3: '建档时把生理列**逐项补齐**；受伤、生理周期推进、体能透支时更新。**「容貌描述」这一列必须写**：用一两句话写清这个人长什么样（脸型/五官/肤色/气质/标志性小细节），要能和别人**一眼区分开**；不要写身材（身材有独立列）。',
            4: '**每轮更新**：微观坐标 / 离场状态 / 各装备位 / 躯干姿势 —— 只要本轮动过就要写。',
            5: '两人**首次交互**时双向各建一条；表面/私密关系、称呼、好感、防备姿态变化时更新。',
            6: '开局**必须建档**；篇章推进、焦点切换时更新（单例表）。',
            7: '接取/触发新任务时新增；进度推进、完成、失败、过期时更新或删除。',
            8: '异常状态**首次出现时新增**；层数变化时更新；解除时删除（同名去重）。',
            9: '获得新物品时新增；数量/归属/耐久变化时更新；耗尽或损毁时删除。',
            10: '技能**首次出现或习得时新增**；熟练度、消耗、效果变化时更新。',
            11: '势力/律法/法则首次出现时新增；格局、声望、敌对关系变化时更新。',
            12: '（这一张由「大总结」任务在到点时单独写，填表时不用写）',
            13: '**每轮更新** HP/MP/SP 的当前值；上限与派生数值由脚本按等级+四维系数自动算。',
            14: '临时实体/怪物**首次出现时新增**；被击败、逃跑、离场时更新状态。',
          };
          if (WHEN[Number(no)]) lines.push('    · 何时写：' + WHEN[Number(no)]);
          // 最小列集：这张表至少要写全哪几列（不多写但绝不能漏）
          const MIN_COLS = {
            0: ['时空坐标', '绝对位置名称', '环境气象', '在场实体名单'],
            1: ['地点名称', '所属大区', '物理规模'],
            2: ['角色名称', '存活状态', '种族', '公开身份/职业', '等级', '年龄', '四维系数(STR|CON|DEX|INT)', '核心性格', '背景履历', '绝对雷区', '核心偏好', '深层软肋', '技能池'],
            3: ['角色名称', '性别', '身高', '体重', '三围', '容貌描述', '整体体型', '发色', '发型', '性经验状态', '痛觉阈值', '快感阈值', '核心性癖', '情境偏好', '性雷区', '特殊体征'],
            4: ['角色名称', '微观坐标', '离场状态', '头部装备', '上装外衣', '上装内层', '颈部附加', '下装外层', '下装内层', '腿部裹覆', '足部', '下肢约束', '双手持物', '躯干姿势', '约束距离', '表层面具', '潜意识漏出', '伪装标识'],
            5: ['发起方A', '承受方B', '表面关系', '表面称呼', '私密关系', '私密称呼', '好感底色', '服从结构', '占有欲表现', '情报盲区', '当前防备姿态', '定情回忆'],
            6: ['终极宏愿', '宏愿进度', '当前篇章', '篇章状态', '即时焦点', '焦点反馈'],
            7: ['任务名称', '行动类别', '物理目标', '执行坐标', '挂载角色', '发放方', '推进状态'],
            9: ['物品名称', '当前归属', '物理类别'],
            10: ['技能名称', '检定类型', '物理描述', '熟练阶层'],
            11: ['名称', '数据分类'],
            13: ['角色名称', 'HP(当前)', 'HP(上限)', 'MP(当前)', 'MP(上限)', 'SP(当前)', 'SP(上限)'],
            14: ['实体名称', '等级', 'HP(当前)', 'HP(上限)'],
          };
          if (MIN_COLS[Number(no)]) lines.push('    · **这张表至少要写全**：' + MIN_COLS[Number(no)].join(' / '));
            // 侧路填表：**逐列定义挂在标签下面**（AI 靠这个知道每一列怎么填）
            const defs = colDefsOf(no);
            cols.forEach((c, i) => {
              if (skipCol(c, i)) return;
              const d = defs[i] ? String(defs[i]) : '';
              // 列名合法就直接用中文列名；不合法（带 / ( ) 空格）就给一个英文别名
              const legal = /^[A-Za-z_\u4e00-\u9fff][A-Za-z0-9_.\-\u4e00-\u9fff]*$/.test(String(c));
              let attrName = String(c);
              if (!legal) {
                try {
                  // 从别名表里找这一列的英文别名（resolveAttr 返回的是 {index,name}，没有 aliases）
                  const entry = (listAttrs(no) || []).find((x) => String(x.name) === String(c));
                  const al = entry && entry.aliases && entry.aliases.length ? String(entry.aliases[0]) : '';
                  attrName = al || 'c' + i;
                } catch (e) { attrName = 'c' + i; }
              }
              lines.push('    · ' + c + (legal ? '（属性名就用「' + attrName + '」）' : '（列名含特殊符号，属性名请用「' + attrName + '」）') + '：' + d);
            });
          } else {
            lines.push('    · 列：' + cols.map((c, i) => (skipCol(c, i) ? null : c)).filter(Boolean).join(' / '));
          }
        }
      } catch (e) { /* ignore */ }
    }
    lines.push('');
    if (withMemory) {
      lines.push('### 长期记忆（<data> 内的独立通道，不占表格）');
      lines.push('表格装"现状"，记忆装"历史"。凡是以后还会被想起的事 —— 角色的内心变化、承诺、创伤、');
      lines.push('被忽略的细节 —— 用下面这个标签沉淀，下一轮脚本会按相关度自动召回给你：');
      lines.push('');
      lines.push('\u0060\u0060\u0060xml');
      lines.push('<character_memory name="⟨角色名⟩">');
      lines.push('【感知】他看到的、听到的、闻到的具体细节');
      lines.push('【情绪】情绪(强度)｜身体反应');
      lines.push('【意图】他打算做什么，或者忍住没做什么');
      lines.push('【记忆锚点】一个以后能被重新想起的具体物象');
      lines.push('</character_memory>');
      lines.push('\u0060\u0060\u0060');
      lines.push('');
      lines.push('规则：**每个在场角色每轮最多一条**；只在这一轮真的留下了什么的时候才写；');
      lines.push('写得越具体越好（"雪地上的三个血点" 比 "她受伤了" 有用得多）。');
      lines.push('');
    }
  }
  lines.push('### 常用属性名（英文别名与中文列名都认）');
  for (const no of [0, 1, 2, 3, 4, 5, 6, 9, 10, 13, 14]) {
    const line = attrHintLine(no);
    if (line) lines.push(line);
  }
  lines.push('');
  lines.push('### 数值变化两种写法');
  lines.push('- 绝对值：`<status name="⟨角色名⟩" hp="120" maxHp="180"/>`');
  lines.push('- 增减：  `<status name="⟨角色名⟩" field="hp" change="-30" reason="左肩中刃"/>`');
  lines.push('- 战斗：  `<skill used="⟨技能名⟩" actor="⟨角色名⟩" target="⟨角色名2⟩" power="7"/>` —— **只写用了什么、对谁、多用力**，伤害与消耗由脚本按公式结算。');
  lines.push('');
  lines.push('### 当前主键清单（写 name 时请照抄，避免同一个人被建两次档）');
  for (const tb of getTables()) {
    if (excludeTables.includes(Number(tb.no))) continue;   // 被排除的表（如表12 大总结）连主键清单都不列
    const rows = store.getRows(tb.no, { create: false });
    if (!rows.length) continue;
    const keys = rows
      .map((r) => tb.keyIdx.map((i) => String(r?.[i] ?? '')).join('|'))
      .filter((s) => s.replace(/\|/g, '').trim() !== '');
    if (keys.length) lines.push(`- 表${tb.no} ${tb.name}：${keys.slice(0, 40).join('、')}`);
  }
  return lines.filter((x) => x !== undefined).join('\n').trim();
}

/**
 * 表格操作指南（主提示词用）= 用户原文 + 脚本生成部分
 * 侧路接管填表时：标签速查与长期记忆两块省掉（填表由侧路做、记忆是独立任务）
 */
function buildTablePromptBase() {
  const skip = (() => {
    try {
      const c = sideApi.config();
      // 只有「侧路真会去填表」时才跳过主提示词的填表段（API 没填就不跳，否则两边都不填）
      return c.enabled !== false && c.skipMainTableSegment !== false && !!c.tasks.fill && sideApi.isUsable();
    } catch { return false; }
  })();
  const guide = buildTablePromptGuide();
  const spec = buildTablePromptSpec({ withTags: !skip, withMemory: !skip });
  return [guide, spec].filter((x) => String(x ?? '').trim()).join('\n\n');
}

/* ------------------------------------------------------------- 表格数据 */

/** 可读表格文本（给人/模型看） */
function buildTableDataPlain({ onlyNonEmpty = true, maxRowsPerTable = 200 } = {}) {
  const out = [];
  for (const t of getTables()) {
    const rows = store.getRows(t.no, { create: false });
    if (onlyNonEmpty && !rows.length) continue;
    out.push(`# 表${t.no} ${t.name}`);
    out.push(t.columns.join(' | '));
    const shown = rows.slice(0, maxRowsPerTable);
    for (const r of shown) {
      out.push(t.columns.map((_, i) => (r?.[i] == null ? '' : String(r[i]))).join(' | '));
    }
    if (rows.length > shown.length) out.push(`…（另有 ${rows.length - shown.length} 行未展示）`);
    out.push('');
  }
  if (!out.length) return '（暂无表格数据）';
  // 长期记忆：与表格分开（表格装现状、记忆装历史），按相关度只注入最相关的一小段
  try {
    /* 【v2.18.0】优先用【预先召回】的缓存（上一轮结束时算好的 ✓ 含在场/焦点 ✓）
     拿不到缓存（比如刚打开聊天/缓存失效）→ recallTextFor 内部会当场同步算一次词面召回 ✓ 不会空手 */
  const mem = (() => {
    try {
      const t = recall.recallTextFor({ maxChars: 5600 });
      if (t && String(t).trim()) return String(t);
    } catch (e) { /* ignore */ }
    return memory.buildMemoryText({ query: recallQuery(), limit: 10, maxChars: 5600 });
  })();
    if (mem) { out.push(''); out.push(mem); }
  } catch (e) { console.warn('[RBQ] 记忆注入失败', e); }
  return out.join('\n');
}

/* ---------------------------------------------------------------- 宏实现 */

export function macroTablePrompt() {
  try { return buildTablePrompt(); } catch (e) {
    console.warn('[RBQ] 生成 tablePrompt 失败', e);
    return '';
  }
}

export function macroTableData() {
  try { return buildTableData(); } catch (e) {
    console.warn('[RBQ] 生成 tableData 失败', e);
    return '';
  }
}

export function macroAllTablesJson() {
  try {
    const json = store.exportPluginJson();
    if (!Object.keys(json).length) return '{}';
    return JSON.stringify(json);
  } catch (e) {
    console.error('[RBQ] 生成 GET_ALL_TABLES_JSON 失败', e);
    return '{}';
  }
}

/** 对外的 {{tablePrompt}} = 基础指南 + 你在设置里开的"额外要求" */
export function buildTablePrompt() {
  const base = buildTablePromptBase();
  try {
    // 默认**不**往里追加任何附加内容：那些各自有独立变量（{{rbq_law}} 等），放哪由你决定
    if (store.getConfigValue('addons.injectIntoTablePrompt', false) !== true) return base;
    const extra = addons.buildAddonText();
    return extra ? `${base}\n\n${extra}` : base;
  } catch (e) {
    console.warn('[RBQ] 额外要求注入失败', e);
    return base;
  }
}

/* ---------------------------------------------------------- 发给 AI 的数据格式 */

const X = (v) => String(v ?? '').trim().replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
const cellOf = (row, i) => X(row?.[i]);
const isEmpty = (row) => !row || !row.some((c) => String(c ?? '').trim());

/**
 * XML 结构化格式（默认）—— 给 AI 看的是"属性化的记录"，不是对齐好的表格。
 * 好处：省 token、层级清楚、模型容易照着写回 <data>；空表直接不出现。
 */
/**
 * 纯机制列：只有"算数值/结算"才用得到，写剧情用不上 → 默认不发给主 AI
 * （填表 AI 仍然拿全量，避免它漏认主键或重复建行）
 * 名字按「英文别名」或「中文列名」任一匹配；可在设置里用 dataFormat.hideColumns 覆盖
 */
export const MECHANICAL_COLUMNS = [
  'growth',            // 四维系数（只用于算属性）
  'load', 'maxLoad',   // 负重 / 负重上限
  'tempMod',           // 临时修正
  'timestamp',         // 更新时间戳
  'mpCost', 'spCost',  // 技能消耗
  'cooldown',          // CD
  'range',             // 波及范围
  'baseDamage',        // 基础伤害/治疗量
  'damageArmor',       // 基础伤害/护甲值
  'volume',            // 碰撞体积
];

function hiddenColumnSet() {
  try {
    const cfg = store.getConfigValue('dataFormat.hideColumns', null);
    const list = Array.isArray(cfg) ? cfg : MECHANICAL_COLUMNS;
    return new Set(list.map((x) => String(x).trim().toLowerCase()));
  } catch { return new Set(MECHANICAL_COLUMNS); }
}

export function buildTableDataXml({ for: who = 'main' } = {}) {
  const rowsOf = (no) => {
    const all = getRows(no, { create: false }) ?? [];
    const t = getTable(no);
    const n = Number(t?.updateConfig?.sendLatestRows ?? 0);
    return n > 0 && all.length > n ? all.slice(all.length - n) : all;
  };

  /** 属性名：用该表的中文列名，但去掉 XML 里不合法的字符（/ ( ) 空格 等） */
  // 属性名只保留「中英文数字下划线」——XML 属性名不允许 / ( ) | : 等字符
  const xmlName = (s) => String(s ?? "").replace(/[^0-9A-Za-z_\u4e00-\u9fa5]/g, "").trim() || "字段";

  /** 一行的属性对：按该表真实列走，空值跳过（不再依赖任何写死的别名清单） */
  const attrsOf = (no, row, skipIdx = [], filter = false) => {
    const cols = getTable(no)?.columns ?? [];
    const out = [];
    const hidden = filter ? hiddenColumnSet() : null;
    cols.forEach((cn, i) => {
      if (skipIdx.includes(i)) return;
      if (hidden) {
        let alias = '';
        try { alias = String(listAttrs(no)?.[i]?.aliases?.[0] ?? '').toLowerCase(); } catch { /* ignore */ }
        if (hidden.has(String(cn).trim().toLowerCase()) || (alias && hidden.has(alias))) return;
      }
      const v = row?.[i];
      if (v == null || String(v).trim() === "") return;
      out.push([xmlName(cn), v]);
    });
    return out;
  };

  const attrsStr = (pairs) => pairs.map(([k, v]) => `${k}="${X(v)}"`).join(" ");
  const out = [];

  const FILTER = who === 'main';
  const w0 = rowsOf(0)[0];
  if (!isEmpty(w0)) out.push(`<world ${attrsStr(attrsOf(0, w0, [], FILTER))}/>`);

  // 角色：表2 档案 + 表13 数值 合成一条（表13 跳过第 0 列的名字，避免重复）
  const t13 = rowsOf(13);
  const byName13 = new Map(t13.map((r) => [String(r?.[0] ?? "").trim(), r]));
  const chars = rowsOf(2).filter((r) => !isEmpty(r));
  if (chars.length) {
    out.push("<characters>");
    for (const c of chars) {
      const nm = String(c?.[0] ?? "").trim();
      const v13 = byName13.get(nm) ?? [];
      const pairs = [...attrsOf(2, c, [], FILTER), ...attrsOf(13, v13, [0], FILTER)];
      out.push(`  <c ${attrsStr(pairs)}/>`);
    }
    out.push("</characters>");
  }

  const simple = (no, tag) => {
    const list = rowsOf(no).filter((r) => !isEmpty(r));
    if (!list.length) return;
    out.push(`<${tag}s>`);
    for (const r of list) out.push(`  <${tag} ${attrsStr(attrsOf(no, r, [], FILTER))}/>`);
    out.push(`</${tag}s>`);
  };
  simple(5, "r");
  simple(7, "q");
  simple(1, "l");
  simple(9, "i");
  simple(8, "b");
  simple(10, "sk");
  // 怪物：去掉已击败/逃跑的（按"状态"列判断，取不到就不筛）
  const mRows = rowsOf(14).filter((r) => !isEmpty(r));
  if (mRows.length) {
    const cols14 = getTable(14)?.columns ?? [];
    const stIdx = (() => { try { const r = resolveAttr(14, "状态"); return r?.index ?? -1; } catch { return -1; } })();
    const alive = mRows.filter((r) => stIdx < 0 || !/defeated|fled|despawned|已击败|已逃跑|已消失/i.test(String(r?.[stIdx] ?? "")));
    if (alive.length) {
      out.push("<ms>");
      for (const r of alive) out.push(`  <m ${attrsStr(attrsOf(14, r, [], FILTER))}/>`);
      out.push("</ms>");
    }
    void cols14;
  }
  simple(11, "f");
  simple(12, "e");

  const p6 = rowsOf(6)[0];
  if (!isEmpty(p6)) out.push(`<plot ${attrsStr(attrsOf(6, p6, [], FILTER))}/>`);

  const d4 = rowsOf(4).filter((r) => !isEmpty(r));
  if (d4.length) {
    out.push("<states>");
    for (const r of d4) out.push(`  <s ${attrsStr(attrsOf(4, r, [], FILTER))}/>`);
    out.push("</states>");
  }

  /* 【v2.18.0】大总结做成变量给主 AI 用（预设里可写 {{getglobalvar::bigSummaryText}}）*/
  try {
    const __dg = summary.digestText ? summary.digestText({ limit: (() => {
  try { const v = Number(SillyTavern.getContext()?.variables?.global?.get?.('memoryRecallBigSummaryMax')); return Number.isFinite(v) && v > 0 ? v : 0; } catch (e) { return 0; }
})(), maxChars: 3600 }) : null;
    extras.writeVar("bigSummaryText", String((__dg && __dg.text) || ""), "global");
  } catch (e) { /* ignore */ }
  const recent = (() => { try { return store.getConfigValue("summary.injectRecent", false) ? summary.recentText({ limit: 5, maxChars: 900 }) : ""; } catch { return ""; } })();
  /* 【用户要求】表格真的是空的时候，不要硬塞一份“假的当前数据”（那会凭空给 AI 时间/地点限制 ✗）
     改成明确告诉它"现在是初始阶段、没有任何记录，请按设定自由发挥" ✓ */
  if (!out.length) {
    return [
      "# 当前剧情数据",
      "【数据库为空】当前处于初始阶段，表格里还没有任何记录 —— 不要假设任何时间、地点、天气或在场角色，",
      "完全按角色卡 / 世界书 / 预设里的设定来写这一轮剧情。",
      // 【用户要求】不要再对"写剧情的 AI"提 <data> 建档 ✗ —— 填表是侧路 API 的活 ✓
    ].join("\n") + (recent ? "\n\n" + recent : "");
  }
  const mem = (() => { try { return memory.buildMemoryText({ query: recallQuery(), limit: 10, maxChars: 1200 }); } catch { return ""; } })();
  const head = FILTER ? '# 当前剧情数据' : '';
  return (head ? head + "\n" : '') + `<runtime_data>\n${out.join("\n")}\n</runtime_data>` + (mem ? `\n\n${mem}` : "") + (recent ? `\n\n${recent}` : "");
}export function buildTableDataTable() {
  return buildTableDataPlain();
}

/**
 * 对外统一的 {{tableData}}：按设置里的 dataFormat.mode 分发。
 *   xml（默认）结构化、省 token、方便模型照着写 <data>
 *   table      可读对齐表格（对齐旧版观感）
 *   json       旧记忆增强表格插件的原始 JSON（给需要它的脚本/其他插件用）
 */
export function buildTableData() {
  const mode = store.getConfigValue('dataFormat.mode', 'xml');
  try {
    if (mode === 'json') return JSON.stringify(store.exportPluginJson());
    if (mode === 'table') return buildTableDataTable();
    return buildTableDataXml();
  } catch (e) {
    console.warn('[RBQ] tableData 生成失败，退回表格格式', e);
    return buildTableDataTable();
  }
}

export const DATA_FORMATS = [
  ['xml', 'XML 结构化（推荐，省 token 且模型好写回）'],
  ['table', '可读表格（旧版观感）'],
  ['json', '原始 JSON（兼容记忆增强表格插件）'],
];

export { TAG_TABLE };

/** 每张表要写什么：列名 + 截短含义（一行一张表） */
export function columnsHint(opts) {
  const maxCols = (opts && opts.maxCols) || 10;
  const maxNote = (opts && opts.maxNote) || 24;
  try {
    const out = [];
    for (const t2 of getTables()) {
      const note = String((t2 && t2.note) || "");
      const defs = [];
      const re = /-\s*\d+\s*[:：]\s*([^：:\n]+)[:：]\s*([^\n]*)/g;
      let m = re.exec(note);
      while (m) {
        const name = String(m[1] || "").trim();
        let desc = String(m[2] || "").trim().replace(/[（(][^)）]*[)）]/g, "").trim();
        if (desc.length > maxNote) desc = desc.slice(0, maxNote) + "…";
        if (name) defs.push(name + (desc ? "（" + desc + "）" : ""));
        if (defs.length >= maxCols) break;
        m = re.exec(note);
      }
      if (defs.length) out.push("- 表" + t2.no + "「" + t2.name + "」：" + defs.join(" "));
    }
    if (!out.length) return "";
    return "#### 每张表要写什么（列的简短含义）" + String.fromCharCode(10) + out.join(String.fromCharCode(10));
  } catch (e) { return ""; }
}

/**
 * 注解版嵌套写法示例：把"每一项对应哪一列、该怎么写"直接标在示例里。
 * 说明取自各表 note 的【列定义】，形状取自 protocol.js 的 EXTRA_TAG_ALIAS。
 */
export function dataWriteSpec(opts) {
  const maxCols = (opts && opts.maxCols) || 12;
  const maxNote = (opts && opts.maxNote) || 20;
  const SHAPES = [
    [0, "world", "init", null],
    [1, "location", "new", null],
    [2, "character", "new", "basic"],
    [3, "physique", "new", "appearance"],
    [4, "state", "update", null],
    [5, "relation", "new", null],
    [9, "item", "new", null],
    [10, "skill_def", "new", null],
    [13, "status", "update", null],
    [14, "monster", "new", null],
    [6, "plot", "update", null],
    [7, "task", "new", null],
    [8, "buff", "new", null],
    [11, "faction", "new", null],
    [12, "epoch", "new", null],
  ];
  try {
    const HASH = String.fromCharCode(35);
    const L = String.fromCharCode(10);
    const out = [];
    out.push("### 怎么写 <data>（每一项都标了它对应哪一列）");
    out.push("<data>");
    for (const [no, tag, mode, group] of SHAPES) {
      const tb = getTables().find((x) => Number(x.no) === no);
      if (!tb) continue;
      const note = String(tb.note || "");
      /* 该表真正的列（本表的列清单）—— 别名表里混进来的别的表的列一律不出现 */
      const colSet = new Set((tb.columns ?? []).map((c) => String(c)));
      const kids = [];
      const re = /-\s*\d+\s*[:：]\s*([^：:\n]+)[:：]\s*([^\n]*)/g;
      let m = re.exec(note);
      while (m) {
        const col = String(m[1] || "").trim();
        let desc = String(m[2] || "").trim();
        if (desc.length > maxNote) desc = desc.slice(0, maxNote) + "…";
        if (col) kids.push({ col: col, desc: desc });
        if (kids.length >= maxCols) break;
        m = re.exec(note);
      }
      if (!kids.length) continue;
      const tagOpen = group ? ("  <" + group + ">") : null;
      out.push("  <" + tag + (mode ? (" mode=\"" + mode + "\"") : "") + (no === 2 || no === 13 || no === 4 || no === 5 || no === 9 || no === 14 ? "" : "") + ">");
      if (tagOpen) out.push(tagOpen);
      const pad = group ? "    " : "  ";
      for (const k of kids) {
        const key = k.col.replace(/[^0-9A-Za-z_\u4e00-\u9fff]/g, "");
        out.push(pad + "<" + key + ">⟨" + k.col + "：" + (k.desc || "按列说明填") + "⟩</" + key + ">");
        out.push(pad + HASH + " 表" + no + "「" + k.col + "」：" + (k.desc || "按列说明填"));
      }
      if (tagOpen) out.push("  </" + group + ">");
      out.push("  </" + tag + ">");
      out.push("");
    }
    out.push("</data>");
    out.push("取值只用上面这些字段，列名照抄；没有的字段不要编。");
    return out.join(L);
  } catch (e) { return ""; }
}

/**
 * 注解版嵌套示例 v2：用英文子标签 + value="…"，每一项后面一行 # 表N「列名」：怎么填
 * 形状取自 protocol.js 导出的 EXTRA_TAG_ALIAS（与解析器同源，不会对不上）。
 */
export function dataWriteSpecV2(opts) {
  const maxCols = (opts && opts.maxCols) || 12;
  const maxNote = (opts && opts.maxNote) || 80;   // 22 太短，定义等于没给
  const SHAPES = [
    [0, "world", "init", null],
    [1, "location", "new", null],
    [2, "character", "new", "basic"],
    [3, "physique", "new", "appearance"],
    [4, "state", "update", null],
    [5, "relation", "new", null],
    [9, "item", "new", null],
    [10, "skill_def", "new", null],
    [13, "status", "update", null],
    [14, "monster", "new", null],
  ];
  try {
    const HASH = String.fromCharCode(35);
    const L = String.fromCharCode(10);
    const Q = String.fromCharCode(34);
    const AL = (typeof EXTRA_TAG_ALIAS !== "undefined" && EXTRA_TAG_ALIAS) || null;
    const out = [];
    out.push("### 怎么写 <data>（每个字段后面那行就是它对应哪一列、该怎么填）");
    out.push("<data>");
    for (const [no, tag, mode, group] of SHAPES) {
      const tb = getTables().find((x) => Number(x.no) === no);
      if (!tb) continue;
      const map = (AL && AL[no]) || null;
      if (!map) continue;
      const note = String(tb.note || "");
      const descOf = (col) => {
        const i = note.indexOf(col);
        if (i < 0) return "";
        const rest = note.slice(i);
        const mc = rest.match(/^[^：:\n]*[:：]\s*([^\n]*)/);
        let d = mc ? String(mc[1]).trim() : "";
        d = d.replace(/^[-—\s]+/, "");
        d = d.replace(/<%[-=]?[\s\S]*?%>/g, "").replace(/\{\{[^}]*\}\}/g, "").replace(/\s+/g, " ").trim();   // 模板块/宏一律去掉
        if (d.length > maxNote) d = d.slice(0, maxNote) + "…";
        return d;
      };
      const pad = group ? "    " : "  ";
      out.push("  <" + tag + (mode ? (" mode=" + Q + mode + Q) : "") + ">");
      if (group) out.push("    <" + group + ">");
      let n = 0;
      const usedCols = {};
      for (const child of Object.keys(map)) {
        const col = map[child];
        if (!colSet.has(String(col))) continue;   // ← 不属于本表的列不出现（原来 表0 块里混着 表6 的列 ✗）
        if (usedCols[col]) continue;              // 同一列只留一个标签，避免重复
        usedCols[col] = true;
        const d = descOf(col);
        out.push(pad + "<" + child + " value=" + Q + "⟨" + col + "⟩" + Q + "/>");
        // 同上：AI 看不到表格，"表N「列名」"这种前缀没用，只给"该怎么填"
        out.push(pad + HASH + " " + (d || "按本列语义填"));
        n++;
        if (n >= maxCols) break;
      }
      if (group) out.push("    </" + group + ">");
      out.push("  </" + tag + ">");
      out.push("");
    }
    out.push("</data>");
    out.push("只能用上面出现过的字段名（照抄英文），值写在 value 里；没有的字段不要编。");
    return out.join(L);
  } catch (e) { return ""; }
}
