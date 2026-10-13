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
/** 本地入口文件名（manifest.js[0]）—— 版本号没变但内容变了时也能认出更新 */
let localEntry = '';
export function getLocalEntry() { return localEntry; }
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
  /* 【实测 · v2.11.6】jsDelivr 的 @main 缓存能落后好几版 ✗
     我这边实测：jsDelivr 报 2.9.4，而 raw / GitHub API 都是 2.11.0 ✓
     所以顺序改成【raw 第一】(官方且最及时) → GitHub API → jsDelivr 只当最后兜底 ✓
     另外：某个源报的版本比本地还旧时，检查逻辑会明确提示"这是缓存"并主动去清 ✓ */
  return [
    'https://raw.githubusercontent.com/' + REPO + '/main/manifest.json',
    'https://api.github.com/repos/' + REPO + '/contents/manifest.json',
    'https://cdn.jsdelivr.net/gh/' + REPO + '@main/manifest.json',
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
      try { localEntry = String((j?.js || [])[0] || ''); } catch (e) { /* ignore */ }
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

/**
 * 清 jsDelivr 缓存（它的 @main 会缓存几分钟到几小时，
 *   这就是“仓库更新了但插件说已是最新”的主因）。purge 接口是公开的，失败也不影响。
 */
export async function purgeCache(entry = '') {
  const paths = ['manifest.json'];
  const e = String(entry || '').trim();
  if (/^[\w.\-]+\.js$/.test(e)) paths.push(e);
  paths.push('index.js');
  let any = false;
  for (const f of paths) {
    try {
      const u = 'https://purge.jsdelivr.net/gh/' + REPO + '@main/' + f;
      const res = await fetch(u, { cache: 'no-store' });
      if (res.ok) any = true;
      console.log('[RBQ] 清缓存 ' + f + ' → ' + (res.ok ? '成功' : ('HTTP ' + res.status)));
    } catch (e2) { console.log('[RBQ] 清缓存 ' + f + ' 失败：' + String(e2?.message ?? e2)); }
  }
  return any;
}

/** 面板按钮用：强制清缓存 + 重查 */
export async function forceRefresh() {
  state.checked = false;
  try { await purgeCache(state.entry || localEntry); } catch (e) { /* ignore */ }
  return check({ force: true });
}

/* ------------------------------------------------------------------ 状态 */

const state = {
  checked: false,
  source: '',
  sources: [],
  checking: false,
  latest: '',
  gitBehind: false,
  git: null,
  entry: '',
  purged: false,
  error: '',
  at: 0,
  downloadUrl: '',
};

export function status() {
  const c = config();
  const latest = state.latest;
  /* 【用户反馈 · 远程酒馆点检查更新却说已是最新】
   根因：以前只看版本号 —— 远端（尤其 jsDelivr 缓存的 manifest）报的版本可能比本地还旧，
        或者版本号一样但内容换了，于是永远显示已是最新。
   现在三条一起判：远端更高 / 版本相同但入口文件不同 / 远端比本地旧（明确提示是缓存） */
const entryDiff = !!(state.latest && state.entry && localEntry && state.entry !== localEntry);
const remoteOlder = !!latest && !!localVersion && localVersion !== '0.1.0' && isNewer(localVersion, latest) && latest !== localVersion;
/* 【v2.11.6】酒馆服务器的 git 比对最高优先 ✓ 它说的是"远端确实有新提交" ✓ 与 CDN 无关 ✓ */
const hasUpdate = !!state.gitBehind || (!!latest && isNewer(latest, localVersion)) || (!!latest && latest === localVersion && entryDiff);
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
    entryDiff,
    remoteOlder,
    remoteEntry: state.entry || '',
    localEntry: localEntry || '',
    purged: !!state.purged,
    gitBehind: !!state.gitBehind,
    git: state.git || null,
    sources: state.sources || [],
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

/**
 * 【用户实测】仓库明明已经更新了 ✗ 插件却说"已是最新" —— 因为 jsDelivr 有缓存 ✗
 *   （它按 @main 缓存，几分钟到几小时才刷 ✓）
 *   修法：**多个源并行查** ✓ 取里面**版本号最高**的那个 ✓
 *   （任何源报了更新的版本就算有更新 ✓ 不再受单个源缓存影响 ✓）
 * @returns {Promise<{version:string, source:string, all:Array}>}
 */
/** 统一的请求头（CSRF 等，酒馆要求）*/
function headersFor() {
  try { return ctx()?.getRequestHeaders?.() ?? { 'Content-Type': 'application/json' }; } catch (e) { return { 'Content-Type': 'application/json' }; }
}

async function fetchLatest(sources) {
  const results = await Promise.all(sources.map(async (url) => {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const j = await res.json();
      const v = versionFromJson(j);
      if (!v) throw new Error("没有 version 字段");
      /* 远端入口文件名（GitHub API 的 base64 也要解出来） */
      let entry = '';
      try {
        if (j && typeof j.content === 'string' && !j.version) entry = String((JSON.parse(atob(String(j.content).replace(/\s/g, '')))?.js || [])[0] || '');
        else entry = String((j?.js || [])[0] || '');
      } catch (e) { /* ignore */ }
      return { url, version: v, entry, ok: true };
    } catch (e) { return { url, version: "", ok: false, err: String(e?.message ?? e).slice(0, 40) }; }
  }));
  const good = results.filter((x) => x.ok);
  if (!good.length) throw new Error(results.map((x) => String(x.url).replace(/^https?:\/\//, "").slice(0, 26) + ":" + (x.err || "")).join(" | ") || "全部更新源都失败");
  /* 取最高版本 ✓ */
  let best = good[0];
  for (const x of good) { if (isNewer(x.version, best.version)) best = x; }
  /* 入口文件名取第一个报出来的 */
  const entry = (good.find((x) => x.entry) || {}).entry || '';
  return { version: best.version, source: best.url, entry, all: good.map((x) => String(x.url).replace(/^https?:\/\//, "").slice(0, 30) + "=" + x.version) };
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
    /* 【v2.11.6 关键】先问酒馆服务器（它 git fetch 后比对提交，与 CDN 无关）*/
    try {
      const git = await gitCheck(headersFor());
      state.git = git || null;
      state.gitBehind = !!(git && git.commit && git.isUpToDate === false);
      if (state.gitBehind) {
        try { console.log('[RBQ] 酒馆服务器说有新提交（本地 ' + git.commit + (git.branch ? ' @ ' + git.branch : '') + '）→ 判定有更新 ✓'); } catch (e) { /* ignore */ }
      }
    } catch (e) { state.git = null; state.gitBehind = false; }
    let r = await fetchLatest(sources);
    /* 远端比本地旧 = 几乎一定是 CDN 缓存 → 主动清一次再查 */
    try {
      const looksStale = r.version && localVersion && localVersion !== '0.1.0' && isNewer(localVersion, r.version);
      if (looksStale) { state.purged = await purgeCache(r.entry); if (state.purged) r = await fetchLatest(sources); }
    } catch (e) { /* ignore */ }
    state.latest = r.version;
    state.entry = r.entry || '';
    state.source = r.source;
    state.sources = r.all || [];
    try { console.log('[RBQ] 各更新源：' + (r.all || []).join(' ｜ ')); } catch (e) { /* ignore */ }
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

/**
 * 问酒馆"我这个扩展到底叫什么、装在哪"（GET /api/extensions/discover）
 *   返回形如 [{type:'local'|'global'|'system', name:'third-party/st-rbq'}] ✓
 *   ⚠️ update 接口会 sanitize 掉名字里的 '/' ✗ → 必须取**最后一段**当文件夹名 ✓
 *      （也顺便解决 "GitHub ZIP 解压出来叫 st-rbq-main" 这种情况 ✓）
 */
async function discoverSelf(headers) {
  try {
    const res = await fetch('/api/extensions/discover', { method: 'GET', headers });
    if (!res.ok) return [];
    const list = await res.json();
    const out = [];
    for (const e of (Array.isArray(list) ? list : [])) {
      const full = String(e?.name || '');
      const folder = full.split('/').pop() || full;
      if (!/st[\s_-]?rbq/i.test(full) && !/st[\s_-]?rbq/i.test(folder)) continue;
      out.push({ extensionName: folder, global: String(e?.type) === 'global', full, type: String(e?.type || '') });
    }
    if (out.length) console.log('[RBQ] 酒馆告诉我本扩展装在：' + JSON.stringify(out));
    return out;
  } catch (e) { return []; }
}

/**
 * 一键更新：调酒馆的扩展更新接口
 *   【用户实测 · 管理扩展里能更新、插件按钮里不能】两个坑：
 *     ① 酒馆前端会传 global（我以前没传 → 只在用户目录下找 ✗）
 *     ② 扩展文件夹名不一定是 st-rbq（GitHub ZIP 解压出来是 st-rbq-main ✗）
 *        而且 update 接口会把名字里的 '/' sanitize 掉 ✗ → 只能用真实文件夹名 ✓
 *   做法：先问 discover 拿到真实名字与安装位置 ✓，再退到默认两种都试一遍 ✓
 */
/**
 * 【酒馆自己就是这么查的】让服务器在扩展目录里 git fetch，再比对提交
 *   POST /api/extensions/version { extensionName, global }
 *   → { currentBranchName, currentCommitHash, isUpToDate, remoteUrl }
 *   不是 git 仓库时 isUpToDate 会是 true 且 commit 为空（那就说明这套查法不适用）
 */
export async function gitCheck(headers) {
  const out = { tried: [], isUpToDate: null, commit: '', branch: '', url: '', error: '' };
  try {
    let found = [];
    try { found = await discoverSelf(headers); } catch (e) { /* ignore */ }
    const seen = new Set();
    const tries = [];
    for (const t of [...found, { extensionName: EXT_NAME, global: false }, { extensionName: EXT_NAME, global: true }]) {
      const k = t.extensionName + '|' + !!t.global;
      if (seen.has(k)) continue;
      seen.add(k);
      tries.push({ extensionName: t.extensionName, global: !!t.global });
    }
    for (const body of tries) {
      let res;
      try {
        res = await fetch('/api/extensions/version', {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch (e) { out.error = String(e?.message ?? e); continue; }
      const txt = await res.text().catch(() => '');
      if (!res.ok) { out.error = 'HTTP ' + res.status + ' ' + String(txt).slice(0, 120); out.tried.push(JSON.stringify(body)); continue; }
      let j = {};
      try { j = JSON.parse(txt) || {}; } catch (e) { /* ignore */ }
      out.tried.push(JSON.stringify(body));
      out.commit = String(j.currentCommitHash || '').slice(0, 7);
      out.branch = String(j.currentBranchName || '');
      out.url = String(j.remoteUrl || '');
      out.isUpToDate = j.isUpToDate === true;
      if (!out.commit) out.error = '这台服务器上的扩展目录不是 Git 仓库（酒馆查不了提交）';
      break;
    }
    try { console.log('[RBQ] 酒馆服务器 git 比对：' + JSON.stringify(out)); } catch (e) { /* ignore */ }
  } catch (e) { out.error = String(e?.message ?? e); }
  return out;
}

export async function applyUpdate() {
  const c = config();
  const headers = (() => { try { return ctx()?.getRequestHeaders?.() ?? { 'Content-Type': 'application/json' }; } catch { return { 'Content-Type': 'application/json' }; } })();
  let found = [];
  try { found = await discoverSelf(headers); } catch (e) { /* ignore */ }
  const seen = new Set();
  const tries = [];
  for (const t of [...found, { extensionName: EXT_NAME, global: false }, { extensionName: EXT_NAME, global: true }]) {
    const k = t.extensionName + '|' + !!t.global;
    if (seen.has(k)) continue;
    seen.add(k);
    tries.push({ extensionName: t.extensionName, global: !!t.global });
  }
  const tried = [];
  let lastErr = '';
  try {
    for (const body of tries) {
      let res;
      try {
        res = await fetch('/api/extensions/update', {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch (e) { lastErr = String(e?.message ?? e); continue; }
      const bodyText = await res.text().catch(() => '');
      if (!res.ok) {
        let detail = bodyText;
        try { const j = JSON.parse(bodyText); detail = j?.message || j?.error || bodyText; } catch (e) { /* 非 JSON 就用原文 */ }
        lastErr = 'HTTP ' + res.status + (detail ? ('（' + String(detail).slice(0, 160) + '）') : '');
        console.log('[RBQ] 一键更新这一组没成：' + JSON.stringify(body) + ' → ' + lastErr);
        continue;
      }
      /* 成功：酒馆回 { shortCommitHash, isUpToDate, extensionPath, remoteUrl } */
      let info = {};
      try { info = JSON.parse(bodyText) || {}; } catch (e) { /* ignore */ }
      const hash = String(info.shortCommitHash || '').slice(0, 7);
      console.log('[RBQ] 一键更新成功：' + JSON.stringify(body) + ' → ' + JSON.stringify(info));
      if (info.isUpToDate) notify('success', '服务器那边已经是最新的了（提交 ' + hash + '）—— 刷新页面即可。');
      else notify('success', '已更新到最新（提交 ' + (hash || '?') + '）—— 刷新页面生效。');
      return { ok: true, info, body };
    }
    throw new Error(lastErr || '四种装法都没试通');
  } catch (e) {
    const msg = String(e?.message ?? e);
    const link = state.downloadUrl || c.downloadUrl;
    const zip = 'https://github.com/' + REPO + '/archive/refs/heads/main.zip';
    notify('warning', '一键更新没成功（' + msg + '）—— 可以手动下载覆盖：' + (link || zip));
    try { console.log('[RBQ] 一键更新失败：' + msg + NL + '   手动更新包：' + zip); } catch (e2) { /* ignore */ }
    return { ok: false, error: msg, downloadUrl: link };
  }
}
