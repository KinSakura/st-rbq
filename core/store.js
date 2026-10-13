/**
 * store.js —— 存储层（唯一真相源）
 *
 * 三层落点（见《RBQ-重构方案-理想形态.md》第 4 节）：
 *   1. extensionSettings.rbqdb  → schema 覆盖 + 全部配置（换聊天也带着，不占聊天体积）
 *   2. chatMetadata.rbqdb       → 权威数据（一份全量 + rev）
 *   3. message.rbqdb_anchor     → 每条 AI 消息一个锚点（哈希 + 撤销数据 + 审计）
 *
 * 本模块只负责"读/写/校验/持久化"，不含业务语义（那是 txn/rules/review 的事），
 * 因此可以在 Node 里用假上下文直接单测。
 */

import { ctx, chatMetadata, extensionSettings, saveChat, saveSettings, chatId as currentChatId, chat } from './ctx.js';
import { clone, hashTable, uid } from './util.js';
import { getTable, getTables, useSchema, resetToBuiltin, getSchema } from './schema.js';

const NS = 'rbqdb';
const ANCHOR_KEY = 'rbqdb_anchor';
export const DATA_VERSION = 1;

/* ------------------------------------------------------------------ 配置 */

export const DEFAULT_CONFIG = Object.freeze({
  macros: { enabled: true, compatNames: true },
  inputButton: {
      enabled: true,
      placement: 'after',           // after = 放在输入框（发送键）右侧；before = 左侧
      icon: 'fa-solid fa-sliders',
      title: 'RBQ 数据库',
      fab: 'off',                   // 浮动入口：auto / always / off（默认关，用输入框旁那个按钮）
    },
  panel: {
    enabled: true,
    position: { x: 20, y: 80 },
    showAllCharacters: false,
    defaultTab: 'world',
  },
  dataProtocol: {
    acceptFactDeclaration: true,   // 新 <data> 事实申报
    applyPartial: true,            // 逐条应用：成功多少写多少
    fuzzyMatch: true,              // 主键/列名模糊匹配
    fuzzyMaxDistance: 2,
    keepUndoRounds: 20,            // 保留最近 N 轮撤销数据
  },
  review: {
    enabled: true,
    showEmptyReport: false,
    autoFix: 'safe',               // off | safe | all
  },
  repair: {
    enabled: true,
    strategy: 'patch',             // patch = 只补数据段（推荐）；regen = 整轮重生成（最后手段）
    maxAttempts: 2,
    autoRegen: false,              // 是否允许"整轮重生成"这条最后手段
    requiredTags: [],              // 例：['data'] —— 缺失时触发定向修复；为空则只在写入失败时触发
    generatorName: '',             // 可选：window 上某个自定义生成函数的函数名
    maxTokens: 1200,
    temperature: 0.4,
    timeoutMs: 60000,
  },
  features: {
    options: true,                 // 四选一行动选项
    memory: true,                  // 角色视角记忆
    departure: true,               // 离场治理
    monster: true,                 // 怪物清理
    round: true,                   // 轮次与大总结提醒
    inspiration: false,            // 叙事灵感
    timeBox: true,                 // 时间框
  },
  debug: { enabled: false, keepAuditRounds: 50 },
});

function deepMerge(base, patch) {
  if (patch == null) return clone(base);
  if (Array.isArray(base) || typeof base !== 'object') return patch;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = k in base ? deepMerge(base[k], v) : v;
  }
  return out;
}

function settingsRoot() {
  const es = extensionSettings();
  if (!es) return null;
  if (!es[NS] || typeof es[NS] !== 'object') es[NS] = {};
  return es[NS];
}

export function getConfig() {
  const root = settingsRoot();
  return deepMerge(DEFAULT_CONFIG, root?.config ?? {});
}

export function updateConfig(patch) {
  const root = settingsRoot();
  if (!root) return null;
  root.config = deepMerge(deepMerge(DEFAULT_CONFIG, root.config ?? {}), patch);
  saveSettings();
  return root.config;
}

export function getConfigValue(path, fallback = undefined) {
  let cur = getConfig();
  for (const seg of String(path).split('.')) {
    if (cur == null || typeof cur !== 'object' || !(seg in cur)) return fallback;
    cur = cur[seg];
  }
  return cur === undefined ? fallback : cur;
}

/** 用户自定义 schema（null = 用内置） */
export function getUserSchema() {
  return settingsRoot()?.schema ?? null;
}

export function resetSchemaToBuiltin() {
  const root = settingsRoot();
  if (root) root.schema = null;
  resetToBuiltin();
  saveSettings();
  return true;
}

export function setUserSchema(schema) {
  const root = settingsRoot();
  if (!root) return false;
  root.schema = schema ? clone(schema) : null;
  if (root.schema) useSchema(root.schema);
  else resetToBuiltin();
  saveSettings();
  return true;
}

/* ------------------------------------------------------------------ 数据 */

function emptyData(id = '') {
  return {
    schemaVersion: DATA_VERSION,
    chatId: id,
    rev: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    tables: {},      // { "0": { rows: [[...]], colsHash, updatedRev } }
  };
}

function emptyProfile(id = '') {
  return { chatId: id, rev: 0, createdAt: Date.now(), updatedAt: Date.now(), tables: {} };
}

/**
 * 取存储根（含 profiles）。
 * 兼容并自动迁移旧结构（旧版把 rev/tables 直接放在根上）。
 */
function getRoot({ create = true } = {}) {
  const md = chatMetadata();
  if (!md) return null;
  let root = md[NS];
  const id = currentChatId();

  if (!root || typeof root !== 'object' || root.schemaVersion !== DATA_VERSION || !root.profiles) {
    const legacy = (root && typeof root === 'object' && root.tables) ? root : null;
    if (!create) return null;
    root = {
      schemaVersion: DATA_VERSION,
      chatId: id,
      createdAt: legacy?.createdAt ?? Date.now(),
      activeProfile: '',
      profiles: {},
    };
    if (legacy) {
      // 旧结构 → 默认档
      root.profiles[''] = {
        chatId: legacy.chatId ?? id,
        rev: legacy.rev ?? 0,
        createdAt: legacy.createdAt ?? Date.now(),
        updatedAt: legacy.updatedAt ?? Date.now(),
        tables: legacy.tables ?? {},
      };
      console.log('[RBQ] 已把旧版数据结构迁移到默认档。');
    }
    md[NS] = root;
  }
  if (!root.profiles) root.profiles = {};
  return root;
}

/* ------------------------------------------------------------ 数据档（隔离） */

/** 列出所有数据档 */
export function listProfiles() {
  const root = getRoot({ create: false });
  if (!root) return [{ key: '', active: true, rows: 0, rev: 0 }];
  return Object.entries(root.profiles).map(([key, p]) => ({
    key,
    active: key === String(root.activeProfile ?? ''),
    rev: p.rev ?? 0,
    rows: Object.values(p.tables ?? {}).reduce((n, t) => n + (t?.rows?.length ?? 0), 0),
  }));
}

export function getActiveProfileKey() {
  const root = getRoot();
  return String(root?.activeProfile ?? '');
}

/** 切换数据档（每个角色卡/世界观一套表格数据） */
export function switchProfile(key) {
  const root = getRoot();
  if (!root) return false;
  const k = String(key ?? '');
  if (!root.profiles[k]) root.profiles[k] = emptyProfile(currentChatId());
  root.activeProfile = k;
  saveChat();
  return true;
}

/** 新建数据档；cloneFrom 给了就复制那一档的数据（换世界观时很有用） */
export function createProfile(key, { cloneFrom = null } = {}) {
  const root = getRoot();
  if (!root) return false;
  const k = String(key ?? '').trim();
  if (!k) return false;
  if (root.profiles[k]) return false;
  if (cloneFrom != null && root.profiles[String(cloneFrom)]) {
    root.profiles[k] = clone(root.profiles[String(cloneFrom)]);
  } else {
    root.profiles[k] = emptyProfile(currentChatId());
  }
  saveSettings();
  return true;
}

export function deleteProfile(key) {
  const root = getRoot();
  if (!root) return false;
  const k = String(key ?? '');
  if (!root.profiles[k] || Object.keys(root.profiles).length <= 1) return false;
  delete root.profiles[k];
  if (String(root.activeProfile) === k) root.activeProfile = Object.keys(root.profiles)[0];
  saveChat();
  return true;
}

export function renameProfile(from, to) {
  const root = getRoot();
  const f = String(from ?? '');
  const t = String(to ?? '').trim();
  if (!root || !t || root.profiles[t] || !root.profiles[f]) return false;
  root.profiles[t] = root.profiles[f];
  delete root.profiles[f];
  if (String(root.activeProfile) === f) root.activeProfile = t;
  saveChat();
  return true;
}

/* ---------------------------------------------------------- 模板预设（schema） */

/** 内置模板 + 用户保存的模板 */
export function listTemplatePresets() {
  const custom = settingsRoot()?.templatePresets ?? {};
  const out = [{ name: '（内置默认）', builtin: true, tables: getTables().length, updatedAt: 0 }];
  for (const [name, v] of Object.entries(custom)) {
    out.push({ name, builtin: false, tables: v?.schema?.tables?.length ?? 0, updatedAt: v?.updatedAt ?? 0 });
  }
  return out;
}


/* ------------------------------------------------- 模板来源（移植 shukuju 三段优先级） */

/**
 * 模板从哪来（shukuju 的 chat_override → preset_link → 全局 三段优先级，L52528）：
 *   1. chat_override  本聊天覆盖（只影响这个聊天）
 *   2. preset_link    链接到某个模板预设
 *   3. global         全局 schema
 *   4. builtin        内置默认
 */
export function getTemplateSource() {
  const data = getData({ create: false });
  if (data?.schemaOverride?.tables?.length) return { mode: "chat_override", schema: data.schemaOverride, label: "本聊天覆盖" };
  const key = data?.templatePresetKey;
  if (key) {
    const preset = settingsRoot()?.templatePresets?.[key];
    if (preset?.schema?.tables?.length) return { mode: "preset_link", schema: preset.schema, label: `模板：${key}` };
  }
  const u = getUserSchema();
  if (u?.tables?.length) return { mode: "global", schema: u, label: "全局模板" };
  return { mode: "builtin", schema: null, label: "内置模板" };
}

/** 本聊天专用 schema（只影响当前聊天；传 null 清除） */
export function setChatSchemaOverride(schema) {
  const data = getData({ create: true });
  data.schemaOverride = schema ? clone(schema) : null;
  const src = getTemplateSource();
  if (src.schema) useSchema(src.schema); else resetToBuiltin();
  return true;
}

/** 把本聊天"链接"到某个模板预设（不改全局） */
export function linkTemplatePreset(name) {
  const data = getData({ create: true });
  if (!name) { data.templatePresetKey = null; return true; }
  if (!settingsRoot()?.templatePresets?.[name]) return false;
  data.templatePresetKey = String(name);
  const src = getTemplateSource();
  if (src.schema) useSchema(src.schema); else resetToBuiltin();
  return true;
}

/**
 * 换模板后过滤旧表（移植 mergeAllIndependentTables 的 templateSheetKeySet 过滤）：
 * 不在当前 schema 里的表**搬进 archived，不删数据**；读/写/导出都不再看见它们。
 */
export function pruneTablesNotInSchema() {
  const data = getData({ create: false });
  if (!data?.tables) return { moved: 0, kept: 0 };
  const alive = new Set(getTables().map((t) => String(t.no)));
  if (!data.archived) data.archived = {};
  let moved = 0;
  let kept = 0;
  for (const k of Object.keys(data.tables)) {
    if (alive.has(k)) { kept++; continue; }
    if (!data.archived[k]) data.archived[k] = { archivedAt: Date.now(), tables: {} };
    data.archived[k].tables[data.rev ?? 0] = data.tables[k];
    delete data.tables[k];
    moved++;
  }
  return { moved, kept };
}

/** 被归档的表（换模板后不参与读写，但没丢） */
export function listArchivedTables() {
  const data = getData({ create: false });
  return Object.entries(data?.archived ?? {}).map(([no, v]) => ({ no: Number(no), at: v?.archivedAt ?? 0 }));
}
/** 把当前 schema 存成一份模板 */
export function saveTemplatePreset(name) {
  const root = settingsRoot();
  if (!root || !name) return false;
  if (!root.templatePresets) root.templatePresets = {};
  root.templatePresets[String(name)] = { schema: clone(getSchema()), updatedAt: Date.now() };
  saveSettings();
  return true;
}

export function deleteTemplatePreset(name) {
  const root = settingsRoot();
  if (!root?.templatePresets?.[name]) return false;
  delete root.templatePresets[name];
  saveSettings();
  return true;
}

/** 切换到某份模板（会改 schema；数据不动） */
export function applyTemplatePreset(name) {
  if (name === '（内置默认）') {
    setUserSchema(null);
    return true;
  }
  const preset = settingsRoot()?.templatePresets?.[name];
  if (!preset?.schema) return false;
  setUserSchema(preset.schema);
  // ④ 模板预置的数据是"基底数据"，不是 AI 填的（移植 _acu_from_base_state）
  const data = getData({ create: true });
  for (const tb of preset.schema.tables ?? []) {
    const hasSeed = Array.isArray(tb.rows) && tb.rows.length > 0;
    const m = getTableMeta(tb.no);
    m.fromBaseState = hasSeed;
    if (!hasSeed) m.lastUpdatedAiFloor = m.lastUpdatedAiFloor ?? 0;
  }
  // ③ 换模板后旧表不再参与读写
  const pruned = pruneTablesNotInSchema();
  return { ok: true, archived: pruned.moved };
}

/** 导出当前 schema（给别的聊天/别人用） */
export function exportTemplatePreset() {
  return JSON.stringify({
    mate: { type: 'rbqTemplate', version: 1, exportedAt: new Date().toISOString() },
    schema: getSchema(),
  }, null, 2);
}

/** 导入一份模板（兼容记忆增强表格导出的 preset：有 tableStructure 就认） */
export function importTemplatePreset(json) {
  const obj = typeof json === 'string' ? JSON.parse(json) : json;
  if (obj?.schema?.tables) {
    setUserSchema(obj.schema);
    return { imported: obj.schema.tables.length, kind: 'rbqTemplate' };
  }
  if (Array.isArray(obj?.tableStructure)) {
    // 旧插件格式：tableStructure + message_template
    const tables = obj.tableStructure.map((t) => ({
      no: Number(t.tableIndex),
      name: String(t.tableName),
      columns: (t.columns ?? []).map(String),
      note: String(t.note ?? ''),
      group: 'misc',
      singleton: [0, 6].includes(Number(t.tableIndex)),
      required: t.Required !== false,
      keyColumns: Number(t.tableIndex) === 5 ? [0, 1] : [0],
      enabled: t.enable !== false,
    })).sort((a, b) => a.no - b.no);
    setUserSchema({
      schemaVersion: 1,
      generatedFrom: 'imported',
      generatedAt: new Date().toISOString(),
      nameToNo: Object.fromEntries(tables.map((t) => [t.name, String(t.no)])),
      tables,
      messageTemplate: String(obj.message_template ?? ''),
    });
    return { imported: tables.length, kind: 'legacyPreset' };
  }
  throw new Error('无法识别的模板格式（既没有 schema.tables 也没有 tableStructure）');
}

/**
 * 取"当前数据档"的数据。
 * 若 chatId 不一致（换了聊天但 metadata 还残留），不自动清空，只标记出来，
 * 避免把别的聊天的表格写进来。
 */
export function getData({ create = true } = {}) {
  const root = getRoot({ create });
  if (!root) return create ? emptyProfile() : null;
  let key = String(root.activeProfile ?? '');
  // __profileFallback：当前档为空、但聊天里别的档有数据 → 自动切到最有数据的那个档
  // （避免"打开面板一片 0 行、以为数据全没了"——数据其实一直在另一个档里）
  // 【重要】但"回滚/清空"之后**绝不能**回退 ✗✓ ——
  //   否则刚清空的档会被判定为空 → 又切回存着旧数据的另一个档 →
  //   表现成"回滚了但数据还在"（实测就是这个 ✗），而且写入溯源里什么都看不到 ✓
  //   所以 restoreTablesSnapshot / 清空数据 都会在当前档打 __noFallback 标记 ✓
  try {
    const __rows = (pf) => { let n = 0; const ts = (pf && pf.tables) || {}; for (const t of Object.values(ts)) n += Array.isArray(t && t.rows) ? t.rows.length : 0; return n; };
    if (!root.profiles?.[key]?.__noFallback && __rows(root.profiles[key]) === 0) {
      let best = null; let bestN = 0;
      for (const [k2, v2] of Object.entries(root.profiles || {})) { const n2 = __rows(v2); if (n2 > bestN) { bestN = n2; best = k2; } }
      if (best != null && bestN > 0) key = best;
    }
  } catch (e) { /* ignore */ }
  if (!root.profiles[key]) {
    if (!create) return null;
    root.profiles[key] = emptyProfile(currentChatId());
  }
  const data = root.profiles[key];
  if (!data.tables) data.tables = {};

  const id = currentChatId();
  if (id && data.chatId && data.chatId !== id) {
    data.__mismatch = { storedChatId: data.chatId, currentChatId: id, at: Date.now() };
  } else {
    delete data.__mismatch;
  }
  return data;
}

/** 覆盖当前数据档 */
export function setData(data) {
  const root = getRoot();
  if (!root) return false;
  root.profiles[String(root.activeProfile ?? '')] = data;
  return true;
}

/** 取存储根（诊断用） */
export function getRawRoot() {
  return getRoot({ create: false });
}

export function getRev() {
  return getData()?.rev ?? 0;
}

/* ================= 表格快照（照记忆增强插件的做法 ✓）=================
   插件给每条消息挂一份 hash_sheets（该消息那一刻的表格快照 ✓）→ 回滚时直接还原 ✓
   不再依赖 rev/undo 链：那条链要求 beforeRev 记得准 + undo 没被清理 ✗（我们连着栽过两次 ✓）
   快照是"一字不差"的还原 ✓ 而且不受 pruneUndo / clearAnchor 影响 ✓ */
export function snapshotTables() {
  try { return JSON.stringify(getData()?.tables ?? {}); } catch (e) { console.warn('[RBQ] 拍快照失败', e); return null; }
}

/** 清空当前数据档的所有表格（并禁止自动回退 ✓）—— 面板「清空本聊天的表格数据」用这个 ✓ */
export async function clearAllTables() {
  const d = getData();
  d.tables = {};
  d.rev = (d.rev ?? 0) + 1;
  d.updatedAt = Date.now();
  d.__noFallback = true;
  await saveChat();
  return true;
}

export async function restoreTablesSnapshot(snap) {
  try {
    const tables = JSON.parse(String(snap));
    const d = getData();
    d.tables = tables;
    // 还原之后禁止"数据档自动回退"（否则刚清空的档会被判空 → 又切回有旧数据的档 ✗）
    d.__noFallback = true;
    d.rev = (d.rev ?? 0) + 1;
    d.updatedAt = Date.now();
    await saveChat();
    return true;
  } catch (e) { console.warn('[RBQ] 还原快照失败', e); return false; }
}

/** 取某张表的行（不存在则按需建空） */
export function getRows(no, { create = true } = {}) {
  const data = getData({ create });
  if (!data) return [];
  const key = String(no);
  let entry = data.tables[key];
  if (!entry) {
    if (!create) return [];
    entry = { rows: [], colsHash: getTable(no)?.signature ?? '', updatedRev: data.rev };
    data.tables[key] = entry;
  }
  if (!Array.isArray(entry.rows)) entry.rows = [];
  return entry.rows;
}

/** 直接覆盖某张表的行（低层；不做校验，供 txn 内部使用） */
/** 写入审计（含"绕过 txn 直写"的路径 ✓）：window.__rbqTraceWrites = true 时记录调用栈 ✓ */
function __auditWrite(no, how) {
  try {
    if (typeof window === "undefined" || !window.__rbqTraceWrites) return;
    const st = String(new Error().stack ?? "").split("\n").slice(1, 5).map((s) => s.trim().replace(/^at\s+/, "").slice(0, 70)).join(" ← ");
    (window.__rbqWriteAudit ??= []).push({ at: Date.now(), kind: how, table: String(no), stack: st });
  } catch (e) { /* ignore */ }
}

export function setRows(no, rows) {
  __auditWrite(no, "setRows直接写");
  const data = getData();
  const key = String(no);
  data.tables[key] = {
    rows: rows ?? [],
    colsHash: getTable(no)?.signature ?? '',
    updatedRev: data.rev,
  };
  return data.tables[key];
}

export function deleteTable(no) {
  const data = getData({ create: false });
  if (!data) return false;
  delete data.tables[String(no)];
  return true;
}

/** 全部表 → 便于遍历 */
export function getAllTables() {
  const data = getData({ create: false });
  return getTables().map((t) => ({
    table: t,
    no: t.no,
    name: t.name,
    columns: t.columns,
    rows: data?.tables?.[String(t.no)]?.rows ?? [],
    colsHash: data?.tables?.[String(t.no)]?.colsHash ?? t.signature,
  }));
}

/* ------------------------------------------------------------- 哈希与锚点 */

/** 各表的整表哈希（用于"这轮之后表是什么样"的指纹） */
export function hashAll() {
  const out = {};
  const data = getData({ create: false });
  for (const t of getTables()) {
    const rows = data?.tables?.[String(t.no)]?.rows;
    if (rows && rows.length) out[String(t.no)] = hashTable(rows);
  }
  return out;
}

export function getAnchor(msg) {
  const a = msg?.[ANCHOR_KEY];
  return a && typeof a === 'object' ? a : null;
}

export function setAnchor(msg, anchor) {
  if (!msg) return false;
  msg[ANCHOR_KEY] = anchor;
  return true;
}

export function clearAnchor(msg) {
  if (msg && ANCHOR_KEY in msg) delete msg[ANCHOR_KEY];
}

/** 列出所有带锚点的消息（含索引），从旧到新 */
/** 清掉所有楼层的回滚锚点（清空数据时一起用 ✓） */
export function clearAllAnchors() {
  let n = 0;
  try {
    for (const m of chat()) { if (m && m[ANCHOR_KEY]) { try { delete m[ANCHOR_KEY]; n++; } catch (e) { /* ignore */ } } }
    try { saveChat(); } catch (e) { /* ignore */ }
  } catch (e) { /* ignore */ }
  return n;
}

export function listAnchors() {
  const out = [];
  const c = chat();
  for (let i = 0; i < c.length; i++) {
    const a = getAnchor(c[i]);
    if (a) out.push({ index: i, message: c[i], anchor: a });
  }
  return out;
}

/** 从最新往前找第一个带锚点的消息（等价于旧插件的 getLastSheetsPiece） */
export function findLatestAnchor() {
  const c = chat();
  for (let i = c.length - 1; i >= 0; i--) {
    const a = getAnchor(c[i]);
    if (a) return { index: i, message: c[i], anchor: a };
  }
  return { index: -1, message: null, anchor: null };
}

/** 最新一条 AI 消息的下标（-1 表示没有） */
export function findLatestAiMessageIndex() {
  const c = chat();
  for (let i = c.length - 1; i >= 0; i--) {
    if (c[i] && c[i].is_user !== true) return i;
  }
  return -1;
}

/**
 * 写入一个锚点并持久化。
 * @param {object} opts
 * @param {number} [opts.messageIndex] 目标消息下标，缺省=最新一条 AI 消息
 * @param {object} [opts.undo]  { 表号: 改动前的行 | null }
 * @param {Array}  [opts.audit] 本轮审计条目
 * @param {Array}  [opts.ops]   原始操作（调试用）
 */
export async function commit({ messageIndex, undo = {}, audit = [], ops = [], roundId = '', modifiedKeys = [], persist = true } = {}) {
  const data = getData();
  data.rev = (data.rev ?? 0) + 1;
  data.updatedAt = Date.now();
  if (!data.chatId) data.chatId = currentChatId();

  const idx = messageIndex ?? findLatestAiMessageIndex();
  const c = chat();
  if (idx >= 0 && c[idx]) {
    const prev = getAnchor(c[idx]);
    setAnchor(c[idx], {
      v: 1,
      roundId: roundId || prev?.roundId || uid('r'),
      rev: data.rev,
      at: Date.now(),
      hash: hashAll(),
      /* 【必须继承】这几个字段是一次性记下、后续每次 commit 都要保留的 ✓
         beforeRev 尤其重要：它记的是"这一楼写入**之前**的版本"，
         重新生成/删楼层就靠它回滚 ✓ —— 以前每次 commit 都把它覆盖掉 ✗✗
         → 回滚时只能退回 rev（= 写入之后）→ 原地踏步（restored: 0）✓✓ */
      beforeRev: prev?.beforeRev,
      // 同理：这两个快照也必须继承（否则每次写入都会被抹掉 ✗ 与 beforeRev 同一个坑 ✓）
      beforeSnapshot: prev?.beforeSnapshot,
      afterSnapshot: prev?.afterSnapshot,
      sideHash: prev?.sideHash,
      sideRound: prev?.sideRound,
      undo: prev?.undo && Object.keys(prev.undo).length ? { ...prev.undo, ...undo } : undo,
      ops: ops.length ? ops : undefined,
      audit: audit.length ? audit : prev?.audit,
      // ── 本楼增量（移植 shukuju：只记"这楼到底动了哪些表" + 各表改动前的行）──
      modifiedKeys: modifiedKeys.length ? modifiedKeys : prev?.modifiedKeys,
      delta: Object.keys(undo).length ? Object.keys(undo) : prev?.delta,
    });
  }

  pruneUndo();
  try { pruneSnapshots(); } catch (e) { /* ignore */ }

  if (persist) await saveChat();
  return data.rev;
}

/** 只保留最近 N 轮的撤销数据，防止聊天文件膨胀 */
/** 只保留最近 N 楼的表格快照（不然聊天存档会越涨越大 ✗）—— 超出的楼层退回用版本号回滚 ✓ */
export function pruneSnapshots() {
  const keep = getConfigValue('dataProtocol.keepSnapshots', 60);
  const anchors = listAnchors();
  if (anchors.length <= keep) return 0;
  let pruned = 0;
  for (let i = 0; i < anchors.length - keep; i++) {
    const a = anchors[i].anchor;
    if (a && (a.beforeSnapshot || a.afterSnapshot)) {
      try { delete a.beforeSnapshot; delete a.afterSnapshot; pruned++; } catch (e) { /* ignore */ }
    }
  }
  return pruned;
}

export function pruneUndo() {
  const keep = getConfigValue('dataProtocol.keepUndoRounds', 60);   // 20 → 60：频繁重新生成时需要更深的历史 ✓
  const anchors = listAnchors();
  if (anchors.length <= keep) return 0;
  let pruned = 0;
  for (let i = 0; i < anchors.length - keep; i++) {
    const a = anchors[i].anchor;
    if (a.undo && Object.keys(a.undo).length) {
      delete a.undo;
      pruned++;
    }
  }
  return pruned;
}

/**
 * 生成"回滚到指定 rev"需要的步骤（从新到旧）。
 * @returns {Array<{index:number, undo:object}>}
 */
export function planRollback(targetRev) {
  const anchors = listAnchors().filter((x) => (x.anchor?.rev ?? 0) > targetRev);
  anchors.sort((a, b) => (b.anchor.rev ?? 0) - (a.anchor.rev ?? 0));
  return anchors
    .filter((x) => x.anchor.undo && Object.keys(x.anchor.undo).length)
    .map((x) => ({ index: x.index, undo: x.anchor.undo }));
}

/* ------------------------------------------------------- 导入 / 导出 */

/**
 * 导出成**与记忆增强表格插件逐字节兼容**的格式。
 * 插件格式：{ "sheet_xxx": { uid, name, content: [[表头(含前导标签列)], [数据行(含前导标签列)]] } }
 * 状态栏依赖：content[0].slice(1) 当表头、name 反查表号。
 */
export function exportPluginJson({ onlyEnabled = true } = {}) {
  const out = {};
  for (const t of getTables()) {
    if (onlyEnabled && t.enabled === false) continue;
    const rows = getRows(t.no, { create: false });
    const header = ['', ...t.columns];
    const content = [header];
    for (const r of rows) {
      const row = ['', ...t.columns.map((_, i) => (r?.[i] == null ? '' : String(r[i])))];
      content.push(row);
    }
    out[`sheet_${t.no}`] = { uid: `sheet_${t.no}`, name: t.name, content };
  }
  return out;
}

export function exportJsonString() {
  return JSON.stringify(exportPluginJson());
}

/**
 * 从插件格式导入。
 * 兼容两种键名：sheet_<数字> 与 sheet_<随机串>；用 name 反查表号（name 找不到才退回键里的数字）。
 * @returns {{imported:number, skipped:string[], byName:boolean}}
 */
export function importPluginJson(json, { replace = false } = {}) {
  const src = typeof json === 'string' ? JSON.parse(json) : json;
  const skipped = [];
  let imported = 0;
  if (!src || typeof src !== 'object') return { imported, skipped, byName: false };

  const data = getData();
  if (replace) data.tables = {};
  let usedName = false;

  for (const [key, sheet] of Object.entries(src)) {
    if (!sheet || typeof sheet !== 'object') continue;
    let no = null;
    const byName = getTable(sheet.name);
    if (byName) { no = byName.no; usedName = true; }
    else if (/^sheet_(\d+)$/.test(key)) no = Number(key.replace('sheet_', ''));
    if (no == null || !getTable(no)) { skipped.push(key); continue; }
    const content = Array.isArray(sheet.content) ? sheet.content : [];
    // content[0] 是表头（含前导标签列），数据行同样含前导列
    const rows = [];
    for (let i = 1; i < content.length; i++) {
      const r = Array.isArray(content[i]) ? content[i] : [];
      const row = r.slice(1).map((v) => (v == null ? '' : String(v)));
      while (row.length < getTable(no).columns.length) row.push('');
      rows.push(row);
    }
    setRows(no, rows);
    imported++;
  }
  return { imported, skipped, byName: usedName };
}

/** 往返自检：导出→导入→再导出，两次字符串应完全一致 */
export function roundTripCheck() {
  const a = exportJsonString();
  const snapshot = clone(getData());
  try {
    importPluginJson(a, { replace: true });
    const b = exportJsonString();
    return { ok: a === b, a, b };
  } finally {
    setData(snapshot);
  }
}


/* --------------------------------------------------- 表级 meta（移植 shukuju L8118） */

/**
 * 每张表的元信息：
 *   lastUpdatedAiFloor —— 这张表最后一次被更新的 AI 楼层数（移植 L8118 的 lastUpdatedAiFloor）
 *   fromBaseState       —— 数据来自模板基底（移植 _acu_from_base_state，基底 ≠ AI 填写）
 *   modifiedRev         —— 最后一次改动它的 rev
 *   modifiedKeys        —— 最后一次改动涉及的列名
 */
const META_WHITELIST = ["lastUpdatedAiFloor", "fromBaseState", "modifiedRev", "modifiedKeys"];

export function getTableMeta(no) {
  const d = getData({ create: true });
  if (!d.tableMeta) d.tableMeta = {};
  const k = String(no);
  if (!d.tableMeta[k]) d.tableMeta[k] = { lastUpdatedAiFloor: 0, fromBaseState: false, modifiedRev: 0, modifiedKeys: [] };
  return d.tableMeta[k];
}

export function setTableMeta(no, patch) {
  const m = getTableMeta(no);
  Object.assign(m, patch ?? {});
  return m;
}

/** 落盘瘦身：只保留白名单字段（移植 sanitizeSheetForStorage_ACU L52245） */
export function sanitizeTableForStorage(entry) {
  const out = {};
  for (const k of ["rows", "colsHash", "updatedRev"]) if (entry && entry[k] !== undefined) out[k] = entry[k];
  return out;
}

/** 整档瘦身（写盘前调一次） */
export function sanitizeDataForStorage(data) {
  if (!data || !data.tables) return data;
  for (const k of Object.keys(data.tables)) data.tables[k] = sanitizeTableForStorage(data.tables[k]);
  if (data.tableMeta) {
    for (const k of Object.keys(data.tableMeta)) {
      const m = data.tableMeta[k];
      const keep = {};
      for (const w of META_WHITELIST) if (m[w] !== undefined) keep[w] = m[w];
      data.tableMeta[k] = keep;
    }
  }
  return data;
}
/* 模板同步版本（templateCheck.js 通过 getConfigValue/updateConfig 读写） */

/** 给诊断面板用的概览 */
export function stats() {
  const data = getData({ create: false });
  const tables = getAllTables();
  const nonEmpty = tables.filter((t) => t.rows.length > 0);
  let profiles = [];
  try { profiles = listProfiles(); } catch { profiles = []; }
  return {
    chatId: currentChatId(),
    profile: getActiveProfileKey(),
    profileCount: profiles.length,
    rev: data?.rev ?? 0,
    updatedAt: data?.updatedAt ?? 0,
    tableCount: tables.length,
    nonEmptyTables: nonEmpty.length,
    rowTotal: nonEmpty.reduce((n, t) => n + t.rows.length, 0),
    anchors: listAnchors().length,
    mismatch: data?.__mismatch ?? null,
    dataBytes: (() => { try { return JSON.stringify(data ?? {}).length; } catch { return 0; } })(),
    tableMeta: data?.tableMeta ?? {},
  };
}

/* ------------------------------------------------------ 表格结构编辑（schema） */

/** 改一张表的结构（名字/列/备注/单例/主键列） */
export function updateTableStructure(no, patch, opts = {}) {
  const schema = clone(getSchema());
  const t = (schema.tables ?? []).find((x) => Number(x.no) === Number(no));
  if (!t) return false;
  Object.assign(t, patch);
  if (!Array.isArray(t.columns) || !t.columns.length) return false;
  const width = t.columns.length;
  const rows = getRows(no, { create: false });
  if (rows.length) {
    // rowOp：删/插某一列时，必须**逐行按同一位置**动数据格，
    // 否则删中间一列会让所有行整体错位一格（以前只截尾巴，就是这个 bug）
    const op = opts.rowOp ?? null;
    for (const r of rows) {
      if (op && op.type === 'remove' && Number.isInteger(op.index) && op.index >= 0 && op.index < r.length) {
        r.splice(op.index, 1);
      } else if (op && op.type === 'insert' && Number.isInteger(op.index)) {
        r.splice(Math.max(0, Math.min(r.length, op.index)), 0, '');
      }
      while (r.length < width) r.push('');
      if (r.length > width) r.length = width;
    }
  }
  // 同步 nameToNo
  schema.nameToNo = Object.fromEntries((schema.tables ?? []).map((x) => [x.name, String(x.no)]));
  setUserSchema(schema);
  saveChat();
  return true;
}

/** 新增一张表（表号自动取当前最大值 +1） */
export function createTable({ name, columns = ['名称'], note = '', singleton = false, keyColumns = [0] } = {}) {
  const schema = clone(getSchema());
  const used = (schema.tables ?? []).map((t) => Number(t.no));
  const no = used.length ? Math.max(...used) + 1 : 0;
  const table = {
    no,
    name: String(name || `新表${no}`),
    columns: columns.map((c) => String(c || '未命名列')).filter(Boolean),
    note: String(note ?? ''),
    group: 'misc',
    singleton: !!singleton,
    required: false,
    keyColumns: keyColumns.filter((i) => i < columns.length),
    enabled: true,
  };
  schema.tables = [...(schema.tables ?? []), table].sort((a, b) => a.no - b.no);
  schema.nameToNo = Object.fromEntries(schema.tables.map((x) => [x.name, String(x.no)]));
  setUserSchema(schema);
  return no;
}

/** 删除一张表（连同它的数据） */
export function deleteTableAndData(no) {
  const schema = clone(getSchema());
  const before = (schema.tables ?? []).length;
  schema.tables = (schema.tables ?? []).filter((t) => Number(t.no) !== Number(no));
  if (schema.tables.length === before) return false;
  schema.nameToNo = Object.fromEntries(schema.tables.map((x) => [x.name, String(x.no)]));
  setUserSchema(schema);
  deleteTable(no);
  saveChat();
  return true;
}

/** 导出当前全部数据 + schema（可整包搬走） */
export function exportBundle() {
  return JSON.stringify({
    mate: { type: 'rbqBundle', version: 1, exportedAt: new Date().toISOString(), profile: getActiveProfileKey() },
    schema: getSchema(),
    tables: exportPluginJson(),
  }, null, 2);
}

/** 导入整包（数据 + 可选 schema） */
export function importBundle(json, { replaceSchema = true, replaceData = true } = {}) {
  const obj = typeof json === 'string' ? JSON.parse(json) : json;
  if (!obj || typeof obj !== 'object') throw new Error('不是有效的 JSON');
  let schemaImported = 0;
  let dataImported = 0;
  if (replaceSchema && obj.schema?.tables) {
    setUserSchema(obj.schema);
    schemaImported = obj.schema.tables.length;
  }
  if (replaceData) {
    const payload = obj.tables ?? (obj.sheet_2 ? obj : null);
    if (payload) {
      const r = importPluginJson(payload, { replace: true });
      dataImported = r.imported;
    }
  }
  saveChat();
  return { schemaImported, dataImported };
}
