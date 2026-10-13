/**
 * addons.js —— 仪表盘附带的实用件（都放在「设置」页，不散落）
 *
 *   1. 提示词附加：旁白 / CG / 小剧场 / 时间框 / 字数要求 / 人设大纲 —— 开关 + 文本，注入 {{tablePrompt}} 末尾
 *   2. 治理：离场名单与表0在场名单对齐、已击败实体清理
 *   3. 灵感：从未用线索 / 未完成任务 / 记忆锚点 / 关系盲区里抽提示
 *   4. 轮次：计数 + 大总结提醒
 *   5. 正则工坊：一键生成酒馆正则（隐藏 <data>、从提示词剔除 <data> 等）
 */

import * as store from './store.js';
import { cellS as C } from './cells.js';
import { ctx, notify } from './ctx.js';
import * as memory from './memory.js';

const rowsOf = (no) => store.getRows(no, { create: false });
const s = (v) => String(v ?? '').trim();

/* ==================================================== 1. 提示词附加 */

export const ADDON_DEFS = [
  { key: 'narration', label: '旁白', hint: '每轮在正文开头用 1~2 句第三人称旁白交代此刻的环境与氛围。' },
  { key: 'cg', label: 'CG 描写', hint: '在关键节点用一段特写镜头描写（画面感），不要写成旁白总结。' },
  { key: 'theater', label: '小剧场', hint: '在正文末尾附一个 <小剧场>…</小剧场>，写与主线无关的日常互动。' },
  { key: 'timebox', label: '时间框', hint: '每轮开头标注【时间：…｜地点：…】，并保持时间连续推进。' },
  { key: 'length', label: '字数要求', hint: '正文不少于 800 字。' },
  { key: 'outline', label: '人设大纲', hint: '写你对角色扮演的额外要求，会原样注入提示词。' },
];

export function getAddon(key) {
  const v = store.getConfigValue(`addons.${key}`, null);
  if (v && typeof v === 'object') return { enabled: !!v.enabled, text: String(v.text ?? '') };
  const def = ADDON_DEFS.find((d) => d.key === key);
  return { enabled: false, text: def?.hint ?? '' };
}

export function setAddon(key, patch) {
  const cur = getAddon(key);
  store.updateConfig({ addons: { [key]: { ...cur, ...patch } } });
  return getAddon(key);
}

/** 拼成要注入提示词的一段（没开启任何附加就返回空串） */
export function buildAddonText() {
  const parts = [];
  for (const d of ADDON_DEFS) {
    const a = getAddon(d.key);
    if (!a.enabled || !a.text.trim()) continue;
    parts.push(`- 【${d.label}】${a.text.trim()}`);
  }
  if (!parts.length) return '';
  return ['## 额外要求', ...parts].join('\n');
}

/* ==================================================== 2. 治理 */

/** 汇总：谁离场了、哪些实体已经打完了、名单对不对 */
export function governanceReport() {
  const t0 = store.getTable?.(0) ?? null;
  void t0;
  const w0 = rowsOf(0)[0];
  const presentRaw = (() => {
    const t = (() => { try { return (store.getTable?.(0)); } catch { return null; } })();
    void t;
    return '';
  })();
  let present = new Set();
  try {
    // 在场实体名单是第 4 列（以前写死第 6 列，读到的是「安全氛围」→ 治理判断全错）
    const names = C(0, w0, '在场实体名单', 4);
    present = new Set(names.split(/[/,，、]/).map((x) => x.trim()).filter(Boolean));
  } catch { /* ignore */ }
  void presentRaw;

  const state4 = rowsOf(4);
  const left = state4.filter((r) => /已离场/.test(C(4, r, '离场状态', 2)));
  const leftNames = new Set(left.map((r) => C(4, r, '角色名称', 0)));

  const monsters = rowsOf(14).filter((r) => /defeated|fled|despawned|已击败|已逃跑|已消失/.test(C(14, r, '状态', 19)));

  const mismatch = {
    stillPresentButLeft: [...leftNames].filter((n) => present.has(n)),
    presentButNotInTable: [...present].filter((n) => !leftNames.has(n) && !state4.some((r) => C(4, r, '角色名称', 0) === n)),
  };

  return {
    departed: left.map((r) => ({ name: C(4, r, '角色名称', 0), note: C(4, r, '离场状态', 2) })),
    monsters: monsters.map((r) => ({ name: C(14, r, '实体名称', 0), state: C(14, r, '状态', 19) })),
    present: [...present],
    mismatch,
  };
}

/** 一键修：把已离场的人从表0在场名单里摘掉；清理已击败实体（可只清场上的） */
export async function fixGovernance({ cleanMonsters = false } = {}) {
  const txn = await import('./txn.js');
  const ops = [];
  const rep = governanceReport();
  const keep = rep.present.filter((n) => !rep.mismatch.stillPresentButLeft.includes(n));
  if (rep.mismatch.stillPresentButLeft.length) {
    ops.push({ op: 'update', table: 0, row: null, rowIndex: 0, values: { 在场实体名单: keep.join('/') } });
  }
  if (cleanMonsters) {
    for (const m of rep.monsters) ops.push({ op: 'delete', table: 14, row: m.name });
  }
  if (!ops.length) return { applied: 0, notes: ['没有需要修的。'] };
  const res = await txn.applyOps(ops, { source: 'governance' });
  return { applied: res.applied, failed: res.failed, notes: [`修正 ${res.applied} 处`] };
}

/* ==================================================== 3. 灵感 */

/** 从现有数据里抽几条"可以往哪推"的提示 */
/* 灵感已迁到 core/inspiration.js（原版 InspirationModule 语义），这里的旧实现已删除 */
/* ==================================================== 4. 轮次提醒 */

export function roundInfo() {
  const w0 = rowsOf(0)[0];
  const raw = s(w0?.[0] ?? '');
  // 轮次 = 楼层 ÷ 2（一轮 = 用户一层 + AI 一层）；表0 有系统轮次就以它为准
  const floorBased = (() => { try { const n = (globalThis.SillyTavern?.getContext?.()?.chat ?? []).length; return Math.max(0, Math.floor(n / 2)); } catch { return 0; } })();
  const round = /^\d+$/.test(raw) ? Number(raw) : floorBased;
  const every = Math.max(1, Number(store.getConfigValue('rounds.summaryEvery', 20)));
  const lastAt = Number(store.getConfigValue('rounds.lastSummaryAt', 0));
  const since = Math.max(0, round - lastAt);
  return { round, every, since, needSummary: since >= every && round > 0 };
}

export function markSummaryDone() {
  const { round } = roundInfo();
  store.updateConfig({ rounds: { lastSummaryAt: round } });
  return round;
}

/* ==================================================== 5. 正则工坊 */

/**
 * 生成 RBQ 需要的酒馆正则。
 * 思路：AI 的 <data>/<RP_OPTIONS> 不该占用户的阅读版面，但要不要从提示词里剔除由你决定。
 */
export function buildRegexScripts() {
  const mk = (name, findRegex, replaceString, opts = {}) => ({
    id: `rbq-${name}-${Math.random().toString(36).slice(2, 8)}`,
    scriptName: `RBQ · ${name}`,
    findRegex,
    replaceString,
    trimStrings: [],
    placement: [1, 2],
    disabled: false,
    markdownOnly: false,
    promptOnly: false,
    runOnEdit: false,
    substituteRegex: 0,
    minDepth: null,
    maxDepth: null,
    ...opts,
  });
  return [
    mk('隐藏 <data> 块（仅显示）', '/<data>[\\s\\S]*?<\\/data>/gi', '', { markdownOnly: true }),
    mk('隐藏 <RP_OPTIONS>（仅显示）', '/<RP_OPTIONS>[\\s\\S]*?<\\/RP_OPTIONS>/gi', '', { markdownOnly: true }),
    mk('从提示词剔除 <data>', '/<data>[\\s\\S]*?<\\/data>/gi', '', { promptOnly: true }),
    mk('从提示词剔除 <RP_OPTIONS>', '/<RP_OPTIONS>[\\s\\S]*?<\\/RP_OPTIONS>/gi', '', { promptOnly: true }),
    mk('隐藏小剧场', '/<小剧场>[\\s\\S]*?<\\/小剧场>/gi', '', { markdownOnly: true, disabled: true }),
  ];
}

/** 装进酒馆（找不到正则扩展就返回 JSON 让你手动导入） */
export function installRegexScripts() {
  const scripts = buildRegexScripts();
  const c = ctx();
  try {
    const es = c?.extensionSettings;
    if (es) {
      if (!Array.isArray(es.regex)) es.regex = [];
      const existing = new Set(es.regex.map((r) => r.scriptName));
      let added = 0;
      for (const sc of scripts) {
        if (existing.has(sc.scriptName)) continue;
        es.regex.push(sc);
        added++;
      }
      if (typeof c.saveSettingsDebounced === 'function') c.saveSettingsDebounced();
      if (added) { notify('success', `已装入 ${added} 条酒馆正则。`); return { ok: true, added }; }
      notify('info', '这些正则已经装过了。');
      return { ok: true, added: 0 };
    }
  } catch (e) {
    console.warn('[RBQ] 安装正则失败', e);
  }
  return { ok: false, json: JSON.stringify(scripts, null, 2) };
}

export { notify };
