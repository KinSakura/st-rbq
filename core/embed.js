/**
 * embed.js —— 可选向量层（默认关闭；没配好一律回退词面召回）
 *   配置存在 extensionSettings.rbqdb.config 里：
 *     embed.url        embedding 接口（填到 /v1 即可，插件自己加 /embeddings）
 *     embed.key        Key（可空：空则视为未启用）
 *     embed.model      模型名
 *     embed.dimensions 维度（0 = 用接口返回的原生维度）
 *     embed.threshold  相似度阈值（默认 0.35）
 *     embed.topK       最多取几条（默认 20）
 *     embed.via        server / direct（与侧路同一套语义，默认 server）
 *   向量存 chatMetadata.rbqdb.embedIndex = { model, dim, items: { <指纹>: { v:[], name, text, round } } }
 *   指纹 = 文本 + 模型的短哈希 → 文本没变就不重复花钱 ✓
 */
import { chat, ctx } from './ctx.js';
import * as memory from './memory.js';
import * as store from './store.js';

export const DEF = { url: '', key: '', model: '', dimensions: 0, threshold: 0.35, topK: 20, via: 'server', source: 'main',
  /* 【v2.23.0】rerank 重排：对粗筛出来的候选再精排一次（照改版 connection-manager 的做法 ✓）*/
  rerankEnabled: true, rerankModel: 'BAAI/bge-reranker-v2-m3' };
/** rerank 用的地址：从向量地址派生（去掉 /embeddings 换成 /rerank ✓ 与改版一致）*/
export function rerankUrl(id, url) {
  const base = effectiveUrl(id, url).replace(/\/+$/, "").replace(/\/embeddings$/i, "");
  return base ? (base + "/rerank") : "";
}
/** rerank 是否可用（要有地址；Key 按来源 ✓ 本地自建可以没有 ✓）*/
export function rerankAvailable() {
  const c = config();
  if (!c.rerankEnabled) return false;
  if (!effectiveUrl(c.source, c.url)) return false;
  const def = sourceDef(c.source);
  if (def.needsKey && !effectiveKey(c.source, c.key)) return false;
  return true;
}
/**
 * 精排：把候选文档按与 query 的相关度重新排序（best-effort ✓ 失败就返回 null → 调用方保持原序 ✓）
 * @returns {Promise<number[]|null>} 返回【按新顺序排列的原下标】
 */
export async function rerank(query, docs, { signal = null } = {}) {
  try {
    if (!rerankAvailable()) return null;
    const c = config();
    const list = (Array.isArray(docs) ? docs : []).map((d) => String(d ?? ""));
    if (!list.length) return null;
    const url = rerankUrl(c.source, c.url);
    const headers = headersFor("direct", effectiveKey(c.source, c.key));
    /* 【v2.23.0】rerank 也 15 秒超时 ✓ */
    const res = await fetchWithTimeout(url, { method: "POST", headers, body: JSON.stringify({ model: c.rerankModel, query: String(query || ""), documents: list, top_n: list.length }) }, 15000);
    const txt = await res.text();
    if (!res.ok) { console.warn("[RBQ] rerank 失败 HTTP " + res.status + "：" + txt.slice(0, 120)); return null; }
    let j = null; try { j = JSON.parse(txt); } catch (e) { console.warn("[RBQ] rerank 返回不是 JSON"); return null; }
    const arr = Array.isArray(j && j.results) ? j.results : (Array.isArray(j && j.data) ? j.data : []);
    if (!arr.length) return null;
    const idx = arr.map((r) => Number(r && (r.index ?? r.document_index))).filter((x) => Number.isFinite(x) && x >= 0 && x < list.length);
    return idx.length === list.length ? idx : null;
  } catch (e) { console.warn("[RBQ] rerank 出错（已跳过）：" + String((e && e.message) || e)); return null; }
}

/*
 * 【v2.18.0 · 借鉴用户改版 connection-manager 的 EMBEDDING_SOURCE_DEFS】
 *   关键启发：不是所有向量接口都要 Key ✗ —— 本地/自建（Ollama / llama.cpp / vLLM）根本不用 Key ✓
 *   所以 available() 改成：只要有【地址或内置默认地址】+【模型】即可；Key 按需 ✓
 *   needsUrl=false 的来源会用它自带的默认地址 ✓
 */
/*
 * 【v2.18.0】读"主 API"的连接信息（真值：SillyTavern.getContext().chatCompletionSettings = oai_settings）
 *   返回 { source, url, key, model }；拿不到就返回空串 ✓ 绝不抛
 */
export function mainApi() {
  try {
    const s = (ctx() && ctx().chatCompletionSettings) || {};
    return {
      source: String(s.chat_completion_source || ""),
      url: String(s.reverse_proxy || s.custom_url || "").trim(),
      key: String(s.proxy_password || "").trim(),
      model: String(s.openai_model || s.model || s.custom_model || "").trim(),
    };
  } catch (e) { return { source: "", url: "", key: "", model: "" }; }
}

export const SOURCES = [
  { id: "main", label: "主 API（默认 · 与聊天同一个接口）", needsUrl: false, needsKey: false, needsModel: true, defaultUrl: "" },
  { id: "custom", label: "自定义（OpenAI 兼容）", needsUrl: true, needsKey: true, needsModel: true, defaultUrl: "" },
  { id: "siliconflow", label: "SiliconFlow", needsUrl: false, needsKey: true, needsModel: true, defaultUrl: "https://api.siliconflow.cn/v1" },
  { id: "openai", label: "OpenAI", needsUrl: false, needsKey: true, needsModel: true, defaultUrl: "https://api.openai.com/v1" },
  { id: "jina", label: "Jina AI", needsUrl: false, needsKey: true, needsModel: true, defaultUrl: "https://api.jina.ai/v1" },
  { id: "ollama", label: "Ollama（本地 · 不要 Key）", needsUrl: false, needsKey: false, needsModel: true, defaultUrl: "http://127.0.0.1:11434/v1" },
  { id: "llamacpp", label: "llama.cpp（本地 · 不要 Key）", needsUrl: true, needsKey: false, needsModel: false, defaultUrl: "" },
  { id: "vllm", label: "vLLM（自建 · 不要 Key）", needsUrl: true, needsKey: false, needsModel: true, defaultUrl: "" },
];
export function sourceDef(id) { try { return SOURCES.find((s) => s.id === String(id || "")) || SOURCES[0]; } catch (e) { return SOURCES[0]; } }
/** 这个来源要不要 Key（本地/自建大多不要 ✓）*/
export function needsKey(id) { return Boolean(sourceDef(id).needsKey); }
/** 实际用的地址：填了就用自己的，没填就用来源默认 ✓ */
export function effectiveUrl(id, url) {
  const u = String(url || "").trim();
  if (u) return u;
  if (String(id) === "main") { const m = mainApi(); if (m.url) return m.url; }
  return String(sourceDef(id).defaultUrl || "");
}
/** 实际用的 Key：填了用填的 ✓；主 API 来源则用主连接里的 proxy_password（如果有）✓ */
export function effectiveKey(id, key) {
  const k = String(key || "").trim();
  if (k) return k;
  if (String(id) === "main") { const m = mainApi(); return String(m.key || ""); }
  return "";
}

export function config() {
  const g = (k, d) => { try { const v = store.getConfigValue("embed." + k, undefined); return (v === undefined || v === null || v === "") ? d : v; } catch (e) { return d; } };
  return {
    url: String(g("url", DEF.url) || "").trim(),
    key: String(g("key", DEF.key) || "").trim(),
    model: String(g("model", DEF.model) || "").trim(),
    dimensions: Number(g("dimensions", DEF.dimensions)) || 0,
    threshold: (() => { const t = Number(g("threshold", DEF.threshold)); return Number.isFinite(t) ? t : DEF.threshold; })(),
    topK: Number(g("topK", DEF.topK)) || DEF.topK,
    via: String(g("via", DEF.via) || DEF.via) === "direct" ? "direct" : "server",
    /* 【v2.18.0 · 真机抓到的 bug】以前这里漏了 source ✗ → sourceDef(undefined) 落到 SOURCES[0]=custom
       → 默认的"主 API"永远不生效 ✗（改版酒馆实测：主连接地址明明读到了却报"还没填接口地址"）*/
    source: String(g("source", DEF.source) || DEF.source),
  };
}
export function setConfig(patchObj = {}) {
  try {
    for (const k of Object.keys(patchObj)) { try { store.setConfigValue("embed." + k, patchObj[k]); } catch (e) { /* ignore */ } }
    return config();
  } catch (e) { return config(); }
}
/** 能不能用（没 key / 没 url / 没 model → 一律不用）*/
/* 【v2.18.0】不再强制要 Key：本地/自建（Ollama/llama.cpp/vLLM）可以没有 Key ✓ */
/** 【v2.18.0】来源=主 API 时的"该用哪个向量模型"：用户没填就用主连接的模型（用户要求 ✓）*/
export function effectiveModel(id, model) {
  const m = String(model || "").trim();
  if (m) return m;
  if (String(id) === "main") { try { return String(mainApi().model || "").trim(); } catch (e) { return ""; } }
  return "";
}
export function available() {
  const c = config();
  const def = sourceDef(c.source);
  const url = effectiveUrl(c.source, c.url);
  if (def.needsModel && !effectiveModel(c.source, c.model)) return false;
  if (def.needsUrl && !url) return false;
  if (def.needsKey && !c.key) return false;
  return Boolean(url || c.model);
}

/* ---------------- 纯函数（可单测） ---------------- */
export function hashText(s) {
  const t = String(s ?? ""); let h1 = 2166136261 >>> 0;
  for (let i = 0; i < t.length; i++) { h1 ^= t.charCodeAt(i); h1 = Math.imul(h1, 16777619) >>> 0; }
  return h1.toString(36) + ":" + t.length.toString(36);
}
export function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { const x = Number(a[i]) || 0, y = Number(b[i]) || 0; dot += x * y; na += x * x; nb += y * y; }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
/** 混排：词面分与向量分都归一到 0~1，再按权相加（词面 0.5 / 向量 0.5）*/
export function blend(lexicalScore, cosineScore, lexWeight = 0.5) {
  const l = Math.max(0, Math.min(1, Number(lexicalScore) || 0));
  const v = Math.max(0, Math.min(1, Number(cosineScore) || 0));
  const w = Math.max(0, Math.min(1, Number(lexWeight)));
  return l * w + v * (1 - w);
}

/* ---------------- 向量仓库（跟着聊天走） ---------------- */
function root() {
  try {
    const c = ctx();
    const md = c.chatMetadata = c.chatMetadata || {};
    const r = md.rbqdb = md.rbqdb || {};
    const idx = r.embedIndex = r.embedIndex || { model: "", dim: 0, items: {} };
    if (!idx.items) idx.items = {};
    return idx;
  } catch (e) { return null; }
}
export function indexInfo() {
  const i = root();
  if (!i) return { model: "", dim: 0, count: 0 };
  return { model: String(i.model || ""), dim: Number(i.dim) || 0, count: Object.keys(i.items || {}).length };
}
export function clearIndex() {
  try { const i = root(); if (i) { i.items = {}; i.model = ""; i.dim = 0; } return true; } catch (e) { return false; }
}
/** 覆盖率：所有记忆条目里，有多少已经向量化（且模型一致）*/
export function coverage() {
  const c = config();
  const i = root();
  const all = (() => { try { return memory.recall({ limit: 99999 }) || []; } catch (e) { return []; } })();
  const total = all.length;
  if (!i || !total) return { total, done: 0, percent: 0, model: c.model, dim: Number(i && i.dim) || 0 };
  let done = 0;
  const sameModel = String(i.model || "") === String(c.model || "");
  for (const h of all) {
    const txt = (() => { try { return memory.textOf(h.entry); } catch (e) { return ""; } })();
    const fp = hashText(txt);
    if (sameModel && i.items[fp]) done++;
  }
  return { total, done, percent: total ? Math.round((done / total) * 100) : 0, model: c.model, dim: Number(i.dim) || 0 };
}

/* ---------------- 调用 embedding 接口 ---------------- */
function headersFor(via, key) {
  if (via === "direct") return { "Content-Type": "application/json", Authorization: "Bearer " + key };
  try { const h = ctx().getRequestHeaders(); if (h) return h; } catch (e) { /* ignore */ }
  return { "Content-Type": "application/json" };
}
/** 取一批文本的向量；返回 { ok, vectors, dim, error }（绝不抛）*/
/** 【v2.23.0】带超时的 fetch（上游不回就不会永远挂着 ✗）*/
async function fetchWithTimeout(url, opts = {}, ms = 15000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => { try { ctl.abort(); } catch (e) { /* ignore */ } }, Math.max(1000, Number(ms) || 15000));
  try {
    const res = await fetch(url, Object.assign({}, opts, { signal: ctl.signal }));
    return res;
  } finally { clearTimeout(timer); }
}
export async function embedTexts(texts, { signal = null } = {}) {
  const c = config();
  const out = { ok: false, vectors: [], dim: 0, error: "" };
  if (!available()) { out.error = "未配置（至少要有地址/模型；本地来源不需要 Key）"; return out; }
  const list = (Array.isArray(texts) ? texts : [texts]).map((t) => String(t ?? ""));
  if (!list.length) { out.ok = true; return out; }
  const base = effectiveUrl(c.source, c.url).replace(/\/+$/, "");
  const url = c.via === "direct" ? (base + "/embeddings") : "/api/backends/chat-completions/generate";
  const useKey = effectiveKey(c.source, c.key);
  const useModel = effectiveModel(c.source, c.model);
  const body = c.via === "direct"
    ? { model: useModel, input: list, ...(c.dimensions > 0 ? { dimensions: c.dimensions } : {}) }
    : { chat_completion_source: "openai", reverse_proxy: base, proxy_password: useKey, model: useModel, input: list, embeddings: true };
  try {
    /* 【v2.23.0】15 秒超时 ✓ 超时=失败 → 调用方自动回退词面 ✓ */
    const res = await fetchWithTimeout(url, { method: "POST", headers: headersFor(c.via, useKey), body: JSON.stringify(body) }, 15000);
    const txt = await res.text();
    if (!res.ok) { out.error = "HTTP " + res.status + "：" + txt.slice(0, 160); return out; }
    let j = null; try { j = JSON.parse(txt); } catch (e) { out.error = "返回不是 JSON：" + txt.slice(0, 120); return out; }
    const arr = Array.isArray(j && j.data) ? j.data : [];
    const vectors = arr.map((d) => (d && Array.isArray(d.embedding) ? d.embedding : null)).filter(Boolean);
    if (!vectors.length) { out.error = "返回里没有 embedding 字段：" + txt.slice(0, 120); return out; }
    out.ok = true; out.vectors = vectors; out.dim = vectors[0].length;
    return out;
  } catch (e) { out.error = String((e && e.message) || e); return out; }
}

/** 重建索引：把所有记忆条目向量化（分批，默认 16 条一批）*/
export async function rebuild({ batch = 16, signal = null, onProgress = null } = {}) {
  const c = config();
  const res = { ok: false, done: 0, total: 0, dim: 0, error: "" };
  if (!available()) { res.error = "未配置（至少要有地址/模型；本地来源不需要 Key）"; return res; }
  const all = (() => { try { return memory.recall({ limit: 99999 }) || []; } catch (e) { return []; } })();
  res.total = all.length;
  if (!all.length) { res.ok = true; return res; }
  const idx = root();
  if (!idx) { res.error = "拿不到聊天存储"; return res; }
  if (String(idx.model || "") !== String(c.model || "")) { idx.items = {}; idx.model = c.model; idx.dim = 0; }
  const need = [];
  for (const h of all) {
    const txt = (() => { try { return memory.textOf(h.entry); } catch (e) { return ""; } })();
    if (!txt) continue;
    const fp = hashText(txt);
    if (!idx.items[fp]) need.push({ fp, txt, name: h.name, round: Number(h.entry && h.entry.round) || 0 });
  }
  for (let i = 0; i < need.length; i += batch) {
    const slice = need.slice(i, i + batch);
    const r = await embedTexts(slice.map((x) => x.txt), { signal });
    if (!r.ok) { res.error = r.error; break; }
    for (let k = 0; k < slice.length && k < r.vectors.length; k++) {
      idx.items[slice[k].fp] = { v: r.vectors[k], name: slice[k].name, text: slice[k].txt.slice(0, 200), round: slice[k].round };
    }
    idx.dim = r.dim || idx.dim;
    res.done += Math.min(slice.length, r.vectors.length);
    try { onProgress && onProgress(res.done, res.total); } catch (e) { /* ignore */ }
  }
  res.ok = res.done > 0;
  res.dim = Number(idx.dim) || 0;
  return res;
}

/** 连接自检：发一条 "ping" 试一次（给设置页用）*/
export async function selfCheck() {
  const c = config();
  const def = sourceDef(c.source);
  const effUrl = effectiveUrl(c.source, c.url);
  if (!effUrl) return { ok: false, step: "接口地址", message: "还没填接口地址（要填到 …/v1 为止）" };
  if (def.needsKey && !c.key) return { ok: false, step: "Key", message: "这个来源需要 Key，但还没填" };
  if (def.needsModel && !effectiveModel(c.source, c.model)) return { ok: false, step: "模型", message: "还没填模型名（来源=主 API 时留空会直接用主连接的模型）" };
  const r = await embedTexts(["连接自检"]);
  const hint = (!def.needsKey && !effectiveKey(c.source, c.key) && /https?:\/\//i.test(effUrl) && !/(127\.0\.0\.1|localhost|0\.0\.0\.0)/i.test(effUrl))
    ? "（主 API 是云端来源：embeddings 通常需要一个 Key，贴一次即可；本地/自建接口不需要 Key）"
    : "";
  if (!r.ok) return { ok: false, step: "请求", message: r.error + hint };
  return { ok: true, dim: r.dim, message: "连上了，维度 " + r.dim + (c.dimensions > 0 && c.dimensions !== r.dim ? ("（你填的是 " + c.dimensions + "，返回 " + r.dim + "）") : "") };
}

/**
 * 给一条查询算向量分（返回 { ok, dim, vector, scores:Map<指纹, 余弦> }）
 * 拿不到向量一律 ok:false → 调用方回退词面 ✓
 */
export async function queryScores(queryText, entries, { signal = null } = {}) {
  const out = { ok: false, error: "", scores: new Map() };
  if (!available()) { out.error = "未配置"; return out; }
  const idx = root();
  if (!idx || !Object.keys(idx.items || {}).length) { out.error = "索引为空（去设置页点一次「重建索引」）"; return out; }
  const c = config();
  if (String(idx.model || "") !== String(c.model || "")) { out.error = "换了模型，需要重建索引"; return out; }
  const r = await embedTexts([String(queryText || "")], { signal });
  if (!r.ok) { out.error = r.error; return out; }
  const qv = r.vectors[0];
  const list = Array.isArray(entries) ? entries : [];
  for (const h of list) {
    const txt = (() => { try { return memory.textOf(h.entry); } catch (e) { return ""; } })();
    const fp = hashText(txt);
    const rec = idx.items[fp];
    if (rec && Array.isArray(rec.v)) out.scores.set(fp, cosine(qv, rec.v));
  }
  out.ok = true;
  return out;
}
