/**
 * txn.js —— 写入事务
 *
 * 设计要点（对应痛点 ① 与 ②）：
 *  1. **先全量解析与校验，再动手**。每条 op 必须解析出 表/行/列 才有资格被写。
 *  2. **逐条应用**（applyPartial）而非整批拒绝：成功多少写多少，失败条目带原因返回，
 *     交给上层进"待确认队列"或做定向修复。原子模式仍可用。
 *  3. **单例表**（表0 宏观时空 / 表6 剧情大纲）永远只有一行：insert/upsert/update 一律并入第 0 行。
 *  4. **关键列保护**：插入新行时自动补上主键值；更新已有行时**绝不改写主键**
 *     （否则模型写错一个字就会把正确的主键覆盖掉）。
 *  5. **撤销**：只对本次真正改动的表保存改动前的整表行。回滚靠它，不靠文本标记。
 *  6. 本模块不碰 DOM、不写消息，便于在 Node 里单测。
 */

import { getTable, keyColumns, isSingleton } from './schema.js';
import { matchTable, matchRow } from './match.js';
import { resolveAttr } from './alias.js';
import { cellStr, clone } from './util.js';
import { chat, saveChat } from './ctx.js';
import * as store from './store.js';

/* ------------------------------------------------------------------ 操作名 */

const OP_ALIASES = {
  set: 'set', setcell: 'set', cell: 'set',
  update: 'update', updaterow: 'update', edit: 'update',
  insert: 'insert', insertrow: 'insert', add: 'insert', new: 'insert',
  upsert: 'upsert', merge: 'upsert',
  delete: 'delete', deleterow: 'delete', remove: 'delete',
  replace: 'replace', replacetable: 'replace',
  delta: 'delta', inc: 'delta', dec: 'delta', addto: 'delta', adjust: 'delta',
};

function normOpName(name) {
  return OP_ALIASES[String(name ?? '').trim().toLowerCase().replace(/[\s_-]/g, '')] ?? null;
}

function maxDist() {
  // 面板上的「模糊匹配」总开关：关掉就只认精确（距离上限压到 0）
  // 之前面板写的是 fuzzyMatch、代码读的是 fuzzyMaxDistance，两个名字对不上 → 开关是假的
  if (store.getConfigValue('dataProtocol.fuzzyMatch', true) === false) return 0;
  return store.getConfigValue('dataProtocol.fuzzyMaxDistance', 2);
}

/** HP/MP/SP/等级 这类取整，其它保留一位小数 */
function roundNum(n, colName = '') {
  if (!Number.isFinite(n)) return 0;
  if (/HP|MP|SP|等级|年龄|层数|数量|耐久/i.test(colName)) return Math.round(n);
  return Math.round(n * 10) / 10;
}

/* ------------------------------------------------------------------ 解析 */

/**
 * 解析并校验单条 op（不改任何数据）
 * @returns {{ok:true, ...}|{ok:false, reason:string, detail?:string, candidates?:Array}}
 */
export function resolveOp(op, opts = {}) {
  if (!op || typeof op !== 'object') return { ok: false, reason: 'empty-op' };

  const kind = normOpName(op.op ?? op.type ?? op.action);
  if (!kind) return { ok: false, reason: 'unknown-op', detail: String(op.op ?? op.type ?? op.action ?? '') };

  const table = matchTable(op.table ?? op.tableIndex ?? op.no ?? op.sheet);
  if (!table) return { ok: false, reason: 'unknown-table', detail: String(op.table ?? op.tableIndex ?? op.no ?? op.sheet ?? '') };
  const no = table.no;
  const rows = store.getRows(no, { create: false });
  const dist = opts.maxDistance ?? maxDist();
  const cols = table.columns;

  /* ---- replace：整表替换 ---- */
  if (kind === 'replace') {
    // 配置允许、或这一条 op 自己声明允许（审查的内部修复用后者）
    const allowed = opts.allowReplace === true || op.allowReplace === true
      || store.getConfigValue('dataProtocol.allowReplace', false) === true;
    if (!allowed) return { ok: false, reason: 'replace-not-allowed' };
    const raw = op.rows ?? op.values ?? [];
    if (!Array.isArray(raw)) return { ok: false, reason: 'replace-needs-array' };
    return { ok: true, kind, no, rows: raw.map((r) => normalizeRow(no, r))  };
  }

  /* ---- delta：数值增减 ---- */
  if (kind === 'delta') {
    const colRef = op.col ?? op.column ?? (op.values ? Object.keys(op.values)[0] : null);
    const col = resolveAttr(no, colRef, { maxDistance: dist });
    if (!col) return { ok: false, reason: 'unknown-column', detail: String(colRef ?? '') };

    const rowRef = op.row ?? op.key ?? op.name ?? op.id ?? op.who;
    let rowIndex = null;
    if (rowRef == null || String(rowRef) === '') {
      if (table.singleton && rows.length === 1) rowIndex = 0;
    } else {
      const m = matchRow(no, rows, rowRef, { maxDistance: dist });
      if (m) rowIndex = m.index;
      else if (table.singleton && rows.length === 1) rowIndex = 0;
    }
    if (rowIndex == null) return { ok: false, reason: 'row-not-found', detail: String(rowRef ?? '') };

    let by = op.by ?? op.change ?? op.delta;
    if (by == null && op.values && typeof op.values === 'object') by = Object.values(op.values)[0];
    const amount = Number(by);
    if (!Number.isFinite(amount)) return { ok: false, reason: 'delta-not-a-number', detail: String(by ?? '') };

    const current = Number(String(rows[rowIndex]?.[col.index] ?? '').replace(/[^\d.+-]/g, '')) || 0;
    const next = op.absolute === true ? amount : current + amount;
    return {
      ok: true, kind: 'update', no, rowIndex, matchedBy: 'delta',
      values: [{ index: col.index, name: cols[col.index], value: String(roundNum(next, cols[col.index])) }],
      note: 'delta',
    };
  }

  /* ---- 解析 values ---- */
  const valuesRaw = op.values ?? op.set ?? op.data
    ?? (kind === 'set' ? { [op.col ?? op.column]: op.value } : null);
  const resolved = [];
  if (kind !== 'delete') {
    if (!valuesRaw || typeof valuesRaw !== 'object') return { ok: false, reason: 'missing-values' };
    for (const [colRef, val] of Object.entries(valuesRaw)) {
      const col = resolveAttr(no, colRef, { maxDistance: dist });
      if (!col) return { ok: false, reason: 'unknown-column', detail: String(colRef) };
      resolved.push({ index: col.index, name: cols[col.index], value: cellStr(val) });
    }
    if (!resolved.length) return { ok: false, reason: 'missing-values' };
  }

  /* ---- 单例表：永远只有一行 ---- */
  if (table.singleton) {
    if (kind === 'delete') {
      if (!rows.length) return { ok: false, reason: 'row-not-found', detail: '单例表无行可删' };
      return { ok: true, kind: 'delete', no, rowIndex: 0, note: 'singleton' };
    }
    return rows.length
      ? { ok: true, kind: 'update', no, rowIndex: 0, values: stripKeys(no, resolved), note: 'singleton-merge' }
      : { ok: true, kind: 'insert', no, values: ensureKeys(no, resolved, op.row ?? op.name ?? null), at: 0, note: 'singleton-create' };
  }

  /* ---- 普通表 ---- */
  const rowRef = op.row ?? op.key ?? op.name ?? op.id ?? op.who ?? null;

  // UI 按行下标编辑（行号 = 下标）
  if (rowRef == null && op.rowIndex != null) {
    const ri = Number(op.rowIndex);
    if (!Number.isInteger(ri) || ri < 0) {
      return { ok: false, reason: 'row-not-found', detail: `rowIndex=${op.rowIndex}` };
    }
    if (kind === 'delete') {
      if (ri >= rows.length) return { ok: false, reason: 'row-not-found', detail: `rowIndex=${op.rowIndex}` };
      return { ok: true, kind: 'delete', no, rowIndex: ri, matchedBy: 'index' };
    }
    if (kind === 'delta') return { ok: false, reason: 'delta-needs-row' };
    if (ri >= rows.length) {
      // 行号越界 → 降级为追加一行
      if (kind === 'upsert') {
        return { ok: true, kind: 'insert', no, values: resolved, at: null, note: 'legacy-out-of-range-insert' };
      }
      return { ok: false, reason: 'row-not-found', detail: `rowIndex=${op.rowIndex}（共 ${rows.length} 行）` };
    }
    return {
      ok: true,
      kind: kind === 'insert' ? 'insert' : 'update',
      no,
      rowIndex: ri,
      values: resolved,
      matchedBy: 'index',
    };
  }

  if (kind === 'insert') {
    return { ok: true, kind: 'insert', no, values: ensureKeys(no, resolved, rowRef), at: op.at ?? null };
  }

  if (kind === 'upsert') {
    const m = (rowRef == null || String(rowRef) === '') ? null : matchRow(no, rows, rowRef, { maxDistance: dist });
    if (m) {
      if (m.ambiguous && opts.strict !== false) {
        return { ok: false, reason: 'row-ambiguous', detail: String(rowRef), candidates: m.candidates.slice(0, 5) };
      }
      // 命中已有行 → 更新，且**不改写主键**
      return { ok: true, kind: 'update', no, rowIndex: m.index, values: stripKeys(no, resolved), matchedBy: m.level, note: 'upsert-hit'  };
    }
    return { ok: true, kind: 'insert', no, values: ensureKeys(no, resolved, rowRef), at: op.at ?? null, note: 'upsert-miss' };
  }

  // update / set / delete 必须有行
  if (rowRef == null || String(rowRef) === '') return { ok: false, reason: 'missing-row' };
  const m = matchRow(no, rows, rowRef, { maxDistance: dist });
  if (!m) return { ok: false, reason: 'row-not-found', detail: String(rowRef) };
  if (m.ambiguous && opts.strict !== false) {
    return { ok: false, reason: 'row-ambiguous', detail: String(rowRef), candidates: m.candidates.slice(0, 5) };
  }
  if (kind === 'delete') return { ok: true, kind: 'delete', no, rowIndex: m.index, matchedBy: m.level };
  return { ok: true, kind: 'update', no, rowIndex: m.index, values: stripKeys(no, resolved), matchedBy: m.level  };
}

/**
 * 更新已有行时去掉主键列，避免模型写错名字反而把正确主键覆盖掉。
 * 例外：**单例表**（表0 宏观时空 / 表6 剧情大纲）只有一行，永远不会有"行冲突"，
 * 而它们的第一列恰恰是必须能改的计数器/目标（系统轮次、终极宏愿）——
 * 否则轮次永远停在初始值。
 */
function stripKeys(no, values) {
  if (isSingleton(no)) return values.slice();
  const ks = keyColumns(no);
  return values.filter((v) => !ks.includes(v.index));
}

/** 插入新行时补上主键列 */
function ensureKeys(no, values, rowRef) {
  const ks = keyColumns(no);
  const out = [...values];
  if (ks.length !== 1) return out;                 // 复合键由上层显式给（表5 的 from/to）
  const ki = ks[0];
  if (out.some((v) => v.index === ki)) return out;
  const t = getTable(no);
  const keyVal = rowRef == null ? '' : String(rowRef).trim();
  if (keyVal) { out.push({ index: ki, name: t?.columns?.[ki] ?? String(ki), value: keyVal, by: 'key' }); return out; }
  /* 兜底：单主键表没给键时给一个可读默认名（覆盖率实测：表12「纪元封包名」一直空着） */
  try {
    const colName = String(t?.columns?.[ki] ?? "");
    const rows = (typeof getRows === 'function') ? getRows(no, { create: false }) : [];
    const prefix = /纪元|封包/.test(colName) ? '纪元' : (/篇章|章节/.test(colName) ? '篇章' : '未命名');
    out.push({ index: ki, name: colName || String(ki), value: prefix + (rows.length + 1), by: 'key-default' });
  } catch (e) { /* ignore */ }
  return out;
}

function normalizeRow(no, r) {
  const t = getTable(no);
  const width = t?.columns.length ?? 0;
  const arr = Array.isArray(r) ? r.map(cellStr) : [];
  while (arr.length < width) arr.push('');
  return arr.slice(0, width);
}

/** 批量解析（dry-run），返回与 ops 等长的结果 */
export function resolveOps(ops, opts = {}) {
  return (ops ?? []).map((op, i) => {
    try {
      return { ...resolveOp(op, opts), index: i, op };
    } catch (e) {
      return { ok: false, index: i, op, reason: 'exception', detail: e?.message ?? String(e) };
    }
  });
}

/* ------------------------------------------------------------------ 应用 */

/**
 * 应用一批 op。
 * @param {Array<object>} ops
 * @param {object} [opts]
 * @param {boolean} [opts.atomic] true=全成功才写；缺省取配置 dataProtocol.applyPartial 的反
 * @param {number}  [opts.messageIndex] 锚点写在哪条消息（缺省=最新 AI 消息）
 * @param {string}  [opts.roundId]
 * @param {string}  [opts.source] 'data' | 'manual' | 'review' | 'repair'
 * @param {boolean} [opts.persist] 是否 saveChat（默认 true）
 * @param {boolean} [opts.dryRun]  只解析不写
 */
export async function applyOps(ops, opts = {}) {
  /* 【最低层硬拦】冻结期内除了白名单来源，一律不写表 ✓
     （只在上层入口加守卫靠不住 —— 实测总有漏的路径，比如 derived-recalc ✗） */
  try {
    const fz = await import("./freeze.js");
    /* 用户点了「终止」→ 侧路后续的写入全部拦下 ✓（回滚/清理类白名单除外 ✓）
       否则会出现"点了终止、侧路照样把数据写进去"（用户实测 ✗） */
    if (fz.isAbortRequested && fz.isAbortRequested() && !fz.allowedWhileFrozen(opts.source)) {
      console.log("[RBQ] 用户已中止，拦截写入（来源 " + String(opts.source ?? "?") + "）");
      return { applied: 0, failed: [], aborted: true };
    }
    if (fz.isFrozen() && !fz.allowedWhileFrozen(opts.source)) {
      console.log("[RBQ] 冻结期内，拦截写入（来源 " + String(opts.source ?? "?") + "，共 " + (ops ?? []).length + " 条）");
      return { applied: 0, failed: [], frozen: true, rev: (() => { try { return store.getRev(); } catch (e) { return 0; } })() };
    }
  } catch (e) { /* ignore */ }
  /* 写入溯源（只在控制台里开了 window.__rbqTraceWrites = true 时记录 ✓）
     用途：排查"回滚之后谁又把数据写回来了" —— 每条写入记来源+时间+涉及表 ✓ */
  try {
    if (typeof window !== "undefined" && window.__rbqTraceWrites) {
      (window.__rbqWriteLog ??= []).push({
        at: Date.now(),
        source: String(opts.source ?? "?"),
        tables: [...new Set((ops ?? []).map((o) => Number(o.no)))] .join(","),
        frozen: (() => { try { return !!opts.__frozen; } catch (e) { return false; } })(),
      });
    }
  } catch (e) { /* ignore */ }
  const list = Array.isArray(ops) ? ops : [];
  const partial = opts.atomic === true ? false
    : opts.atomic === false ? true
      : store.getConfigValue('dataProtocol.applyPartial', true);

  const resolved = resolveOps(list, { maxDistance: opts.maxDistance ?? maxDist() });
  const okList = resolved.filter((r) => r.ok);
  const failed = resolved.filter((r) => !r.ok).map((f) => ({
    index: f.index, op: f.op, reason: f.reason, detail: f.detail, candidates: f.candidates,
  }));

  const result = {
    ok: failed.length === 0,
    applied: 0,
    failed,
    affected: [],
    warnings: [],
    dryRun: !!opts.dryRun,
    rev: store.getRev(),
  };

  if (opts.dryRun) {
    result.applied = okList.length;
    result.affected = [...new Set(okList.map((r) => r.no))];
    return result;
  }

  if (!partial && failed.length > 0) {
    result.ok = false;
    result.applied = 0;
    return result;
  }

  // 快照受影响表的改动前数据（撤销用）
  const affectedNos = [...new Set(okList.map((r) => r.no))];
  const undo = {};
  for (const no of affectedNos) {
    const rows = store.getRows(no, { create: false });
    undo[String(no)] = rows.length ? clone(rows) : null;
  }

  // 逐条应用（同一批内后一条能看到前一条的结果 —— 例如先 insert 再 update）
  const audit = [];
  for (const r of okList) {
    try {
      applyOne(r);
      result.applied++;
      audit.push({
        op: r.kind, table: r.no, tableName: getTable(r.no)?.name,
        row: r.rowIndex ?? r.at ?? null, matchedBy: r.matchedBy, note: r.note,
        tag: r.op?.__tag, source: r.op?.__from ?? opts.source,
      });
    } catch (e) {
      failed.push({ index: r.index, op: r.op, reason: 'apply-exception', detail: e?.message ?? String(e) });
      result.warnings.push(`写入第 ${r.index} 条时出错：${e?.message ?? e}`);
      if (!partial) break;
    }
  }

  result.ok = failed.length === 0;
  result.affected = affectedNos;

  if (result.applied > 0) {
    // 记录本楼到底改了哪些表（移植 shukuju 的 modifiedKeys / updateGroupKeys）
  try {
    const touched = [...new Set(okList.map((r) => Number(r.no)).filter((n) => Number.isFinite(n)))];
    const aiFloor = (() => { try { return chat().filter((m) => m && !m.is_user).length; } catch { return 0; } })();
    for (const no of touched) {
      const cols = [...new Set(okList.filter((r) => Number(r.no) === no).flatMap((r) => Object.keys(r.values ?? r.op?.values ?? {})))];
      store.setTableMeta(no, { lastUpdatedAiFloor: aiFloor, fromBaseState: false, modifiedKeys: cols });
    }
    result.modifiedKeys = touched.map(String);
  } catch (e) { console.warn("[RBQ] 记录 modifiedKeys 失败", e); }

  result.rev = await store.commit({
    modifiedKeys: result.modifiedKeys ?? [],
      messageIndex: opts.messageIndex,
      undo,
      audit,
      ops: list,
      roundId: opts.roundId,
      persist: opts.persist !== false,
    });
  }

  return result;
}

function applyOne(r) {
  const rows = store.getRows(r.no);
  const width = getTable(r.no)?.columns.length ?? 0;

  switch (r.kind) {
    case 'insert': {
      const row = new Array(width).fill('');
      for (const v of r.values) row[v.index] = v.value;

      // 同一批里可能有多条 op 针对还没落地的行（解析期看到的是批前状态），
      // 因此这里做两层幂等保护：
      //   ① 单例表：永远并入第 0 行，不新增
      //   ② 普通表：若已存在"主键完全相同"的行，则并入而不是新增（防止同一实体被建两次档）
      if (isSingleton(r.no)) {
        if (rows.length > 0) {
          const target = rows[0];
          while (target.length < width) target.push('');
          for (const v of r.values) target[v.index] = v.value;
          return;
        }
        r.at = 0;
      } else {
        const hit = findRowByExactKey(r.no, rows, r.values);
        if (hit != null) {
          const target = rows[hit];
          while (target.length < width) target.push('');
          for (const v of r.values) target[v.index] = v.value;
          return;
        }
      }

      if (r.at != null && Number.isFinite(Number(r.at))) {
        const at = Math.max(0, Math.min(rows.length, Number(r.at)));
        rows.splice(at, 0, row);
      } else {
        rows.push(row);
      }
      return;
    }
    case 'update': {
      const row = rows[r.rowIndex];
      if (!row) throw new Error(`行 ${r.rowIndex} 不存在`);
      while (row.length < width) row.push('');
      for (const v of r.values) row[v.index] = v.value;
      return;
    }
    case 'delete': {
      if (r.rowIndex < 0 || r.rowIndex >= rows.length) throw new Error(`行 ${r.rowIndex} 越界`);
      rows.splice(r.rowIndex, 1);
      return;
    }
    case 'replace': {
      const next = r.rows.map((x) => normalizeRow(r.no, x));
      rows.length = 0;
      rows.push(...next);
      return;
    }
    default:
      throw new Error(`未实现的操作类型 ${r.kind}`);
  }
}

/** 在已有行里找"主键完全一致"的行（用于 insert 的幂等保护） */
function findRowByExactKey(no, rows, values) {
  const ks = keyColumns(no);
  if (!ks.length) return null;
  const want = ks.map((ki) => {
    const v = values.find((x) => x.index === ki);
    return v ? v.value : '';
  });
  if (want.every((w) => w === '')) return null;      // 没给主键，不做保护
  for (let i = 0; i < rows.length; i++) {
    if (ks.every((ki, n) => String(rows[i]?.[ki] ?? '') === want[n])) return i;
  }
  return null;
}

/* ------------------------------------------------------------ 便捷封装 */

export function setCell(no, rowRef, colRef, value, opts = {}) {
  return applyOps([{ op: 'set', table: no, row: rowRef, col: colRef, value }], opts);
}

export function updateRow(no, rowRef, values, opts = {}) {
  return applyOps([{ op: 'update', table: no, row: rowRef, values }], opts);
}

export function insertRow(no, values, opts = {}) {
  return applyOps([{ op: 'insert', table: no, values }], opts);
}

export function deleteRow(no, rowRef, opts = {}) {
  return applyOps([{ op: 'delete', table: no, row: rowRef }], opts);
}

/**
 * 回滚到指定 rev：从最新锚点往回逐条恢复"改动前的数据"。
 */
export async function rollbackTo(targetRev) {
  const plan = store.planRollback(targetRev);
  if (!plan.length) return { ok: false, restored: 0, rev: store.getRev() };

  let restored = 0;
  const c = chat();
  for (const step of plan) {
    for (const [noStr, rows] of Object.entries(step.undo ?? {})) {
      const no = Number(noStr);
      if (rows == null) store.deleteTable(no);
      else store.setRows(no, clone(rows));
      restored++;
    }
    if (c[step.index]) store.clearAnchor(c[step.index]);
  }
  const data = store.getData();
  data.rev = targetRev;
  data.updatedAt = Date.now();
  await saveChat();
  return { ok: true, restored, rev: targetRev };
}
