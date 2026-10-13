/**
 * memory.js —— 记忆系统（这是"让 AI 记住更多"的核心，不是表格的附属）
 *
 * 为什么要单独一套：
 *   表格解决的是"当前状态"（现在在哪、HP 多少、谁对谁什么关系）；
 *   但"三个月前慕容雪在雪地里说过什么"这种**跨轮次的长期记忆**表格装不下，
 *   硬塞进表格会把表格撑爆、反而污染当前状态。
 *   所以：表格 = 现状，记忆 = 历史，两者分开存、分别注入。
 *
 * 数据流：
 *   AI 输出 <character_memory name="X">【感知】…【情绪】…【意图】…【记忆锚点】…</character_memory>
 *     ↓ 解析成结构化条目，挂到该角色名下（含轮次、时间）
 *     ↓ 下一轮按"相关度"召回（词面重合 + 时间衰减 + 重要度）
 *     ↓ 只把最相关的几条拼成一小段文本，塞进 {{tableData}} 末尾
 *
 * 没有 embedding 时的召回策略（诚实说明）：纯词面（字符二元组 Jaccard）+ 时间衰减 + 重要度加成。
 * 若将来接上向量，只要替换 score() 即可。
 */

import * as store from './store.js';
import * as extras from './extras.js';
import * as summaryStore from './summary.js';
import { chat, notify, ctx } from './ctx.js';
import { clone } from './util.js';

const MAX_PER_CHAR = 0   // 0 = 不限制（默认全部保存）;        // 每个角色最多留多少条
const FIELDS = ['感知', '情绪', '意图', '记忆锚点', '关联与影响', '台词'];

/* ------------------------------------------------------------------ 存取 */

function profile() {
  const d = store.getData();
  if (!d.memories || typeof d.memories !== 'object') d.memories = {};
  return d.memories;
}

export function allMemories() { return profile(); }

export function memoriesOf(name) {
  return profile()[String(name ?? '')] ?? [];
}

export function stats() {
  const m = profile();
  const chars = Object.keys(m);
  return {
    characters: chars.length,
    total: chars.reduce((n, k) => n + (m[k]?.length ?? 0), 0),
    byChar: chars.map((k) => ({ name: k, count: m[k].length, latest: m[k][m[k].length - 1]?.at ?? 0 }))
      .sort((a, b) => b.count - a.count),
  };
}

/* ---------------------------------------------------------------- 解析 */

/**
 * 从 <character_memory> 的正文里抽出【字段】内容。
 * 用分割法而不是正则：字段名任意、不会因为转义写错而整个模块挂掉。
 */
export function parseMemoryBody(text) {
  const src = String(text ?? '');
  const out = {};
  // 以「【字段名】」为分隔切成若干段：偶数位是内容，奇数位是字段名
  const parts = src.split(/[【\[]\s*([^】\]]+?)\s*[】\]]/);
  for (let i = 1; i < parts.length; i += 2) {
    const key = String(parts[i] ?? '').trim();
    const val = String(parts[i + 1] ?? '').trim().replace(/\s+/g, ' ');
    if (key && val) out[key] = val;
  }
  if (!Object.keys(out).length && src.trim()) out['感知'] = src.trim().replace(/\s+/g, ' ');
  return out;
}

/**
 * 解析一条 <character_memory> 事实。
 * @returns {{name:string, fields:object, raw:string}|null}
 */
export function parseMemoryFact(fact) {
  if (!fact) return null;
  const name = String(fact.attrs?.name ?? fact.attrs?.who ?? fact.attrs?.角色 ?? '').trim();
  const body = String(fact.text ?? '').trim() || String(fact.attrs?.text ?? '').trim();
  if (!name || !body) return null;
  return { name, fields: parseMemoryBody(body), raw: body };
}

/* ---------------------------------------------------------------- 写入 */

/** 当前轮次（用表0 的系统轮次，取不到就用 rev） */
function currentRound() {
  try {
    const t0 = store.getTable?.(0) ?? null;
    void t0;
    const rows = store.getRows(0, { create: false });
    const v = rows?.[0]?.[0];
    const n = Number(String(v ?? '').replace(/[^\d]/g, ''));
    if (Number.isFinite(n) && n > 0) return n;
  } catch { /* ignore */ }
  // 兜底：一轮 = 用户楼层 + AI 楼层，所以是楼层数 ÷ 2（和系统轮次口径一致）
  try { const n = Math.floor(Number(store.chatLength?.() ?? 0) / 2); if (n > 0) return n; } catch { /* ignore */ }
  return Math.max(1, Number(store.getRev?.() ?? 1) || 1);
}

/**
 * 写入一批记忆（去重：同角色 + 相同正文不重复记）。
 * @returns {{added:number, characters:string[]}}
 */
/* 【用户要求】记忆条目上带"这一轮的表0时间框" ✓（不再记真实时钟 ✓）
   取值由外部注入（index.js 接 extras.timeBoxText ✓）→ 避免和 extras.js 循环依赖 ✓ */
let __timeBoxProvider = null;
export function setTimeBoxProvider(fn) { __timeBoxProvider = (typeof fn === "function") ? fn : null; }
/** 当前时间框文字（拿不到就返回空串 ✓） */
export function currentTimeBox() {
  try { const v = __timeBoxProvider ? __timeBoxProvider() : ""; return String(v ?? "").trim(); } catch (e) { return ""; }
}
/**
 * 【用户要求】等"这一轮所有角色记忆 + 最新表格数据"都落定后，把这轮记忆的时间统一改成最新表0时间 ✓
 *   （记忆是在填表之后才写的 ✓ 但收口/补写可能又动了表0 → 所以最后再回填一次最准 ✓）
 */
export function stampRoundTime(round, timeText) {
  const t = String(timeText ?? "").trim();
  if (!t) return 0;
  const mem = profile();
  let n = 0;
  for (const name of Object.keys(mem)) {
    for (const e of (Array.isArray(mem[name]) ? mem[name] : [])) {
      if (round !== undefined && round !== null && Number(e.round) !== Number(round)) continue;
      if (e.t === t) continue;
      e.t = t; n++;
    }
  }
  return n;
}

export function addMemories(items, msgId) {
  const mem = profile();
  let added = 0;
  const chars = new Set();
  const round = currentRound();
  const msgCount = chat().length;

  for (const it of items ?? []) {
    const name = String(it?.name ?? '').trim();
    if (!name) continue;
    const raw = String(it.raw ?? it.text ?? '').trim();
    if (!raw) continue;
    if (!mem[name]) mem[name] = [];
    let list = mem[name];
    // 同一条消息重新生成 → 先清掉它上一次写的记忆（否则会叠加）
    if (msgId !== undefined && msgId !== null) {
      const kept = list.filter((x) => String(x.msgId ?? "") !== String(msgId));
      if (kept.length !== list.length) { mem[name] = kept; list = kept; }
    }
    // 去重：同一条正文（前 40 字）已有则跳过
    const sig = raw.slice(0, 40);
    if (list.some((x) => String(x.raw ?? '').slice(0, 40) === sig)) continue;
    list.push({
      id: `m${round}_${list.length}_${Math.random().toString(36).slice(2, 6)}`,
      at: Date.now(),          // 真实写入时刻（内部用，界面不再显示它 ✓）
      t: currentTimeBox(),     // 【用户要求】这一轮的表0时间框（跟时间框同格式 ✓）
      round,
      msgCount,
      msgId: msgId === undefined ? null : msgId,
      fields: it.fields ?? parseMemoryBody(raw),
      raw,
      important: /重要|关键|永远|铭记|誓言/.test(raw),
    });
    added++;
    chars.add(name);
  }
  return { added, characters: [...chars] };
}

/** 从 unparsed 事实里收记忆（给 rules/expandFacts 调用） */
export function collectFromFacts(unparsed) {
  const items = [];
  for (const f of unparsed ?? []) {
    if (f.tag !== 'character_memory' && f.tag !== 'memory') continue;
    const p = parseMemoryFact(f);
    if (p) items.push(p);
  }
  const r = addMemories(items);
  return { ...r, items };
}

/** 删掉某一层消息写入的全部记忆（重新生成/回滚时用） */
export function removeByMsgId(msgId) {
  try {
    const store0 = profile();
    let n = 0;
    for (const name of Object.keys(store0 ?? {})) {
      const list = Array.isArray(store0[name]) ? store0[name] : [];
      const kept = list.filter((x) => String(x?.msgId ?? "") !== String(msgId));
      n += list.length - kept.length;
      store0[name] = kept;
      if (!kept.length) delete store0[name];
    }
    if (n) { try { save(); } catch (e) { /* ignore */ } console.log("[RBQ] 已回滚该层的记忆 " + n + " 条（msgId=" + msgId + "）"); }
    return n;
  } catch (e) { console.warn("[RBQ] 回滚记忆失败", e); return 0; }
}

export function removeMemory(name, id) {
  const mem = profile();
  const list = mem[String(name ?? '')];
  if (!Array.isArray(list)) return false;
  const i = list.findIndex((x) => x.id === id);
  if (i < 0) return false;
  list.splice(i, 1);
  return true;
}

export function clearCharacter(name) {
  const mem = profile();
  if (!mem[String(name ?? '')]) return false;
  delete mem[String(name ?? '')];
  return true;
}

export function clearAll() {
  const d = store.getData();
  d.memories = {};
  return true;
}

/* ---------------------------------------------------------------- 召回 */

/** 字符二元组 */
function bigrams(s) {
  const t = String(s ?? '').replace(/[\s\p{P}]/gu, '');
  const out = new Set();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  if (t.length === 1) out.add(t);
  return out;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * 相关度打分。
 *   0.55 × 词面重合 + 0.30 × 时间新鲜度 + 0.15 × 重要度
 */

/* --------------------------------------------------- 智脑式关键字召回（免费路径） */

/**
 * 提取关键词：按标点切块，长度 ≥2 保留；≥4 字的块再补 2-3 字滑窗子串。
 * 目的：解决"AI 造的复合词（腥臭爱液）在自然对话里只出现片段（爱液）"的问题。
 */
export function keywordsOf(text) {
  const s = String(text ?? '').replace(/[\[\]【】()（）「」『』《》<>]/g, ' ');
  const chunks = s.split(/[，。！？；、,.!?;:\s\|\/—\-…~～]+/).map((x) => x.trim()).filter(Boolean);
  const out = new Set();
  for (const c of chunks) {
    if (c.length < 2) continue;
    out.add(c);
    if (c.length >= 4) {
      for (let n = 2; n <= 3; n++) for (let i = 0; i + n <= c.length; i++) out.add(c.slice(i, i + n));
    }
  }
  return [...out];
}

/** 关键词命中：正向（关键词或其滑窗出现在查询里）或反向（查询的连续词块被关键词包含） */
const STOP_CHARS = new Set('的了是我你他她它在和就都也很还这那有个不没吗呢吧啊哦嗯一'.split(''));

export function hitTest(keyword, query) {
  const k = String(keyword);
  const q = String(query);
  if (!k || !q) return 0;
  if (q.includes(k)) return 1;                       // 正向：整词出现
  if (k.length >= 4) {
    for (let i = 0; i + 2 <= k.length; i++) if (q.includes(k.slice(i, i + 2))) return 0.6;   // 关键词自身的滑窗
  }
  // 反向：用户输入里的"连续词块"（按标点/空格切出来的一段）只要被关键词包含就命中。
  // 照智脑的原话："用户输入中的连续词块只要被关键词包含即命中"，例如用户就说了"蛊" → 命中"月光蛊"。
  // 注意：不从长句里逐字挑单字（那会被"今天天气不错"里的"气"命中"…的气味"，噪音太大）。
  for (const chunk of q.split(/[，。！？；、,.!?;:\s"'“”（）()【】\[\]]+/)) {
    const c = chunk.trim();
    if (!c) continue;
    if (c.length >= 2) { if (k.includes(c)) return 0.8; }
    else if (!STOP_CHARS.has(c) && k.includes(c)) return 0.35;
  }
  return 0;
}

/** 一条记忆 vs 查询：匹配质量 / 命中密度 */
export function matchOf(entryText, query) {
  const kws = keywordsOf(entryText);
  if (!kws.length) return { quality: 0, density: 0, hits: 0, total: 0 };
  let sum = 0;
  let hits = 0;
  let best = 0;
  for (const k of kws) { const h = hitTest(k, query); if (h > 0) { hits++; sum += h; if (h > best) best = h; } }
  return { quality: sum / kws.length, density: hits / kws.length, hits, total: kws.length, best };
}
/** 一条记忆的可比文本（关键字匹配与向量化都用它） */
export function textOf(entry) {
  return [
    entry?.raw,
    entry?.fields?.['感知'], entry?.fields?.['情绪'], entry?.fields?.['意图'],
    entry?.fields?.['记忆锚点'], entry?.fields?.['关键词'],
  ].filter(Boolean).join('｜');
}

/** 相关性分解：关键字匹配质量 + 向量相似度（用于"毫不相关就别召回"的过滤） */
export function relevanceOf(entry, query) {
  const mt = matchOf(textOf(entry), String(query ?? ''));
  return { quality: mt.quality, hits: mt.hits, best: mt.best ?? 0 };
}

export function score(entry, queryInfo, { now = chat().length, vectorWeight = 0.6, character = null, cast = [] } = {}) {
  // 纯关键字召回（关键词滑窗 + 词块反向命中），不依赖任何外部 API
  const qtext = typeof queryInfo === 'string' ? queryInfo : (queryInfo?.text ?? '');
  const qg = queryInfo && typeof queryInfo === 'object' && queryInfo.grams ? queryInfo.grams : queryInfo;
  const text = textOf(entry);
  const lex = jaccard(bigrams(text), qg && qg.size ? qg : bigrams(qtext));
  // ① 匹配质量（关键字正向 + 用户侧反向 + 滑窗，占 0.50）
  const mt = matchOf(text, qtext);
  // ② 时间衰减（0.10）
  const age = Math.max(0, now - (entry?.msgCount ?? now));
  const recency = 1 / (1 + age / 40);
  // ③ 命中密度（0.15）
  const density = mt.density;
  // ④ 角色重叠（0.15）：这条属于谁 / 查询里有没有提他
  const charHit = character && (qtext.includes(character) || (cast ?? []).includes(character)) ? 1 : 0;
  // ⑤ 事件重要度（0.10）
  const imp = entry?.important ? 1 : 0.3;
  // 关键字一个都没命中时，用词面重合兜底（免得什么都召回不到）
  const quality = mt.quality > 0 ? mt.quality : lex * 0.6;
  return 0.50 * quality + 0.10 * recency + 0.15 * density + 0.15 * charHit + 0.10 * imp;
}

/**
 * 召回最相关的记忆。
 * @param {object} opts
 * @param {string[]} [opts.names] 只在这些角色里找（缺省=全部）
 * @param {string}   [opts.query] 当前上下文（通常是最近一条用户输入 + 上一轮正文尾部）
 * @param {number}   [opts.limit=8]
 * @param {number}   [opts.minScore=0.12]
 * @returns {Array<{name:string, entry:object, score:number}>}
 */
export function recall({ names = null, query = '', limit = 8, minScore = 0.12 } = {}) {
  const mem = profile();
  const qg = bigrams(query);
  const now = chat().length;
  const out = [];
  const pool = names?.length ? names.filter((n) => mem[n]) : Object.keys(mem);
  // 查询里提到了哪些角色（用于角色重叠打分）
  const cast = (() => {
    try {
      const q = String(query ?? '');
      return Object.keys(mem).filter((n) => q.includes(n));
    } catch { return []; }
  })();
  const qinfo = { text: String(query ?? ''), grams: qg };
  for (const name of pool) {
    for (const e of mem[name] ?? []) {
      const s = score(e, qinfo, { now, character: name, cast });
      if (s < minScore) continue;
      // 毫不相关就别召回：关键字几乎没有命中的直接丢掉（新鲜度/重要度是固定底分，不能当相关性用）
      const rel = relevanceOf(e, query);
      // 长记忆会被“命中/关键词总数”稀释，所以：比例够 **或** 有一次强命中（≥0.6，整词/词块级）都算相关
      if (rel.quality < 0.10 && (rel.best ?? 0) < 0.6) continue;
      out.push({ name, entry: e, score: s });
    }
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}

/**
 * 一条记忆压成"可读文本"（这就是发给 AI 的格式 ✓）
 *   【用户要求】要像这样带字段名与时间，别挤成一行、别没有标签 ✗：
 *     - 【苏越｜第1轮｜『新历742年-11月04日-星期三-23:15 - 第四码头铁皮屋 - 暴雨/12℃ - 警戒区』】
 *       【感知】…
 *       【情绪】…
 *       【意图】…
 *       【记忆锚点】…
 *   没有解析出字段的老数据 → 退回原始整段（不丢内容 ✓）
 */
export function line(name, e) {
  const f = e.fields ?? {};
  const head = '【' + name + '｜第' + e.round + '轮' + (e.t ? ('｜' + e.t) : '') + '】';
  const pairs = [['感知', f['感知']], ['情绪', f['情绪']], ['意图', f['意图']], ['记忆锚点', f['记忆锚点']]];
  const body = pairs.filter(([, v]) => v).map(([k, v]) => '【' + k + '】' + v).join('\n  ');
  if (!body) return '- ' + head + ' ' + String(e.raw ?? '').trim();
  return '- ' + head + '\n  ' + body;
}

/**
 * 生成要注入提示词的记忆文本（有长度上限，防止把上下文吃光）。
 * @param {{names?:string[], query?:string, limit?:number, maxChars?:number}} opts
 */
export function buildMemoryText({ names = null, query = '', limit = 0, maxChars = 0 } = {}) {
  const gget = (k) => { try { return ctx()?.variables?.global?.get?.(k); } catch { return undefined; } };
  const falsy = (v) => v === false || v === 0 || ['false', '0', 'off', 'no'].includes(String(v ?? '').trim().toLowerCase());
  const rawEnabled = gget('memoryRecallEnabled');
  // 未设置（undefined/null/空串）= 默认开启；只有显式 false/'false'/0/'off'/'no' 才关闭
  const enabled = (rawEnabled === undefined || rawEnabled === null || String(rawEnabled).trim() === '') ? true : !falsy(rawEnabled);
  const rawMax = Number(gget('memoryRecallMaxEntries'));
  const cap = Number.isFinite(rawMax) && rawMax > 0 ? rawMax : 0;

  const writeRecallVars = (text, hits2) => {
    try {
      extras.writeVar('characterMemoriesText', text ?? '', 'chat');
      extras.writeVar('recalledMemorySummary',
        hits2 && hits2.length
          ? [...new Set(hits2.map((h) => h.name))].map((n) => n + '(' + hits2.filter((x) => x.name === n).length + '条)').join('、')
          : '未启用或无人召回', 'chat');
      extras.writeVar('characterMemories', JSON.stringify(profile()), 'chat');
    } catch { /* ignore */ }
  };
  if (!enabled) { writeRecallVars('', []); return ''; }

  const hits = recall({ names, query, limit: cap > 0 ? cap : 9999 });
  const evs = (() => { try { return eventsForRecall({ query, limit: 3 }); } catch { return []; } })();
  if (!hits.length && !evs.length) { writeRecallVars('', []); return ''; }

  const lines = [];
  let used = 0;
  for (const h of hits) {
    const l = line(h.name, h.entry);
    if (maxChars > 0 && used + l.length > maxChars) break;
    lines.push(l);
    used += l.length + 1;
  }
  const parts = [];
  if (lines.length) parts.push('## 长期记忆（按相关度召回，供你保持前后一致）', ...lines);
  if (evs.length) {
    parts.push('', '### 相关事件（小总结）');
    for (const e of evs) parts.push('- [第' + e.round + '轮] ' + String(e.text ?? '').split(String.fromCharCode(10)).join('；').slice(0, 160));
  }
  const out = parts.join(String.fromCharCode(10));
  writeRecallVars(out, hits);
  return out;
}
export function eventsForRecall({ query = '', limit = 3, minScore = 0.12 } = {}) {
  let events = [];
  try { events = summaryStore.listEvents ? summaryStore.listEvents({ limit: 500 }) : []; } catch { events = []; }
  if (!events.length) return [];
  const q = String(query ?? '');
  const scored = [];
  for (const e of events) {
    const text = String(e.text ?? '');
    if (!text) continue;
    const mt = matchOf(text, q);
    if (mt.quality < minScore) continue;
    scored.push({ round: e.round, text, score: mt.quality });
  }
  scored.sort((a, b) => (b.score - a.score) || (b.round - a.round));
  return scored.slice(0, Math.max(0, Number(limit) || 3));
}

/** 给提示词用的短摘要（不相关时也给一句"有记忆但本轮不相关"的提示） */
export function buildMemoryHint() {
  const s = stats();
  if (!s.total) return '';
  return `（长期记忆库：${s.characters} 个角色 / ${s.total} 条）`;
}

export { clone };
