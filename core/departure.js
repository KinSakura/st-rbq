/**
 * departure.js —— 离场锚点与临时实体清理
 *
 * 照 rbq.js 原实现重建（变量名、正则、默认值都跟着原来那套，预设里的引用不用改）：
 *   DepartureModule        —— departureThreshold(全局, 默认50) / departureCoreList / departureRecords
 *                             / departureReminder / departureReminderActive
 *   MonsterDespawnModule   —— monsterDespawnThreshold(全局, 默认10) / monsterLastSeen
 *
 * 表4「离场状态」列的值形如：已离场丨退场锚点：12   或   已离场(隐匿)丨退场锚点：12
 */
import * as store from './store.js';
import { resolveAttr } from './alias.js';
import { ctx } from './ctx.js';

export const DEPARTURE_DEFAULT_THRESHOLD = 50;
export const MONSTER_DESPAWN_DEFAULT_THRESHOLD = 10;
/** 离场状态里的锚点格式（照原代码；丨和|、：和: 都认；隐匿也认） */
export const DEPARTURE_RE = /已离场(?:\(隐匿\))?\s*[丨|]\s*退场锚点\s*[:：]\s*(\d+)/;

/* ------------------------------------------------------------ 变量读写（同名） */

function chatVars() {
  try { return ctx()?.chatMetadata ?? ctx()?.chat_metadata ?? null; } catch { return null; }
}

export function getChatVar(key, fallback = null) {
  try {
    const v = ctx()?.variables?.chat?.get?.(key);
    if (v !== undefined && v !== null && v !== '') return v;
  } catch { /* ignore */ }
  const cm = chatVars();
  if (cm && cm[key] !== undefined) return cm[key];
  return fallback;
}

export function setChatVar(key, value) {
  let ok = false;
  try {
    if (ctx()?.variables?.chat?.set) { ctx().variables.chat.set(key, value); ok = true; }
  } catch { /* ignore */ }
  const cm = chatVars();
  if (cm) { cm[key] = value; ok = true; }
  return ok;
}

export function delChatVar(key) {
  try { ctx()?.variables?.chat?.set?.(key, ''); } catch { /* ignore */ }
  const cm = chatVars();
  if (cm) delete cm[key];
}

function globalVar(key, fallback = null) {
  try {
    const v = ctx()?.variables?.global?.get?.(key);
    if (v !== undefined && v !== null && v !== '') return v;
  } catch { /* ignore */ }
  return fallback;
}

function setGlobalVar(key, value) {
  try { ctx()?.variables?.global?.set?.(key, value); return true; } catch { return false; }
}


/* ---- 记录双写：同名变量（给预设用）+ 我自己的 chat 数据（权威，防变量被重置） ---- */

function dget(key, fallback) {
  const d = store.getData({ create: false });
  if (d && d.departure && d.departure[key] !== undefined) return d.departure[key];
  return getChatVar(key, fallback);
}

function dset(key, value) {
  setChatVar(key, value);
  const d = store.getData({ create: true });
  if (!d.departure) d.departure = {};
  d.departure[key] = value;
  return true;
}
/* ------------------------------------------------------------ 表格读取 */

function rowsOf(no) { try { return store.getRows(no, { create: false }) ?? []; } catch { return []; } }
function cellOf(no, row, semantic) {
  const hit = resolveAttr(no, semantic);
  if (!hit) return undefined;
  return row?.[hit.index];
}

/** 当前轮次（表0 系统轮次；读不到就用层数） */
export function currentRound() {
  const r = rowsOf(0)[0];
  if (r) {
    const v = cellOf(0, r, '系统轮次');
    const n = parseInt(String(v ?? '').replace(/[^\d]/g, ''), 10);
    if (Number.isFinite(n)) return n;
  }
  try { return (ctx()?.chat ?? []).filter((m) => m && !m.is_user).length; } catch { return 0; }
}

/* ------------------------------------------------------------ 离场 */

export const Departure = {
  getThreshold() {
    const n = Number(globalVar('departureThreshold') ?? store.getConfigValue('departure.threshold', null));
    return Number.isFinite(n) && n > 0 ? n : DEPARTURE_DEFAULT_THRESHOLD;
  },
  setThreshold(v) {
    const n = Number(v) || DEPARTURE_DEFAULT_THRESHOLD;
    setGlobalVar('departureThreshold', n);
    store.updateConfig({ departure: { ...(store.getConfigValue('departure', {}) ?? {}), threshold: n } });
    return n;
  },

  getCoreList() { const l = dget('departureCoreList', []); return Array.isArray(l) ? l : []; },
  setCoreList(list) { return dset('departureCoreList', Array.isArray(list) ? list : []); },
  addCore(name) { const l = this.getCoreList(); if (l.includes(name)) return false; l.push(name); this.setCoreList(l); return true; },
  removeCore(name) { const l = this.getCoreList(); const i = l.indexOf(name); if (i < 0) return false; l.splice(i, 1); this.setCoreList(l); return true; },
  toggleCore(name) { return this.getCoreList().includes(name) ? this.removeCore(name) : this.addCore(name); },
  deleteRecord(name) { const r = this.getRecords(); if (r[name] === undefined) return false; delete r[name]; dset('departureRecords', r); return true; },

/** 从表4 的离场状态列解析出 [{name, round}] */
  extract() {
    const out = [];
    for (const row of rowsOf(4)) {
      const name = cellOf(4, row, '角色名称');
      const status = String(cellOf(4, row, '离场状态') ?? '');
      const m = DEPARTURE_RE.exec(status);
      if (m && name) { const round = parseInt(m[1], 10); if (Number.isFinite(round)) out.push({ name: String(name).trim(), round }); }
    }
    return out;
  },

/** 重建记录（同名取最大轮次；核心名单里没有记录的置 null 表示"还没离场"） */
  updateRecords() {
    const extracted = this.extract();
    const records = {};
    for (const d of extracted) if (records[d.name] === undefined || d.round > records[d.name]) records[d.name] = d.round;
    for (const name of this.getCoreList()) if (records[name] === undefined) records[name] = null;
    dset('departureRecords', records);
    return records;
  },

  getRecords() { const r = dget('departureRecords', {}); return r && typeof r === 'object' ? r : {}; },

/** 超出阈值、需要提醒的离场角色（按锚点轮次从早到晚排序） */
  check(roundOverride = null) {
    const round = Number.isFinite(Number(roundOverride)) && roundOverride !== null ? Number(roundOverride) : currentRound();
    const threshold = this.getThreshold();
    const records = this.getRecords();
    const core = new Set(this.getCoreList());
    const triggered = [];
    for (const [name, anchor] of Object.entries(records)) {
      if (anchor === null || anchor === undefined) continue;
      const gone = round - Number(anchor);
      if (gone >= threshold) triggered.push({ name, anchor: Number(anchor), gone, core: core.has(name) });
    }
    triggered.sort((a, b) => a.anchor - b.anchor);
    return { round, threshold, triggered };
  },

/** 生成提醒文本（照原代码的措辞），并写 departureReminder 变量供预设取用 */
  reminderText(roundOverride = null) {
    const { round, threshold, triggered } = this.check(roundOverride);
    if (!triggered.length) { delChatVar('departureReminder'); delChatVar('departureReminderActive'); return ''; }
    const lines = triggered.map((t) => `${t.name}（退场锚点 ${t.anchor}，已离场 ${t.gone} 轮）`);
    const text = `【离场锚点提醒】以下角色离场已≥${threshold}轮：` + String.fromCharCode(10) + lines.join(String.fromCharCode(10)) + String.fromCharCode(10) + `（当前轮次 ${round}）`;
    dset('departureReminder', text);
    setChatVar('departureReminderActive', true);
    return text;
  },

/** 没离场的在场角色（表0 在场名单 - 已离场） */
  presentList() {
    const r = rowsOf(0)[0];
    const raw = r ? String(cellOf(0, r, '在场实体名单') ?? '') : '';
    const present = raw.split(/[、,，;；/|]/).map((s) => s.trim()).filter(Boolean);
    const gone = new Set(Object.keys(this.getRecords()));
    return present.filter((n) => !gone.has(n));
  },
};

/* ------------------------------------------------------------ 怪物/临时实体 */

export const MonsterDespawn = {
  getThreshold() {
    const n = Number(globalVar('monsterDespawnThreshold') ?? store.getConfigValue('monster.threshold', null));
    return Number.isFinite(n) && n > 0 ? n : MONSTER_DESPAWN_DEFAULT_THRESHOLD;
  },
  setThreshold(v) {
    const n = Number(v) || MONSTER_DESPAWN_DEFAULT_THRESHOLD;
    setGlobalVar('monsterDespawnThreshold', n);
    store.updateConfig({ monster: { ...(store.getConfigValue('monster', {}) ?? {}), threshold: n } });
    return n;
  },

  all() {
    return rowsOf(14).map((row, index) => ({
      index,
      name: String(cellOf(14, row, '实体名称') ?? ''),
      status: String(cellOf(14, row, '状态') ?? cellOf(14, row, '存活状态') ?? 'active'),
      level: cellOf(14, row, '等级') ?? '',
    })).filter((x) => x.name);
  },

  active() { return this.all().filter((x) => !/dead|死亡|已击败|despawn/i.test(x.status)); },

  getLastSeen() { const r = dget('monsterLastSeen', {}); return r && typeof r === 'object' ? r : {}; },

/** 记录"这一轮见过的怪物"，并清掉表里已经不存在的名字 */
  update(round = currentRound()) {
    const records = this.getLastSeen();
    const active = this.active().map((x) => x.name);
    for (const name of active) records[name] = round;
    const alive = new Set(this.all().map((x) => x.name));
    for (const name of Object.keys(records)) if (!alive.has(name)) delete records[name];
    dset('monsterLastSeen', records);
    return records;
  },

/** 超过阈值没出现的怪物（= 该清理的） */
  check(round = currentRound()) {
    const threshold = this.getThreshold();
    const records = this.getLastSeen();
    const out = [];
    for (const m of this.active()) {
      const last = records[m.name];
      if (last === undefined) continue;
      const gone = round - Number(last);
      if (gone >= threshold) out.push({ ...m, lastSeen: Number(last), gone });
    }
    out.sort((a, b) => b.gone - a.gone);
    return { round, threshold, pending: out };
  },

/** 生成清理指令：按新协议让 AI 把该消失的实体标成 despawned */
  cleanupCommands(round = currentRound()) {
    return this.check(round).pending.map((m) => `<data>\n<monster name="${String(m.name ?? m.角色名称 ?? "").trim()}" 状态="despawned"/>\n</data>`);
  },

/** 直接把该清理的实体从表里删掉（返回删了几行） */
  cleanupNow(round = currentRound()) {
    const pending = this.check(round).pending;
    if (!pending.length) return 0;
    const rows = rowsOf(14).slice();
    const kill = new Set(pending.map((p) => p.index));
    const kept = rows.filter((_, i) => !kill.has(i));
    store.setRows(14, kept);
    const records = this.getLastSeen();
    for (const p of pending) delete records[p.name];
    dset('monsterLastSeen', records);
    return pending.length;
  },
};

/** 一轮结束时的统一维护：更新记录 + 生成提醒文本 */
export function maintain() {
  const round = currentRound();
  Departure.updateRecords();
  MonsterDespawn.update(round);
  const dep = Departure.check();
  const mon = MonsterDespawn.check(round);
  return { round, departure: dep, monster: mon, reminder: Departure.reminderText() };
}
