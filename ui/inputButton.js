/**
 * inputButton.js —— 输入框旁的小按钮（发送键左边/右边）
 *
 * 完全复刻你现有 RBQ 的手感：
 *   · 图标 fa-sliders，样式**镜像参考按钮**（优先 options_button / extensionsMenuButton），
 *     所以它看起来就是原生工具栏的一部分，而不是贴上去的异物；
 *   · MutationObserver + 轮询兜底（酒馆会重建输入区，按钮被吞掉时自动补回来）；
 *   · 点一下开面板。
 *
 * 唯一的新增：placement 可配（before = 紧贴发送键左侧，与旧版一致；after = 发送键右侧）。
 */

import { doc, win, notify } from '../core/ctx.js';
import * as store from '../core/store.js';

const BTN_ID = 'rbq-input-btn';
const STYLE_ID = 'rbq-input-btn-style';
let observer = null;
let pollTimer = null;

/* --------------------------------------------------------- 定位发送按钮 */

function findSendButton() {
  const d = doc();
  if (!d) return null;
  return d.getElementById('send_but') ?? d.querySelector('#send_form #send_but') ?? null;
}

/** 工具栏定位失败时的兜底锚点（窄屏/移动版布局会把 #send_but 挪走或隐藏） */
function findFallbackAnchor() {
  const d = doc();
  if (!d) return null;
  for (const sel of ['#send_form', '#nonQRFormItems', '#rightSendForm', '#leftSendForm']) {
    const el = d.querySelector(sel);
    if (el) return el;
  }
  return null;
}

/** 有没有可见的工具栏锚点（窄屏或移动版可能一个都没有） */
function hasUsableAnchor() {
  const d = doc();
  if (!d) return false;
  const el = findSendButton() ?? findFallbackAnchor();
  if (!el) return false;
  try {
    const cs = win()?.getComputedStyle?.(el);
    // 只判断"是否被显式隐藏"——不要看尺寸：jsdom 里没有布局，宽高恒为 0
    if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) return false;
  } catch { /* ignore */ }
  return true;
}

/** 兜底：一个固定的浮动入口（底部左侧），保证任何设备都打得开面板 */
function ensureFloatingButton(d) {
  try { removeFloatingButton(d); } catch (e) { /* ignore */ }
  return null;   // 同上：不再创建悬浮钮
  /* eslint-disable no-unreachable */
  const FAB = 'rbq-fab-btn';
  let fab = d.getElementById(FAB);
  if (!fab) {
    fab = d.createElement('div');
    fab.id = FAB;
    fab.setAttribute('role', 'button');
    fab.setAttribute('tabindex', '0');
    fab.title = 'RBQ 数据库';
    fab.innerHTML = '<i class="fa-solid fa-sliders"></i>';
    // 同上：点击交给文档级委托
    ((d.documentElement ?? d.body)).appendChild(fab);
  }
  return fab;
}

/** 浮动入口什么时候显示：窄屏 / 工具栏按钮不在可视区 / 找不到按钮 —— 一律显示（可配 fab: auto|always|off） */
export const FAB_NARROW_PX = 760;
export function shouldShowFab(widthOverride = null) {
  void widthOverride;
  return false;   // 【用户要求】彻底不要这个悬浮兜底钮（直接删除）
  /* eslint-disable no-unreachable */
  const cfg = store.getConfigValue('inputButton', {});
  // 用户反馈：输入框旁的按钮在，右下角却还飘一个圆形兜底钮 → 默认**关闭**兜底 ✓
  // （要的话在设置里把它设成 always，或把输入框按钮关掉后它会自动出现）
  if (cfg.fab !== "always" && cfg.fab !== "auto") return false;
  if (cfg.fab === "always") return true;
  const d = doc();
  const w = Number.isFinite(Number(widthOverride))
    ? Number(widthOverride)
    : (() => { try { return win()?.innerWidth ?? 1024; } catch { return 1024; } })();
  // 用户反馈：输入框旁的按钮本来就在，右下角却还飘出一个圆形兜底按钮 ✗
  // → 现在只有在"输入框旁的按钮真的不存在"时才给兜底入口（不再按 rect 猜可见性，也不再看宽度）
  const b = d?.getElementById(BTN_ID);
  if (!b) return true;                                   // 找不到按钮 → 才显示兜底
  try { if (!b.parentElement) return true; } catch { return true; }
  return false;
}

function removeFloatingButton(d) {
  d?.getElementById('rbq-fab-btn')?.remove();
}

/** 找一个"原生按钮"当样式模板 */
function findReferenceButton() {
  const send = findSendButton();
  const d = send?.ownerDocument ?? doc();
  if (!d) return null;
  for (const id of ['options_button', 'extensionsMenuButton', 'extensions_menu_button', 'rightSendForm']) {
    const el = d.getElementById(id);
    if (el && el.id !== BTN_ID) return el;
  }
  if (send?.parentNode) {
    for (const sib of [...send.parentNode.children]) {
      if (sib.id === 'send_but' || sib.id === BTN_ID) continue;
      try {
        const cs = win()?.getComputedStyle?.(sib);
        const bg = cs?.backgroundColor;
        if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') return sib;
      } catch { /* ignore */ }
    }
  }
  return null;
}

/* ------------------------------------------------------------- 样式注入 */

function injectButtonStyle(d) {
  let style = d.getElementById(STYLE_ID);
  if (!style) {
    style = d.createElement('style');
    style.id = STYLE_ID;
    d.head?.appendChild(style);
  }

  // 默认值：即使找不到参考按钮也要好看
  let bg = 'rgba(255,255,255,0.10)';
  let radius = '8px';
  let width = '40px';
  let height = '40px';
  let color = 'var(--SmartThemeBodyColor, #d0d0d0)';
  let border = 'none';

  const ref = findReferenceButton();
  if (ref) {
    try {
      const cs = win()?.getComputedStyle?.(ref);
      if (cs) {
        if (cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent') bg = cs.backgroundColor;
        if (cs.borderRadius && cs.borderRadius !== '0px') radius = cs.borderRadius;
        if (cs.width && cs.width !== 'auto' && cs.width !== '0px') width = cs.width;
        if (cs.height && cs.height !== 'auto' && cs.height !== '0px') height = cs.height;
        if (cs.color) color = cs.color;
        if (cs.borderTopWidth && cs.borderTopWidth !== '0px') border = `${cs.borderTopWidth} ${cs.borderTopStyle} ${cs.borderTopColor}`;
      }
    } catch { /* ignore */ }
  }

  style.textContent = `
#rbq-fab-btn {
  position: fixed;
  right: 12px;
  /* 只用 top 定位：<html> 带 transform 时 bottom 会把元素推到屏幕外 */
  top: calc(100vh - 150px);
  bottom: auto;
  z-index: 99998;
  width: 42px;
  height: 42px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: ${bg};
  color: ${color};
  border: ${border};
  box-shadow: 0 4px 14px rgba(0,0,0,.45);
  cursor: pointer;
}
#rbq-fab-btn:hover { filter: brightness(1.25); }
#${BTN_ID} {
  background: ${bg};
  border: ${border};
  border-radius: ${radius};
  width: ${width};
  height: ${height};
  color: ${color};
  margin: 0 2px;
  font-size: 16px;
}
#${BTN_ID} i { pointer-events: none; }
`;
}

/* --------------------------------------------------------------- 注入 */

export function injectInputButton() {
  const send = findSendButton();
  const anchorOk = hasUsableAnchor() && !!send?.parentNode;
  const dd = doc();
  if (dd) injectButtonStyle(dd);
  // 工具栏按钮能插就插（宽屏时它就是主入口）
  if (!anchorOk) {
    if (dd) ensureFloatingButton(dd);
    return false;   // 【审计修】工具栏按钮没插上就返回 false ✓（以前恒 true → 轮询提前放弃、30 秒告警永不触发 ✗）
  }
  // 注意：这里用 send.ownerDocument，别用 doc()
  const docOwner = send.ownerDocument;
  // 窄屏 / 按钮被挤出可视区 / 找不到按钮 → 一律再给一个浮动入口（与工具栏按钮共存）
  if (shouldShowFab()) ensureFloatingButton(docOwner);
  else removeFloatingButton(docOwner);

  const d = send.ownerDocument;
  const cfg = store.getConfigValue('inputButton', {});
  // 一次性迁移：老版本默认是 before（发送键左侧），用户更喜欢输入框右侧 → 自动挪到 after
  try {
    if (cfg.placement === 'before' && cfg.placementMovedToAfter !== true) {
      const cur = store.getConfigValue('inputButton', {}) ?? {};
      store.updateConfig({ inputButton: { ...cur, placement: 'after', placementMovedToAfter: true } });
      cfg.placement = 'after';
      console.log('[RBQ] 输入框按钮已从“发送键左侧”迁移到“输入框右侧”');
    }
  } catch { /* ignore */ }
  if (cfg.enabled === false) {
    d.getElementById(BTN_ID)?.remove();
    removeFloatingButton(d);
    return true;
  }

  injectButtonStyle(d);

  let btn = d.getElementById(BTN_ID);
  if (!btn) {
    btn = d.createElement('div');
    btn.id = BTN_ID;
    btn.setAttribute('role', 'button');
    btn.setAttribute('tabindex', '0');
    btn.innerHTML = `<i class="${cfg.icon || 'fa-solid fa-sliders'}"></i>`;
    // 注意：**不要**在这里加 click 监听 —— 点击统一由文档级委托处理，
    // 否则一次点击会走两条路径 → "开一次又关一次"，表现为点了没反应。
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPanelSafely(); }
    });
  }

  btn.title = cfg.title || 'RBQ 数据库';

  // 默认放「输入框右边」（用户偏好）；只有显式设成 before 才放左边
  const placement = cfg.placement === 'before' ? 'before' : 'after';
  const anchor = placement === 'after' ? send.nextSibling : send;
  if (placement === 'after' ? btn.previousSibling !== send : btn.nextSibling !== send) {
    try {
      send.parentNode.insertBefore(btn, anchor);
    } catch { /* ignore */ }
  }
  refreshBadge();
  return true;
}

/** 有数据时给按钮加个小绿点 */
export function refreshBadge() {
  const d = doc();
  const btn = d?.getElementById(BTN_ID);
  if (!btn) return;
  try {
    const s = store.stats();
    btn.classList.toggle('rbq-has-data', s.rowTotal > 0);
  } catch { /* ignore */ }
}

/* --------------------------------------------------- 观察与轮询（防被吞） */

/**
 * 文档级点击兜底：酒馆会在重排/切布局时**克隆**输入区节点，克隆不会带走我们绑的监听器。
 * 所以再在 document 上挂一个委托：只要点中我们的三个入口，就开面板。
 */
let delegatedClickBound = false;
export function bindDelegatedOpen() {
  const d = doc();
  if (!d || delegatedClickBound) return;
  delegatedClickBound = true;
  d.addEventListener('click', (e) => {
    const t2 = e.target;
    if (!t2?.closest) return;
    const hit = t2.closest('#rbq-input-btn, #rbq-fab-btn, #rbq-menu-entry');
    if (!hit) return;
    e.preventDefault();
    e.stopPropagation();
    // 不需要时间护栏：元素自身的 click 已移除，全站只有这一条点击路径，不存在双触发
    setTimeout(() => openPanelSafely(), 0);
  }, true);
}

export function observeInputButton() {
  if (observer) return;
  const d = doc();
  const target = d?.body;
  if (!target) return;
  observer = new MutationObserver(() => {
    const sb = findSendButton();
    if (!sb) return;
    const b = sb.ownerDocument.getElementById(BTN_ID);
    const cfg = store.getConfigValue('inputButton', {});
    if (cfg.enabled === false) return;
    const needInject = !b
      || (cfg.placement === 'after' ? b.previousSibling !== sb : b.nextSibling !== sb);
    if (needInject) injectInputButton();
  });
  try { observer.observe(target, { childList: true, subtree: true }); } catch { /* ignore */ }
}

export function startInputButtonInjection() {
  injectInputButton();
  bindDelegatedOpen();
  observeInputButton();
  if (pollTimer) return;
  let attempts = 0;
  pollTimer = setInterval(() => {
    attempts++;
    const ok = injectInputButton();
    if (ok && attempts > 4) {
      clearInterval(pollTimer);
      pollTimer = null;
      return;
    }
    if (attempts >= 60) {                 // 30 秒还没找到发送键
      clearInterval(pollTimer);
      pollTimer = null;
      console.warn('[RBQ] 30 秒内没找到 #send_but，输入框按钮注入失败。请确认酒馆版本。');
      notify('warning', '没找到发送键，输入框按钮未能注入。');
    }
  }, 500);
}

export function stopInputButton() {
  removeFloatingButton(doc());
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (observer) { try { observer.disconnect(); } catch { /* ignore */ } observer = null; }
  doc()?.getElementById(BTN_ID)?.remove();
}

/* ------------------------------------------------------------- 面板入口 */

let openPanelFn = null;
/** 由 index.js 注入，避免 ui 之间互相 import 造成循环 */
export function setPanelOpener(fn) {
  openPanelFn = fn;
}

function showOpenError(msg) {
  try {
    const d = doc();
    if (!d) return;
    let b = d.getElementById('rbq-open-error');
    if (!b) {
      b = d.createElement('div');
      b.id = 'rbq-open-error';
      b.style.cssText = 'position:fixed;left:12px;top:calc(100vh - 120px);bottom:auto;z-index:999999;background:#7a2a1f;color:#fff;padding:10px 14px;border-radius:8px;font:13px/1.6 sans-serif;max-width:70vw;white-space:pre-wrap';
      ((d.documentElement ?? d.body)).appendChild(b);
    }
    b.textContent = 'RBQ 打不开面板：' + msg + String.fromCharCode(10) + '按 F12 把 [RBQ] 相关那几行发我；也可在控制台执行 RBQ.openPanel() 试试。';
  } catch { /* ignore */ }
}

function openPanelSafely() {
  try {
    if (typeof openPanelFn === 'function') openPanelFn();
    else { console.warn('[RBQ] 面板尚未就绪（openPanelFn 还没注入）'); showOpenError('面板模块尚未就绪'); }
  } catch (e) {
    console.error('[RBQ] 打开面板失败', e);
    notify('error', `打开面板失败：${e?.message ?? e}`);
    showOpenError(e?.message ?? String(e));
  }
}
