/**
 * inspiration.js —— 叙事灵感（照 rbq.js 的 InspirationModule 原文实现）
 *
 * 原版行为：
 *   · 开关 inspirationEnabled（全局，默认 true）
 *   · 间隔 inspirationMinInterval / MaxInterval（默认 3 / 7 轮）
 *   · 测试模式 inspirationTestMode（开启后每轮都触发）
 *   · 到点触发：写 divinationEvent（当前叙事灵感：…） + divinationEventActive=true
 *              + lastInspirationRound=当前轮 + 删除 nextInspirationRound
 *   · 未触发时：divinationEvent = 「暂时不需要意外事件影响当前剧情」，Active=false
 */
import * as store from './store.js';
import { ctx } from './ctx.js';
import * as extras from './extras.js';

/* 方向与风格：**逐字取自原版** */
const directions = ["一个看似偶然的发现可能带来转机","某个不起眼的细节可能指向隐藏的机遇","一次短暂的休息可能让角色获得新视角","一位陌生人的善意可能成为关键助力","环境的微小变化可能暗示着有利的路径","角色不经意的一句话可能触动他人，打开新局面","一次计划外的绕路可能避开重大危险","角色在整理物品时发现遗忘的线索","天气的变化可能为角色提供掩护或便利","一只动物或野物的出现可能指引方向","一个不经意的举动可能引发连锁麻烦","看似稳定的局面可能暗藏裂痕","角色的疏忽可能让已有的优势化为乌有","周围环境的异动可能预示着即将到来的危险","信任的人或物可能潜藏着不可靠的因素","角色在赶路时可能遭遇意外的延误","一件看似无害的道具可能在关键时刻失灵","他人对角色的误解可能导致关系紧张","环境中的气味或声音可能暴露角色的位置","角色自身的疲劳或分心可能导致判断失误","一个不利的局面可能意外转变为突破口","一次失败可能暴露出原本被忽视的机会","原本的收获可能伴随着隐形的代价","看似无关的事件可能突然关联起来改变走向","角色的直觉可能在关键时刻产生错误的判断","一次求助可能反而将角色拖入更深的问题","一个看似正确的选择可能引发意想不到的后果","角色的善意可能被误解，反而带来意外的盟友","一场意外可能打破僵局，提供全新的解决路径","角色在绝境中可能发现自身的某种新能力"];
const flavors = ["（注意：这个方向可能以微妙或戏剧性的方式呈现）","（建议：可以将其融入当前场景的某个物体或对话中）","（提示：考虑让事件与角色的当前目标产生联系）","（备选：也可以作为后续情节的伏笔）","（方向仅供参考，具体表现方式可自由发挥）","（可以结合当前场景的物理环境进行具体化）","（注意节奏，不必急于立刻展现全部影响）","（可以使其与角色之前的选择产生呼应）","（将其视为一种可能性，而非必然发生）","（允许其以非常隐晦的方式开始，然后逐渐显现）"];

/* 读写通道必须一致：原来写走 extras.writeVar（/setvar 一类）、读走 variables API，
   两边可能不是同一个存储 → 开关点了会“弹回去”。现在写两边都写、读两边都读。 */
function gget(k) {
  try { const v = ctx()?.variables?.global?.get?.(k); if (v !== undefined && v !== null && v !== '') return v; } catch { /* ignore */ }
  try { const v2 = extras.readVar?.(k, 'global'); if (v2 !== undefined && v2 !== null && v2 !== '') return v2; } catch { /* ignore */ }
  return undefined;
}
function gset(k, v) {
  let ok = false;
  try { ok = extras.writeVar(k, v, 'global') || ok; } catch { /* ignore */ }
  try { ctx()?.variables?.global?.set?.(k, v); ok = true; } catch { /* ignore */ }
  return ok;
}
function cget(k) {
  try { const v = ctx()?.variables?.chat?.get?.(k); if (v !== undefined && v !== null && v !== '') return v; } catch { /* ignore */ }
  try { const v2 = extras.readVar?.(k, 'chat'); if (v2 !== undefined && v2 !== null && v2 !== '') return v2; } catch { /* ignore */ }
  return undefined;
}
function cset(k, v) {
  let ok = false;
  try { ok = extras.writeVar(k, v, 'chat') || ok; } catch { /* ignore */ }
  try { ctx()?.variables?.chat?.set?.(k, v); ok = true; } catch { /* ignore */ }
  return ok;
}

export const DEF = { enabled: true, min: 3, max: 7, test: false };

/* 酒馆变量把布尔存成 1/0 或 'true'/'false' → 判定必须都认（否则写进去读回来是 false，开关会弹回去） */
function truthyVar(v) { return v === true || v === 1 || v === '1' || v === 'true'; }

export function getEnabled() { const v = gget('inspirationEnabled'); return v === undefined || v === null || v === '' ? DEF.enabled : truthyVar(v); }
export function setEnabled(v) { return gset('inspirationEnabled', !!v); }
export function getMinInterval() { const v = Number(gget('inspirationMinInterval')); return Number.isFinite(v) && v >= 1 ? v : DEF.min; }
export function setMinInterval(v) { const n = Number(v); if (n >= 1) gset('inspirationMinInterval', n); return getMinInterval(); }
export function getMaxInterval() { const v = Number(gget('inspirationMaxInterval')); return Number.isFinite(v) && v >= 1 ? v : DEF.max; }
export function setMaxInterval(v) { const n = Number(v); if (n >= 1) gset('inspirationMaxInterval', n); return getMaxInterval(); }
export function getTestMode() { return truthyVar(gget('inspirationTestMode')); }
export function setTestMode(v) { return gset('inspirationTestMode', !!v); }

/** 生成一条灵感（原版 _generate：随机方向 + 随机风格） */
export function generate() {
  const d = directions.length ? directions[Math.floor(Math.random() * directions.length)] : '一个看似偶然的发现可能带来转机';
  const f = flavors.length ? flavors[Math.floor(Math.random() * flavors.length)] : '';
  return d + ' ' + f;
}

/** 触发一次灵感（原版 trigger） */
export function trigger(round = null) {
  const r = Number.isFinite(Number(round)) && round !== null ? Number(round) : currentRound();
  const text = `当前叙事灵感：${generate()}。请根据这个方向，结合当前剧情、场景和角色状态，自然地编织一个符合逻辑的环境变化或意外事件。`;
  cset('divinationEvent', text);
  cset('divinationEventActive', true);
  cset('lastInspirationRound', r);
  extras.writeVar('nextInspirationRound', '', 'chat');
  return { round: r, text };
}

/** 不触发时的默认值（原版 ensureDefault） */
export function ensureDefault() {
  const def = '暂时不需要意外事件影响当前剧情';
  if (cget('divinationEvent') !== def) { cset('divinationEvent', def); cset('divinationEventActive', false); }
  return def;
}

export function currentRound() {
  try { const r = store.getRows(0, { create: false })[0]; const n = parseInt(String(r?.[0] ?? '').replace(/[^0-9]/g, ''), 10); if (Number.isFinite(n)) return n; } catch { /* ignore */ }
  const cv = Number(cget('systemRound'));
  if (Number.isFinite(cv)) return cv;
  try { return (ctx()?.chat ?? []).filter((m) => m && !m.is_user).length; } catch { return 0; }
}

/** 每轮检查（原版 checkAndGenerate） */
export function checkAndGenerate(force = false) {
  if (!getEnabled()) { ensureDefault(); return { active: false, reason: 'disabled' }; }
  const round = currentRound();
  if (!round || round < 0) return { active: false, reason: 'no-round' };
  if (getTestMode()) { const r = trigger(round); return { active: true, test: true, ...r }; }
  let last = Number(cget('lastInspirationRound')) || 0;
  if (last === 0) { last = round - 1; cset('lastInspirationRound', last); }
  let next = Number(cget('nextInspirationRound')) || 0;
  if (!next || next <= round) {
    const min = getMinInterval(); const max = Math.max(min, getMaxInterval());
    next = round + min + Math.floor(Math.random() * (max - min + 1));
    cset('nextInspirationRound', next);
  }
  if (force || round >= next) { const r = trigger(round); return { active: true, ...r }; }
  ensureDefault();
  return { active: false, next, round };
}

/** 界面用：当前状态 */
export function status() {
  return {
    enabled: getEnabled(), min: getMinInterval(), max: getMaxInterval(), test: getTestMode(),
    round: currentRound(),
    last: Number(cget('lastInspirationRound')) || 0,
    next: Number(cget('nextInspirationRound')) || 0,
    text: String(cget('divinationEvent') ?? ''),
    active: truthyVar(cget('divinationEventActive')),
  };
}
