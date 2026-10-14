/**
 * recall.js —— 【预先召回】把"下一轮主 AI 该带哪些记忆/总结"提前算好并缓存
 *
 * 为什么必须提前（用户硬约束②）：
 *   主提示词里的宏是【同步】展开的，而向量召回要发 HTTP（异步）✗
 *   → 所以在【本轮侧路任务链的最后】（填表/记忆/附加/大总结并发结束 → 记忆补跑 → 这里）算好，
 *     缓存下来；下一轮主 AI 构提示词时同步读缓存即可 ✓
 *   拿不到缓存时（用户急着点发送）→ 退回同步的词面召回 ✓ 绝不卡住 ✓
 *
 * 缓存失效（用户硬约束①）：缓存里记 { rev, msgId, round }
 *   · rev = memory.memRev()（任何记忆写入/删除/清空/回滚都会 +1）
 *   · 删楼层 / 重新生成 → 记忆回滚 → rev 变了 → 缓存【自动失效】✓
 *   · 另外按 msgId/round 双重判据，防止"同一 rev 但换了楼层"
 */
import { chat, ctx } from './ctx.js';
import * as memory from './memory.js';
import * as store from './store.js';
import { getColumns } from './schema.js';
import * as embed from './embed.js';   // v2.18.0 可选向量层

const KEY = 'recallCache';

/** 读/写缓存（放在 chatMetadata.rbqdb 里，跟着聊天走 ✓ 删楼层不会残留到别的聊天）*/
function metaRoot() {
  try {
    const c = ctx();
    const md = c.chatMetadata = c.chatMetadata || {};
    const root = md.rbqdb = md.rbqdb || {};
    return root;
  } catch (e) { return null; }
}
export function readCache() {
  try { const r = metaRoot(); return (r && r[KEY]) || null; } catch (e) { return null; }
}
export function writeCache(obj) {
  try { const r = metaRoot(); if (r) r[KEY] = obj; return true; } catch (e) { return false; }
}
export function clearCache() { try { const r = metaRoot(); if (r) delete r[KEY]; return true; } catch (e) { return false; } }

/** 组装查询串：在场角色 + 当前焦点 + 最近消息尾部（与 prompts.recallQuery 同思路 ✓ 但不依赖它以免循环导入）*/
export function buildQuery() {
  const parts = [];
  try {
    let names = [];
    try { names = (ctx()?.variables?.global?.get?.("rbqPresentNames") || "").toString(); } catch (e) { names = ""; }
    if (!names) {
      try {
        const r0 = (store.getRows(0, { create: false }) || [])[0] || [];
        const i0 = getColumns(0).indexOf("在场实体名单");
        if (i0 >= 0) names = String(r0[i0] || "");
      } catch (e) { /* ignore */ }
    }
    if (names) parts.push("【在场】" + names);
  } catch (e) { /* ignore */ }
  try {
    const r6 = (store.getRows(6, { create: false }) || [])[0] || [];
    const i6 = getColumns(6).indexOf("即时焦点");
    const f = i6 >= 0 ? String(r6[i6] || "").trim() : "";
    if (f) parts.push("【焦点】" + f.slice(0, 120));
  } catch (e) { /* ignore */ }
  try {
    const c = chat(); let tail = "";
    for (let i = c.length - 1; i >= 0 && tail.length < 800; i--) { const m = c[i]; if (m) tail += " " + String(m.mes ?? "").slice(-320); }
    if (tail) parts.push(tail);
  } catch (e) { /* ignore */ }
  return parts.join(" ");
}

/**
 * 跑一次预先召回。opts: { round, msgId, maxChars, limit }
 * @returns {{ok:boolean, reason?:string, count:number, text:string, rev:number, mode:string}}
 */
export function precompute(opts = {}) {
  const out = { ok: false, count: 0, text: "", rev: 0, mode: "lexical" };
  try {
    const round = Number(opts.round) || (chat() || []).length;
    const msgId = opts.msgId;
    const rev = (() => { try { return memory.memRev(); } catch (e) { return 0; } })();
    out.rev = rev;
    const query = buildQuery();
    /* 词面召回（永远可用 ✓ 也是无 key / 超时时的回退 ✓）*/
    const text = (() => { try { return memory.buildMemoryText({ query, limit: opts.limit || 0, maxChars: opts.maxChars || 5600 }) || ""; } catch (e) { return ""; } })();
    const hits = (() => { try { return memory.recall({ query, limit: 9999 }); } catch (e) { return []; } })();
    out.text = text;
    out.count = Array.isArray(hits) ? hits.length : 0;
    out.ok = true;
    writeCache({ rev, msgId: (msgId === undefined ? null : msgId), round, at: Date.now(), mode: out.mode, count: out.count, text });
  } catch (e) { out.reason = String((e && e.message) || e); }
  return out;
}

/**
 * 给主提示词用的同步读取（宏里调它 ✓ 绝不发网络 ✓）
 *   缓存有效 → 返回缓存文本；失效/没有 → 当场算一次词面（同步 ✓ 保证这一轮不空手）
 */
export function recallTextFor({ round = null, maxChars = 5600 } = {}) {
  try {
    const cache = readCache();
    const rev = (() => { try { return memory.memRev(); } catch (e) { return -1; } })();
    const sameRound = (round === null || round === undefined) ? true : (Number(cache && cache.round) === Number(round));
    if (cache && cache.text !== undefined && Number(cache.rev) === Number(rev) && sameRound) {
      return String(cache.text || "");
    }
    /* 失效 → 同步兜底（词面）✓ 并顺手刷新缓存 */
    const r = precompute({ round: (round === null || round === undefined) ? undefined : round, maxChars });
    return r.text || "";
  } catch (e) { return ""; }
}

/**
 * 【纯函数】把词面命中与向量分混排（便于单测 ✓ 不发网络）
 *   hits：memory.recall() 的结果（含 {name, entry, score}）
 *   vectorScores：Map<指纹, 余弦> 或 Map<名字+文本, 余弦>；这里按 entry 文本指纹匹配
 *   opts：{ threshold, topK, lexWeight }
 *   行为：先按 blend(词面, 向量) 重排；再把"只在向量里、分数过阈值"的补进来 ✓
 * @returns {{list:any[], used:number, added:number}}
 */
export function rankBlended(hits, vectorScores, opts = {}) {
  const lexWeight = Number.isFinite(Number(opts.lexWeight)) ? Number(opts.lexWeight) : 0.5;
  const threshold = Number.isFinite(Number(opts.threshold)) ? Number(opts.threshold) : 0.35;
  const topK = Number(opts.topK) > 0 ? Number(opts.topK) : 20;
  const list = Array.isArray(hits) ? hits.slice() : [];
  const map = vectorScores instanceof Map ? vectorScores : new Map();
  const fpOf = (h) => { try { return fp(h && h.entry); } catch (e) { return ""; } };
  const cosOf = (h) => { const k = fpOf(h); return (k && map.has(k)) ? Number(map.get(k)) || 0 : 0; };
  const scored = list.map((h) => ({ h, lex: Number(h.score) || 0, cos: cosOf(h) }));
  for (const s of scored) s.final = blendLocal(s.lex, s.cos, lexWeight);
  scored.sort((a, b) => b.final - a.final);
  /* 向量独有的条目：词面分 0 但余弦过阈值 → 补进来 */
  if (map.size) {
    const have = new Set(list.map((h) => fpOf(h)));
    for (const [k, v] of map.entries()) {
      if (have.has(k)) continue;
      const cos = Number(v) || 0;
      if (cos < threshold) continue;
      scored.push({ h: { name: "", entry: null, score: 0, __fp: k }, lex: 0, cos, final: blendLocal(0, cos, lexWeight) });
    }
    scored.sort((a, b) => b.final - a.final);
  }
  const cut = scored.slice(0, topK);
  const added = cut.filter((s) => s.lex === 0 && s.cos > 0).length;
  return { list: cut, used: cut.length, added };
}
function blendLocal(l, v, w) {
  const a = Math.max(0, Math.min(1, Number(l) || 0));
  const b = Math.max(0, Math.min(1, Number(v) || 0));
  return a * w + b * (1 - w);
}
function fp(entry) {
  try { const t = memory.textOf(entry); let h1 = 2166136261 >>> 0; const s = String(t ?? ""); for (let i = 0; i < s.length; i++) { h1 ^= s.charCodeAt(i); h1 = Math.imul(h1, 16777619) >>> 0; } return h1.toString(36) + ":" + s.length.toString(36); } catch (e) { return ""; }
}

/**
 * 异步版预先召回：有向量就用【词面 × 向量】混排，没有就退回词面（默认路径）
 *   用户要求：无 key / 超时 / 索引为空 → 一律回退词面 ✓ 绝不卡住 ✓
 * @returns {{ok:boolean, count:number, text:string, rev:number, mode:string, reason?:string}}
 */
export async function precomputeAsync(opts = {}) {
  const base = precompute(opts);
  try {
    if (!embed.available()) return Object.assign(base, { mode: "lexical", reason: "未配置向量（回退词面）" });
    const query = buildQuery();
    const hits = (() => { try { return memory.recall({ query, limit: 9999 }) || []; } catch (e) { return []; } })();
    const cfg = embed.config();
    const vs = await embed.queryScores(query, hits, {});
    if (!vs.ok) return Object.assign(base, { mode: "lexical", reason: vs.error || "向量不可用（回退词面）" });
    let ranked = rankBlended(hits, vs.scores, { threshold: cfg.threshold, topK: cfg.topK, lexWeight: 0.5 });
    /* 【v2.23.0】rerank 精排：对已经混排出来的候选再按 query 精排一次 ✓ 失败就保持原序 ✓ */
    try {
      if (embed.rerankAvailable && embed.rerankAvailable() && ranked.list.length > 1) {
        const docs = ranked.list.map((s) => { try { return String(memory.textOf(s.h && s.h.entry) || ''); } catch (e) { return ''; } });
        const order = await embed.rerank(query, docs, {});
        if (order && order.length) {
          ranked = { list: order.map((i) => ranked.list[i]).filter(Boolean), used: ranked.list.length, added: ranked.added };
          console.log('[RBQ] rerank 精排完成：' + docs.length + ' 条候选已按相关度重排');
        }
      }
    } catch (e) { console.warn('[RBQ] rerank 跳过：' + String((e && e.message) || e)); }
    /* 用混排后的顺序生成文本（复用 memory 的渲染与每人保底配额 ✓）*/
    const picked = [];
    for (const s of ranked.list) { if (s.h && s.h.entry) picked.push({ name: s.h.name, entry: s.h.entry }); }
    const lines = picked.map((p) => { try { return memory.line(p.name, p.entry); } catch (e) { return ""; } }).filter(Boolean);
    const text = lines.length ? ("## 长期记忆（语义 + 相关度召回，供你保持前后一致）" + String.fromCharCode(10) + lines.join(String.fromCharCode(10))) : base.text;
    const round = Number(opts.round) || (chat() || []).length;
    const rev = (() => { try { return memory.memRev(); } catch (e) { return 0; } })();
    writeCache({ rev, msgId: (opts.msgId === undefined ? null : opts.msgId), round, at: Date.now(), mode: "vector", count: picked.length, text });
    return { ok: true, count: picked.length, text, rev, mode: "vector" };
  } catch (e) { return Object.assign(base, { mode: "lexical", reason: String((e && e.message) || e) }); }
}

/** 缓存是否还有效（面板/卡片显示用 ✓ 不产生副作用）*/
export function cacheStatus() {
  try {
    const cache = readCache();
    if (!cache) return { valid: false, reason: "还没有缓存" };
    const rev = memory.memRev();
    if (Number(cache.rev) !== Number(rev)) return { valid: false, reason: "记忆变了（第 " + cache.rev + " → " + rev + " 版）" };
    return { valid: true, reason: "有效", count: Number(cache.count) || 0, at: cache.at };
  } catch (e) { return { valid: false, reason: String((e && e.message) || e) }; }
}
