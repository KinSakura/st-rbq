/**
 * inject.js —— 给 AI 的第三条通道：酒馆原生注入（setExtensionPrompt）
 *
 * 三条通道各管一段：
 *   ① 宏 {{tableData}} —— 用户在预设里自己决定放哪（rbq.js 那套用法）
 *   ② 变量（narrationPromptActive 等）—— 功能开关
 *   ③ 原生注入（本文件）—— 有些预设不想改、或环境没有宏时，直接把数据塞进上下文
 *
 * api 可注入，便于单测（不依赖真酒馆）。
 */
import { ctx } from './ctx.js';
import * as store from './store.js';
import { buildTableData, buildTablePrompt } from '../prompts/prompts.js';

export const DEFAULT_NATIVE = {
  enabled: false,
  position: 'in_chat',
  depth: 4,
  scan: true,
  withPrompt: false,
};

export function nativeConfig() {
  const saved = store.getConfigValue('dataFormat.nativeInject', {}) ?? {};
  return { ...DEFAULT_NATIVE, ...saved };
}

export function setNativeConfig(patch) {
  const next = { ...nativeConfig(), ...(patch ?? {}) };
  const df = store.getConfigValue('dataFormat', {}) ?? {};
  store.updateConfig({ dataFormat: { ...df, nativeInject: next } });
  return next;
}

function posOf(api, position) {
  const t = api?.extension_prompt_types ?? {};
  return position === 'in_prompt' ? (t.IN_PROMPT ?? 0) : (t.IN_CHAT ?? 1);
}

/** 把表格数据按配置注入（或清空）。返回结果便于诊断与测试 */
export function applyNativeInjection(api = ctx()) {
  const c = nativeConfig();
  const set = api?.setExtensionPrompt;
  if (typeof set !== 'function') return { ok: false, reason: 'no-api' };
  if (!c.enabled) {
    try { set('rbqdb', '', posOf(api, c.position), 0, false); } catch { /* ignore */ }
    return { ok: false, reason: 'disabled' };
  }
  let text = buildTableData();
  if (c.withPrompt) text = buildTablePrompt() + String.fromCharCode(10, 10) + text;
  const position = posOf(api, c.position);
  const depth = Number(c.depth) || 0;
  try {
    set('rbqdb', text, position, depth, !!c.scan);
  } catch (e) {
    return { ok: false, reason: 'call-failed', error: e?.message ?? String(e) };
  }
  return { ok: true, bytes: text.length, position, depth };
}

export function clearNativeInjection(api = ctx()) {
  const set = api?.setExtensionPrompt;
  if (typeof set !== 'function') return false;
  try { set('rbqdb', '', 0, 0, false); } catch { /* ignore */ }
  return true;
}
