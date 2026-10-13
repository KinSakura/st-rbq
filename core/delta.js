/**
 * core/delta.js —— 按楼层算"这一层改了什么"，并支持【只撤销这一层】
 *
 * 为什么需要它：删除**中间**某层时，正确语义是"只撤销那一层写进去的东西"✓，
 *   后面的层还得留着 ✓（例：甲/乙/丙 三层，删掉中间的乙 → 应该是 甲 + 丙 ✓）
 * 以前我是"还原到被删层的 before 快照"✗ → 把后面的层也一起丢了 ✗
 *
 * 做法（不新增存储 ✓）：每层本来就存了 `beforeSnapshot` / `afterSnapshot` ✓，
 *   两者的差 = 那一层改动的单元格与行 ✓ → 反着应用一遍 = 精确撤销那一层 ✓✓
 *
 * 【v2.11.2 审计重写】以前有两个真 bug ✗：
 *   ① 只遍历 after 的行 ✗ → "before 里有的行、after 里没了"（= 这一层删掉的行）
 *      完全没被识别 → 撤销时那行不会回来 ✓
 *   ② 还原单元格时用的是 **after 快照里的行下标** ✗ → 一旦这一层增删过行，
 *      下标就错位 → 会把值写到别的行上（实测四种用例全错 ✓）
 *   现在改成 **按主键对齐** ✓（主键列取自 schema，支持表5 这种复合主键 ✓）
 *   并显式记录三种差异：new（新增行）/ gone（删除行）/ cell（改单元格 ✓）
 */
import * as store from './store.js';
import { keyColumns } from './schema.js';

/** 把快照（JSON 字符串）解析成 { 表号: rows[] } */
function parseSnap(snap) {
  if (!snap) return null;
  try { return JSON.parse(String(snap)); } catch (e) { return null; }
}

/** 取某张表的主键列（拿不到就当第 0 列 ✓） */
function keysOf(no) {
  try {
    const ks = keyColumns(Number(no));
    if (Array.isArray(ks) && ks.length) return ks;
  } catch (e) { /* ignore */ }
  return [0];
}

/** 一行按主键拼出的稳定键（复合主键用 \u0001 连接 ✓） */
function rowKey(no, row) {
  const ks = keysOf(no);
  return ks.map((c) => String(row?.[c] ?? '').trim()).join('\u0001');
}

/** 看一行是不是"空行"（全空的行不参与比较 ✓ 酒馆里会留占位空行 ✓） */
function isBlank(row) {
  if (!Array.isArray(row)) return true;
  return row.every((c) => String(c ?? '').trim() === '');
}

/**
 * 算两快照之间的差异
 * @returns {{table:number, kind:'new'|'gone'|'cell', key:string, row:number, col:number, before:string, after:string, rowBefore:any[]|null}[]}
 *   · kind='new'  这一层**新建**的行（撤销 = 删掉它 ✓）row = after 里的下标
 *   · kind='gone' 这一层**删掉**的行（撤销 = 把它插回来 ✓）rowBefore = before 里那一行
 *   · kind='cell' 只是改了某个格子（撤销 = 写回 before 的值 ✓）
 *   （为兼容老调用方，仍保留 row/col/before/after 字段 ✓）
 */
export function diffSnapshots(beforeSnap, afterSnap) {
  const a = parseSnap(beforeSnap) ?? {};
  const b = parseSnap(afterSnap) ?? {};
  const out = [];
  const tables = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const t of tables) {
    const no = Number(t);
    const ra = (a[t]?.rows ?? []).filter((r) => !isBlank(r));
    const rb = (b[t]?.rows ?? []).filter((r) => !isBlank(r));
    const mapA = new Map();
    ra.forEach((r, i) => { if (!mapA.has(rowKey(no, r))) mapA.set(rowKey(no, r), r); });
    const mapB = new Map();
    rb.forEach((r, i) => { if (!mapB.has(rowKey(no, r))) mapB.set(rowKey(no, r), r); });

    /* ① after 有、before 没有 → 这一层新建的行 ✓ */
    for (let i = 0; i < rb.length; i++) {
      const r2 = rb[i];
      const k = rowKey(no, r2);
      if (mapA.has(k)) continue;
      out.push({ table: no, kind: 'new', key: k, row: i, col: -1, before: '', after: k, rowBefore: null, rowAfter: r2 });
    }
    /* ② before 有、after 没有 → 这一层删掉的行 ✓（以前完全漏了 ✗） */
    for (let i = 0; i < ra.length; i++) {
      const r1 = ra[i];
      const k = rowKey(no, r1);
      if (mapB.has(k)) continue;
      out.push({ table: no, kind: 'gone', key: k, row: i, col: -2, before: k, after: '', rowBefore: r1, rowAfter: null });
    }
    /* ③ 两边都有 → 逐格比（按主键配对 ✓ 不再按行下标 ✗） */
    for (const [k, r2] of mapB) {
      const r1 = mapA.get(k);
      if (!r1) continue;
      const len = Math.max(r1?.length ?? 0, r2?.length ?? 0);
      for (let c = 0; c < len; c++) {
        const v1 = String(r1?.[c] ?? '');
        const v2 = String(r2?.[c] ?? '');
        if (v1 !== v2) out.push({ table: no, kind: 'cell', key: k, row: -1, col: c, before: v1, after: v2, rowBefore: r1, rowAfter: r2 });
      }
    }
  }
  return out;
}

/**
 * 只撤销"某一层"的改动（用它的 before/after 快照算差 ✓）
 *   后面那些层的数据会被保留 ✓✓
 * @returns {{reverted:number, deletedRows:number, restoredRows:number}}
 */
export async function revertFloorDelta(beforeSnap, afterSnap) {
  const diff = diffSnapshots(beforeSnap, afterSnap);
  if (!diff.length) return { reverted: 0, deletedRows: 0, restoredRows: 0 };
  let reverted = 0;
  let deletedRows = 0;
  let restoredRows = 0;

  /* 按表分组，一张表只读写一次（快 + 少闪 ✓） */
  const byTable = new Map();
  for (const d of diff) {
    if (!byTable.has(d.table)) byTable.set(d.table, []);
    byTable.get(d.table).push(d);
  }

  for (const [no, list] of byTable) {
    let rows = (() => { try { return (store.getRows(no, { create: false }) ?? []).slice().map((r) => (Array.isArray(r) ? r.slice() : r)); } catch (e) { return []; } })();
    if (!Array.isArray(rows)) rows = [];

    /* ① 删掉这一层新建的行（按主键找 ✓ 不按下标 ✗） */
    const news = list.filter((d) => d.kind === 'new');
    for (const d of news) {
      const i = rows.findIndex((r) => rowKey(no, r) === d.key);
      if (i >= 0) { rows.splice(i, 1); deletedRows++; }
    }
    /* ② 把这层删掉的行插回来（尽量放回原来的位置 ✓） */
    const gones = list.filter((d) => d.kind === 'gone').sort((x, y) => Number(x.row) - Number(y.row));
    for (const d of gones) {
      if (rows.some((r) => rowKey(no, r) === d.key)) continue;   // 后面某层又建回来了 → 不动 ✓
      const at = Math.max(0, Math.min(rows.length, Number(d.row) || 0));
      rows.splice(at, 0, (d.rowBefore ?? []).slice());
      restoredRows++;
    }
    /* ③ 把改过的格子写回 before 的值（按主键找行 ✓ 不按下标 ✗） */
    const cells = list.filter((d) => d.kind === 'cell');
    for (const d of cells) {
      const i = rows.findIndex((r) => rowKey(no, r) === d.key);
      if (i < 0) continue;                                       // 这行已经不在了（后面某层删了）→ 不动 ✓
      const row = rows[i];
      while (row.length <= d.col) row.push('');
      if (String(row[d.col] ?? '') === String(d.before ?? '')) continue;
      row[d.col] = d.before;
      reverted++;
    }
    try { store.setRows(no, rows); } catch (e) { /* ignore */ }
  }

  try { await store.commit({ persist: true }); } catch (e) { /* ignore */ }
  console.log('[RBQ] 已只撤销该层的 ' + reverted + ' 个单元格 / ' + deletedRows + ' 行新增 / ' + restoredRows + ' 行删除（后面的层保留 ✓）');
  return { reverted, deletedRows, restoredRows };
}
