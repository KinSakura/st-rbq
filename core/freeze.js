/**
 * core/freeze.js —— 表格写入的"冻结开关"（放在中立模块里，sidePipeline 与 txn 都能用 ✓）
 *
 * 为什么需要它：回滚（重新生成 / 删楼层）之后，上一轮侧路的"尾部写入"还会陆续落盘 ✗
 *   （持续收口的 4 秒定时器、延迟重算、补写批次…）→ 会把刚清空的表又写回数据 ✓
 * 实测：不清的话 1 楼重新生成后会残留 4~6 行 ✗（我在测试环境用写入溯源定位到 derived-recalc ✓）
 */
let until = 0;

/** 冻结写入 ms 毫秒（回滚时调用） */
export function freezeFor(ms = 15000) {
  until = Date.now() + Math.max(1000, Number(ms) || 15000);
  try { console.log('[RBQ] 已冻结表格写入 ' + Math.round((until - Date.now()) / 1000) + ' 秒（防止回滚后又被尾部写入填回去）'); } catch (e) { /* ignore */ }
}

export function isFrozen() { return Date.now() < until; }

/** 解冻（测试 / 用户手动恢复时用 ✓） */
export function unfreeze() { until = 0; }

/** 冻结期内允许写的来源白名单（回滚本身、以及用户手动的维护动作 ✓） */
const ALLOW = new Set(['final-fill-restore', 'restore-snapshot', 'rollback', 'final-fill-cleanup', 'final-fill-junk', 'final-fill-placeholder', 'final-fill-dup14']);
export function allowedWhileFrozen(source) { return ALLOW.has(String(source ?? "")); }

/* ================= 用户中止（点进度卡片上的「终止」）=================
   in-flight 那次模型调用断不掉（酒馆的 generateRaw 不接受 AbortSignal ✗），
   所以做法是：**记一个标志** —— 后续任务不再开跑、后续写表一律拦下 ✓
   不然会出现"点了终止、侧路照样跑完、数据照样写进去"（用户实测 ✗） */
let abortRequested = false;
export function requestAbort() { abortRequested = true; try { console.log('[RBQ] 已记录「用户中止」标志：后续任务与写入都会停下'); } catch (e) { /* ignore */ } }
export function isAbortRequested() { return abortRequested; }
export function clearAbort() { abortRequested = false; }
