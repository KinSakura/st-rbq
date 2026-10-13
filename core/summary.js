/**
 * summary.js —— 小总结 / 大总结（对齐用户 RBQ 预设与 rbq.js 的原机制）
 *
 * 用户原有机制（不是调 API 后台生成，而是"AI 自己写、脚本提醒与落库"）：
 *   小总结：AI 每轮在正文末尾追加一段备忘录，包成
 *           <This_round_events><!-- … --></This_round_events>
 *           脚本负责：① 解析出来落库 ② 从可见正文里隐藏
 *   大总结：rbq.js 的轮次提醒 —— 每 50 轮（可配）注入一句提醒，
 *           未到轮次时用原文：【当前未达到大总结轮次，禁止生成大总结】
 */
import * as store from './store.js';
import { cellS } from './cells.js';
import { getTables } from './schema.js';
import { ctx } from './ctx.js';

/** 小总结的标签与正则（照预设原文） */
export const SMALL_TAG = 'This_round_events';
export const SMALL_RE = /<This_round_events>([\s\S]*?)<\/This_round_events>/i;
/** 大总结：默认 50 轮；未达标时的提醒原文（照 rbq.js 常量） */
export const BIG_SUMMARY_DEFAULT_THRESHOLD = 50;
export const BIG_SUMMARY_DISABLED_TEXT = '【当前未达到大总结轮次，禁止生成大总结】';
export const BIG_SUMMARY_READY_TEXT = '【已达到大总结轮次：可以生成大总结】';

/** 原文的整倍数边界提醒（rbq.js _syncReminderVariable） */
export function boundaryReminder(round, threshold, count, range = '') {
  const formatted = 'D' + String(round).padStart(4, '0');
  return `【当前系统轮次已达到 ${formatted}，处于大总结触发阈值 ${threshold} 的整倍数边界。开始第${count}次大总结：只输出 <data> 里的 <epoch …/> 标签（属性名用表12 的中文列名，值写在引号里），为过去 ${threshold} 轮生成大总结，总结范围是 ${range}，详细复盘这期间的死者名单、战略资产获得、派系崩塌及版图变化等，补全表12 的所有列，不要输出别的文字。】`;
}

/* ---------------------------------------------------------------- 小总结 */

/** 把 HTML 注释壳剥掉，拿到备忘录正文 */
export function unwrap(body) {
  let s = String(body ?? '');
  s = s.replace(/<!--/g, '').replace(/-->/g, '');
  return s.split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
}

/** 解析一轮消息里的小总结 */
export function parseSmall(text) {
  const m = SMALL_RE.exec(String(text ?? ''));
  if (!m) return { found: false, body: '', lines: [] };
  const body = unwrap(m[1]);
  const lines = body.split('\n').map((l) => l.replace(/^[-*•·]\s*/, '').trim()).filter(Boolean);
  return { found: true, body, lines, raw: m[0] };
}

/** 从可见正文里隐藏小总结（返回处理后的文本） */
export function stripSmall(text) {
  return String(text ?? '').replace(new RegExp(SMALL_RE.source, 'gi'), '').replace(/\n{3,}/g, '\n\n').trim();
}

/** 正则工坊要用的隐藏脚本（对用户隐藏 <This_round_events> 整块） */
export function hideScript() {
  return { scriptName: 'RBQ-隐藏小总结', findRegex: '/<This_round_events>[\\s\\S]*?<\\/This_round_events>/gsi', replaceString: '', markdownOnly: true, promptOnly: false, placement: [2] };
}

function data() { const d = store.getData({ create: true }); if (!d.summary) d.summary = { events: [] }; return d.summary; }

/** 落库：把这一轮的小总结追加进本轮事件表（按轮次去重）
 *  存在**本聊天**的数据里：`chatMetadata.rbqdb…summary.events` ✓
 *  每轮一条（同轮覆盖 ✓），按轮次排序，最多留 400 条 ✓
 *  msgId = 这条小总结是哪一楼写出来的 ✓（回滚/删楼时要按它清掉 ✓）
 */
export function recordSmall(round, parsed, msgId) {
  if (!parsed?.found) return 0;
  const d = data();
  const key = String(round);
  const item = { round, text: parsed.body, lines: parsed.lines, at: Date.now(), msgId: msgId === undefined ? null : msgId };
  const i = d.events.findIndex((e) => String(e.round) === key);
  if (i >= 0) d.events[i] = item; else d.events.push(item);
  d.events.sort((a, b) => a.round - b.round);
  if (d.events.length > 400) d.events = d.events.slice(-400);
  return d.events.length;
}

/** 【回滚用】删掉某一楼写出来的小总结（重新生成 / 删楼时调 ✓ 不然被删剧情的"小总结"会继续发给 AI ✗） */
export function removeByMsgId(msgId) {
  if (msgId === undefined || msgId === null) return 0;
  const d = data();
  const before = d.events.length;
  d.events = d.events.filter((e) => String(e.msgId ?? '') !== String(msgId));
  return before - d.events.length;
}

/** 【回滚用】按轮次删（没记 msgId 的老数据靠它兜底 ✓） */
export function dropRound(round) {
  const d = data();
  const before = d.events.length;
  d.events = d.events.filter((e) => Number(e.round) !== Number(round));
  return before - d.events.length;
}

/** 【回滚用】删楼层后把事件的 msgId 从旧下标重映射到新下标（不在映射里的=这层被删了 → 丢掉 ✓） */
export function remapMsgIds(map) {
  if (!(map instanceof Map)) return { updated: 0, removed: 0 };
  const d = data();
  let updated = 0; let removed = 0;
  const kept = [];
  for (const e of (Array.isArray(d.events) ? d.events : [])) {
    const id = Number(e.msgId);
    if (!Number.isFinite(id)) { kept.push(e); continue; }
    if (map.has(id)) { if (e.msgId !== map.get(id)) { e.msgId = map.get(id); updated++; } kept.push(e); }
    else { removed++; }
  }
  d.events = kept;
  return { updated, removed };
}

/** 【回滚用】整库清空（删掉唯一那楼 / 清空数据时调 ✓） */
export function clearAll() {
  const d = data();
  const n = (d.events ?? []).length;
  d.events = [];
  return n;
}

/** 取本轮事件（最近的排后面） */
export function listEvents({ limit = 50 } = {}) { const d = data(); return d.events.slice(-limit); }

/** 给 AI 的"最近几轮发生了什么"（接在表格数据后面，防止它忘掉刚发生的事） */
export function recentText({ limit = 5, maxChars = 900 } = {}) {
  const ev = listEvents({ limit });
  if (!ev.length) return '';
  const out = ['## 最近几轮事件（小总结）'];
  let used = 0;
  for (const e of ev.slice().reverse()) {
    const line = `- [第${e.round}轮] ${e.text.replace(/\n/g, '；')}`;
    if (used + line.length > maxChars) break;
    out.push(line);
    used += line.length + 1;
  }
  return out.join('\n');
}

/* ---------------------------------------------------------------- 大总结 */

export function getThreshold() {
  const n = Number(store.getConfigValue('summary.bigThreshold', null));
  return Number.isFinite(n) && n > 0 ? n : BIG_SUMMARY_DEFAULT_THRESHOLD;
}

export function setThreshold(v) {
  const n = Number(v) || BIG_SUMMARY_DEFAULT_THRESHOLD;
  const cur = store.getConfigValue('summary', {}) ?? {};
  store.updateConfig({ summary: { ...cur, bigThreshold: n } });
  return n;
}

/** 当前轮次（表0 系统轮次，读不到退回 AI 层数） */
export function currentRound() {
  try {
    const hit = require === undefined ? null : null;
    void hit;
  } catch { /* ignore */ }
  const r = (() => { try { return store.getRows(0, { create: false })[0]; } catch { return null; } })();
  if (r) {
    const n = parseInt(String(cellS(0, r, '系统轮次', 0)).replace(/[^\d]/g, ''), 10);
    if (Number.isFinite(n)) return n;
  }
  try { return (ctx()?.chat ?? []).filter((m) => m && !m.is_user).length; } catch { return 0; }
}

/** 该不该做大总结 + 要注入的提醒文本（照原机制：没到轮次就明令禁止） */
export function reminder(roundOverride = null) {
  const round = Number.isFinite(Number(roundOverride)) && roundOverride !== null ? Number(roundOverride) : currentRound();
  const threshold = getThreshold();
  const last = Number(store.getConfigValue('summary.lastBigAt', 0)) || 0;
  const should = round - last >= threshold;
  return { round, threshold, last, should, text: should ? BIG_SUMMARY_READY_TEXT : BIG_SUMMARY_DISABLED_TEXT };
}

/** 标记"这一轮做大总结了" */
export function markBigDone(round = currentRound()) {
  const cur = store.getConfigValue('summary', {}) ?? {};
  store.updateConfig({ summary: { ...cur, lastBigAt: Number(round) || 0 } });
  return Number(round) || 0;
}

/** 解析大总结产出（时间线形式）→ 写进纪事表（表12） */
export function parseBig(text) {
  const s = String(text ?? '');
  const m = /<big_summary>([\s\S]*?)<\/big_summary>/i.exec(s) || /<大总结>([\s\S]*?)<\/大总结>/i.exec(s);
  if (!m) return { found: false, items: [] };
  const lines = unwrap(m[1]).split('\n').map((l) => l.replace(/^[-*•·]\s*/, '').trim()).filter(Boolean);
  return { found: true, items: lines };
}

/**
 * 把大总结产出落进纪事表（表12）。
 * 表12 的列：纪元封包名 / 时间轴区间 / 地理迁徙路线 / 剧情压缩 / …
 * 我们把每条大总结写成一行：封包名 = 第 N 轮，剧情压缩 = 该条内容。
 */
export function applyBigToTable(items, round = currentRound()) {
  const list = Array.isArray(items) ? items.filter((x) => String(x ?? '').trim()) : [];
  if (!list.length) return { ok: false, added: 0 };
  let cols = [];
  try { cols = getTables().find((x) => x.no === 12)?.columns ?? []; } catch { cols = []; }
  if (!cols.length) return { ok: false, added: 0, reason: 'no-table12' };
  const rows = store.getRows(12, { create: true });
  const idx = (kw) => cols.findIndex((c) => String(c).includes(kw));
  const iPack = idx('封包') >= 0 ? idx('封包') : 0;
  const iSpan = idx('时间轴');
  const iStory = idx('剧情压缩') >= 0 ? idx('剧情压缩') : Math.min(1, cols.length - 1);
  let added = 0;
  for (const it of list) {
    const row = new Array(cols.length).fill('');
    row[iPack] = `第 ${round} 轮`;
    if (iSpan >= 0) row[iSpan] = `第 ${round} 轮`;
    row[iStory] = String(it).slice(0, 500);
    rows.push(row);
    added++;
  }
  return { ok: true, added, round };
}

/** 一轮维护总入口：解析小总结 → 落库 → 算大总结提醒
 *  【修 bug】以前这个函数**从来没被调用过** ✗ → 小总结压根没存 ✓
 *  现在由 index.js 在处理完一轮 AI 正文后调用（传 msgId ✓ 方便回滚清掉 ✓） */
export function maintain(text, roundOverride = null, msgId = null) {
  const parsed = parseSmall(text);
  const round = Number.isFinite(Number(roundOverride)) && roundOverride !== null ? Number(roundOverride) : currentRound();
  if (parsed.found) recordSmall(round, parsed, msgId);
  const big = reminder(round);
  try {
    const c = ctx();
    if (c?.variables?.chat?.set) {
      c.variables.chat.set('fiftyRoundReminder', big.text);
      c.variables.chat.set('fiftyRoundReminderFormatted', 'D' + String(round).padStart(4, '0'));
      c.variables.chat.set('fiftyRoundReminderActive', !!big.should);
      // 到达整倍数边界时用原文的边界提醒
      try {
        const cnt = Number(store.getConfigValue('summary.count', 0)) || 0;
        const range = String(store.getConfigValue('summary.range', '') ?? '');
        if (big.should && round % big.threshold === 0) {
          c.variables.chat.set('fiftyRoundReminder', boundaryReminder(round, big.threshold, cnt + 1, range));
        }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return { round, small: parsed, big, events: listEvents({ limit: 200 }).length };
}
