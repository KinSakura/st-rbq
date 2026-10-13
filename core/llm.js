/**
 * llm.js —— 可插拔的小请求通道
 *
 * 用途：定向修复（让 AI 只补一小段 <data>）、将来可能的摘要/审查辅助。
 * 关键点：**没有可用的调用通道时，必须优雅失败并明确告知**，绝不静默卡住。
 *
 * 调用通道按优先级尝试：
 *   1. 配置里指定的全局函数名（config.repair.generatorName，便于你自己接第二 API）
 *   2. 酒馆原生 ctx.generateRaw（不需要额外配置）
 *   3. TavernHelper.generateRaw
 */

import { ctx, notify } from './ctx.js';
import * as store from './store.js';

const state = {
  lastError: null,
  lastCallAt: 0,
  calls: 0,
};

export function stats() {
  return { ...state };
}

/** 找一个可用的生成函数；找不到返回 null */
export function resolveGenerator() {
  const name = store.getConfigValue('repair.generatorName', '');
  const w = (() => { try { return typeof window !== 'undefined' ? window : null; } catch { return null; } })();

  if (name) {
    const custom = w?.[name] ?? w?.parent?.[name];
    if (typeof custom === 'function') return { fn: custom, via: `window.${name}` };
  }
  const c = ctx();
  if (typeof c?.generateRaw === 'function') return { fn: c.generateRaw.bind(c), via: 'generateRaw' };
  const th = w?.TavernHelper ?? w?.parent?.TavernHelper;
  if (typeof th?.generateRaw === 'function') return { fn: th.generateRaw.bind(th), via: 'TavernHelper.generateRaw' };
  return null;
}

export function isAvailable() {
  return resolveGenerator() != null;
}

/**
 * 发一次小请求。
 * @param {string} prompt
 * @param {{maxTokens?:number, temperature?:number, timeoutMs?:number, systemPrompt?:string}} [opts]
 * @returns {Promise<{ok:boolean, text:string, via?:string, error?:string}>}
 */
export async function generate(prompt, opts = {}) {
  const gen = resolveGenerator();
  if (!gen) {
    state.lastError = 'no-generator';
    return { ok: false, text: '', error: '当前环境没有可用的生成通道（generateRaw / TavernHelper 都不可用）。' };
  }
  const timeoutMs = opts.timeoutMs ?? store.getConfigValue('repair.timeoutMs', 60000);
  state.calls++;
  state.lastCallAt = Date.now();

  try {
    const args = {
      prompt: String(prompt ?? ''),
      max_tokens: opts.maxTokens ?? store.getConfigValue('repair.maxTokens', 1200),
      temperature: opts.temperature ?? store.getConfigValue('repair.temperature', 0.4),
    };
    if (opts.systemPrompt) args.systemPrompt = opts.systemPrompt;

    const call = Promise.resolve(gen.fn(args));
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error(`生成超时（${timeoutMs}ms）`)), timeoutMs));
    const raw = await Promise.race([call, timeout]);

    // 各版本返回值可能是 string / {content} / {text}
    const text = typeof raw === 'string' ? raw : (raw?.content ?? raw?.text ?? raw?.message ?? '');
    if (!text) {
      state.lastError = 'empty-response';
      return { ok: false, text: '', via: gen.via, error: '生成通道返回了空内容。' };
    }
    return { ok: true, text, via: gen.via };
  } catch (e) {
    state.lastError = e?.message ?? String(e);
    console.warn('[RBQ] 小请求失败', e);
    return { ok: false, text: '', via: gen.via, error: state.lastError };
  }
}

export function warnUnavailable(where = '定向修复') {
  notify('warning', `${where}需要一次额外的 AI 请求，但当前环境没有可用的生成通道，已跳过。`);
}
