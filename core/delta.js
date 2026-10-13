/**
 * core/delta.js —— 按楼层算"这一层改了什么"，并支持【只撤销这一层】
 *
 * 为什么需要它：删除**中间**某层时，正确语义是"只撤销那一层写进去的东西"✓，
 *   后面的层还得留着 ✓（例：甲/乙/丙 三层，删掉中间的乙 → 应该是 甲 + 丙 ✓）
 * 以前我是"还原到被删层的 before 快照"✗ → 把后面的层也一起丢了 ✗（用户实测反馈"删楼层还是有问题" ✓）
 *
 * 做法（不新增存储 ✓）：每层本来就存了 `beforeSnapshot` / `afterSnapshot` ✓，
 *   两者的差 = 那一层改动的单元格 ✓ → 反着应用一遍 = 精确撤销那一层 ✓✓
 */
import * as store from './store.js';

/** 把快照（JSON 字符串）解析成 { 表号: rows[] } */
function parseSnap(snap) {
  if (!snap) return null;
  try { return JSON.parse(String(snap)); } catch (e) { return null; }
}

/**
 * 算两快照之间的差异（单元格级）
 * @returns {{table:number, row:number, col:number, before:string, after:string}[]}
 *   row = 行下标（以 after 为准；before 里多的行用 row=-1 表示"这一层新建的行"→ 撤销就是删行）
 */
export function diffSnapshots(beforeSnap, afterSnap) {
  const a = parseSnap(beforeSnap) ?? {};
  const b = parseSnap(afterSnap) ?? {};
  const out = [];
  const tables = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const t of tables) {
    const ra = (a[t]?.rows ?? []);
    const rb = (b[t]?.rows ?? []);
    const keyOf = (r) => String(r?.[0] ?? '');
    // 行数不同也要处理：先把 before 里按主键建索引
    const idxA = new Map();
    ra.forEach((r, i) => idxA.set(keyOf(r), i));
    for (let i = 0; i < rb.length; i++) {
      const r2 = rb[i];
      const k = keyOf(r2);
      const i1 = idxA.has(k) ? idxA.get(k) : -1;
      if (i1 < 0) {
        // 这一层新建的行 ✓（撤销 = 删掉它 ✓）
        out.push({ table: Number(t), row: i, col: -1, before: '', after: k });
        continue;
      }
      const r1 = ra[i1];
      const len = Math.max(r1?.length ?? 0, r2?.length ?? 0);
      for (let c = 0; c < len; c++) {
        const v1 = String(r1?.[c] ?? '');
        const v2 = String(r2?.[c] ?? '');
        if (v1 !== v2) out.push({ table: Number(t), row: i, col: c, before: v1, after: v2 });
      }
    }
  }
  return out;
}

/**
 * 只撤销"某一层"的改动（用它的 before/after 快照算差 ✓）
 *   后面那些层的数据会被保留 ✓✓
 * @returns {{reverted:number, deletedRows:number}}
 */
export async function revertFloorDelta(beforeSnap, afterSnap) {
  const diff = diffSnapshots(beforeSnap, afterSnap);
  if (!diff.length) return { reverted: 0, deletedRows: 0 };
  let reverted = 0;
  let deletedRows = 0;
  // 删行要**从后往前**做，避免下标错位 ✓
  const del = diff.filter((d) => d.col === -1).sort((x, y) => y.row - x.row);
  for (const d of del) {
    try {
      const rows = (store.getRows(d.table, { create: false }) ?? []).slice();
      // 按主键找到当前行（下标可能已经变了 ✓）
      const k = String(d.after ?? '');
      const now = rows.findIndex((r) => String(r?.[0] ?? '') === k);
      if (now >= 0) { rows.splice(now, 1); store.setRows(d.table, rows); deletedRows++; }
    } catch (e) { /* ignore */ }
  }
  // 单元格还原
  for (const d of diff) {
    if (d.col === -1) continue;
    try {
      const rows = (store.getRows(d.table, { create: false }) ?? []).slice();
      const tgt = rows[d.row];
      if (!tgt) continue;
      while (tgt.length <= d.col) tgt.push('');
      if (String(tgt[d.col] ?? '') === String(d.before ?? '')) continue;
      tgt[d.col] = d.before;
      store.setRows(d.table, rows);
      reverted++;
    } catch (e) { /* ignore */ }
  }
  try { await store.commit({ persist: true }); } catch (e) { /* ignore */ }
  console.log('[RBQ] 已只撤销该层的 ' + reverted + ' 个单元格 / ' + deletedRows + ' 行（后面的层保留 ✓）');
  return { reverted, deletedRows };
}
