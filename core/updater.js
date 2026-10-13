/**
 * updater.js —— 插件更新检查与一键更新
 *
 * 行为：
 *   · 从**配置的更新源**（默认空 = 不检查，横幅不出现）拉取远端 manifest.json
 *   · 与本地 manifest.json 的 version 比较（语义化数字比较）
 *   · 有新版 → 面板顶部出现小横幅 + 「更新」按钮
 *   · 「更新」按钮：调酒馆自己的 `POST /api/extensions/update`（不模拟点击、不改酒馆代码）
 *     失败（例如本地目录不是 git 仓库）→ 返回下载地址，让用户手动覆盖
 */

import * as store from './store.js';
import { ctx, notify } from './ctx.js';

export const EXT_NAME = 'st-rbq';

/** 本地版本（从 manifest.json 读，失败则回退） */
let localVersion = '0.1.0';
export function setLocalVersion(v) { if (v) localVersion = String(v); }
export function getLocalVersion() { return localVersion; }

export const DEF = {
  enabled: true,
  sourceUrl: '',            // 远端 manifest.json 地址；空 = 不检查
  downloadUrl: '',          // 兜底下载地址（更新失败时提示）
  dismissVersion: '',       // 用户点过"稍后"的版本
};

export function config() { return { ...DEF, ...(store.getConfigValue('update', {}) ?? {}) }; }
export function setConfig(patch = {}) { const next = { ...config(), ...patch }; store.updateConfig({ update: next }); return next; }

/* ------------------------------------------------------------------ 版本比较 */

/** 把 "0.1.17" / "v1.2" 解析成数字数组 */
export function parseVersion(v) {
  return String(v ?? '')
    .trim()
    .replace(/^v/i, '')
    .split(/[.\-+]/)
    .map((x) => parseInt(x, 10))
    .filter((n) => Number.isFinite(n));
}

/** a 是否比 b 新 */
export function isNewer(a, b) {
  const A = parseVersion(a); const B = parseVersion(b);
  const n = Math.max(A.length, B.length);
  for (let i = 0; i < n; i++) {
    const x = A[i] ?? 0; const y = B[i] ?? 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

/* ------------------------------------------------------------------ 状态 */

const state = {
  checked: false,
  checking: false,
  latest: '',
  error: '',
  at: 0,
  downloadUrl: '',
};

export function status() {
  const c = config();
  const latest = state.latest;
  const hasUpdate = !!latest && isNewer(latest, localVersion);
  const dismissed = !!latest && c.dismissVersion === latest;
  return {
    current: localVersion,
    latest,
    hasUpdate,
    show: hasUpdate && !dismissed && c.enabled !== false,
    dismissed,
    checking: state.checking,
    checked: state.checked,
    error: state.error,
    at: state.at,
    sourceUrl: c.sourceUrl,
    downloadUrl: c.downloadUrl,
  };
}

export function dismiss() {
  const st = status();
  if (st.latest) setConfig({ dismissVersion: st.latest });
  return status();
}

/** 检查更新（可重复调用；带 in-flight 去重） */
export async function check({ force = false } = {}) {
  const c = config();
  if (c.enabled === false) return status();
  if (!String(c.sourceUrl).trim()) { state.checked = true; state.error = '未配置更新源'; return status(); }
  if (state.checking) return status();
  if (state.checked && !force) return status();
  state.checking = true;
  state.error = '';
  try {
    const res = await fetch(String(c.sourceUrl).trim(), { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    state.latest = String(j?.version ?? j?.Version ?? '').trim();
    state.downloadUrl = String(j?.download ?? c.downloadUrl ?? '').trim();
    if (!state.latest) throw new Error('远端 manifest 没有 version 字段');
  } catch (e) {
    state.error = String(e?.message ?? e);
    state.latest = '';
  } finally {
    state.checking = false;
    state.checked = true;
    state.at = Date.now();
  }
  return status();
}

/** 一键更新：调酒馆的扩展更新接口 */
export async function applyUpdate() {
  const c = config();
  try {
    const headers = (() => { try { return ctx()?.getRequestHeaders?.() ?? { 'Content-Type': 'application/json' }; } catch { return { 'Content-Type': 'application/json' }; } })();
    const res = await fetch('/api/extensions/update', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ extensionName: EXT_NAME }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    notify('success', '更新完成，刷新页面生效。');
    return { ok: true };
  } catch (e) {
    const msg = String(e?.message ?? e);
    const link = state.downloadUrl || c.downloadUrl;
    notify('warning', link ? ('自动更新失败（' + msg + '），请手动下载：' + link) : ('自动更新失败：' + msg));
    return { ok: false, error: msg, downloadUrl: link };
  }
}
