/**
 * match.js —— 主键/行/列的匹配与定位
 *
 * 这是"把定位从模型手里拿走"的落点（痛点 ② 的核心）：
 * 模型只说"角色=左玄"，由这里负责找到是哪一行。
 * 四级匹配：exact（原文相等） → normalized（归一化相等） → contains（包含） → distance（编辑距离）
 * 命中不了就返回 null，交给上层进"待确认队列"，而不是丢弃整批。
 */

import { getTable, getTables, resolveColumn, keyColumns } from './schema.js';
import { normalize, editDistance } from './util.js';

const LEVEL_SCORE = { exact: 1000, normalized: 800, contains: 500, distance: 200 };

/**
 * 比较一个单元格与目标值，返回匹配等级与分数。
 *
 * 关于模糊（distance）层的两条硬约束 —— 这是踩过的坑：
 *   旧写法允许「左玄」与「女」编辑距离=2 就算命中，于是**本该新建的行会被当成
 *   更新写到别人身上**。所以：
 *     ① 短于 3 个字符的名字一律不做模糊匹配；
 *     ② 允许的编辑距离随名字长度收紧（长名字才允许错 2 个字符）。
 * @returns {{level:string, score:number}|null}
 */
export function cellLevel(value, ref, { maxDistance = 2 } = {}) {
  const a = String(value ?? '');
  const b = String(ref ?? '').trim();
  if (!b || !a) return null;
  if (a === b) return { level: 'exact', score: LEVEL_SCORE.exact };

  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return null;
  if (na === nb) return { level: 'normalized', score: LEVEL_SCORE.normalized };

  if (na.includes(nb) || nb.includes(na)) {
    const ratio = Math.min(na.length, nb.length) / Math.max(na.length, nb.length);
    // 包含匹配也要求被包含的一方至少有 2 个字符，且不能只占极小比例
    if (Math.min(na.length, nb.length) >= 2 && ratio >= 0.34) {
      return { level: 'contains', score: LEVEL_SCORE.contains + Math.round(ratio * 100) };
    }
  }

  // 模糊匹配按名字长度分档收紧：
  //   2~3 字：只允许错 1 个字符（这样「左炫」能救回「左玄」，但「左玄」不会命中「女」）
  //   4 字以上：允许错到 min(配置上限, 长度/3)——4 字只允许 1 个，6 字才允许 2 个
  const minLen = Math.min(na.length, nb.length);
  if (minLen < 2) return null;
  const allowed = minLen <= 3
    ? Math.min(1, maxDistance)
    : Math.min(maxDistance, Math.floor(minLen / 3));
  if (allowed <= 0) return null;
  const d = editDistance(na, nb, allowed);
  if (d <= allowed) return { level: 'distance', score: LEVEL_SCORE.distance - d * 10 };
  return null;
}

/** 在一列里找候选（按分数降序） */
export function matchInColumn(rows, colIndex, ref, opts = {}) {
  const out = [];
  (rows ?? []).forEach((row, i) => {
    const v = row?.[colIndex];
    const m = cellLevel(v, ref, opts);
    if (m) out.push({ index: i, value: String(v ?? ''), ...m });
  });
  return out.sort((a, b) => b.score - a.score || a.index - b.index);
}

/**
 * 定位一行。
 * @param {number} no 表号
 * @param {Array<Array<string>>} rows
 * @param {string|number} ref 主键值；复合键表（表5）支持 "A|B" 或只给 A
 * @returns {{index:number, value:string, level:string, ambiguous:boolean, candidates:Array, matchedColumns:string[]}|null}
 */
export function matchRow(no, rows, ref, { maxDistance = 2 } = {}) {
  /* 【回滚 · 审计员这条说错了】JS 默认参数只对 `undefined` 生效 ✓ 对显式传的 `0` **不生效** ✓
     所以原来这个写法本来就对（传 0 = 关掉模糊匹配 ✓）✗ 我改成 opts 是多此一举 ✓ 已还原 ✓ */
  const t = getTable(no);
  if (!t || !rows?.length || ref == null || ref === '') return null;

  const ks = keyColumns(no);
  const refStr = String(ref).trim();

  // 复合键：拆开逐个匹配，要求每个分量都能命中
  if (ks.length > 1 && refStr.includes('|')) {
    const parts = refStr.split('|').map((s) => s.trim()).filter(Boolean);
    const scored = [];
    rows.forEach((row, i) => {
      let worst = null;
      for (let k = 0; k < ks.length; k++) {
        const part = parts[k] ?? parts[0];
        const m = cellLevel(row?.[ks[k]], part, { maxDistance });
        if (!m) return;                       // 任一分量不匹配 → 该行淘汰
        if (!worst || m.score < worst.score) worst = m;
      }
      if (worst) scored.push({ index: i, value: ks.map((c) => row?.[c] ?? '').join('|'), ...worst });
    });
    if (!scored.length) return null;
    scored.sort((a, b) => b.score - a.score || a.index - b.index);
    const ambiguous = scored.length > 1 && scored[0].score === scored[1].score;
    return { ...scored[0], ambiguous, candidates: scored, matchedColumns: ks.map((c) => t.columns[c]) };
  }

  // 单主键：先按主键列
  const primary = ks[0] ?? 0;
  let list = matchInColumn(rows, primary, ref, { maxDistance });

  // 兜底：模型可能把非主键列当定位键给了（例如用"角色名"以外的唯一列）。
  // 注意：兜底只接受**精确/归一化**命中 —— 不在这里做模糊，
  // 否则「左玄」会以编辑距离=2 命中别人的「女」，把新建写成覆盖。
  if (!list.length) {
    for (let c = 0; c < t.columns.length; c++) {
      if (c === primary) continue;
      const alt = [];
      rows.forEach((row, i) => {
        const m = cellLevel(row?.[c], ref, { maxDistance: 0 });   // maxDistance:0 → 只允许 exact/normalized
        if (m && (m.level === 'exact' || m.level === 'normalized')) {
          alt.push({ index: i, value: String(row?.[c] ?? ''), ...m });
        }
      });
      if (alt.length) {
        alt.sort((a, b) => b.score - a.score || a.index - b.index);
        return {
          index: alt[0].index,
          value: alt[0].value,
          level: alt[0].level,
          ambiguous: alt.length > 1 && alt[0].score === alt[1].score,
          candidates: alt,
          matchedColumns: [t.columns[c]],
        };
      }
    }
    return null;
  }

  const ambiguous = list.length > 1 && list[0].score === list[1].score && list[0].level !== 'exact';
  return { ...list[0], ambiguous, candidates: list, matchedColumns: [t.columns[primary]] };
}

/** 列定位：先走 schema 的精确/归一化，再走包含/编辑距离 */
export function matchColumn(no, ref, { maxDistance = 2 } = {}) {
  const direct = resolveColumn(no, ref);
  if (direct) return { index: direct.index, name: direct.name, level: direct.by };
  const t = getTable(no);
  if (!t) return null;
  const list = matchInColumn([t.columns], 0, ref, { maxDistance });
  if (!list.length) return null;
  const hit = list[0];
  return { index: hit.index, name: t.columns[hit.index], level: hit.level };
}

/** 表定位：表号 / 表名 / 归一化表名 / 包含 / 编辑距离 */
export function matchTable(ref) {
  if (ref == null) return null;
  if (typeof ref === 'number' || /^\d+$/.test(String(ref))) return getTable(Number(ref));
  const direct = getTable(String(ref));
  if (direct) return direct;

  const needle = normalize(ref);
  let best = null;
  let bestD = Infinity;
  for (const t of getTables()) {
    const n = normalize(t.name);
    if (n === needle) return t;
    if (needle && n && (n.includes(needle) || needle.includes(n))) return t;
    const d = editDistance(n, needle, 3);
    if (d < bestD) { bestD = d; best = t; }
  }
  return bestD <= 3 ? best : null;
}

/** 找一列里所有非空值（给提示词/UI 列出候选主键用） */
export function listKeys(no) {
  const t = getTable(no);
  if (!t) return [];
  const idx = keyColumns(no);
  return (allRows(no)).map((row) => idx.map((i) => String(row?.[i] ?? '')).join('|')).filter((s) => s.replace(/\|/g, ''));
}

// 单独引入以免上面的 import 顺序影响 tree-shaking 判断
function allRows(no) {
  // 这里不直接依赖 store，由调用方注入 rows 更干净；保留空实现会被上层替换
  return _rowsProvider ? _rowsProvider(no) : [];
}

let _rowsProvider = null;
/** 注入行数据来源（避免 match → store → schema 的循环依赖） */
export function setRowsProvider(fn) {
  _rowsProvider = fn;
}
