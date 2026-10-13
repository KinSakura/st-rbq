/**
 * repair.js —— 出错时的"定向修复"，以及一个显式状态机
 *
 * 旧实现的毛病（痛点 ③）：一堆标志位互相猜状态（_isGenerating / _regenRetryCount /
 * _waitingForRegen / _lastGenerationEndedAt…）+ 90 秒看门狗 + 多个 setTimeout 抢时序，
 * 而且一旦数据段没写对就**整轮重新生成**（贵、且会毁掉已经满意的正文）。
 *
 * 这里的做法：
 *   1. **每轮一个显式状态**，存在该消息的锚点里：{roundId, attempts, lastReason, history}。
 *      能直接看出"这轮试了几次、为什么失败"，不用读代码猜。
 *   2. **优先定向修复**：把"哪一条没写进去、为什么"连同该表的列名与现有主键一起回灌给 AI，
 *      只要它补一小段 <data>。**不重写正文。**
 *   3. **整轮重生成降级为最后手段**，默认关闭；开启后也有上限与退避，且用户手动停止后绝不自动重试。
 *   4. 没有任何可用生成通道时，明确告知并放弃，不静默卡住。
 */

import { chat, notify, ctx } from './ctx.js';
import { getTable, getTables } from './schema.js';
import { listAttrs } from './alias.js';
import * as store from './store.js';
import * as txn from './txn.js';
import * as protocol from './protocol.js';
import * as llm from './llm.js';

/* ---------------------------------------------------------------- 状态机 */

/** 状态取值：idle（未处理）→ applying（已尝试写入）→ ok / needs-repair → repaired / gave-up */
const RUNTIME = {
  /** 用户手动停止的轮次（这些轮次不允许自动重试） */
  userStoppedRounds: new Set(),
  lastOutcome: null,
};

export function markUserStopped(roundId) {
  // '*' 作为通配哨兵：用户手动停止后，在下一次开始生成之前不做任何自动修复
  RUNTIME.userStoppedRounds.add('*');
  if (roundId) RUNTIME.userStoppedRounds.add(roundId);
  RUNTIME.lastOutcome = { at: Date.now(), state: 'user-stopped', roundId };
}
export function clearUserStop(roundId) {
  RUNTIME.userStoppedRounds.clear();
  if (roundId) RUNTIME.userStoppedRounds.delete(roundId);
}
export function runtimeState() {
  return { ...RUNTIME, userStoppedRounds: [...RUNTIME.userStoppedRounds] };
}

/** 取/写某条消息上的修复状态 */
export function getState(messageIndex) {
  const msg = chat()[messageIndex];
  const a = store.getAnchor(msg);
  return a?.repair ?? { roundId: a?.roundId ?? null, attempts: 0, history: [] };
}

function putState(messageIndex, patch) {
  const msg = chat()[messageIndex];
  if (!msg) return null;
  const a = store.getAnchor(msg) ?? { v: 1, roundId: null, rev: store.getRev(), at: Date.now(), hash: {}, undo: {} };
  const cur = a.repair ?? { roundId: a.roundId ?? null, attempts: 0, history: [] };
  a.repair = { ...cur, ...patch, lastAt: Date.now() };
  store.setAnchor(msg, a);
  return a.repair;
}

/* ---------------------------------------------------------------- 判断 */

/**
 * 判断这一轮是否需要修复。
 * @param {object} p
 * @param {string} p.text                AI 原始输出
 * @param {object} p.applyResult         txn.applyOps 的返回值
 * @param {object} [p.parseResult]       protocol.parseAll 的返回值
 * @returns {{needsRepair:boolean, reason?:string, detail?:any}}
 */
export function analyzeRound({ text, applyResult, parseResult }) {
  const cfg = store.getConfig();

  // ① 有 op 被拒 —— 这是**证据级**信号，优先修这一种
  const failed = applyResult?.failed ?? [];
  if (failed.length) {
    return {
      needsRepair: true,
      reason: 'apply-failed',
      detail: { failed, warnings: applyResult?.warnings ?? [] },
    };
  }

  // ② 配置要求必须出现某些标签，但一个表格标签都没有
  const required = cfg.repair?.requiredTags ?? [];
  if (required.length) {
    const hasDataTag = /<data\b/i.test(String(text ?? ''));
    const missing = required.filter((tag) => !new RegExp(`<${tag}\\b`, 'i').test(String(text ?? '')));
    if (!hasDataTag || missing.length) {
      return { needsRepair: true, reason: 'missing-tags', detail: { missing, hasDataTag } };
    }
  }

  // ③ 解析出了事实但一条 op 都没成功（例如全被规则挡下）
  const hadIntent = (parseResult?.facts?.length ?? 0) > 0 || (parseResult?.ops?.length ?? 0) > 0;
  if (hadIntent && (applyResult?.applied ?? 0) === 0) {
    return { needsRepair: true, reason: 'nothing-applied', detail: { parseResult } };
  }

  return { needsRepair: false };
}

/* ------------------------------------------------------- 构造修复提示词 */

function tableCheatSheet(no) {
  const t = getTable(no);
  if (!t) return '';
  const attrs = listAttrs(no).map((a) => (a.aliases.length ? `${a.aliases[0]}=${a.name}` : a.name));
  const rows = store.getRows(no, { create: false });
  const keys = rows.map((r) => t.keyIdx.map((i) => String(r?.[i] ?? '')).join('|')).filter((s) => s.replace(/\|/g, ''));
  return [
    `表${no} ${t.name}`,
    `  可写字段：${attrs.join('、')}`,
    keys.length ? `  已有条目（请用这些名字，不要新建重复的）：${keys.slice(0, 40).join('、')}` : '  目前没有条目',
  ].join('\n');
}

/**
 * 生成"只补数据"的提示词。
 * 刻意**不给**任何正文改写的机会：明确要求只输出 <data> 块。
 */
export function buildPatchPrompt({ reason, failed = [], missing = [], originalText = '', maxChars = 32000 }) {
  const parts = [];
  parts.push('你刚才的回复里，表格数据部分有问题，需要你**只补这一部分**。');
  parts.push('');
  parts.push('【硬性要求】');
  parts.push('1. 只输出一个 <data> 块，不要输出任何正文、解释、或其它标签。');
  parts.push('2. 只写"谁对谁做了什么"，不需要你算行号列号 —— 插件会自己找到正确的行与列。');
  parts.push('3. 名字请照抄下面的「已有条目」，避免同一个人被建成两条。');
  parts.push('');

  if (reason === 'apply-failed') {
    parts.push('【上次失败的原因】');
    for (const f of failed.slice(0, 12)) {
      const t = f.op?.table ?? '';
      parts.push(`- ${f.reason}${f.detail ? `：${f.detail}` : ''}${t !== '' ? `（表 ${t}）` : ''}`);
      if (f.candidates?.length) {
        parts.push(`  可能的候选：${f.candidates.map((c) => c.value ?? c.index).join('、')}`);
      }
    }
    parts.push('');
  } else if (reason === 'missing-tags') {
    parts.push('【上次缺少的内容】');
    parts.push(`- 缺少标签：${missing.join('、') || '整个 <data> 块'}`);
    parts.push('');
  } else if (reason === 'nothing-applied') {
    parts.push('【上次的情况】有表格改动意图，但没有任何一条能落地，请重新完整地写一次 <data>。');
    parts.push('');
  }

  const involved = new Set();
  for (const f of failed) {
    const no = Number(String(f.op?.table ?? '').replace(/\D/g, ''));
    if (!Number.isNaN(no) && getTable(no)) involved.add(no);
  }
  const show = involved.size ? [...involved] : [0, 2, 4, 13];
  parts.push('【相关表格的字段与已有条目】');
  for (const no of show) parts.push(tableCheatSheet(no));
  parts.push('');

  if (originalText) {
    const snippet = String(originalText).slice(-Math.max(1000, maxChars));
    parts.push('【你上一轮的回复末尾（仅供参考，不要重写）】');
    parts.push(snippet);
    parts.push('');
  }
  parts.push('现在请只输出 <data> 块。');
  return parts.join('\n');
}

/* ---------------------------------------------------------------- 执行 */

/**
 * 尝试修复。
 * @param {object} p
 * @param {number} p.messageIndex
 * @param {string} p.reason
 * @param {Array}  [p.failed]
 * @param {Array}  [p.missing]
 * @param {string} [p.originalText]
 * @returns {Promise<{ok:boolean, strategy:string, attempts:number, applied:number, notes:string[]}>}
 */
export async function repairRound({ messageIndex, reason, failed = [], missing = [], originalText = '' }) {
  const cfg = store.getConfig();
  const notes = [];
  const st = getState(messageIndex);
  const roundId = st.roundId ?? store.getAnchor(chat()[messageIndex])?.roundId ?? null;
  const maxAttempts = Math.max(1, Number(cfg.repair?.maxAttempts ?? 2));

  if (RUNTIME.userStoppedRounds.has('*') || (roundId && RUNTIME.userStoppedRounds.has(roundId))) {
    notes.push('用户手动停止过生成，按约定不再自动重试（下次开始生成后恢复）。');
    putState(messageIndex, { attempts: st.attempts, lastReason: 'user-stopped', history: [...(st.history ?? []), { at: Date.now(), strategy: 'none', ok: false, detail: 'user-stopped' }] });
    return { ok: false, strategy: 'none', attempts: st.attempts, applied: 0, notes };
  }

  if (st.attempts >= maxAttempts) {
    notes.push(`本轮已尝试修复 ${st.attempts} 次，达到上限（${maxAttempts}），放弃。`);
    putState(messageIndex, { lastReason: 'max-attempts' });
    RUNTIME.lastOutcome = { at: Date.now(), state: 'gave-up', messageIndex, reason };
    return { ok: false, strategy: 'none', attempts: st.attempts, applied: 0, notes };
  }

  const strategy = cfg.repair?.strategy ?? 'patch';

  /* ---- 策略 1：定向补数据（默认，不碰正文） ---- */
  if (strategy !== 'regen') {
    if (!llm.isAvailable()) {
      llm.warnUnavailable('定向修复');
      notes.push('没有可用的生成通道，未做定向修复。');
      putState(messageIndex, { lastReason: 'no-llm', history: [...(st.history ?? []), { at: Date.now(), strategy: 'patch', ok: false, detail: 'no-llm' }] });
      return { ok: false, strategy: 'patch', attempts: st.attempts, applied: 0, notes };
    }

    const prompt = buildPatchPrompt({ reason, failed, missing, originalText });
    const gen = await llm.generate(prompt, { maxTokens: cfg.repair?.maxTokens ?? 1200, temperature: cfg.repair?.temperature ?? 0.4 });
    const attempt = st.attempts + 1;

    if (!gen.ok) {
      notes.push(`定向修复请求失败：${gen.error}`);
      putState(messageIndex, {
        attempts: attempt, lastReason: 'llm-failed',
        history: [...(st.history ?? []), { at: Date.now(), strategy: 'patch', ok: false, detail: gen.error }],
      });
      return { ok: false, strategy: 'patch', attempts: attempt, applied: 0, notes };
    }

    const parsed = protocol.parseAll(gen.text, { allowFacts: true });
    if (!parsed.ops.length) {
      notes.push('定向修复返回的内容里没有可用的 <data> 事实。');
      putState(messageIndex, {
        attempts: attempt, lastReason: 'patch-empty',
        history: [...(st.history ?? []), { at: Date.now(), strategy: 'patch', ok: false, detail: 'no-ops' }],
      });
      return { ok: false, strategy: 'patch', attempts: attempt, applied: 0, notes };
    }

    const res = await txn.applyOps(parsed.ops, { source: 'repair', messageIndex });
    putState(messageIndex, {
      attempts: attempt,
      lastReason: res.failed.length ? 'patch-partial' : 'patch-ok',
      history: [...(st.history ?? []), { at: Date.now(), strategy: 'patch', ok: res.failed.length === 0, applied: res.applied, failed: res.failed.length }],
    });

    if (res.applied > 0) {
      notes.push(`定向修复成功：补写 ${res.applied} 条`);
      RUNTIME.lastOutcome = { at: Date.now(), state: 'repaired', messageIndex, strategy: 'patch', applied: res.applied };
      notify('success', `表格数据已由定向修复补上（${res.applied} 条）。`);
      return { ok: res.failed.length === 0, strategy: 'patch', attempts: attempt, applied: res.applied, notes };
    }

    notes.push(`定向修复写入失败：${res.failed.map((f) => f.reason).join('、')}`);
    return { ok: false, strategy: 'patch', attempts: attempt, applied: 0, notes };
  }

  /* ---- 策略 2：整轮重生成（最后手段，默认关闭） ---- */
  if (!cfg.repair?.autoRegen) {
    notes.push('整轮重生成未开启（设置里可开），本轮不做。');
    return { ok: false, strategy: 'regen', attempts: st.attempts, applied: 0, notes };
  }

  const ok = await requestRegenerate();
  notes.push(ok ? '已请求整轮重新生成。' : '请求重新生成失败（没有可用的命令通道）。');
  putState(messageIndex, {
    attempts: st.attempts + 1, lastReason: 'regen-requested',
    history: [...(st.history ?? []), { at: Date.now(), strategy: 'regen', ok }],
  });
  RUNTIME.lastOutcome = { at: Date.now(), state: 'regenerating', messageIndex };
  return { ok, strategy: 'regen', attempts: st.attempts + 1, applied: 0, notes };
}

/** 请求酒馆重新生成（尽量用原生通道，失败回落到 TavernHelper） */
export async function requestRegenerate() {
  const c = ctx();
  try {
    if (typeof c?.executeSlashCommandsWithOptions === 'function') {
      await c.executeSlashCommandsWithOptions('/regenerate', { showOutput: false });
      return true;
    }
  } catch (e) {
    console.warn('[RBQ] executeSlashCommandsWithOptions /regenerate 失败', e);
  }
  try {
    const w = (() => { try { return typeof window !== 'undefined' ? window : null; } catch { return null; } })();
    const th = w?.TavernHelper ?? w?.parent?.TavernHelper;
    if (typeof th?.triggerSlash === 'function') {
      await th.triggerSlash('/regenerate');
      return true;
    }
  } catch (e) {
    console.warn('[RBQ] TavernHelper.triggerSlash /regenerate 失败', e);
  }
  return false;
}

/** 给人看的状态摘要（面板用） */
export function describeState(messageIndex) {
  const s = getState(messageIndex);
  const last = s.history?.[s.history.length - 1];
  return {
    attempts: s.attempts ?? 0,
    lastReason: s.lastReason ?? '—',
    lastOk: last?.ok ?? null,
    history: s.history ?? [],
    outcome: RUNTIME.lastOutcome,
    llmAvailable: llm.isAvailable(),
  };
}

export { getTables };
