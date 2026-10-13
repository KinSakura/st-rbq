/**
 * vars.js —— 变量管理：插件写了哪些变量、作用域、当前值、怎么调用
 *
 * 这里只列"插件自己会写/会读"的变量。用户在预设里用：
 *   聊天变量 → {{getvar::变量名}}     全局变量 → {{getglobalvar::变量名}}
 */
import * as store from './store.js';
import { cellS } from './cells.js';
import { ctx } from './ctx.js';
import * as extras from './extras.js';

/** 插件使用的变量清单（如实列，别编） */
export const VAR_DEFS = [
  { name: 'systemRound', scope: 'chat', desc: '当前轮次（取自表0「系统轮次」）' },
  { name: 'systemRoundFormatted', scope: 'chat', desc: '轮次的可读写法（如 第 12 轮）' },
  { name: 'departureThreshold', scope: 'global', desc: '离场提醒阈值（默认 50）' },
  { name: 'departureCoreList', scope: 'chat', desc: '核心角色名单（数组）' },
  { name: 'departureRecords', scope: 'chat', desc: '离场记录：{ 角色名: 退场锚点轮次 }' },
  { name: 'departureReminder', scope: 'chat', desc: '离场提醒文本（超过阈值时写入）' },
  { name: 'departureReminderActive', scope: 'chat', desc: '是否有待处理的离场提醒' },
  { name: 'monsterDespawnThreshold', scope: 'global', desc: '临时实体清理阈值（默认 10）' },
  { name: 'monsterLastSeen', scope: 'chat', desc: '每只实体最后出现的轮次' },
  { name: 'fiftyRoundReminder', scope: 'chat', desc: '大总结提醒文本（原文变量名）' },
  { name: 'fiftyRoundReminderActive', scope: 'chat', desc: '是否处于大总结触发边界' },
  { name: 'fiftyRoundReminderFormatted', scope: 'chat', desc: '大总结轮次格式（D0001）' },
  { name: 'roundSummaryCount', scope: 'chat', desc: '已完成的大总结次数' },
  { name: 'roundSummaryRange', scope: 'chat', desc: '本次大总结覆盖的轮次范围' },
  { name: 'userSpeakBanText', scope: 'global', desc: '抢话开关：允许代说时为空，禁止时为提醒文本' },
  { name: 'userSpeakBanEnabled', scope: 'global', desc: '是否允许 AI 代说 {{user}} 台词（抢话）' },
  { name: 'timeBoxEnabled', scope: 'global', desc: '是否自动插入时间框' },
  { name: 'timeBoxSkipTags', scope: 'global', desc: '时间框要跳过的标签（默认 thinking_matrix,thinking）' },
  { name: 'rpFastForwardEnabled', scope: 'global', desc: '四选一是否用快进模式提示词' },
  { name: 'rpPromptNormal', scope: 'global', desc: '四选一的普通提示词模板' },
  { name: 'rpPromptFastForward', scope: 'global', desc: '四选一的快进提示词模板' },
  { name: 'fastForward', scope: 'chat', desc: '快进模式标志（开启时写提示文本）' },
  { name: 'narrationPromptActive', scope: 'chat', desc: '旁白点评开关（附加功能）' },
  { name: 'cgPromptActive', scope: 'chat', desc: 'CG 描述开关（附加功能）' },
  { name: 'theaterPromptActive', scope: 'chat', desc: '小剧场开关（附加功能）' },
  { name: 'theaterTypeHint', scope: 'chat', desc: '小剧场类型提示（附加功能）' },
  { name: 'rpPromptActive', scope: 'global', desc: '四选一提示词开关（附加功能）' },
  { name: 'lengthRequirementText', scope: 'global', desc: '字数要求文本（附加功能）' },
  { name: 'userOutlineActiveText', scope: 'global', desc: '人设大纲文本（附加功能）' },
];

/** 调用写法 */
export function usageOf(def) { return def.scope === 'global' ? `{{getglobalvar::${def.name}}}` : `{{getvar::${def.name}}}`; }

function chatVars() { try { return ctx()?.chatMetadata ?? ctx()?.chat_metadata ?? null; } catch { return null; } }

export function readVar(name, scope) {
  try {
    const v = scope === 'global' ? ctx()?.variables?.global?.get?.(name) : ctx()?.variables?.chat?.get?.(name);
    if (v !== undefined && v !== null && v !== '') return v;
  } catch { /* ignore */ }
  if (scope === 'chat') { const cm = chatVars(); if (cm && cm[name] !== undefined) return cm[name]; }
  return null;
}

export function writeVar(name, value, scope) {
  let ok = false;
  try {
    const api = scope === 'global' ? ctx()?.variables?.global : ctx()?.variables?.chat;
    if (api?.set) { api.set(name, value); ok = true; }
  } catch { /* ignore */ }
  if (scope === 'chat') { const cm = chatVars(); if (cm) { cm[name] = value; ok = true; } }
  return ok;
}

/** 清单 + 当前值（给界面用） */
export function listVars() {
  return VAR_DEFS.map((d) => ({
    ...d,
    usage: usageOf(d),
    value: readVar(d.name, d.scope),
    set: readVar(d.name, d.scope) !== null,
  }));
}

/** 把轮次写进变量（预设里用 {{getvar::systemRoundFormatted}}） */
export function writeRoundVars(roundOverride = null) {
  let round = Number(roundOverride);
  if (!Number.isFinite(round) || roundOverride === null) {
    const r = (() => { try { return store.getRows(0, { create: false })[0]; } catch { return null; } })();
    const n = r ? parseInt(String(cellS(0, r, '系统轮次', 0)).replace(/[^\d]/g, ''), 10) : NaN;
    round = Number.isFinite(n) ? n : (() => { try { return (ctx()?.chat ?? []).filter((m) => m && !m.is_user).length; } catch { return 0; } })();
  }
  writeVar('systemRound', String(round), 'chat');
  // 原文格式：D + 四位补零（如 D0001）；同时写全局（原版两处都写）
  writeVar('systemRoundFormatted', 'D' + String(round).padStart(4, '0'), 'chat');
  writeVar('systemRoundFormatted', 'D' + String(round).padStart(4, '0'), 'global');
  writeVar('systemRound', String(round), 'global');
  return round;
}

/** 界面上的"一键重置"：把这些变量清成空串（不会删掉变量本身） */
export function clearAll() {
  let n = 0;
  for (const d of VAR_DEFS) { try { writeVar(d.name, '', d.scope); n++; } catch { /* ignore */ } }
  return n;
}

/** 附加功能那几个开关变量的当前状态（合并给界面用） */
export function extrasState() { try { return extras.list().map((e) => e.varName).filter(Boolean); } catch { return []; } }
