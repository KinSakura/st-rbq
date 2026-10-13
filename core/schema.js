/**
 * schema.js —— 表格结构（15 张表的列定义）与"列名 ↔ 列下标"的唯一真相源
 *
 * 关键设计（针对旧 RBQ 最大的隐患）：
 *   旧代码用硬编码的 TABLE_COL 下标比对列，一旦列序变化就**静默错列**。
 *   这里所有定位一律走列名 → 下标映射；下标只在内部使用，不对外暴露。
 *   并且每次改动 schema 都会重算映射，同时保留一份"列签名"用于检测表头漂移。
 */

import DEFAULT_SCHEMA from '../data/default-schema.js';
import { normalize, hashCell } from './util.js';

/** @type {{tables: Map<number, object>, byName: Map<string, object>, order: number[]}} */
const idx = {
  tables: new Map(),
  byName: new Map(),
  order: [],
};

let current = null;

/** 列签名：列顺序或列名变化时会变，用来发现"表头漂移" */
function columnSignature(columns) {
  return hashCell(columns.map((c) => normalize(c)).join('|'));
}

function indexTable(t) {
  const table = { ...t };
  table.colIndex = new Map();       // 归一化列名 → 下标
  table.colIndexExact = new Map();  // 原文列名 → 下标
  t.columns.forEach((name, i) => {
    table.colIndex.set(normalize(name), i);
    table.colIndexExact.set(String(name), i);
  });
  table.signature = columnSignature(t.columns);
  table.keyIdx = (t.keyColumns ?? [0]).filter((i) => i >= 0 && i < t.columns.length);
  return table;
}

function build(schema) {
  idx.tables.clear();
  idx.byName.clear();
  idx.order = [];
  for (const t of schema.tables ?? []) {
    const table = indexTable(t);
    idx.tables.set(Number(t.no), table);
    idx.byName.set(t.name, table);
    idx.order.push(Number(t.no));
  }
  idx.order.sort((a, b) => a - b);
  current = schema;
}

build(DEFAULT_SCHEMA);

/** 用用户自定义的 schema 覆盖内置 schema（配置中心可编辑） */
export function useSchema(schema) {
  if (schema && Array.isArray(schema.tables) && schema.tables.length > 0) {
    build(schema);
    return true;
  }
  return false;
}

/**
 * 恢复内置 schema。
 * 注意：不能用 `useSchema(getSchema())` 来代替 —— 那只是把"当前已被改过的 schema"
 * 再套一遍，导入过模板后就永远回不到内置了。
 */
export function resetToBuiltin() {
  build(DEFAULT_SCHEMA);
  return true;
}

export function getBuiltinSchema() {
  return DEFAULT_SCHEMA;
}

export function getSchema() {
  return current;
}

export function getTables() {
  return idx.order.map((no) => idx.tables.get(no));
}

export function getTable(noOrName) {
  if (noOrName == null) return null;
  if (typeof noOrName === 'number' || /^\d+$/.test(String(noOrName))) {
    return idx.tables.get(Number(noOrName)) ?? null;
  }
  const direct = idx.byName.get(String(noOrName));
  if (direct) return direct;
  const n = normalize(noOrName);
  for (const t of idx.tables.values()) {
    if (normalize(t.name) === n) return t;
  }
  return null;
}

export function getTableNo(name) {
  return getTable(name)?.no ?? null;
}

export function getColumns(no) {
  return getTable(no)?.columns ?? [];
}

export function getColumnCount(no) {
  return getColumns(no).length;
}

/**
 * 把"列名或列下标"解析成真实下标。
 * @param {number} no 表号
 * @param {string|number} ref 列名（推荐）或 0 起的列下标
 * @returns {{index:number, name:string, by:string}|null}
 */
export function resolveColumn(no, ref) {
  const t = getTable(no);
  if (!t) return null;
  if (typeof ref === 'number' || /^\d+$/.test(String(ref))) {
    const i = Number(ref);
    if (i >= 0 && i < t.columns.length) {
      return { index: i, name: t.columns[i], by: 'index' };
    }
    return null;
  }
  const raw = String(ref).trim();
  const exact = t.colIndexExact.get(raw);
  if (exact != null) return { index: exact, name: t.columns[exact], by: 'exact' };
  const n = normalize(raw);
  const hit = t.colIndex.get(n);
  if (hit != null) return { index: hit, name: t.columns[hit], by: 'normalized' };
  return null;
}

/** 列出某张表的列名（供提示词/UI 使用） */
export function columnsOf(no) {
  return [...getColumns(no)];
}

/** 单例表判断（永远只有一行：表0 宏观时空、表6 剧情大纲） */
export function isSingleton(no) {
  return !!getTable(no)?.singleton;
}

/** 主键列下标（默认第 0 列；表5 是 0+1 复合键） */
export function keyColumns(no) {
  return getTable(no)?.keyIdx ?? [0];
}

/**
 * 从一行数据里取主键字符串。
 * 表5（社交网络）主键 = "发起方|承受方"，与旧实现的 `A|B` 约定一致。
 */
export function rowKey(no, row) {
  const ks = keyColumns(no);
  return ks.map((i) => String(row?.[i] ?? '')).join('|');
}

/** 表头漂移检测：数据里存的列签名与 schema 不一致时返回 true */
export function headerDrifted(no, storedSignature) {
  const t = getTable(no);
  if (!t || !storedSignature) return false;
  return t.signature !== storedSignature;
}
