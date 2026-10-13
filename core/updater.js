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

/** 本地版本（启动时从扩展自己的 manifest.json 读 ✓ 读不到再回退） */
let localVersion = '0.1.0';
export function setLocalVersion(v) { if (v) localVersion = String(v); }
export function getLocalVersion() { return localVersion; }

/** 本项目仓库（发布用 ✓） */
export const REPO = 'KinSakura/st-rbq';
export const REPO_URL = 'https://github.com/' + REPO;

/**
 * 更新源：**多源兜底** ✓
 *   国内直连 raw.githubusercontent 常不通 ✗ → 优先 jsDelivr（一般能通 ✓），再退 raw，最后退 GitHub API ✓
 *   用户自己填了 sourceUrl 就只用他填的那个 ✓
 */
export const DEF = {
  enabled: true,
  sourceUrl: 'https://cdn.jsdelivr.net/gh/' + REPO + '@main/manifest.json',
  downloadUrl: REPO_URL,
  dismissVersion: '',       // 用户点过"忽略"的版本
  notifiedVersion: '',      // 已经提示过的版本（避免每次打开都弹）
  autoCheck: true,          // 启动时自动查一次
};

/** 兜底源（用户没填 sourceUrl 时按顺序试 ✓） */
export function fallbackSources() {
  return [
    'https://cdn.jsdelivr.net/gh/' + REPO + '@main/manifest.json',
    'https://raw.githubusercontent.com/' + REPO + '/main/manifest.json',
    'https://api.github.com/repos/' + REPO + '/contents/manifest.json',
  ];
}

/**
 * 读"本地版本"：从扩展自己的 manifest.json（用 import.meta.url 定位 ✓ 不依赖酒馆 API ✓）
 *   ⚠️ 以前没人调 setLocalVersion ✗ → localVersion 一直是 0.1.0 ✓
 *      会变成"永远显示有新版本" ✗ 所以这里自己读一次 ✓
 */
export async function initLocalVersion() {
  try {
    const url = new URL('../manifest.json', import.meta.url);
    const res = await fetch(url, { cache: 'no-store' });
    if (res.ok) {
      const j = await res.json();
      setLocalVersion(j?.version);
      return localVersion;
    }
  } catch (e) { /* ignore */ }
  return localVersion;
}

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
  source: '',
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
    downloadUrl: c.downloadUrl || DEF.downloadUrl,
    source: state.source || '',
    repo: REPO_URL,
  };
}

export function dismiss() {
  const st = status();
  if (st.latest) setConfig({ dismissVersion: st.latest });
  return status();
}

/** 从远端 JSON 里取版本号（兼容 GitHub API 那种 base64 包裹的返回 ✓） */
function versionFromJson(j) {
  if (j && typeof j === 'object' && typeof j.content === 'string' && !j.version) {
    try {
      const txt = atob(String(j.content).replace(/\s/g, ''));
      const parsed = JSON.parse(txt);
      return String(parsed?.version ?? '').trim();
    } catch (e) { /* ignore */ }
  }
  return String(j?.version ?? j?.Version ?? '').trim();
}

/** 按顺序试多个源，第一个成功的就算 ✓（返回用过的源地址 ✓） */
async function fetchLatest(sources) {
  const errs = [];
  for (const url of sources) {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j = await res.json();
      const v = versionFromJson(j);
      if (!v) throw new Error('没有 version 字段');
      return { version: v, source: url };
    } catch (e) { errs.push(String(url).replace(/^https?:\/\//, '').slice(0, 28) + ':' + String(e?.message ?? e).slice(0, 24)); }
  }
  throw new Error(errs.join(' | ') || '全部更新源都失败');
}

/**
 * 检查更新（可重复调用；带 in-flight 去重）
 *   用户填了 sourceUrl → 只试它 ✓；没填 → 走多源兜底 ✓
 */
export async function check({ force = false } = {}) {
  const c = config();
  if (c.enabled === false) return status();
  if (state.checking) return status();
  if (state.checked && !force) return status();
  state.checking = true;
  state.error = '';
  try {
    if (!localVersion || localVersion === '0.1.0') { try { await initLocalVersion(); } catch (e) { /* ignore */ } }
    const custom = String(c.sourceUrl ?? '').trim();
    const def = String(DEF.sourceUrl).trim();
    const sources = (custom && custom !== def) ? [custom] : fallbackSources();
    const r = await fetchLatest(sources);
    state.latest = r.version;
    state.source = r.source;
    state.downloadUrl = String(c.downloadUrl || DEF.downloadUrl || '').trim();
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

/**
 * 启动时自动查一次 + **有新版本就提示一次**（同一个版本只提示一次 ✓）
 *   @returns {Promise<{shown:boolean, latest:string}>}
 */
export async function bootCheck() {
  try {
    const c = config();
    if (c.enabled === false || c.autoCheck === false) return { shown: false, latest: '' };
    await initLocalVersion();
    const st = await check({ force: false });
    if (st.hasUpdate && c.notifiedVersion !== st.latest) {
      setConfig({ notifiedVersion: st.latest });
      try {
        notify('info', 'RBQ 数据库有新版本 ' + st.latest + '（当前 ' + st.current + '）—— 面板「设置 → 插件更新」可一键更新，或去 ' + (st.downloadUrl || DEF.downloadUrl));
      } catch (e) { /* ignore */ }
      console.log('[RBQ] 发现新版本：' + st.latest + '（当前 ' + st.current + '，源 ' + (state.source || '') + '）');
      return { shown: true, latest: st.latest };
    }
    console.log('[RBQ] 版本检查：当前 ' + st.current + (st.latest ? ('，远端 ' + st.latest + (st.hasUpdate ? '（有新版）' : '（已是最新）')) : ('（没查到：' + st.error + '）')));
    return { shown: false, latest: st.latest };
  } catch (e) {
    console.warn('[RBQ] 版本检查失败（不影响使用）', e);
    return { shown: false, latest: '' };
  }
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
