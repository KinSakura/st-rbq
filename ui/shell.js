/**
 * shell.js —— 面板外壳：界面字号、拖动、缩放、复位
 *
 * 借鉴智脑外壳：面板可拖动 / 可缩放 / 界面字号 13·14·16 三档 / 位置大小记住。
 * 所有值存 extensionSettings.rbqdb.ui，换聊天也保留。
 */
import * as store from '../core/store.js';

export const FONT_SIZES = [13, 14, 16];

/** 面板默认位置与"未设置尺寸"哨兵 —— 注意 updateConfig 是深合并，删键不会传播，复位只能写显式值 */
export const DEFAULT_POS = { x: 20, y: 80 };
export const NO_SIZE = { w: 0, h: 0 };
/** "未设位置"哨兵：x 为 NaN 时 fitPanel 会走居中分支（深合并不能删键，只能这样表达"没有"） */
export const NO_SIZE_POS = { x: NaN, y: NaN };

export function uiConfig() {
  const panel = store.getConfigValue('panel', {}) ?? {};
  const sz = panel.size;
  return {
    fontSize: Number(panel.fontSize) || 14,
    pos: panel.position ?? { ...DEFAULT_POS },
    size: sz && sz.w > 0 ? sz : null,
  };
}

export function setUiConfig(patch) {
  const cur = uiConfig();
  const next = { ...cur, ...(patch ?? {}) };
  const panel = store.getConfigValue('panel', {}) ?? {};
  const out = { ...panel };
  // 注意：绝不能往配置里写 null —— deepMerge 遇到 null 目标会抛错。清空 = 删掉这个键。
  if ('fontSize' in (patch ?? {})) out.fontSize = next.fontSize;
  if ('pos' in (patch ?? {})) out.position = next.pos && Number.isFinite(next.pos.x) ? next.pos : { ...DEFAULT_POS };
  if ('size' in (patch ?? {})) out.size = next.size && next.size.w > 0 ? next.size : { ...NO_SIZE };
  store.updateConfig({ panel: out });
  return next;
}

function panelEl(root) {
  if (root) return root;
  try { return globalThis.document?.getElementById('rbq-panel') ?? null; } catch { return null; }
}


/* ------------------------------------------------ 居中与自适应（窗口大小变了也要能用） */

function viewport() {
  try {
    const w = globalThis.window ?? {};
    return { w: w.innerWidth ?? 1200, h: w.innerHeight ?? 800 };
  } catch { return { w: 1200, h: 800 }; }
}

const MARGIN = 8;

/** 面板当前实际尺寸（拿不到就用 CSS 默认） */
export function panelSize(el) {
  const w = Number(el?.offsetWidth) || 0;
  const h = Number(el?.offsetHeight) || 0;
  return { w: w || 980, h: h || 640 };
}

/** 把位置夹到"面板完整可见"的范围（原来只保证留 80px，导致窄屏大半个挂屏外） */
function clampPos(pos, size, vp) {
  const maxL = Math.max(MARGIN, vp.w - (size?.w || 0) - MARGIN);
  const maxT = Math.max(MARGIN, vp.h - (size?.h || 0) - MARGIN);
  const x = Number(pos?.x);
  const y = Number(pos?.y);
  return {
    x: Math.round(Math.max(MARGIN, Math.min(Number.isFinite(x) ? x : MARGIN, maxL))),
    y: Math.round(Math.max(MARGIN, Math.min(Number.isFinite(y) ? y : MARGIN, maxT))),
  };
}

/** 把面板摆到"完全可见"的位置：能居中就居中，装不下就贴边 */
export function centerPanel(el = null) {
  const node = panelEl(el);
  if (!node || !node.style) return null;
  const vp = viewport();
  const size = panelSize(node);
  const maxLeft = Math.max(MARGIN, vp.w - size.w - MARGIN);
  const maxTop = Math.max(MARGIN, vp.h - size.h - MARGIN);
  const left = Math.round(Math.max(MARGIN, Math.min((vp.w - size.w) / 2, maxLeft)));
  const top = Math.round(Math.max(MARGIN, Math.min((vp.h - size.h) / 2, maxTop)));
  node.style.left = left + 'px';
  node.style.top = top + 'px';
  node.style.right = 'auto';
  node.style.bottom = 'auto';
  return { x: left, y: top };
}

/**
 * 每次打开/窗口变化时调用：
 *  - 用户拖过 → 把他的位置夹回可视区（不会被挤出屏幕）
 *  - 没拖过   → 居中
 *  - 尺寸也夹到窗口内（窗口变小后面板不会溢出）
 */
export function fitPanel(el = null) {
  const node = panelEl(el);
  if (!node || !node.style) return null;
  const vp = viewport();
  const c = uiConfig();
  // 尺寸：不超过窗口，也不小于最小值
  const wantW = Math.min((c.size?.w ?? Number(node.offsetWidth)) || 980, Math.max(320, vp.w - MARGIN * 2));
  const wantH = Math.min((c.size?.h ?? Number(node.offsetHeight)) || 640, Math.max(240, vp.h - MARGIN * 2));
  node.style.maxWidth = Math.min(Math.max(320, vp.w - MARGIN * 2) + 'px', MAX_PANEL_W + 'px');
  node.style.maxHeight = Math.max(240, vp.h - MARGIN * 2) + 'px';
  if (c.size && c.size.w > 0) { node.style.width = wantW + 'px'; node.style.height = wantH + 'px'; }
  if (c.pos && Number.isFinite(c.pos.x)) {
    const size = panelSize(node);
    const fixed = clampPos(c.pos, size, vp);
    const left = fixed.x;
    const top = fixed.y;
    node.style.left = left + 'px';
    node.style.top = top + 'px';
    node.style.right = 'auto';
    node.style.bottom = 'auto';
    return { x: left, y: top };
  }
  try { applyNarrowClass(node); } catch { /* ignore */ }
  return centerPanel(node);
}

let autoFitBound = false;
/** 窗口尺寸变化时把面板夹回可见区（只绑一次） */
export function bindAutoFit() {
  if (autoFitBound) return;
  autoFitBound = true;
  const w = (() => { try { return globalThis.window ?? null; } catch { return null; } })();
  if (!w || typeof w.addEventListener !== 'function') return;
  let timer = null;
  w.addEventListener('resize', () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { try { fitPanel(); applyNarrowClass(); } catch { /* ignore */ } }, 120);
  });
}

/** 窄面板标记：面板宽度小于阈值时给 #rbq-panel 加 rbq-narrow，CSS 据此改成单列/收拢布局 */
/** 面板绝对上限：大屏下也不会无限制变大 */
export const MAX_PANEL_W = 1180;
export const MAX_PANEL_H = 860;
export const NARROW_PX = 620;
export function applyNarrowClass(el = null, widthOverride = null) {
  const node = panelEl(el);
  if (!node) return false;
  let w = Number(widthOverride);
  if (!Number.isFinite(w) || w <= 0) {
    w = Number(node.offsetWidth) || 0;
    if (!w) { try { w = (globalThis.window?.innerWidth ?? 1024); } catch { w = 1024; } }
  }
  const narrow = w < NARROW_PX;
  node.classList.toggle('rbq-narrow', narrow);
  node.classList.toggle('rbq-wide', !narrow);
  return narrow;
}
/** 把 ui 配置套到面板上（字号 + 位置 + 大小） */
export function applyShell(root = null) {
  const el = panelEl(root);
  if (!el || !el.style) return false;
  const c = uiConfig();
  el.setAttribute('data-rbq-fs', String(c.fontSize || 14));
  if (c.pos && Number.isFinite(c.pos.x) && Number.isFinite(c.pos.y)) {
    const vp = viewport();
    const size = c.size && c.size.w > 0 ? c.size : panelSize(el);
    const fixed = clampPos(c.pos, size, vp);
    el.style.left = fixed.x + 'px';
    el.style.top = fixed.y + 'px';
    el.style.right = 'auto';
    el.style.bottom = 'auto';
  }
  if (c.size && c.size.w > 0 && c.size.h > 0) {
    el.style.width = c.size.w + 'px';
    el.style.height = c.size.h + 'px';
  }
  try { applyNarrowClass(el); } catch { /* ignore */ }
  return true;
}

export function setFontSize(n) {
  const v = FONT_SIZES.includes(Number(n)) ? Number(n) : 14;
  setUiConfig({ fontSize: v });
  applyShell();
  return v;
}

export function setSize(w, h) {
  const size = { w: Math.max(320, Math.round(Number(w) || 0)), h: Math.max(240, Math.round(Number(h) || 0)) };
  setUiConfig({ size });
  applyShell();
  return size;
}

export function setPos(x, y) {
  const pos = { x: Math.max(0, Math.round(Number(x) || 0)), y: Math.max(0, Math.round(Number(y) || 0)) };
  setUiConfig({ pos });
  applyShell();
  return pos;
}

/** 复位位置与大小（字号不动） */
export function resetShell(root = null) {
  setUiConfig({ pos: { ...NO_SIZE_POS }, size: { ...NO_SIZE } });
  const el = panelEl(root);
  if (el && el.style) {
    el.style.left = ''; el.style.top = ''; el.style.right = ''; el.style.bottom = '';
    el.style.width = ''; el.style.height = '';
    centerPanel(el);
  }
  return true;
}

function docOf() { try { return globalThis.document ?? null; } catch { return null; } }

/** 把 handle 拖起来移动 root；松手后记住位置。返回解绑函数 */
export function bindDrag(handle, root) {
  const d = docOf();
  if (!handle || !root || !d) return () => {};
  if (handle.dataset && handle.dataset.rbqDragBound === '1') return () => {};
  if (handle.dataset) handle.dataset.rbqDragBound = '1';
  let start = null;
  const onMove = (e) => {
    if (!start) return;
    const nx = Math.max(0, start.left + (e.clientX - start.x));
    const ny = Math.max(0, start.top + (e.clientY - start.y));
    root.style.left = nx + 'px';
    root.style.top = ny + 'px';
    root.style.right = 'auto';
    root.style.bottom = 'auto';
  };
  const onUp = () => {
    d.removeEventListener('mousemove', onMove);
    d.removeEventListener('mouseup', onUp);
    if (start) {
      const x = parseInt(root.style.left, 10);
      const y = parseInt(root.style.top, 10);
      if (Number.isFinite(x) && Number.isFinite(y)) setUiConfig({ pos: { x, y } });
    }
    start = null;
  };
  const onDown = (e) => {
    if (e && e.button !== undefined && e.button !== 0) return;
    const r = root.getBoundingClientRect ? root.getBoundingClientRect() : { left: 0, top: 0 };
    start = { x: e?.clientX ?? 0, y: e?.clientY ?? 0, left: r.left ?? 0, top: r.top ?? 0 };
    if (e && e.preventDefault) e.preventDefault();
    d.addEventListener('mousemove', onMove);
    d.addEventListener('mouseup', onUp);
  };
  handle.addEventListener('mousedown', onDown);
  return () => handle.removeEventListener('mousedown', onDown);
}

/** 把 grip 拖起来缩放 root（右下角）；松手后记住大小 */
export function bindResize(grip, root) {
  const d = docOf();
  if (!grip || !root || !d) return () => {};
  if (grip.dataset && grip.dataset.rbqResizeBound === '1') return () => {};
  if (grip.dataset) grip.dataset.rbqResizeBound = '1';
  let start = null;
  const onMove = (e) => {
    if (!start) return;
    const w = Math.max(320, start.w + (e.clientX - start.x));
    const h = Math.max(240, start.h + (e.clientY - start.y));
    root.style.width = w + 'px';
    root.style.height = h + 'px';
  };
  const onUp = () => {
    d.removeEventListener('mousemove', onMove);
    d.removeEventListener('mouseup', onUp);
    if (start) {
      const w = parseInt(root.style.width, 10);
      const h = parseInt(root.style.height, 10);
      if (Number.isFinite(w) && Number.isFinite(h)) setUiConfig({ size: { w, h } });
    }
    start = null;
  };
  const onDown = (e) => {
    const r = root.getBoundingClientRect ? root.getBoundingClientRect() : { width: 0, height: 0 };
    start = { x: e?.clientX ?? 0, y: e?.clientY ?? 0, w: r.width ?? 0, h: r.height ?? 0 };
    if (e && e.preventDefault) e.preventDefault();
    d.addEventListener('mousemove', onMove);
    d.addEventListener('mouseup', onUp);
  };
  grip.addEventListener('mousedown', onDown);
  return () => grip.removeEventListener('mousedown', onDown);
}
