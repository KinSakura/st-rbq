/**
 * panel.js —— 主面板：表格浏览器 / 编辑器 + 审计 + 设置
 *
 * 一个窗口，三个标签页。表格页同时就是编辑器（单元格直接改，改完走事务写入，
 * 所以手工改动一样有 rev、一样能撤销）。
 *
 * 设计上刻意不依赖 jQuery，也不依赖任何酒馆内部 UI 组件 —— 只用一个挂到页面上的
 * 独立 fixed 窗口，酒馆改版时最不容易被牵连。
 */

import { doc, win, notify, ctx } from '../core/ctx.js';
import * as zoomPan from './zoomPan.js';
import { cellS as C } from '../core/cells.js';
import { getTables, getTable, resolveColumn } from '../core/schema.js';
import * as store from '../core/store.js';
import * as memory from '../core/memory.js';
import * as sideApi from '../core/sideApi.js';
import * as sidePipeline from '../core/sidePipeline.js';
import * as updater from '../core/updater.js';
import * as presetImport from '../core/presetImport.js';
import * as inject from '../core/inject.js';
import * as templateCheck from '../core/templateCheck.js';
import * as departure from '../core/departure.js';
import * as summary from '../core/summary.js';
import * as vars from '../core/vars.js';
import * as legacyVars from '../core/legacyVars.js';
import * as inspiration from '../core/inspiration.js';
import * as shell from './shell.js';
import * as txn from '../core/txn.js';
import * as repair from '../core/repair.js';
import * as optionsApi from '../core/options.js';
import * as addons from '../core/addons.js';
import * as workshop from '../core/regexWorkshop.js';
import * as extras from '../core/extras.js';
import { DATA_FORMATS } from '../prompts/prompts.js';
import { THEMES, setTheme, currentTheme, dynamicBackground, setDynamicBackground, applyTheme } from './theme.js';
import { escapeHtml, debounce } from '../core/util.js';
import { refreshBadge } from './inputButton.js';

const PANEL_ID = 'rbq-panel';
let panelEl = null;
let state = {
  tab: 'views',
  view: 'overview',     // 当前视图（键见 VIEW_TABS）
  dossier: { name: '', tab: 'profile' },
  card: null,          // 打开中的角色卡
  tableNo: 0,
  selectedRow: -1,
  dirty: false,
};

/* ------------------------------------------------------------------ 工具 */

function d() { return doc(); }

function el(tag, attrs = {}, children = []) {
  const node = d().createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') { const s0 = String(v == null ? '' : v).replace(/\b(null|undefined|nullnull)\b/g, '').trim(); if (s0) node.textContent = s0; }   // 去掉 null/undefined（详情里曾出现 nullnull）
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v != null && v !== false) node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.appendChild(typeof c === 'string' ? d().createTextNode(c) : c);
  }
  return node;
}

function q(sel) {
  const root = panelEl ?? d()?.getElementById(PANEL_ID) ?? null;
  return root ? root.querySelector(sel) : null;
}

/* ------------------------------------------------------------- 窗口骨架 */

/* __vscrollWatch：持续记录视图容器的滚动位置（渲染那一刻 DOM 已被清空，读不到真值） */
function installVScrollWatch(root) {
  try {
    if (!root || root.__rbqVWatch) return;
    root.__rbqVWatch = true;
    root.addEventListener("scroll", (e) => {
      try {
        const el0 = e.target;
        if (el0 && el0.classList && el0.classList.contains("rbq-hud-vbody")) state.lastVScroll = el0.scrollTop;
      } catch (err) { /* ignore */ }
    }, true);
    // __vscrollObserver：无论谁重建了视图内容，都把滚动位置贴回去（只在内容够高时，避免被夹成 0）
    try {
      const mo = new MutationObserver(() => {
        try {
          const v = root.querySelector('.rbq-hud-vbody');
          if (!v) return;
          const want = Number.isFinite(state.lastVScroll) ? state.lastVScroll : 0;
          if (want > 0 && Math.abs(v.scrollTop - want) > 2 && (v.scrollHeight - v.clientHeight) >= want) v.scrollTop = want;
        } catch (err) { /* ignore */ }
      });
      mo.observe(root, { childList: true, subtree: true });
      root.__rbqVMo = mo;
    } catch (e) { /* ignore */ }
  } catch (e) { /* ignore */ }
}
function buildPanel() {
  try { setTimeout(() => installVScrollWatch(d()?.getElementById?.(PANEL_ID)), 0); } catch (e) { /* ignore */ }
  const p = el('div', { id: PANEL_ID, class: 'rbq-hidden' });

  const header = el('div', { class: 'rbq-header' }, [
    el('span', { class: 'rbq-drag-handle', text: '⠿', title: '按住拖动面板', style: 'cursor:move;opacity:.6;margin-right:6px;user-select:none' }),
    el('div', { class: 'rbq-title', html: '📊 RBQ 数据库 <small class="rbq-sub"></small>' }),
      el('span', { class: 'rbq-ver-badge', text: 'v2.9.4' }),
    el('button', { class: 'rbq-btn rbq-icon', title: '刷新', onclick: () => render() }, '⟳'),
    el('button', { class: 'rbq-btn rbq-icon', title: '收起', onclick: () => hidePanel() }, '✕'),
  ]);

  const tabs = el('div', { class: 'rbq-tabs' }, [
    /* 【用户要求的顺序】✓
       第一个必须是【视图】✓；接着【侧路 API】【数据】✓；
       最后两个固定是【设置】【变量管理】（变量管理放最末 ✓）；
       中间按"常用 → 少用"排：管理类（结构/审计）→ 记忆/轮次 → 附加功能类 → 正则工坊 ✓ */
    tabBtn('views', '视图'),
    tabBtn('side', '侧路 API'),
    tabBtn('tables', '数据'),
    tabBtn('structure', '结构'),
    tabBtn('audit', '审计'),
    tabBtn('memory', '记忆与召回'),
    tabBtn('rounds', '轮次与总结'),
    tabBtn('extras', '附加功能'),
    tabBtn('speak', '抢话与时间框'),
    tabBtn('options', '四选一'),
    tabBtn('outline', '大纲'),
    tabBtn('inspiration', '灵感'),
    tabBtn('departure', '离场与实体'),
    tabBtn('workshop', '正则工坊'),
    tabBtn('settings', '设置'),
    tabBtn('vars', '变量管理'),
  ]);
  // 滚轮 → 横向滚动（否则电脑上滚不到后面的标签）
  try {
    tabs.classList.add('rbq-tabs-wheel');
    tabs.addEventListener('wheel', (ev) => {
      const canScroll = (tabs.scrollWidth ?? 0) > (tabs.clientWidth ?? 0) + 2;
      if (!canScroll) return;
      if (ev.deltaY === 0) return;
      ev.preventDefault();
      tabs.scrollLeft += ev.deltaY;
    }, { passive: false });
  } catch { /* ignore */ }

  const body = el('div', { class: 'rbq-body' }, [
    el('div', { class: 'rbq-pane', 'data-pane': 'views' }),
    el('div', { class: 'rbq-pane', 'data-pane': 'departure' }),
    el('div', { class: 'rbq-pane', 'data-pane': 'inspiration' }),
    el('div', { class: 'rbq-pane', 'data-pane': 'speak' }),
    el('div', { class: 'rbq-pane', 'data-pane': 'options' }),
    el('div', { class: 'rbq-pane', 'data-pane': 'outline' }),
    el('div', { class: 'rbq-pane', 'data-pane': 'side' }),
    el('div', { class: 'rbq-pane', 'data-pane': 'rounds' }),
    el('div', { class: 'rbq-pane', 'data-pane': 'vars' }),
    el('div', { class: 'rbq-pane', 'data-pane': 'memory' }),
    el('div', { class: 'rbq-pane', 'data-pane': 'extras' }),
    el('div', { class: 'rbq-pane', 'data-pane': 'workshop' }),
    el('div', { class: 'rbq-pane', 'data-pane': 'tables' }),
    el('div', { class: 'rbq-pane', 'data-pane': 'structure' }),
    el('div', { class: 'rbq-pane', 'data-pane': 'audit' }),
    el('div', { class: 'rbq-pane', 'data-pane': 'settings' }),
  ]);

  p.append(header, tabs, body);
  ((d().documentElement ?? d().body)).appendChild(p);

  makeDraggable(p, header);
  // 缩放手柄（右下角）
  panelEl = p;
  try { shell.bindAutoFit(); } catch { /* ignore */ }
  try {
    const grip = el('div', { class: 'rbq-resize-grip', title: '拖动缩放面板', style: 'position:absolute;right:2px;bottom:2px;width:14px;height:14px;cursor:nwse-resize;opacity:.5' });
    grip.textContent = '◢';
    p.appendChild(grip);
    shell.bindResize(grip, p);
    shell.applyShell(p);
  } catch (e) { console.warn('[RBQ] 外壳初始化失败', e); }
  return p;
}

/** 每个页的图标（方案 B：图标导航，悬停/激活时才显示文字） */
const TAB_ICONS = {
  views: '🖼', departure: '📋', rounds: '⏱', memory: '🧠', extras: '🧩', workshop: '🔧',
  tables: '🗄', structure: '🏗', audit: '🧾', settings: '⚙', rounds: '⏱', memory: '🧠', vars: '🔖',
  inspiration: '🌿', speak: '🗣', options: '🎲', outline: '📝', side: '⚡',
};

function tabBtn(id, label) {
  // 图标放 data-ico，由 CSS ::before 渲染 —— 这样 button.textContent 仍然只是标签名，
  // 任何"按文字找标签页"的代码（含测试）都不会被打断。
  return el('button', {
    class: 'rbq-tab', 'data-tab': id, 'data-ico': TAB_ICONS[id] ?? '•', title: label, text: label,
    onclick: () => { state.tab = id; render(); },
  });
}

function makeDraggable(p, handle) {
  let dragging = false;
  let sx = 0; let sy = 0; let ox = 0; let oy = 0;

  const onMove = (e) => {
    if (!dragging) return;
    e.preventDefault();
    const cx = e.touches ? e.touches[0].clientX : e.clientX;
    const cy = e.touches ? e.touches[0].clientY : e.clientY;
    const w = win();
    const maxX = (w?.innerWidth ?? 1200) - 80;
    const maxY = (w?.innerHeight ?? 800) - 40;
    const nx = Math.max(-200, Math.min(ox + (cx - sx), maxX));
    const ny = Math.max(0, Math.min(oy + (cy - sy), maxY));
    p.style.left = `${nx}px`;
    p.style.top = `${ny}px`;
    p.style.right = 'auto';
    p.style.bottom = 'auto';
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    const rect = p.getBoundingClientRect();
    store.updateConfig({ panel: { position: { x: Math.round(rect.left), y: Math.round(rect.top) } } });
  };

  handle.addEventListener('mousedown', (e) => {
    if (e.target.closest('button')) return;
    dragging = true;
    sx = e.clientX; sy = e.clientY;
    const rect = p.getBoundingClientRect();
    ox = rect.left; oy = rect.top;
    e.preventDefault();
  });
  handle.addEventListener('touchstart', (e) => {
    if (e.target.closest('button')) return;
    dragging = true;
    sx = e.touches[0].clientX; sy = e.touches[0].clientY;
    const rect = p.getBoundingClientRect();
    ox = rect.left; oy = rect.top;
  }, { passive: true });

  d().addEventListener('mousemove', onMove);
  d().addEventListener('mouseup', onUp);
  d().addEventListener('touchmove', onMove, { passive: false });
  d().addEventListener('touchend', onUp);
}

/* ---------------------------------------------------------------- 渲染 */

export function mountPanel() {
  try { installTopEntry(); } catch (e) { /* ignore */ }

  if (panelEl) return panelEl;
  panelEl = buildPanel();
  return panelEl;
}

export function showPanel() {
  // 自愈：酒馆重排/换布局时可能把面板节点从 DOM 摘掉，而 panelEl 还指着它 —— 这时必须重挂
  const doc0 = d();
  const connected = !!panelEl && (() => { try { return panelEl.isConnected === true || doc0?.body?.contains(panelEl); } catch { return false; } })();
  if (!panelEl || !connected) {
    try { panelEl?.remove?.(); } catch { /* ignore */ }
    panelEl = null;
    mountPanel();
  }
  if (!panelEl) { console.warn('[RBQ] mountPanel 没有产出面板节点'); return; }
  panelEl.classList.remove('rbq-hidden');
  panelEl.style.display = '';
  // 打开时统一交给 shell：没拖过就居中，拖过就把位置夹回可视区，窗口小了自动缩
  try { shell.bindAutoFit(); shell.fitPanel(panelEl); } catch (e) { console.warn('[RBQ] 面板定位失败', e); }
  // 校验：拿不到尺寸（说明被隐藏/挤出视口）→ 强制贴底铺满，保证一定看得见
  try {
    const w = Number(panelEl.offsetWidth) || 0;
    const h = Number(panelEl.offsetHeight) || 0;
    const cs = (() => { try { return win()?.getComputedStyle?.(panelEl); } catch { return null; } })();
    if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) {
      panelEl.style.display = 'flex';
      panelEl.style.visibility = 'visible';
    }
    if (w === 0 || h === 0) {
      panelEl.style.left = '0';
      panelEl.style.right = '0';
      panelEl.style.bottom = '0';
      panelEl.style.top = 'auto';
      panelEl.style.width = '100vw';
      panelEl.style.height = '86vh';
      panelEl.style.zIndex = '100001';
    }
    console.log('[RBQ] 面板已打开：' + w + '×' + h + ' 位置 ' + panelEl.style.left + ',' + panelEl.style.top);
  } catch { /* ignore */ }
  // 关键校正：祖先若有 CSS transform，position:fixed 会相对那个祖先，
  // 于是"居中"算出来的位置可能整块跑到视口外（实测 rect.top = -851）。
  // 这里按真实 rect 把面板挪回视口内；挪不动就贴底铺满。
  try {
    const r0 = panelEl.getBoundingClientRect();
    const vw = (() => { try { return win()?.innerWidth ?? 0; } catch { return 0; } })();
    const vh = (() => { try { return win()?.innerHeight ?? 0; } catch { return 0; } })();
    if (vw && vh) {
      const cs2 = (() => { try { return win()?.getComputedStyle?.(panelEl); } catch { return null; } })();
      const topNum = parseFloat(cs2?.top ?? 'NaN');
      const leftNum = parseFloat(cs2?.left ?? 'NaN');
      let moved = false;
      if (r0.top < 4 || r0.bottom > vh) {
        // 直接用"当前 rect 顶部"归位到 10px（不依赖 computed top，兼容 transform 祖先）
        panelEl.style.top = (10 - r0.top) + 'px';
        moved = true;
      }
      if (r0.left < 4 || r0.right > vw) {
        panelEl.style.left = (r0.left < 4 ? (8 - r0.left) : (vw - r0.right - 8)) + 'px';
        moved = true;
      }
      if (moved) {
        // 窄屏先把宽度夹进视口，否则右边会被切掉  /* __clampWidth */
    try {
      const vw0 = doc().documentElement.clientWidth || win().innerWidth || 0;
      const maxW = Math.max(260, vw0 - 16);
      if ((panelEl.offsetWidth || 0) > maxW) panelEl.style.width = maxW + 'px';
      if (window.innerWidth < 520) panelEl.classList.add('rbq-narrow'); else panelEl.classList.remove('rbq-narrow');
      const l0 = panelEl.offsetLeft || 0;
      const w0 = panelEl.offsetWidth || 0;
      if (l0 + w0 > vw0 - 4) panelEl.style.left = Math.max(4, vw0 - w0 - 8) + 'px';
    } catch { /* ignore */ }
    const r1 = panelEl.getBoundingClientRect();
        const stillOut = r1.top < 0 || r1.left < 0 || r1.bottom > vh + 1 || r1.right > vw + 1;
        if (stillOut) {
          // 还不行：贴底铺满（最稳的兜底显示方式）
          panelEl.style.left = '0px';
          panelEl.style.top = '10px';
          panelEl.style.right = 'auto';
          panelEl.style.bottom = 'auto';
          panelEl.style.width = '100vw';
          panelEl.style.height = '84vh';
          panelEl.style.zIndex = '100001';
        }
        console.log('[RBQ] 位置校正：' + JSON.stringify({ before: { top: Math.round(r0.top), left: Math.round(r0.left) }, after: (() => { const r2 = panelEl.getBoundingClientRect(); return { top: Math.round(r2.top), left: Math.round(r2.left) }; })() }));
      }
    }
  } catch { /* ignore */ }
  render();

  try { ensureUpdateBanner(); } catch { /* ignore */ }
  try { ensurePresetBanner(); } catch { /* ignore */ }
}

/* __topEntry：常驻入口 —— 塞进酒馆顶栏/扩展菜单，点一下开关面板。
   悬浮球只在视图页渲染，一旦视图异常就没有入口了，所以必须有这个常驻按钮。 */
export function installTopEntry() {
  try {
    if (document.getElementById('rbq-top-entry')) return;
    const btn = el('div', { id: 'rbq-top-entry', class: 'rbq-top-entry', title: 'RBQ 数据库：点击开关面板', text: '🗄 RBQ' });
    btn.addEventListener('click', (ev) => { try { ev.stopPropagation(); } catch (e) { /* ignore */ } try { mountPanel(); togglePanel(); } catch (e) { /* ignore */ } });
    const host = document.getElementById('extensionsMenu')
      || document.getElementById('top-settings-holder')
      || document.getElementById('top-bar')
      || document.querySelector('.drawer-icon.fa-solid.fa-magic')?.parentElement
      || document.body;
    host.appendChild(btn);
  } catch (e) { /* ignore */ }
}

export function hidePanel() {
  panelEl?.classList.add('rbq-hidden');
}

export function togglePanel() {
  if (!panelEl || panelEl.classList.contains('rbq-hidden')) showPanel();
  else hidePanel();
}

const renderDebounced = debounce(() => render(), 120);

function render() {
  // 横幅要在 render 的 DOM 重建**结束之后**再挂，否则会被清掉
  setTimeout(() => { try { ensureUpdateBanner(); } catch { /* ignore */ } try { ensurePresetBanner(); } catch { /* ignore */ } }, 0);
  // 外壳：字号 / 位置 / 大小 + 拖动与缩放（每次渲染都确保手柄在，绑定函数自带幂等）
  try {
    const shellEl = q('#rbq-panel');
    if (shellEl) {
      shell.applyShell(shellEl);
      const dragH = q('#rbq-panel .rbq-drag-handle');
      if (dragH) shell.bindDrag(dragH, shellEl);
      if (!q('#rbq-panel .rbq-resize-grip')) {
        const grip = el('div', { class: 'rbq-resize-grip', title: '拖动缩放面板', style: 'position:absolute;right:2px;bottom:2px;width:14px;height:14px;cursor:nwse-resize;opacity:.5' });
        grip.textContent = '◢';
        shellEl.appendChild(grip);
        shell.bindResize(grip, shellEl);
      }
    }
  } catch (e) { console.warn('[RBQ] 外壳初始化失败', e); }
  if (!panelEl) return;
  // 记住滚动位置：设置页每改一项都会重绘，不记住就会跳回顶部
  const __scrollRestore = (() => {
    const active = panelEl.querySelector('.rbq-pane.rbq-active');
    const sc = active?.querySelector('.rbq-scroll') ?? active?.querySelector('.rbq-viewhost') ?? active?.querySelector('.rbq-hud-viewport');
    // __scrollAll：把面板内所有滚动容器的位置都记下来（设置/工坊/离场/技能/地图…通用）
    const all = [];
    try {
      const root = doc?.getElementById?.("rbq-panel");
      if (root) {
        const seen = {};
        for (const el0 of root.querySelectorAll("*")) {
          if (!el0.scrollTop) continue;
          const cls = String(el0.className || el0.tagName || "x");
          const n = (seen[cls] = (seen[cls] || 0) + 1);
          all.push({ key: cls + "#" + n, top: el0.scrollTop });
        }
      }
    } catch (e) { /* ignore */ }
    const vb = doc?.querySelector?.("#rbq-panel .rbq-hud-vbody");
    return { top: sc?.scrollTop ?? 0, vtop: vb?.scrollTop ?? 0, vkey: state.view, all };   // 视图容器的滚动位置也要记住
  })();
  panelEl.querySelectorAll('.rbq-tab').forEach((b) => {
    b.classList.toggle('rbq-active', b.dataset.tab === state.tab);
  });
  panelEl.querySelectorAll('.rbq-pane').forEach((p) => {
    p.classList.toggle('rbq-active', p.dataset.pane === state.tab);
  });
  const sub = panelEl.querySelector('.rbq-sub');
  if (sub) {
    try {
      const s = store.stats();
      sub.textContent = `第 ${s.rev} 版 · ${s.rowTotal} 行 · ${s.nonEmptyTables}/${s.tableCount} 表有数据`;
    } catch { sub.textContent = ''; }
  }
  /* __paneStage：渲染到"文档内隐藏、同尺寸"的暂存 pane，渲染完一次性换上（消闪；只换一次） */
  const __paneHandle = (() => {
    try {
      /* 【用户实测】设置页上看到别的页的表格盖在上面 ✗
         原因：这个"暂存容器"如果因为异常/并发没被移除 ✓ 就会残留在文档里 ✓
         这里每次渲染前先把所有残留的暂存容器清掉 ✓（再给新的加上多重隐藏 ✓） */
      try {
        document.querySelectorAll('#rbq-panel > .rbq-pane[style*="visibility: hidden"]').forEach((el) => {
          if (el.getAttribute('data-pane') && el.style.position === 'absolute') el.remove();
        });
      } catch (e) { /* ignore */ }
      const real = document.querySelector('#rbq-panel .rbq-pane[data-pane="' + String(state.tab) + '"]');
      if (!real || !real.parentElement) return null;
      const stage = real.cloneNode(false);
      stage.style.visibility = 'hidden';
      stage.style.position = 'absolute';
      stage.style.left = '0';
      stage.style.top = '0';
      stage.style.width = '100%';
      stage.style.height = '100%';
      stage.style.pointerEvents = 'none';
      /* 多重保险：完全不参与绘制 / 压在最底下 / 无障碍树里也藏起来 ✓ */
      stage.style.opacity = '0';
      stage.style.zIndex = '-1';
      stage.setAttribute('aria-hidden', 'true');
      // ★ 关键：暂存容器必须挂进文档（上一次空屏就是因为漏了这一句）
      real.parentElement.appendChild(stage);
      real.removeAttribute('data-pane');                    // 真实 pane 暂不响应查询（但它留在原地继续显示旧内容 → 无空白帧）
      stage.setAttribute('data-pane', String(state.tab));    // stage 借用属性 → 渲染器命中它
      return { real, stage };
    } catch (e) { return null; }
  })();
  if (state.tab === 'views') renderViewsPane();
  else if (state.tab === 'departure') renderDeparturePane();
  else if (state.tab === 'inspiration') renderInspirationPane();
  else if (state.tab === 'speak') renderSpeakPane();
  else if (state.tab === 'options') renderOptionsPane();
  else if (state.tab === 'outline') renderOutlinePane();
  else if (state.tab === 'side') renderSidePane();
  else if (state.tab === 'rounds') renderRoundsPane();
  else if (state.tab === 'memory') { renderMemoryPane(); attachMemoryCapCard(); }
  else if (state.tab === 'vars') renderVarsPane();
  else if (state.tab === 'extras') { EXTRAS_FILTER = ['narration', 'cg', 'theater']; renderExtrasPane('extras'); EXTRAS_FILTER = null; }
  else if (state.tab === 'workshop') renderWorkshopPane();
  else if (state.tab === 'tables') renderTablesPane();
  else if (state.tab === 'structure') renderStructurePane();
  else if (state.tab === 'audit') renderAuditPane();
  else { renderSettingsPane(); try { attachSettingsExtras(); } catch { /* ignore */ } }
  if (__paneHandle) {
    try {
      const stage = __paneHandle.stage;
      const real = __paneHandle.real;
      const tab = stage.getAttribute("data-pane") || String(state.tab);
      if (stage.childNodes.length) {
        real.replaceChildren(...Array.from(stage.childNodes));   // 一次性换上（此前旧内容一直可见 → 无空白帧）
      }
      real.setAttribute("data-pane", tab);                        // 还原属性
      if (stage.parentNode) stage.remove();
    } catch (e) { try { __paneHandle.real.setAttribute("data-pane", String(state.tab)); } catch (e2) { /* ignore */ } try { if (__paneHandle.stage.parentNode) __paneHandle.stage.remove(); } catch (e3) { /* ignore */ } }
  }
  applyTheme(q('#rbq-panel'));
  // 外壳：字号 / 位置 / 大小 + 拖动与缩放（只绑一次）
  try {
    const shellEl = q('#rbq-panel');
    shell.applyShell(shellEl);
    const dragH = q('#rbq-panel .rbq-drag-handle');
    if (dragH && shellEl) shell.bindDrag(dragH, shellEl);
    if (shellEl && !q('#rbq-panel .rbq-resize-grip')) {
      const grip = el('div', { class: 'rbq-resize-grip', title: '拖动缩放面板', style: 'position:absolute;right:2px;bottom:2px;width:14px;height:14px;cursor:nwse-resize;opacity:.5' });
      grip.textContent = '◢';
      shellEl.appendChild(grip);
      shell.bindResize(grip, shellEl);
    }
  } catch (e) { console.warn('[RBQ] 外壳初始化失败', e); }
  refreshBadge();
  const __now = panelEl.querySelector('.rbq-pane.rbq-active');
  const __sc = __now?.querySelector('.rbq-scroll') ?? __now?.querySelector('.rbq-viewhost') ?? __now?.querySelector('.rbq-hud-viewport');
  if (__sc) __sc.scrollTop = __scrollRestore.top;
  try {
    const vb2 = doc?.querySelector?.("#rbq-panel .rbq-hud-vbody");
    const put = () => { const v3 = doc?.querySelector?.("#rbq-panel .rbq-hud-vbody"); if (v3) v3.scrollTop = Number.isFinite(state.lastVScroll) ? state.lastVScroll : __scrollRestore.vtop; };
    if (vb2 && __scrollRestore && __scrollRestore.vkey === state.view && Number.isFinite(__scrollRestore.vtop)) {
      put();
      // 视图内容是动态 import 渲染的，等它长完高度再恢复一次，否则 scrollTop 会被夹到 0（看起来像"跳回最上面"）
      try { requestAnimationFrame(put); } catch (e) { /* ignore */ }
      setTimeout(put, 60);
      setTimeout(put, 220);
      // 通用恢复（所有滚动容器）
      const putAll = () => {
        try {
          const root = doc?.getElementById?.("rbq-panel");
          if (!root || !__scrollRestore || !Array.isArray(__scrollRestore.all)) return;
          const seen = {};
          for (const el0 of root.querySelectorAll("*")) {
            const cls = String(el0.className || el0.tagName || "x");
            const n = (seen[cls] = (seen[cls] || 0) + 1);
            const hit = __scrollRestore.all.find((r) => r.key === cls + "#" + n);
            if (hit && el0.scrollTop !== hit.top) el0.scrollTop = hit.top;
          }
        } catch (e) { /* ignore */ }
      };
      putAll();
      try { requestAnimationFrame(putAll); } catch (e) { /* ignore */ }
      setTimeout(putAll, 60);
      setTimeout(putAll, 220);
      setTimeout(putAll, 400);
      setTimeout(putAll, 800);   // 动态视图加载慢时也要恢复
    }
  } catch (e) { /* ignore */ }
}

/* ------------------------------------------------------------ 视图页（给用户看） */

const VIEW_TABS = [
  ['relations', '人物关系'],
  ['map', '地图'],
  ['quests', '任务'],
  ['inventory', '背包'],
  ['equipment', '装备'],
  ['skills', '技能'],
  ['monsters', '敌人'],
  ['factions', '势力'],
  ['chronicle', '纪事'],
  ['memory', '记忆'],
  ['extras', '附加'],
  ['overview', '总览'],
];
/** 由 ui/views/panels.js 提供的一组"面板型"视图 */
const PANEL_VIEWS = new Set(['memory']);
/** 由 ui/views/graphs.js 提供的"图形化"视图（看板/轮盘/威胁牌/阵营图/年代带） */
const GRAPH_VIEWS = new Set(['quests', 'skills', 'monsters', 'factions', 'chronicle']);
/** 由 ui/views/inventory.js 提供的"格子型"视图 */
const INVENTORY_VIEWS = new Set(['inventory', 'equipment']);

/** 附加功能里有没有开着的项（没开就不显示「附加」视图） */
function extrasEnabledAny() {
  try {
    for (const k of ['narration', 'cg', 'theater']) {
      try {
        const v = extras.get && extras.get(k);
        if (v && (v.enabled === undefined ? v : v.enabled)) return true;
        if (extras.isEnabled && extras.isEnabled(k)) return true;
      } catch (e) { /* ignore */ }
    }
    // 兜底：聊天变量（与原 rbq.js 一致）
    try {
      const st = window.SillyTavern && window.SillyTavern.getContext && window.SillyTavern.getContext();
      const vars = (st && st.chatMetadata && st.chatMetadata.variables) || {};
      if (String(vars.narrationPromptActive || '').trim() || String(vars.cgPromptActive || '').trim() || String(vars.theaterPromptActive || '').trim()) return true;
    } catch (e) { /* ignore */ }
    return false;
  } catch (e) { return false; }
}

function renderViewsPane() {
  const pane = q('.rbq-pane[data-pane="views"]');
  if (!pane) return;
  pane.textContent = '';

  const host = el('div', { class: 'rbq-hud' });
  pane.appendChild(host);

  const api = {
    el,
    notify,
    state,
    extras,
    views: VIEW_TABS.filter(([k]) => k !== 'extras' || extrasEnabledAny()),
    currentView: state.view,
    selectedCharacter: state.card,
    setView: (k) => { state.view = k; render(); },
    gotoTab: (k) => { state.tab = k; render(); },
    pickCharacter: (n) => { state.card = state.card === n ? null : n; render(); },
    onPickCharacter: (n) => { state.card = n; render(); },
    latestOptions: () => optionsApi.latestOptions(),
    sendOption: (dir, text) => optionsApi.sendOption(dir, text),
    renderViewport: (key, el2) => renderViewportInto(key, el2),
  };

  import('./views/dashboard.js?v=2940')
    .then((m) => m.renderDashboard(host, api))
    .catch((e) => {
      host.textContent = '';
      host.appendChild(el('div', { class: 'rbq-empty', text: `仪表盘加载失败：${e?.message ?? e}` }));
    });

  // 角色卡浮层：点角色坞头像弹出，一个角色的全部东西都在这一张卡里
  if (state.card) {
    const overlay = el('div', {
      class: 'rbq-cc-overlay',
      onclick: (e) => { if (e.target === overlay) { state.card = null; render(); } },
    });
    const panel = el('div', { class: 'rbq-cc-panel' });
    overlay.appendChild(panel);
    pane.appendChild(overlay);
    import('./views/characterCard.js?v=2940')
      .then((m) => m.renderCharacterCard(panel, state.card, {
        el,
        onClose: () => { state.card = null; render(); },
        onPickCharacter: (n) => { state.card = n; render(); },
      }))
      .catch((e) => { panel.textContent = ''; panel.appendChild(el('div', { class: 'rbq-empty', text: `角色卡加载失败：${e?.message ?? e}` })); });
  }
}

/** 视口内容分发：把已有的各个视图渲染进仪表盘的大视口 */
/* 包装：视图会先清空容器再重建（中间有一帧空白＝闪烁）→ 改成在离屏容器里建好再一次性换上 */
function renderViewportInto(key, hostEl) {
  // __stageInDoc：暂存容器【挂在文档里但不可见】→ 有真实尺寸（轮盘/地图算得对），渲染完一次性换上（无空白帧）
  let stage = null;
  try {
    stage = hostEl.cloneNode(false);
    stage.removeAttribute("id");
    stage.style.visibility = "hidden";
    stage.style.position = "absolute";
    stage.style.left = "0";
    stage.style.top = "0";
    stage.style.width = "100%";
    stage.style.height = "100%";
    stage.style.pointerEvents = "none";
    stage.style.overflow = "hidden";
    const parent = hostEl.parentElement || hostEl.parentNode;
    if (!parent) stage = null; else parent.appendChild(stage);
  } catch (e) { stage = null; }
  if (!stage) {   // 兜底：拿不到暂存容器就直接渲染
    const pr0 = __renderViewportInto(key, hostEl);
    try { setTimeout(() => { try { zoomPan.attach(hostEl); } catch (e) { /* ignore */ } }, 300); } catch (e) { /* ignore */ }
    return pr0;
  }
  let done = false;
  const commit = () => {
    if (done) return;
    try {
      if (!stage.childNodes.length) return;
      done = true;
      hostEl.replaceChildren(...Array.from(stage.childNodes));
      try { stage.remove(); } catch (e) { /* ignore */ }
      try { zoomPan.attach(hostEl); } catch (e) { /* ignore */ }
    } catch (e) { /* ignore */ }
  };
  let pr = null;
  try { pr = __renderViewportInto(key, stage); } catch (e) { commit(); throw e; }
  commit();                                     // 同步视图：立刻换上
  if (pr && typeof pr.then === "function") { try { pr.then(commit, commit); } catch (e) { /* ignore */ } }   // 异步视图
  try { setTimeout(commit, 500); } catch (e) { /* ignore */ }   // 仅一次兜底（不重试、不循环）
  return pr;
}
function __renderViewportInto(key, hostEl) {
  // 渲染完成后给 SVG 挂上拖动/缩放（各视图渲染是动态 import，所以延后一拍）
  try { setTimeout(() => { try { zoomPan.attach(hostEl); } catch (e) { /* ignore */ } }, 260); } catch (e) { /* ignore */ }
  // 未知键兜底：视图列表里没有就回到第一个（否则会卡在旧键上什么都不渲染）
  if (!VIEW_TABS.some(([k]) => k === key)) key = VIEW_TABS[0][0];   /* __viewFallback */
  const sub = {
    el,
    notify,
    state,
    characters: (() => { try { return ctx().characters ?? []; } catch { return []; } })(),
    // 只重绘当前视图：保留面板外壳与滚动容器 → 不闪、不跳顶
    rerender: () => {
      try {
        const vb = doc?.querySelector?.('#rbq-panel .rbq-hud-vbody');
        if (!vb) return render();
        const top = Number.isFinite(state.lastVScroll) ? state.lastVScroll : (vb.scrollTop || 0);
        // 每次恢复都按选择器重新查：面板可能被全局点击处理整块重建，闭包里的旧节点会脱离文档
        const put = () => { try { const cur = doc?.querySelector?.('#rbq-panel .rbq-hud-vbody'); if (cur) cur.scrollTop = top; } catch (e) { /* ignore */ } };
        const p2 = renderViewportInto(state.view, vb);
        put();
        try { requestAnimationFrame(put); } catch (e) { /* ignore */ }
        setTimeout(put, 80); setTimeout(put, 250);
        if (p2 && typeof p2.then === 'function') p2.then(() => { put(); setTimeout(put, 80); }).catch(() => {});
        return p2;
      } catch (e) { return render(); }
    },
    onPickCharacter: (n) => { state.card = n; render(); },
  };
  // 修法：给视图一个离屏暂存容器，等它渲染完再一次性换到真实容器上
  const fail = (e) => {
    hostEl.textContent = '';
    hostEl.appendChild(el('div', { class: 'rbq-empty', text: `加载失败：${e?.message ?? e}` }));
  };
  if (key === 'extras') return import('./views/extrasLines.js?v=2940').then((m) => m.renderExtras(hostEl, sub));
  if (key === 'relations') return import('./views/relations.js?v=2940').then((m) => m.renderRelations(hostEl, sub));
  if (key === 'map') return import('./views/map.js?v=2940').then((m) => m.renderMap(hostEl, sub));
  if (key === 'inventory' || key === 'equipment') {
    return import('./views/inventory.js?v=2940').then((m) => (key === 'inventory' ? m.renderInventory(hostEl, sub) : m.renderEquipment(hostEl, sub)));
  }
  if (GRAPH_VIEWS.has(key)) {
    return import('./views/graphs.js?v=2940').then((m) => {
      const map = { quests: m.renderQuestBoard, skills: m.renderSkillWheel, monsters: m.renderThreats, factions: m.renderFactionWeb, chronicle: m.renderEraTimeline };
      (map[key] ?? m.renderQuestBoard)(hostEl, sub);
    }).catch(fail);
  }
  if (PANEL_VIEWS.has(key)) {
    return import('./views/panels.js?v=2940').then((m) => {
      const hit = m.PANELS.find(([k]) => k === key);
      if (!hit) { hostEl.textContent = ''; hostEl.appendChild(el('div', { class: 'rbq-empty', text: `没有名为 ${key} 的视图` })); return; }
      hit[2](hostEl, sub);
    }).catch(fail);
  }
  if (key === 'options') return renderOptionsView(hostEl, sub);
  return renderOverviewView(hostEl, sub);
}

/** 本轮行动选项（原 RBQ 的四选一） */
function renderOptionsView(host, api) {
  const { el: e } = api;
  import('../core/options.js').then((m) => {
    const latest = m.latestOptions();
    host.textContent = '';
    if (!latest) {
      host.appendChild(e('div', {
        class: 'rbq-empty',
        html: '这一轮还没有行动选项。<br><span class="rbq-hint">AI 在正文后输出 <code>&lt;RP_OPTIONS&gt;</code> 时，这里会出现四个方向；点一下就会作为你的输入发出去。</span>',
      }));
      return;
    }
    host.appendChild(e('div', { class: 'rbq-viewbar' }, [
      e('span', { class: 'rbq-hint', text: `来自第 ${latest.messageIndex + 1} 楼` }),
      e('span', { class: 'rbq-spacer' }),
      e('button', { class: 'rbq-btn', text: '在消息里显示按钮', onclick: () => { const n = m.injectButtons(); api.notify('info', n ? `已注入 ${n} 处` : '没有可注入的消息'); } }),
    ]));
    const wrap = e('div', { class: 'rbq-option-cards' });
    for (const [dir, text] of Object.entries(latest.options)) {
      const card = e('div', { class: 'rbq-option-card' }, [
        e('div', { class: 'rbq-option-dir', text: dir }),
        e('div', { class: 'rbq-option-text', text: String(text) }),
      ]);
      card.addEventListener('click', async () => {
        const ok = await m.sendOption(dir, text);
        if (ok) api.notify('success', `已按「${dir}」发出。`);
      });
      wrap.appendChild(card);
    }
    host.appendChild(wrap);
    host.appendChild(e('div', { class: 'rbq-hint', text: '点击卡片 = 把这个方向作为你的输入发出去。' }));
  }).catch((err) => { host.textContent = ''; host.appendChild(e('div', { class: 'rbq-empty', text: `加载失败：${err?.message ?? err}` })); });
}

/** 总览：把"这一局现在什么情况"一句话说清 */
function renderOverviewView(host, api) {
  const { el: e } = api;
  host.textContent = '';
  const s = store.stats();
  const tables = store.getAllTables();
  const get = (no) => tables.find((t) => t.no === no);
  const t0 = get(0); const t6 = get(6); const t4 = get(4);
  const cellOf = (pack, colName) => {
    if (!pack) return '';
    const i = pack.columns.indexOf(colName);
    return i >= 0 ? String(pack.rows?.[0]?.[i] ?? '').trim() : '';
  };

  const now = e('div', { class: 'rbq-card' }, [
    e('h4', { text: '现在' }),
    e('dl', { class: 'rbq-kv' }, [
      e('dt', { text: '地点' }), e('dd', { text: cellOf(t0, '绝对位置名称') || '—' }),
      e('dt', { text: '时间' }), e('dd', { text: cellOf(t0, '时空坐标') || '—' }),
      e('dt', { text: '天气' }), e('dd', { text: cellOf(t0, '环境气象') || '—' }),
      e('dt', { text: '氛围' }), e('dd', { text: cellOf(t0, '安全氛围') || '—' }),
      e('dt', { text: '在场' }), e('dd', { text: cellOf(t0, '在场实体名单') || '—' }),
      e('dt', { text: '世界法则' }), e('dd', { text: cellOf(t0, '世界法则') || '—' }),
    ]),
  ]);
  host.appendChild(now);

  const plot = cellOf(t6, '当前篇章') || cellOf(t6, '终极宏愿');
  if (plot) {
    host.appendChild(e('div', { class: 'rbq-card' }, [
      e('h4', { text: '主线' }),
      e('dl', { class: 'rbq-kv' }, [
        e('dt', { text: '终极宏愿' }), e('dd', { text: cellOf(t6, '终极宏愿') || '—' }),
        e('dt', { text: '宏愿进度' }), e('dd', { text: cellOf(t6, '宏愿进度') || '—' }),
        e('dt', { text: '当前篇章' }), e('dd', { text: cellOf(t6, '当前篇章') || '—' }),
        e('dt', { text: '篇章状态' }), e('dd', { text: cellOf(t6, '篇章状态') || '—' }),
        e('dt', { text: '即时焦点' }), e('dd', { text: cellOf(t6, '即时焦点') || '—' }),
      ]),
    ]));
  }

  // 任务 / 异常 / 离场
  const tasks = get(7)?.rows ?? [];
  if (tasks.length) {
    const card = e('div', { class: 'rbq-card' }, [e('h4', { text: `任务（${tasks.length}）` })]);
    for (const r of tasks.slice(0, 8)) {
      card.appendChild(e('div', { class: 'rbq-audit-item' }, [
        e('span', { class: 'rbq-badge', text: C(7, r, 'category', 1) || '任务' }),
        e('span', { text: C(7, r, 'name', 0) }),
        e('span', { class: 'rbq-hint', text: C(7, r, 'progress', 9) }),
        e('span', { class: 'rbq-hint', text: C(7, r, 'deadline', 7) ? `死线 ${C(7, r, 'deadline', 7)}` : '' }),
      ]));
    }
    host.appendChild(card);
  }

  const left = (t4?.rows ?? []).filter((r) => String(r?.[2] ?? '').includes('已离场'));
  if (left.length) {
    host.appendChild(e('div', { class: 'rbq-card' }, [
      e('h4', { text: `已离场（${left.length}）` }),
      e('div', { class: 'rbq-chips' }, left.map((r) => e('span', { class: 'rbq-chip', text: String(r?.[0] ?? ''), title: String(r?.[2] ?? '') }))),
    ]));
  }

  host.appendChild(e('div', { class: 'rbq-hint', text: `数据：第 ${s.rev} 版 · ${s.rowTotal} 行 · ${s.nonEmptyTables}/${s.tableCount} 张表有内容` }));
}

/* ------------------------------------------------------------ 结构页 */

let structNo = null;   // 结构页当前选中的表号

function renderStructurePane() {
  const pane = q('.rbq-pane[data-pane="structure"]');
  if (!pane) return;
  pane.textContent = '';
  const scroll = el('div', { class: 'rbq-scroll' });
  // 模板检验（照骰子系统的"模板检验预设"）
  {
    const check = templateCheck.checkTemplate();
    const card = el('div', { class: 'rbq-card' }, [
      el('h4', { text: '模板检验' }),
      el('div', { class: 'rbq-hint', text: check.ok ? '当前模板可用。' : '当前模板有问题，下面按严重程度列出。' }),
    ]);
    const line = (kind, item) => el('div', { class: 'rbq-row' }, [
      el('span', { class: kind === 'error' ? 'rbq-badge rbq-danger' : kind === 'warning' ? 'rbq-badge rbq-warn' : 'rbq-badge', text: kind === 'error' ? '错误' : kind === 'warning' ? '警告' : '信息' }),
      el('span', { text: item.text }),
    ]);
    for (const e of check.errors) card.appendChild(line('error', e));
    for (const w of check.warnings) card.appendChild(line('warning', w));
    for (const i of check.infos) card.appendChild(line('info', i));
    card.appendChild(el('div', { class: 'rbq-row' }, [
      el('button', { class: 'rbq-btn', text: '导出兼容说明（视图↔表列要求）', onclick: () => downloadText(templateCheck.exportCompatibilityDoc(), 'rbq-视图表列要求.md') }),
    ]));
    scroll.appendChild(card);
  }
  // 模板同步（照 DND TemplateSync 的版本门控）
  {
    const st2 = templateCheck.templateSyncState();
    const card = el('div', { class: 'rbq-card' }, [
      el('h4', { text: '模板同步' }),
      el('div', { class: 'rbq-hint', text: st2.needsSync ? (st2.isFirstTime ? '首次使用，建议导入配套模板。' : '模板有更新，建议导入。') : '模板已是最新。' }),
      el('div', { class: 'rbq-hint', text: '当前版本 ' + st2.current + '；已同步 ' + (st2.synced ?? '（无）') }),
    ]);
    card.appendChild(el('div', { class: 'rbq-row' }, [
      el('button', { class: 'rbq-btn rbq-primary', text: '导入内置模板', onclick: () => { store.resetSchemaToBuiltin(); templateCheck.setSyncedTemplateVersion(); notify('success', '已导入内置模板'); render(); } }),
      el('button', { class: 'rbq-btn', text: '跳过（记为已同步）', onclick: () => { templateCheck.setSyncedTemplateVersion(); notify('info', '已记为已同步'); render(); } }),
    ]));
    scroll.appendChild(card);
  }
  const cfg = store.getConfig();
  const tables = getTables();
  if (structNo == null || !getTable(structNo)) structNo = tables[0]?.no ?? 0;

  /* ---- 模板预设 ---- */
  const tplCard = el('div', { class: 'rbq-card' }, [
    el('h4', { text: '模板预设（表格结构）' }),
    el('div', { class: 'rbq-hint', text: '一套「表格结构」= 有哪些表、每张表有哪些列。可以存多套，换世界观时一键切换。数据不会被模板影响。' }),
    el('div', { class: 'rbq-row' }, [
      el('label', { text: '当前模板' }),
      (() => {
        const sel = el('select', { class: 'rbq-select' });
        const list = store.listTemplatePresets();
        const cur = store.getUserSchema();
        for (const p of list) {
          const o = el('option', { value: p.name, text: `${p.name}（${p.tables} 表）` });
          sel.appendChild(o);
        }
        sel.value = cur ? sel.options[1]?.value ?? list[0].name : list[0].name;
        sel.addEventListener('change', () => {
          if (!store.applyTemplatePreset(sel.value)) { notify('error', '切换模板失败。'); return; }
          notify('success', `已切换到模板「${sel.value}」`);
          render();
        });
        return sel;
      })(),
      el('button', {
        class: 'rbq-btn', text: '存为新模板',
        onclick: () => {
          const name = prompt('模板名字？');
          if (!name) return;
          store.saveTemplatePreset(name);
          notify('success', `已保存模板「${name}」`);
          render();
        },
      }),
      el('button', {
        class: 'rbq-btn rbq-danger', text: '删除当前模板',
        onclick: () => {
          const sel = q('.rbq-pane[data-pane="structure"] .rbq-select');
          const name = sel?.value;
          if (!name || name === '（内置默认）') { notify('warning', '内置默认模板不能删除。'); return; }
          store.deleteTemplatePreset(name);
          store.applyTemplatePreset('（内置默认）');
          notify('success', `已删除模板「${name}」`);
          render();
        },
      }),
    ]),
    el('div', { class: 'rbq-row' }, [
      el('button', { class: 'rbq-btn', text: '导出模板', onclick: () => downloadText(store.exportTemplatePreset(), 'rbq-template.json') }),
      el('button', {
        class: 'rbq-btn', text: '导入模板',
        onclick: () => pickFile(async (text) => {
          try {
            const r = store.importTemplatePreset(text);
            notify('success', `已导入模板（${r.imported} 张表，格式 ${r.kind}）`);
            render();
          } catch (e) { notify('error', `导入失败：${e?.message ?? e}`); }
        }),
      }),
    ]),
  ]);
  scroll.appendChild(tplCard);

  /* ---- 数据档（隔离） ---- */
  const profiles = store.listProfiles();
  scroll.appendChild(el('div', { class: 'rbq-card' }, [
    el('h4', { text: '数据档（一个聊天里放多套数据）' }),
    el('div', { class: 'rbq-hint', text: '每个数据档是完全独立的一套表格数据。适合「同一聊天里跑多个角色卡/世界观，互不污染」。' }),
    el('div', { class: 'rbq-row' }, [
      el('label', { text: `当前数据档（${profiles.length} 个）` }),
      (() => {
        const sel = el('select', { class: 'rbq-select' });
        for (const p of profiles) {
          sel.appendChild(el('option', { value: p.key, text: `${p.key || '（默认）'} — ${p.rows} 行` }));
        }
        sel.value = store.getActiveProfileKey();
        sel.addEventListener('change', async () => {
          store.switchProfile(sel.value);
          await store.commit?.({ persist: true });
          notify('success', `已切换到数据档「${sel.value || '默认'}」`);
          render();
        });
        return sel;
      })(),
      el('button', {
        class: 'rbq-btn', text: '新建（复制当前）',
        onclick: async () => {
          const name = prompt('新数据档的名字？');
          if (!name) return;
          if (!store.createProfile(name, { cloneFrom: store.getActiveProfileKey() })) { notify('error', '创建失败（重名？）'); return; }
          store.switchProfile(name);
          notify('success', `已新建并切换到「${name}」`);
          render();
        },
      }),
      el('button', {
        class: 'rbq-btn rbq-danger', text: '删除当前档',
        onclick: () => {
          const key = store.getActiveProfileKey();
          if (!key) { notify('warning', '默认档不能删除。'); return; }
          if (!store.deleteProfile(key)) { notify('error', '删除失败（至少保留一个档）。'); return; }
          notify('success', `已删除「${key}」`);
          render();
        },
      }),
    ]),
    el('div', { class: 'rbq-row' }, [
      el('button', { class: 'rbq-btn', text: '导出整包（数据+结构）', onclick: () => downloadText(store.exportBundle(), `rbq-bundle-${new Date().toISOString().slice(0, 10)}.json`) }),
      el('button', {
        class: 'rbq-btn', text: '导入整包',
        onclick: () => pickFile(async (text) => {
          try {
            const r = store.importBundle(text);
            notify('success', `已导入：结构 ${r.schemaImported} 表 / 数据 ${r.dataImported} 表`);
            render();
          } catch (e) { notify('error', `导入失败：${e?.message ?? e}`); }
        }),
      }),
    ]),
  ]));

  /* ---- 单表结构（只读）---- */
  const t = getTable(structNo);
  const structCard = el("div", { class: "rbq-card" }, [el("h4", { text: "表格结构" })]);
  {
    const sel = el("select", { class: "rbq-select" });
    for (const x of tables) sel.appendChild(el("option", { value: String(x.no), text: `表${x.no} ${x.name}` }));
    sel.value = String(structNo);
    sel.addEventListener("change", () => { structNo = Number(sel.value); render(); });
    structCard.appendChild(el("div", { class: "rbq-row" }, [el("label", { text: "选择表格" }), sel]));
    if (t) {
      structCard.appendChild(el("div", { class: "rbq-row" }, [el("label", { text: "表名" }), el("span", { class: "rbq-kv-v", text: t.name }), t.singleton ? el("span", { class: "rbq-badge", text: "单例表" }) : null]));
      const colBox = el("div", { class: "rbq-col-list" });
      t.columns.forEach((c, i) => {
        colBox.appendChild(el("div", { class: "rbq-col-item" }, [
          el("span", { class: "rbq-col-idx", text: String(i) }),
          el("span", { class: "rbq-col-name", text: c }),
          i === (t.keyIdx?.[0] ?? 0) ? el("span", { class: "rbq-badge", text: "主键" }) : null,
        ]));
      });
      structCard.appendChild(el("div", { class: "rbq-row" }, [el("label", { text: "列" }), el("span", { class: "rbq-hint", text: `${t.columns.length} 列` })]));
      structCard.appendChild(colBox);
    }
  }
  scroll.appendChild(structCard);

  pane.appendChild(scroll);
}

/* ---------------------------------------------------- 文件选择 / 下载 */

function downloadText(text, filename) {
  try {
    const blob = new Blob([text], { type: 'application/json' });
    const a = d().createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  } catch {
    console.log(`[RBQ] ${filename}`, text);
    notify('info', '下载不可用，内容已输出到控制台。');
  }
}

function pickFile(onText) {
  const input = d().createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.style.display = 'none';
  input.addEventListener('change', () => {
    const f = input.files?.[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => { try { onText(String(rd.result ?? '')); } finally { input.remove(); } };
    rd.readAsText(f);
  });
  ((d().documentElement ?? d().body)).appendChild(input);
  input.click();
}

/* ------------------------------------------------------------ 表格页 */

/* 局部刷新（用户要求：点表格不要跳回最上面 —— 以前调 render() 整页重建，滚动位置就没了 ✗）
   只换右侧工具栏+表格，左侧列表原地改高亮，滚动位置完全不动 ✓ */
function renderTablesPaneLocal() {
  try {
    const pane = q('.rbq-pane[data-pane="tables"]');
    if (!pane) return;
    const list = pane.querySelector(".rbq-tablelist");
    const wrap = pane.querySelector(".rbq-gridwrap");
    if (!list || !wrap) { render(); return; }
    const keepList = list.scrollTop;
    for (const it of list.children) {
      const no = Number(String(it.querySelector(".rbq-no")?.textContent ?? "").trim());
      it.classList.toggle("rbq-active", no === state.tableNo);
    }
    /* 点表格时不乱滚：只有当前项跑出可视区，才把它滚进来看（且滚到整行，不切半行） */
    try {
      const act = [...list.children].find((it) => it.classList.contains("rbq-active"));
      if (act) {
        const rh = act.offsetHeight || 26;
        const top = act.offsetTop;
        const h = list.clientHeight;
        if (top < list.scrollTop || top + rh > list.scrollTop + h) {
          list.scrollTop = Math.max(0, Math.round((top - rh) / rh) * rh);
        } else {
          list.scrollTop = keepList;
        }
      } else list.scrollTop = keepList;
    } catch (e) { list.scrollTop = keepList; }
    wrap.replaceChildren(buildToolbar(), buildGrid());
  } catch (e) { console.warn("[RBQ] 局部刷新数据页失败", e); render(); }
}

function renderTablesPane() {
  const pane = q('.rbq-pane[data-pane="tables"]');
  if (!pane) return;
  pane.textContent = '';

  const list = el('div', { class: 'rbq-tablelist' });
  for (const t of getTables()) {
    const rows = store.getRows(t.no, { create: false });
    list.appendChild(el('div', {
      class: `rbq-tablelist-item${t.no === state.tableNo ? ' rbq-active' : ''}`,
      title: t.name,
      onclick: () => { state.tableNo = t.no; state.selectedRow = -1; renderTablesPaneLocal(); },
    }, [
      el('span', { class: 'rbq-no', text: String(t.no).padStart(2, '0') }),
      el('span', { text: t.name }),
      el('span', { class: 'rbq-count', text: rows.length ? String(rows.length) : '' }),
    ]));
  }

  const wrap = el('div', { class: 'rbq-gridwrap' });
  wrap.appendChild(buildToolbar());
  wrap.appendChild(buildGrid());

  pane.append(list, wrap);
  /* 列表永远从第 1 项开始（用户：上面选表的地方不要停在中间、不要切掉半行） */
  try { list.scrollTop = 0; } catch (e) { /* ignore */ }
}

function buildToolbar() {
  const t = getTable(state.tableNo);
  const bar = el('div', { class: 'rbq-toolbar' });
  bar.append(
    el('strong', { text: t ? `表${t.no} ${t.name}` : '—' }),
    el('span', { class: 'rbq-badge', text: `${store.getRows(state.tableNo, { create: false }).length} 行` }),
    el('button', { class: 'rbq-btn', title: '在末尾新增一行', onclick: addRow }, '＋ 新增行'),
    el('button', {
      class: 'rbq-btn rbq-danger',
      title: '删除选中的行（点行号选中）',
      onclick: deleteSelectedRow,
    }, '－ 删除行'),
    el('span', { class: 'rbq-spacer' }),
    el('button', { class: 'rbq-btn', title: '跑一遍审查（只报告 + 安全项自动修）', onclick: runReview }, '🔍 审查'),
    el('button', { class: 'rbq-btn', title: '按等级与四维系数重算派生属性', onclick: runRecalc }, 'Σ 重算属性'),
    el('button', { class: 'rbq-btn', title: '复制该表的 JSON', onclick: () => copyTableJson() }, '复制 JSON'),
    el('button', { class: 'rbq-btn', title: '撤销最近一次写入', onclick: undoLast }, '↶ 撤销'),
    el('button', { class: 'rbq-btn', title: '导出全部表格（与旧插件兼容）', onclick: exportAll }, '导出'),
  );
  return bar;
}

function buildGrid() {
  const t = getTable(state.tableNo);
  const scroll = el('div', { class: 'rbq-gridscroll' });
  if (!t) return scroll;

  const rows = store.getRows(t.no, { create: false });
  if (!rows.length) {
    scroll.appendChild(el('div', {
      class: 'rbq-empty',
      html: `表${t.no} 还没有数据。<br><span class="rbq-hint">点「＋ 新增行」手工加一行，或者让 AI 在 <code>&lt;data&gt;</code> 里写一条试试。</span>`,
    }));
  }

  const table = el('table', { class: 'rbq-grid' });
  const thead = el('thead');
  const hr = el('tr');
  hr.appendChild(el('th', { class: 'rbq-rowno', text: '#' }));
  for (const c of t.columns) hr.appendChild(el('th', { text: c, title: c }));
  thead.appendChild(hr);
  table.appendChild(thead);

  const tbody = el('tbody');
  rows.forEach((row, ri) => {
    const tr = el('tr', { class: ri === state.selectedRow ? 'rbq-selected' : '' });
    tr.appendChild(el('td', {
      class: 'rbq-rowno', text: String(ri + 1),
      title: '点击选中/取消',
      onclick: () => { state.selectedRow = state.selectedRow === ri ? -1 : ri; render(); },
    }));
    t.columns.forEach((colName, ci) => {
      const td = el('td', {
        contenteditable: 'true',
        'data-row': ri,
        'data-col': ci,
        text: row?.[ci] ?? '',
      });
      td.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); td.blur(); }
        if (e.key === 'Escape') { td.textContent = row?.[ci] ?? ''; td.blur(); }
      });
      td.addEventListener('blur', () => commitCell(td, ri, ci, row?.[ci] ?? ''));
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  scroll.appendChild(table);
  return scroll;
}

/* ---------------------------------------------------------- 编辑动作 */

async function commitCell(td, rowIndex, colIndex, oldValue) {
  const t = getTable(state.tableNo);
  if (!t) return;
  const newValue = td.textContent ?? '';
  if (newValue === oldValue) return;              // 没变就不写，避免白涨 rev

  const colName = t.columns[colIndex];
  const res = await txn.applyOps([{
    op: 'set', table: t.no, rowIndex, col: colName, value: newValue,
  }], { source: 'manual' });

  if (res.failed.length) {
    notify('error', `写入失败：${res.failed[0].reason}${res.failed[0].detail ? `（${res.failed[0].detail}）` : ''}`);
    td.textContent = oldValue;
    return;
  }
  notify('success', `已写入 表${t.no} 第${rowIndex + 1}行「${colName}」`);
  render();
}

async function addRow() {
  const res = await txn.applyOps([{ op: 'insert', table: state.tableNo, values: { 0: '' } }], { source: 'manual' });
  if (res.failed.length) {
    // 单例表不允许加第二行 —— 给出人话提示
    const reason = res.failed[0].reason;
    notify('warning', reason === 'missing-values' ? '该表是单例表，只能有一行。' : `新增失败：${reason}`);
    return;
  }
  state.selectedRow = store.getRows(state.tableNo, { create: false }).length - 1;
  render();
}

async function deleteSelectedRow() {
  if (state.selectedRow < 0) { notify('warning', '先在左侧点一下行号选中要删的行。'); return; }
  const res = await txn.applyOps([{ op: 'delete', table: state.tableNo, rowIndex: state.selectedRow }], { source: 'manual' });
  if (res.failed.length) { notify('error', `删除失败：${res.failed[0].reason}`); return; }
  state.selectedRow = -1;
  notify('success', '已删除。');
  render();
}

async function undoLast() {
  const revs = store.listAnchors().map((a) => a.anchor.rev).filter((r) => r > 0);
  if (!revs.length) { notify('warning', '没有可回退的记录。'); return; }
  const target = Math.max(0, ...revs) - 1;
  const res = await txn.rollbackTo(target);
  notify(res.ok ? 'success' : 'warning', res.ok ? `已回退到第 ${target} 版` : '没有可回退的记录（可能已超出保留轮数）。');
  render();
}

/** 跑审查：只报告 + 自动应用安全修复（不直接改消息，全部走事务） */
async function runReview() {
  try {
    notify('info', '正在审查…');
    const { review, formatIssues } = await import('../core/review.js');
    const r = await review({ apply: true });
    const summary = `审查完成：发现 ${r.issues.length} 个问题，自动修正 ${r.applied} 处`
      + (r.failed?.length ? `，${r.failed.length} 处修正失败` : '');
    console.log(`[RBQ] ${summary}`);
    if (r.issues.length) console.log(formatIssues(r.issues));
    notify(r.issues.length ? (r.applied ? 'warning' : 'info') : 'success', summary);
    refreshPanel();
  } catch (e) {
    notify('error', `审查失败：${e?.message ?? e}`);
  }
}

/** 按 表2 的等级+系数重算 表13/14 的派生属性 */
async function runRecalc() {
  try {
    const { recalcCharacters } = await import('../core/rules.js');
    const ops = recalcCharacters({ fillMax: true });
    if (!ops.length) { notify('warning', '没有可重算的角色（需要表2 里有等级与四维系数）。'); return; }
    const res = await txn.applyOps(ops, { source: 'recalc' });
    notify(res.failed.length ? 'warning' : 'success',
      `重算完成：${res.applied} 个角色${res.failed.length ? `，${res.failed.length} 个失败` : ''}`);
    refreshPanel();
  } catch (e) {
    notify('error', `重算失败：${e?.message ?? e}`);
  }
}

function copyTableJson() {
  const t = getTable(state.tableNo);
  const json = store.exportJsonString();
  try {
    d().defaultView?.navigator?.clipboard?.writeText(JSON.stringify({
      [t.name]: store.exportPluginJson()?.[`sheet_${t.no}`],
    }, null, 2));
    notify('success', '已复制该表 JSON。');
  } catch {
    console.log('[RBQ] 表 JSON', store.exportPluginJson()?.[`sheet_${t.no}`]);
    notify('info', '剪贴板不可用，已输出到控制台。');
  }
  void json;
}

function exportAll() {
  const json = store.exportJsonString();
  try {
    const blob = new Blob([json], { type: 'application/json' });
    const a = d().createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `rbq-tables-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
    notify('success', '已导出全部表格。');
  } catch (e) {
    console.log('[RBQ] 全量导出', json);
    notify('info', '下载不可用，已输出到控制台。');
    void e;
  }
}

/* ------------------------------------------------------------ 审计页 */

function renderAuditPane() {
  const pane = q('.rbq-pane[data-pane="audit"]');
  if (!pane) return;
  pane.textContent = '';
  const scroll = el('div', { class: 'rbq-scroll' });

  let s = {};
  try { s = store.stats(); } catch { /* ignore */ }

  scroll.appendChild(el('div', { class: 'rbq-card' }, [
    el('h4', { text: '存储概览' }),
    el('dl', { class: 'rbq-kv' }, [
      el('dt', { text: '聊天' }), el('dd', { text: s.chatId || '（未知）' }),
      el('dt', { text: '当前版本' }), el('dd', { text: `第 ${s.rev ?? 0} 版` }),
      el('dt', { text: '表格数量' }), el('dd', { text: `${s.nonEmptyTables ?? 0} 张有数据 / 共 ${s.tableCount ?? 0} 张` }),
      el('dt', { text: '数据总行数' }), el('dd', { text: String(s.rowTotal ?? 0) }),
      el('dt', { text: '可回滚记录' }), el('dd', { text: `${s.anchors ?? 0} 条` }),
      el('dt', { text: '占用体积' }), el('dd', { text: `${((s.dataBytes ?? 0) / 1024).toFixed(1)} KB` }),
    ]),
    s.mismatch ? el('div', { class: 'rbq-hint', html: `⚠️ <b>检测到聊天 ID 不一致</b>：数据属于 <code>${escapeHtml(s.mismatch.storedChatId)}</code>，当前是 <code>${escapeHtml(s.mismatch.currentChatId)}</code>。可能是切换聊天时的时序问题，先别写入。` }) : null,
  ]));

  const latest = store.findLatestAnchor();
  const audit = latest?.anchor?.audit ?? [];
  const card = el('div', { class: 'rbq-card' }, [
    el('h4', { text: `最近一次写入记录（第 ${latest?.anchor?.rev ?? '—'} 版）` }),
  ]);
  if (!audit.length) {
    card.appendChild(el('div', { class: 'rbq-hint', text: '这一轮没有记录到写入动作。' }));
  } else {
    for (const a of audit) {
      card.appendChild(el('div', { class: 'rbq-audit-item' }, [
        el('span', { class: 'rbq-badge rbq-ok', text: a.op ?? '?' }),
        el('span', { text: `表${a.table} ${a.tableName ?? ''}` }),
        a.row != null ? el('span', { class: 'rbq-hint', text: `行 ${Number(a.row) + 1}` }) : null,
        a.tag ? el('span', { class: 'rbq-hint', text: `<${a.tag}>` }) : null,
        a.matchedBy ? el('span', { class: 'rbq-hint', text: `命中：${a.matchedBy}` }) : null,
        a.note ? el('span', { class: 'rbq-badge', text: a.note }) : null,
      ]));
    }
  }
  scroll.appendChild(card);

  // 表级明细
  const detail = el('div', { class: 'rbq-card' }, [el('h4', { text: '各表状态' })]);
  for (const t of getTables()) {
    const rows = store.getRows(t.no, { create: false });
    detail.appendChild(el('div', { class: 'rbq-audit-item' }, [
      el('span', { class: 'rbq-badge', text: `表${t.no}` }),
      el('span', { text: t.name }),
      el('span', { class: 'rbq-hint', text: `${rows.length} 行 / ${t.columns.length} 列` }),
      t.singleton ? el('span', { class: 'rbq-badge rbq-warn', text: '单例' }) : null,
    ]));
  }
  scroll.appendChild(detail);

  // 最近一轮的写入/修复情况 —— 出问题时一眼看到"试了几次、为什么"
  try {
    const latest = store.findLatestAnchor();
    const idx = latest?.index ?? -1;
    const rs = idx >= 0 ? repair.describeState(idx) : null;
    const card = el('div', { class: 'rbq-card' }, [el('h4', { text: '上一轮的修复情况' })]);
    if (!rs) {
      card.appendChild(el('div', { class: 'rbq-hint', text: '还没有可显示的记录。' }));
    } else {
      card.appendChild(el('dl', { class: 'rbq-kv' }, [
        el('dt', { text: '尝试修复次数' }), el('dd', { text: String(rs.attempts) }),
        el('dt', { text: '最近原因' }), el('dd', { text: rs.lastReason }),
        el('dt', { text: '额外请求通道' }), el('dd', { text: rs.llmAvailable ? '可用' : '不可用（无法自动补数据）' }),
      ]));
      if (rs.history?.length) {
        for (const h of rs.history.slice(-4)) {
          card.appendChild(el('div', { class: 'rbq-audit-item' }, [
            el('span', { class: `rbq-badge ${h.ok ? 'rbq-ok' : 'rbq-danger'}`, text: h.strategy }),
            el('span', { text: h.ok ? '成功' : '未成功' }),
            h.applied != null ? el('span', { class: 'rbq-hint', text: `写入 ${h.applied} 条` }) : null,
            h.detail ? el('span', { class: 'rbq-hint', text: String(h.detail) }) : null,
          ]));
        }
      }
      if (rs.outcome) {
        card.appendChild(el('div', { class: 'rbq-hint', text: `当前状态：${rs.outcome.state}` }));
      }
    }
    scroll.appendChild(card);
  } catch (e) {
    scroll.appendChild(el('div', { class: 'rbq-card' }, [el('div', { class: 'rbq-hint', text: `修复状态读取失败：${e?.message ?? e}` })]));
  }

  pane.appendChild(scroll);
}


/** 开关行（设置页与附加功能页共用） */
function toggleRow(label, checked, onChange) {
  return el('div', { class: 'rbq-row' }, [
  el('label', { text: label }),
  el('label', { class: 'rbq-switch' }, [
    el('input', {
      type: 'checkbox',
      ...(checked ? { checked: true } : {}),
      onchange: (e) => onChange(e.target.checked),
    }),
    el('span', { class: 'rbq-knob' }),
  ]),
]);
}


/* ------------------------------------------------------------ 正则工坊页 */

function renderWorkshopPane() {
  const pane = q('.rbq-pane[data-pane="workshop"]');
  if (!pane) return;
  // 不再先清空（会闪一帧 ✗）；构建完一次性 replaceChildren ✓
  const scroll = el('div', { class: 'rbq-scroll' });
    const st = (state.ws ??= {
      searchType: 'tag', content: '', tagMode: 'block', action: 'delete', replaceText: '',
      sources: { ai: true, user: false, slash: false }, name: '', runOnEdit: false,
      minDepth: '', maxDepth: '', manage: false,
    });
    const spec = () => ({
      searchType: st.searchType, content: st.content, tagMode: st.tagMode, action: st.action,
      replaceText: st.replaceText, name: st.name || '未命名',
      sources: Object.entries(st.sources).filter(([, v]) => v).map(([k]) => k),
      runOnEdit: st.runOnEdit, minDepth: st.minDepth, maxDepth: st.maxDepth,
    });
    const card = el('div', { class: 'rbq-card' }, [
      el('h4', { text: '正则工坊' }),
      el('div', { class: 'rbq-hint', text: '酒馆全局正则里现在有 ' + (() => { try { const all = (ctx()?.extensionSettings?.regex ?? []); return all.length + ' 条（其中「RBQ-」开头 ' + all.filter((r) => String(r.scriptName || '').startsWith('RBQ-')).length + ' 条）'; } catch (e) { return '读不到（环境差异）'; } })() + ' ✓' }),
      el('div', { class: 'rbq-hint', html: '和你 RBQ 配置菜单里那套一样：① 检索类型 → ② 内容 → ③ 标签处理模式 → ④ 处理方式 → ⑤ 作用范围 → ⑥ 脚本名 → ⑦ 预览。<b>对用户隐藏</b>＝用户看不到但 AI 收到；<b>对AI隐藏</b>＝AI 收不到但你能看到。' }),
    ]);

    /* 【用户要求】删掉「常用例子」那一排 ✓（不需要 ✓） */
    const field = (label, node) => el('div', { class: 'rbq-ws-field' }, [el('div', { class: 'rbq-ws-label', text: label }), node]);
    const chipRow = (options, cur, onPick) => {
      const row = el('div', { class: 'rbq-chips' });
      for (const [v, label, hint] of options) {
        const b = el('button', { class: `rbq-catchip${cur === v ? ' rbq-active' : ''}`, text: label, title: hint || '' });
        b.addEventListener('click', () => onPick(v));
        row.appendChild(b);
      }
      return row;
    };

    // ① 检索类型
    card.appendChild(field('① 检索类型', chipRow(workshop.SEARCH_TYPES, st.searchType, (v) => { st.searchType = v; render(); })));
    // ② 内容
    const contentLabel = { tag: '② 标签名（不含 <>）', text: '② 要检索的文本', symbol: '② 符号（用逗号分隔）', advanced: '② 完整正则（含斜杠和 flags）' }[st.searchType];
    const ci = el('input', { class: 'rbq-input', style: 'width:100%;box-sizing:border-box', value: st.content });
    ci.placeholder = { tag: '例如：data', text: '例如：你好世界', symbol: '例如：*,_,~', advanced: '例如：/<data[\\s\\S]*?<\\/data>/gsi' }[st.searchType];
    ci.addEventListener('change', () => { st.content = ci.value; render(); });
    card.appendChild(field(contentLabel, ci));
    // ③ 标签处理模式（仅标签）
    if (st.searchType === 'tag') {
      card.appendChild(field('③ 标签处理模式', chipRow(workshop.TAG_MODES, st.tagMode, (v) => { st.tagMode = v; render(); })));
    }
    // ④ 处理方式
    const actionBox = chipRow(workshop.ACTIONS, st.action, (v) => { st.action = v; render(); });
    card.appendChild(field('④ 处理方式', actionBox));
    if (st.action === 'replace') {
      const ri = el('input', { class: 'rbq-input', style: 'width:100%;box-sizing:border-box', value: st.replaceText, placeholder: '替换成的文本' });
      ri.addEventListener('change', () => { st.replaceText = ri.value; render(); });
      card.appendChild(field('　替换为', ri));
    }
    // ⑤ 作用范围
    const scopeRow = el('div', { class: 'rbq-chips' });
    for (const [key, label] of [['ai', 'AI 输出'], ['user', '用户输入'], ['slash', '斜杠命令']]) {
      const b = el('button', { class: `rbq-catchip${st.sources[key] ? ' rbq-active' : ''}`, text: label });
      b.addEventListener('click', () => { st.sources[key] = !st.sources[key]; render(); });
      scopeRow.appendChild(b);
    }
    card.appendChild(field('⑤ 作用范围（至少选一个）', scopeRow));
    // ⑥ 脚本名
    const nameRow = el('div', { class: 'rbq-row' }, [
      el('span', { class: 'rbq-hint', text: 'RBQ-' }),
      (() => {
        const i = el('input', { class: 'rbq-input', value: st.name, placeholder: '隐藏data', style: 'min-width:200px' });
        i.addEventListener('change', () => { st.name = i.value; render(); });
        return i;
      })(),
    ]);
    card.appendChild(field('⑥ 脚本名称（自动加 RBQ- 前缀）', nameRow));
    // ⑦ 预览
    card.appendChild(field('⑦ 预览', el('pre', { class: 'rbq-ws-preview', text: workshop.previewOf(spec()) })));
    // 高级
    const adv = el('details', { class: 'rbq-librow-more' }, [el('summary', { text: '高级选项' })]);
    const roe = el('input', { type: 'checkbox', ...(st.runOnEdit ? { checked: true } : {}) });
    roe.addEventListener('change', () => { st.runOnEdit = roe.checked; render(); });
    const mkDepth = (k) => {
      const i = el('input', { class: 'rbq-input', type: 'number', value: String(st[k] ?? ''), placeholder: k === 'minDepth' ? '最小' : '最大' });
      i.style.width = '90px';
      i.addEventListener('change', () => { st[k] = i.value; render(); });
      return i;
    };
    adv.append(
      el('label', { class: 'rbq-row', style: 'cursor:pointer' }, [roe, el('span', { text: '编辑消息时也应用（runOnEdit）' })]),
      el('div', { class: 'rbq-row' }, [el('span', { class: 'rbq-hint', text: '深度限制（留空＝不限）' }), mkDepth('minDepth'), el('span', { text: '~' }), mkDepth('maxDepth')]),
    );
    card.appendChild(adv);
    // 按钮
    card.appendChild(el('div', { class: 'rbq-row' }, [
      el('button', {
        class: 'rbq-btn rbq-primary', text: '🚀 一键创建',
        onclick: async () => {
          const r = workshop.buildScript(spec());
          if (!r.ok) { notify('warning', '还没填完：' + r.error); return; }
          const res = await workshop.install(r.script);
          if (!res.ok) {
            downloadText(workshop.exportJson(r.script), 'rbq-regex.json');
            notify('error', `装不进去（${res.reason}）—— 已自动导出 JSON 给你手动导入。`);
          } else {
            /* 【用户报过"一键创建失败"】装完必须**当场确认**到底进没进 ST 的全局正则 ✓
               （以前只弹一句"装好了"✗ 用户去 ST 扩展页看不到就以为失败了 ✓
                 原因多半是 ST 的正则页没重新渲染 ✓ 不是没装上 ✓）
               这里直接读 ST 的正则数组回显条数 ✓ 让他一眼确认 ✓ */
            const all = (() => { try { return (ctx()?.extensionSettings?.regex ?? []).length; } catch (e) { return -1; } })();
            const mine = workshop.installed().length;
            notify('success', `已装进酒馆全局正则：新增 ${res.added} 条、更新 ${res.replaced} 条；`
              + `现在「RBQ-」开头的共 ${mine} 条（全局总计 ${all} 条 ✓）。`
              + `若扩展页没刷新，切走再切回「扩展 → 正则」就能看到 ✓`);
          }
          render();
        },
      }),
      el('button', {
        class: 'rbq-btn', text: '导出 JSON',
        onclick: () => {
          const r = workshop.buildScript(spec());
          if (!r.ok) { notify('warning', r.error); return; }
          downloadText(workshop.exportJson(r.script), 'rbq-regex.json');
        },
      }),
      el('button', {
        class: 'rbq-btn rbq-info', text: '📋 管理已建',
        onclick: () => { st.manage = !st.manage; render(); },
      }),
    ]));
    // 已建列表
    if (st.manage) {
      const list = workshop.installed();
      const box = el('div', { class: 'rbq-ws-manage' }, [el('div', { class: 'rbq-ws-label', text: `已建正则（${list.length} 条，认 RBQ- 前缀）` })]);
      for (const sc of list) {
        box.appendChild(el('div', { class: 'rbq-row' }, [
          el('span', { class: 'rbq-librow-name', text: sc.scriptName }),
          el('code', { class: 'rbq-wsregex', text: String(sc.findRegex).slice(0, 40) }),
          el('span', { class: 'rbq-spacer' }),
          el('button', { class: 'rbq-btn rbq-danger rbq-icon', text: '✕', title: '删掉这条', onclick: () => { workshop.removeOne(sc.scriptName); render(); } }),
        ]));
      }
      if (!list.length) box.appendChild(el('div', { class: 'rbq-hint', text: '还没建过。' }));
      box.appendChild(el('button', { class: 'rbq-btn rbq-danger', text: '全部卸载', onclick: () => { const n = workshop.removeAll(); notify('success', `卸载 ${n} 条`); render(); } }));
      card.appendChild(box);
    }
    scroll.appendChild(card);
    /* 【用户实测】点不同选项时整块会闪一下 ✗
       原因：上面先 `pane.textContent = ''` 再 append ✓ → 中间有**一帧空白** ✓ → 看起来就是闪 ✓
       修法：一次性 replaceChildren（不留空帧 ✓）+ 还原滚动位置（不然会跳回顶部 ✓） */
    const keepTop = (() => { try { return pane.querySelector('.rbq-scroll')?.scrollTop ?? 0; } catch (e) { return 0; } })();
    pane.replaceChildren(scroll);
    try { scroll.scrollTop = keepTop; } catch (e) { /* ignore */ }
}


/* ------------------------------------------------------------ 离场与实体页 */

function renderDeparturePane() {
  const pane = q('.rbq-pane[data-pane="departure"]');
  if (!pane) return;
  pane.textContent = '';
  const scroll = el('div', { class: 'rbq-scroll' });
  const st = departure.maintain();

  // ① 离场锚点提醒
  const depCard = el('div', { class: 'rbq-card' }, [
    el('h4', { text: '离场锚点提醒' }),
    el('div', { class: 'rbq-hint', text: '离场超过阈值的角色会在这里列出来，并写进 departureReminder 变量供预设使用。' }),
  ]);
  const thrRow = el('div', { class: 'rbq-row' }, [el('span', { class: 'rbq-hint', text: '阈值（轮）', style: 'min-width:76px' })]);
  const ti = el('input', { class: 'rbq-input', type: 'number', value: String(departure.Departure.getThreshold()), style: 'width:90px' });
  ti.addEventListener('change', () => { departure.Departure.setThreshold(ti.value); });
  thrRow.appendChild(ti);
  thrRow.appendChild(el('span', { class: 'rbq-hint', text: '当前轮次 ' + st.round }));
  depCard.appendChild(thrRow);

  const recs = Object.entries(departure.Departure.getRecords());
  if (!recs.length) {
    depCard.appendChild(el('div', { class: 'rbq-hint', text: '还没有离场记录。表4「离场状态」写成「已离场丨退场锚点：12」就会自动记下来。' }));
  } else {
    const table = el('table', { class: 'rbq-table' });
    table.appendChild(el('thead', {}, [el('tr', {}, ['角色', '退场锚点', '已离场轮数', '状态', ''].map((h) => el('th', { text: h })))]));
    const tb = el('tbody');
    for (const [name, anchor] of recs) {
      const gone = anchor === null || anchor === undefined ? null : st.round - Number(anchor);
      const overdue = gone !== null && gone >= st.departure.threshold;
      const tr = el('tr', {}, [
        el('td', { text: name }),
        el('td', { text: anchor === null || anchor === undefined ? '—' : String(anchor) }),
        el('td', { text: gone === null ? '—' : String(gone) }),
        el('td', {}, [el('span', { class: 'rbq-badge' + (overdue ? ' rbq-warn' : ''), text: overdue ? '该清理了' : '正常' })]),
        el('td', {}, [(() => {
          const b = el('button', { class: 'rbq-btn rbq-btn-sm', text: '删除记录' });
          b.addEventListener('click', () => { departure.Departure.deleteRecord(name); render(); });
          return b;
        })()]),
      ]);
      tb.appendChild(tr);
    }
    table.appendChild(tb);
    depCard.appendChild(table);
  }
  if (st.reminder) depCard.appendChild(el('pre', { class: 'rbq-ws-preview', text: st.reminder }));
  depCard.appendChild(el('div', { class: 'rbq-row' }, [
    el('button', { class: 'rbq-btn rbq-primary', text: '刷新离场记录', onclick: () => { departure.Departure.updateRecords(); notify('success', '已刷新'); render(); } }),
    el('button', { class: 'rbq-btn', text: '写入提醒变量', onclick: () => { const t2 = departure.Departure.reminderText(); notify(t2 ? 'info' : 'success', t2 ? '已写入 departureReminder' : '没有需要提醒的角色'); render(); } }),
  ]));
  scroll.appendChild(depCard);

  // ② 核心角色名单
  const coreCard = el('div', { class: 'rbq-card' }, [
    el('h4', { text: '核心角色名单' }),
    el('div', { class: 'rbq-hint', text: '名单里的角色即使没有离场记录也会保留一行（写在 departureCoreList）。' }),
  ]);
  const coreList = departure.Departure.getCoreList();
  const coreRow = el('div', { class: 'rbq-chips' });
  for (const n of coreList) {
    const b = el('button', { class: 'rbq-catchip rbq-active', text: n + ' ✕', title: '点一下移出名单' });
    b.addEventListener('click', () => { departure.Departure.removeCore(n); render(); });
    coreRow.appendChild(b);
  }
  if (!coreList.length) coreRow.appendChild(el('span', { class: 'rbq-hint', text: '（空）' }));
  coreCard.appendChild(coreRow);
  const ci = el('input', { class: 'rbq-input', placeholder: '输入角色名', style: 'flex:1;min-width:140px' });
  const doAdd = () => { const v = ci.value.trim(); if (!v) { notify('warning', '先输入角色名'); return; } departure.Departure.addCore(v); ci.value = ''; render(); };
  // 手机端没有回车键 —— 必须有按钮
  ci.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doAdd(); } });
  const addBtn = el('button', { class: 'rbq-btn rbq-primary', text: '加入', onclick: doAdd });
  coreCard.appendChild(el('div', { class: 'rbq-row' }, [ci, addBtn]));
  scroll.appendChild(coreCard);

  // ③ 在场名单对照
  const presCard = el('div', { class: 'rbq-card' }, [
    el('h4', { text: '表0 在场名单 × 已离场' }),
    el('div', { class: 'rbq-hint', text: '在场名单里但已经离场的名字会从这里看出来（方便你校正）。' }),
  ]);
  const present = departure.Departure.presentList();
  const chips = el('div', { class: 'rbq-chips' });
  for (const n of present) chips.appendChild(el('span', { class: 'rbq-catchip', text: n }));
  if (!present.length) chips.appendChild(el('span', { class: 'rbq-hint', text: '（表0 在场名单是空的）' }));
  presCard.appendChild(chips);
  scroll.appendChild(presCard);

  // ④ 临时实体清理
  const monCard = el('div', { class: 'rbq-card' }, [
    el('h4', { text: '临时实体（表14）清理' }),
    el('div', { class: 'rbq-hint', text: '超过阈值没再出现的怪物会被列出来，可以一键清掉，也可以只生成清理指令。' }),
  ]);
  const mtRow = el('div', { class: 'rbq-row' }, [el('span', { class: 'rbq-hint', text: '阈值（轮）', style: 'min-width:76px' })]);
  const mi = el('input', { class: 'rbq-input', type: 'number', value: String(departure.MonsterDespawn.getThreshold()), style: 'width:90px' });
  mi.addEventListener('change', () => { departure.MonsterDespawn.setThreshold(mi.value); der(); });
  mtRow.appendChild(mi);
  mtRow.appendChild(el('span', { class: 'rbq-hint', text: '表里共 ' + departure.MonsterDespawn.all().length + ' 条' }));
  monCard.appendChild(mtRow);
  if (!st.monster.pending.length) {
    monCard.appendChild(el('div', { class: 'rbq-hint', text: '没有需要清理的实体。' }));
  } else {
    for (const m of st.monster.pending) monCard.appendChild(el('div', { class: 'rbq-row' }, [el('span', { class: 'rbq-badge rbq-warn', text: '待清理' }), el('span', { text: m.name + '（最后一见 ' + m.lastSeen + '，已 ' + m.gone + ' 轮）' })]));
  }
  monCard.appendChild(el('div', { class: 'rbq-row' }, [
    el('button', { class: 'rbq-btn rbq-danger', text: '立即清理', onclick: () => { const n = departure.MonsterDespawn.cleanupNow(); notify(n ? 'success' : 'info', n ? ('已清理 ' + n + ' 条') : '没有需要清理的'); render(); } }),
    el('button', { class: 'rbq-btn', text: '只复制清理指令', onclick: () => { const cmds = departure.MonsterDespawn.cleanupCommands(); downloadText(cmds.join(String.fromCharCode(10)), 'rbq-cleanup.txt'); notify(cmds.length ? 'info' : 'success', cmds.length ? ('已导出 ' + cmds.length + ' 条指令') : '没有需要清理的'); } }),
  ]));
  scroll.appendChild(monCard);

  pane.appendChild(scroll);
}

/* ------------------------------------------------------------ 轮次与总结页 */

function renderRoundsPane() {
  const pane = q('.rbq-pane[data-pane="rounds"]');
  if (!pane) return;
  pane.textContent = '';
  const scroll = el('div', { class: 'rbq-scroll' });
  const round = summary.currentRound();
  const big = summary.reminder(round);
  // 大总结
  const card = el('div', { class: 'rbq-card' }, [
    el('h4', { text: '大总结（AI 自己写，插件只提醒与落库）' }),
    el('div', { class: 'rbq-hint', text: '没到轮次会注入禁止生成的提醒；够轮次才允许，产出落进纪事表。' }),
  ]);
  const thr = el('div', { class: 'rbq-row' }, [el('span', { class: 'rbq-hint', text: '每多少轮', style: 'min-width:76px' })]);
  const ti = el('input', { class: 'rbq-input', type: 'number', value: String(big.threshold), style: 'width:90px' });
  ti.addEventListener('change', () => { summary.setThreshold(ti.value); render(); });
  thr.appendChild(ti);
  thr.appendChild(el('span', { class: 'rbq-badge' + (big.should ? ' rbq-ok' : ''), text: big.should ? '可以生成' : '还没到' }));
  card.appendChild(thr);
  card.appendChild(el('div', { class: 'rbq-hint', text: '当前轮次 ' + round + '；上次大总结 ' + (big.last || 0) + ' 轮。' }));
  card.appendChild(el('pre', { class: 'rbq-ws-preview', text: big.text }));
  card.appendChild(el('div', { class: 'rbq-row' }, [
    el('button', { class: 'rbq-btn rbq-primary', text: '标记这一轮做过大总结', onclick: () => { summary.markBigDone(round); notify('success', '已记下'); render(); } }),
  ]));
  scroll.appendChild(card);
  // 小总结
  const sc = el('div', { class: 'rbq-card' }, [
    el('h4', { text: '小总结（本轮事件）' }),
    el('div', { class: 'rbq-hint', text: '解析 AI 正文里的 ' + summary.SMALL_TAG + ' 备忘录会被解析并记录成「本轮事件」。' }),
  ]);
  const ev = summary.listEvents({ limit: 30 });
  if (!ev.length) sc.appendChild(el('div', { class: 'rbq-hint', text: '还没有小总结。' }));
  else for (const e of ev.slice().reverse()) sc.appendChild(el('div', { class: 'rbq-row' }, [el('span', { class: 'rbq-badge', text: '第' + e.round + '轮' }), el('span', { class: 'rbq-hint', text: e.text.replace(/\n/g, '；').slice(0, 120) })]));
  scroll.appendChild(sc);
  pane.appendChild(scroll);
}

/* ------------------------------------------------------------ 记忆与召回页 */

function renderMemoryPane() {
  const pane = q('.rbq-pane[data-pane="memory"]');
  if (!pane) return;
  pane.textContent = '';
  const scroll = el('div', { class: 'rbq-scroll' });
  const st = memory.stats();
  const card = el('div', { class: 'rbq-card' }, [
    el('h4', { text: '记忆库' }),
    el('div', { class: 'rbq-hint', text: '按关键词命中、角色相关性与时间新旧排序。' }),
    el('div', { class: 'rbq-hint', text: '角色数 ' + (st.characters ?? Object.keys(memory.allMemories()).length) + '；总条数 ' + (st.total ?? 0) + '。' }),
  ]);
  scroll.appendChild(card);
  pane.appendChild(scroll);
}



/* ------------------------------------------------- 抢话 / 时间框 / 字数（合成一页） */

function extrasPageInto(paneKey, keys, extraCards = []) {
  const pane = q(`.rbq-pane[data-pane="${paneKey}"]`);
  if (!pane) return null;
  EXTRAS_FILTER = keys;
  renderExtrasPane(paneKey);
  EXTRAS_FILTER = null;
  const host = pane.querySelector('.rbq-scroll');
  if (host && extraCards.length) {
    // 插在**页头卡之后**（原来插在页头之前，会把页头挤到最下面）
    const anchor = host.children[1] ?? null;
    for (const c of extraCards) host.insertBefore(c, anchor);
  }
  return pane;
}

function renderSpeakPane() {
  const enableRow = toggleRow('允许 AI 代说 {{user}} 台词（抢话）', extras.get('speakBan').enabled, (v) => { extras.set('speakBan', { enabled: v }); extras.applyAll({ quiet: true }); render(); });
  extrasPageInto('speak', ['speakBan', 'timeBox', 'lengthReq'], []);
}

function renderOptionsPane() {
  const on = optionsApi.optionsEnabled();
  const ffCfg = extras.get('fastForward');
  const ffOn = !!ffCfg.enabled;
  const auto = optionsApi.autoRpEnabled();
  const card = el('div', { class: 'rbq-card' }, [
    el('h4', { text: '四选一' }),
    el('div', { class: 'rbq-hint', text: '开启后，AI 输出 <RP_OPTIONS> 时会在最新一条 AI 消息下面渲染 A/B/C/D 按钮。' }),
  ]);
  card.appendChild(toggleRow('启用四选一', on, (v) => { optionsApi.setOptionsEnabled(v); render(); }));
  card.appendChild(toggleRow('启用快进模式（改用下面的快进模板）', ffOn, (v) => { extras.set('fastForward', { enabled: v }); extras.applyAll({ quiet: true }); render(); }));
  card.appendChild(toggleRow('全自动 RP（自动替你选一个并继续）', auto, (v) => { optionsApi.setAutoRp(v); render(); }));
  const modeSel = el('select', { class: 'rbq-select' }, [['random', '随机（更像骰子）'], ['first', '总是选第一个（好）']].map(([v, l]) => el('option', { value: v, text: l })));
  modeSel.value = optionsApi.autoRpMode();
  modeSel.addEventListener('change', () => { optionsApi.setAutoRpMode(modeSel.value); });
  // 召回上限（0 = 全部召回）
  const capRaw = (() => { try { return ctx()?.variables?.global?.get?.('memoryRecallMaxEntries'); } catch { return undefined; } })();
  const capI = el('input', { class: 'rbq-input', type: 'number', min: '0', value: String(capRaw ?? 0), style: 'width:90px' });
  capI.addEventListener('change', () => { extras.writeVar('memoryRecallMaxEntries', Number(capI.value) || 0, 'global'); notify('success', Number(capI.value) > 0 ? ('召回上限 ' + capI.value + ' 条/人') : '已设为全部召回'); render(); });
  card.appendChild(el('div', { class: 'rbq-row' }, [
    el('span', { class: 'rbq-hint', text: '召回上限（0 = 全部）', style: 'min-width:120px' }), capI,
  ]));
  card.appendChild(el('div', { class: 'rbq-hint', text: '默认全部召回：在场角色的相关记忆都会带上；调小可以省 token。' }));
  card.appendChild(el('div', { class: 'rbq-row' }, [el('label', { text: '自动选择方式' }), modeSel]));
  card.appendChild(el('div', { class: 'rbq-hint', text: '提示词默认就是原版的两段；改完立刻生效。' }));
  // 两块模板编辑器（照原版：一个开关 + 一个快进开关，模板只是文本）
  const tmpl = (label, key) => {
    const cur = extras.get(key);
    const ta = el('textarea', { class: 'rbq-textarea', rows: '8', style: 'width:100%;min-height:140px' });
    ta.value = cur.text || '';
    ta.addEventListener('change', () => { extras.set(key, { text: ta.value }); extras.applyAll({ quiet: true }); notify('success', label + ' 已保存'); });
    return el('div', { class: 'rbq-card' }, [el('h4', { text: label }), ta]);
  };
  extrasPageInto('options', [], [card, tmpl('普通模式提示词（原版 DEFAULT_PROMPT_NORMAL）', 'rp'), tmpl('快进模式提示词（原版 DEFAULT_PROMPT_FASTFORWARD）', 'rpFastForward')]);
}

function renderOutlinePane() {
  extrasPageInto('outline', ['outline'], []);
}

/* ------------------------------- 记忆与召回：召回开关与上限（独立卡片，渲染后挂载） */

function attachMemoryCapCard() {
  const host = q('.rbq-pane[data-pane="memory"] .rbq-scroll');
  if (!host || host.querySelector('[data-rbq-memcap]')) return;
  const gget = (k) => { try { return ctx()?.variables?.global?.get?.(k); } catch { return undefined; } };
  const rawEnabled = gget('memoryRecallEnabled');
  const enabled = !(rawEnabled === false || ['false', '0', 'off', 'no'].includes(String(rawEnabled ?? '').trim().toLowerCase()));
  const capRaw = Number(gget('memoryRecallMaxEntries'));
  const cap = Number.isFinite(capRaw) && capRaw > 0 ? capRaw : 0;
  const card = el('div', { class: 'rbq-card', 'data-rbq-memcap': '1' }, [
    el('h4', { text: '召回设置' }),
  ]);
  card.appendChild(toggleRow('启用记忆召回', enabled, (v) => { extras.writeVar('memoryRecallEnabled', v ? 'true' : 'false', 'global'); notify('success', v ? '已开启召回' : '已关闭召回'); render(); }));
  const capI = el('input', { class: 'rbq-input', type: 'number', min: '0', value: String(cap), style: 'width:96px' });
  capI.addEventListener('change', () => {
    const n = Math.max(0, Number(capI.value) || 0);
    extras.writeVar('memoryRecallMaxEntries', n, 'global');
    notify('success', n > 0 ? ('每个角色最多召回 ' + n + ' 条') : '已设为全部召回');
  });
  card.appendChild(el('div', { class: 'rbq-row' }, [el('span', { class: 'rbq-hint', text: '每角色召回上限', style: 'min-width:110px' }), capI]));
  card.appendChild(el('div', { class: 'rbq-hint', text: '0 = 全部召回（默认）。调小可以省 token。' }));
  try {
    const st = memory.stats();
    card.appendChild(el('div', { class: 'rbq-hint', text: '记忆库：' + (st.characters ?? 0) + ' 个角色 / ' + (st.total ?? 0) + ' 条' }));
  } catch { /* ignore */ }
  host.insertBefore(card, host.firstChild);
}


/* ------------------------------------------------------------ 更新横幅 */

export function ensureUpdateBanner() {
  const head = q('.rbq-head') ?? q('.rbq-header') ?? q('#rbq-panel > div');
  try { document.getElementById('rbq-update-banner')?.remove(); } catch { /* ignore */ }   // 清掉旧整行横幅
  if (!head) return;
  const st = updater.status();
  let chip = document.getElementById('rbq-update-chip');
  if (!st.show) { chip?.remove(); return; }
  if (!chip) { chip = el('button', { class: 'rbq-chip-badge' }); chip.id = 'rbq-update-chip'; chip.title = '插件有新版本，点击更新'; head.appendChild(chip); }
  chip.textContent = '⬆ 插件 ' + st.latest;
  chip.onclick = async () => { await updater.applyUpdate(); render(); };
}

/** 预设更新横幅（内置预设版本比已导入的新 → 提示一键导入） */
export function ensurePresetBanner() {
  const head = q('.rbq-head') ?? q('.rbq-header') ?? q('#rbq-panel > div');
  try { document.getElementById('rbq-preset-banner')?.remove(); } catch { /* ignore */ }
  if (!head) return;
  let need = [];
  try { need = presetImport.checkUpdates().items.filter((x) => x.need); } catch { need = []; }
  let chip = document.getElementById('rbq-preset-chip');
  if (!need.length) { chip?.remove(); return; }
  if (!chip) { chip = el('button', { class: 'rbq-chip-badge' }); chip.id = 'rbq-preset-chip'; chip.title = '内置预设有新版本，点击导入'; head.appendChild(chip); }
  chip.textContent = '⬆ 预设 ' + (need[0].bundled || '');
  chip.onclick = async () => { for (const e of need) await presetImport.importOne(e); render(); };
}

/* ------------------------------- 设置页：插件更新 / 一键导入预设（渲染后挂载，稳） */

let __piManifestLoaded = false;

function attachSettingsExtras() {
  const host = q('.rbq-pane[data-pane="settings"] .rbq-scroll');
  if (!host || host.querySelector('[data-rbq-upd]')) return;
  const st = updater.status();
  const upd = el('div', { class: 'rbq-card', 'data-rbq-upd': '1' }, [
    el('h4', { text: '插件更新' }),
    /* 状态行：把"当前 / 远端 / 什么时候查的 / 有没有忽略"都说清楚 ✓ */
    el('div', {
      class: 'rbq-hint',
      text: (() => {
        const when = st.at ? new Date(st.at).toLocaleTimeString() : '';
        if (!st.latest) return '当前版本 ' + st.current + (st.error ? ('　（检查失败：' + st.error + '）') : '　（还没检查）');
        if (st.hasUpdate) return '当前版本 ' + st.current + '　→　有新版本 ' + st.latest + (when ? ('　（' + when + ' 检查）') : '') + (st.dismissed ? '　[已忽略]' : '');
        return '当前版本 ' + st.current + '　已是最新 ✓' + (when ? ('　（' + when + ' 检查）') : '');
      })(),
    }),
  ]);
  const c = updater.config();
  const mkInput = (label, key) => {
    const i = el('input', { class: 'rbq-input', type: 'text', value: String(c[key] ?? ''), style: 'flex:1;min-width:200px' });
    i.addEventListener('change', () => { updater.setConfig({ [key]: i.value }); });
    return el('div', { class: 'rbq-row' }, [el('span', { class: 'rbq-hint', text: label, style: 'min-width:96px' }), i]);
  };
  upd.appendChild(mkInput('更新源 URL', 'sourceUrl'));
  upd.appendChild(mkInput('下载地址', 'downloadUrl'));
  upd.appendChild(el('div', { class: 'rbq-hint', text: '更新源默认就是本项目的 GitHub 仓库（多源兜底：jsDelivr → raw.githubusercontent → GitHub API，国内一般能通 ✓）。想换镜像再改上面那栏 ✓' }));
  try {
    upd.appendChild(el('div', {
      class: 'rbq-hint',
      text: '仓库：' + (st.repo || updater.REPO_URL)
        + (st.source ? ('　本次用的源：' + String(st.source).replace(/^https?:\/\//, '').slice(0, 46)) : ''),
    }));
  } catch (e) { /* ignore */ }
  upd.appendChild(el('div', { class: 'rbq-row' }, [
    el('button', { class: 'rbq-btn rbq-primary', text: '检查更新', onclick: async () => { const s2 = await updater.check({ force: true }); notify(s2.hasUpdate ? 'success' : 'info', s2.hasUpdate ? ('有新版本 ' + s2.latest) : (s2.error ? ('检查失败：' + s2.error) : '已是最新')); render(); } }),
    el('button', { class: 'rbq-btn', text: '立即更新', onclick: async () => { await updater.applyUpdate(); render(); } }),
    el('button', { class: 'rbq-btn', text: '打开仓库', onclick: () => { try { window.open(updater.REPO_URL, '_blank'); } catch (e) { /* ignore */ } } }),
    (st.hasUpdate ? el('button', { class: 'rbq-btn', text: '忽略此版本', title: '不再为这个版本显示顶部横幅', onclick: () => { updater.dismiss(); render(); } }) : null),
  ].filter(Boolean)));
  host.insertBefore(upd, host.firstChild);

  const pi = el('div', { class: 'rbq-card', 'data-rbq-pi': '1' }, [
    el('h4', { text: '一键导入预设' }),
  ]);
  try { if (!__piManifestLoaded) { __piManifestLoaded = true; presetImport.loadManifest().then(() => render()).catch(() => { /* 用兜底清单 */ }); } } catch { /* ignore */ }
  for (const e of presetImport.list()) {
    pi.appendChild(el('div', { class: 'rbq-row' }, [
      el('span', { class: 'rbq-hint', text: e.label, style: 'flex:1' }),
      el('button', { class: 'rbq-btn rbq-btn-sm rbq-primary', text: '导入', onclick: async () => { await presetImport.importOne(e); render(); } }),
    ]));
  }
  host.insertBefore(pi, host.firstChild);
}
/* ------------------------------------------------------------ 侧路 API 页 */

function renderSidePane() {
  const pane = q('.rbq-pane[data-pane="side"]');
  if (!pane) return;
  pane.textContent = '';
  const scroll = el('div', { class: 'rbq-scroll' });
  const c = sideApi.config();
  const card = el('div', { class: 'rbq-card' }, [
    el('h4', { text: '侧路 API（正文之后并发跑填表 / 记忆 / 大总结）' }),
    el('div', { class: 'rbq-hint', text: sideApi.isConfigured() ? '正在用独立接口（不占用酒馆的连接）。' : '留空 = 直接用酒馆里配好的那个 API（推荐先这样试；填了 URL/Key 才走独立接口）。' }),
  ]);
  card.appendChild(toggleRow('启用侧路 API', c.enabled !== false, (v) => { sideApi.setConfig({ enabled: v }); render(); }));
  const mk = (label, key, type, w) => {
    const i = el('input', { class: 'rbq-input', type: type || 'text', value: String(c[key] ?? ''), style: w ? ('width:' + w) : 'flex:1;min-width:160px' });
    i.addEventListener('change', () => { sideApi.setConfig({ [key]: type === 'number' ? Number(i.value) : i.value }); render(); });
    return el('div', { class: 'rbq-row' }, [el('span', { class: 'rbq-hint', text: label, style: 'min-width:96px' }), i]);
  };
  card.appendChild(mk('接口地址', 'url'));
  card.appendChild(mk('API Key', 'key', 'password'));
  card.appendChild(mk('模型', 'model'));
  card.appendChild(mk('最大并发', 'maxConcurrency', 'number', '90px'));
  card.appendChild(mk('超时(ms)', 'timeoutMs', 'number', '110px'));
  card.appendChild(mk('重试次数', 'retries', 'number', '90px'));

  /* 【用户要求】预设里名字带某个符号表情的提示词 → 自动并入侧路提示词 ✓（符号包住头尾 ✓） */
  card.appendChild(mk('预设注入标记', 'marker', 'text', '90px'));
  card.appendChild(el('div', { class: 'rbq-hint', text: '预设里凡是【名字含这个符号】的提示词，都会被自动并进侧路提示词（用它包住头尾）。默认 🔒，格式：' + String.fromCharCode(10) + '🔒' + String.fromCharCode(10) + '内容…' + String.fromCharCode(10) + '🔒' }));
  card.appendChild(el('div', { class: 'rbq-row' }, [
    el('button', { class: 'rbq-btn', text: '测试连接', onclick: async () => { const r = await sideApi.testConnection(); notify(r.ok ? 'success' : 'warning', r.message); } }),
  ]));
  scroll.appendChild(card);
  const taskCard = el('div', { class: 'rbq-card' }, [el('h4', { text: '任务开关' }), el('div', { class: 'rbq-hint', text: '填表与记忆是两个独立调用，可各自重试；大总结要等填表完成。' })]);
  for (const [k, label] of [['fill', '填表（正文 → <data>）'], ['memory', '记忆提炼（正文 → 角色记忆）'], ['summary', '大总结（到阈值时）'], ['extras', '附加功能（旁白/CG/小剧场）']]) {
    taskCard.appendChild(toggleRow(label, !!c.tasks[k], (v) => { sideApi.setTask(k, v); render(); }));
  }
  scroll.appendChild(taskCard);
  const stCard = el('div', { class: 'rbq-card' }, [el('h4', { text: '最近状态' })]);
  const list = sidePipeline.status();
  if (!list.length) stCard.appendChild(el('div', { class: 'rbq-hint', text: '还没有跑过。发一轮正文后这里会显示 填表✓ 记忆✓ 大总结… ' }));
  for (const rec of list.slice(0, 8)) {
    stCard.appendChild(el('div', { class: 'rbq-row' }, [
      el('span', { class: 'rbq-badge', text: '第 ' + rec.id + ' 层' }),
      el('span', { class: 'rbq-hint', text: sidePipeline.statusLine(rec) }),
      el('span', {
        class: 'rbq-hint',
        text: (() => {
          const bad = Object.entries(rec.tasks).find(([, v]) => v && v.state === 'failed');
          if (!bad) return '';
          return '✗ ' + bad[0] + '：' + sideApi.hintOf(bad[1].error);
        })(),
      }),
      el('button', {
        class: 'rbq-btn rbq-btn-sm', text: '重试',
        onclick: async () => {
          const txt = (() => { try { return String(ctx()?.chat?.[rec.id]?.mes ?? ''); } catch { return ''; } })();
          if (!txt) { notify('warning', '拿不到那一层的正文'); return; }
          // 走 api.sideRun（会弹右下角的进度卡片 + 带「终止」按钮）；
          // 以前这里直接调 sidePipeline.rerun ✗ → 用户点了重跑却看不到任何进度卡片
          try {
            if (api && typeof api.sideRun === 'function') {
              await api.sideRun(rec.id, txt, { round: rec.round });
            } else {
              notify('info', '正在重跑侧路…');
              await sidePipeline.rerun(rec.id, txt, { round: rec.round });
              notify('success', '重跑完成');
            }
          } catch (e) {
            notify('error', `重跑失败：${e?.message ?? e}`);
          }
          render();
        },
      }),
    ]));
  }
  scroll.appendChild(stCard);

  // 预览：看看侧路实际会发什么提示词
  const pvCard = el('div', { class: 'rbq-card' }, [el('h4', { text: '侧路提示词预览' })]);
  const pvBox = el('pre', { class: 'rbq-ws-preview', text: '点上面的按钮看实际会发出去的内容。' });
  const mkPv = (label, task) => el('button', {
    class: 'rbq-btn rbq-btn-sm', text: label,
    onclick: () => {
      let sample = '';
      try { const last = (ctx()?.chat ?? []).filter((m) => m && !m.is_user).pop(); sample = String(last?.mes ?? ''); } catch { sample = ''; }
      if (!sample) sample = '（当前没有 AI 楼层，用占位正文预览）';
      pvBox.textContent = sidePipeline.preview(task, sample, 50);
    },
  });
  pvCard.appendChild(el('div', { class: 'rbq-row' }, [mkPv('填表', 'fill'), mkPv('记忆', 'memory'), mkPv('大总结', 'summary'), mkPv('附加', 'extras')]));
  pvCard.appendChild(pvBox);
  scroll.appendChild(pvCard);
  pane.appendChild(scroll);
}
/* ------------------------------------------------------------ 灵感页 */

function renderInspirationPane() {
  const pane = q('.rbq-pane[data-pane="inspiration"]');
  if (!pane) return;
  pane.textContent = '';
  const scroll = el('div', { class: 'rbq-scroll' });
  const st = inspiration.status();
  const card = el('div', { class: 'rbq-card' }, [el('h4', { text: '叙事灵感' })]);
  card.appendChild(toggleRow('启用灵感', st.enabled, (v) => { inspiration.setEnabled(v); render(); }));
  const numRow = (label, value, onChange) => {
    const i = el('input', { class: 'rbq-input', type: 'number', value: String(value), style: 'width:90px' });
    i.addEventListener('change', () => { onChange(i.value); render(); });
    return el('div', { class: 'rbq-row' }, [el('span', { class: 'rbq-hint', text: label, style: 'min-width:110px' }), i]);
  };
  card.appendChild(numRow('最小间隔（轮）', st.min, (v) => inspiration.setMinInterval(v)));
  card.appendChild(numRow('最大间隔（轮）', st.max, (v) => inspiration.setMaxInterval(v)));
  card.appendChild(toggleRow('测试模式（每轮都触发）', st.test, (v) => { inspiration.setTestMode(v); render(); }));
  card.appendChild(el('div', { class: 'rbq-hint', text: `当前轮次 ${st.round} · 上次触发 ${st.last || '—'} · 下次预计 ${st.next || '—'} 轮` }));
  card.appendChild(el('div', { class: 'rbq-row' }, [
    el('button', { class: 'rbq-btn rbq-primary', text: '立即生成灵感', onclick: () => { const r = inspiration.trigger(inspiration.currentRound()); notify('success', r.text.slice(0, 40) + '…'); render(); } }),
    el('button', { class: 'rbq-btn', text: '清空灵感', onclick: () => { inspiration.ensureDefault(); notify('info', '已恢复默认（不触发意外事件）'); render(); } }),
  ]));
  scroll.appendChild(card);
  const cur = el('div', { class: 'rbq-card' }, [el('h4', { text: '当前灵感（变量 divinationEvent）' })]);
  cur.appendChild(el('pre', { class: 'rbq-ws-preview', text: st.text || '（空）' }));
  cur.appendChild(el('div', { class: 'rbq-hint', text: '预设用 {{getvar::divinationEvent}} 取；开启后会按间隔自动更新。' }));
  scroll.appendChild(cur);
  pane.appendChild(scroll);
}
/* ------------------------------------------------------------ 变量管理页 */

function renderVarsPane() {
  const pane = q('.rbq-pane[data-pane="vars"]');
  if (!pane) return;
  pane.textContent = '';
  const scroll = el('div', { class: 'rbq-scroll' });
  const list = [...vars.listVars(), ...legacyVars.list()];
  const card = el('div', { class: 'rbq-card' }, [
    el('h4', { text: '插件会写的变量' }),
    el('div', { class: 'rbq-hint', text: '聊天变量用 {{getvar::名字}} 取；全局变量用 {{getglobalvar::名字}} 取。' }),
  ]);
  const table = el('table', { class: 'rbq-table' });
  table.appendChild(el('thead', {}, [el('tr', {}, ['变量', '作用域', '用途', '当前值', '调用'].map((h) => el('th', { text: h })))]));
  const tb = el('tbody');
  for (const d of list) {
    const raw = d.value;
    const val = raw === null || raw === '' ? '（空）' : (typeof raw === 'object' ? JSON.stringify(raw) : String(raw));
    tb.appendChild(el('tr', {}, [
      el('td', { text: d.name }),
      el('td', {}, [el('span', { class: 'rbq-badge', text: d.scope === 'global' ? '全局' : '聊天' })]),
      el('td', { class: 'rbq-hint', text: d.desc }),
      el('td', { class: 'rbq-hint', text: val.length > 36 ? val.slice(0, 36) + '…' : val }),
      el('td', {}, [(() => {
        const b = el('button', { class: 'rbq-btn rbq-btn-sm', text: '复制', title: d.usage });
        b.addEventListener('click', () => { try { navigator.clipboard?.writeText(d.usage); notify('success', '已复制 ' + d.usage); } catch { notify('info', d.usage); } });
        return b;
      })()]),
    ]));
  }
  table.appendChild(tb);
  card.appendChild(table);
  card.appendChild(el('div', { class: 'rbq-row' }, [
    el('button', { class: 'rbq-btn rbq-primary', text: '立即刷新变量', onclick: () => { vars.writeRoundVars(); extras.applyAll({ quiet: true }); notify('success', '已刷新'); render(); } }),
    el('button', { class: 'rbq-btn', text: '写轮次变量', onclick: () => { const r = vars.writeRoundVars(); notify('success', 'systemRound = ' + r); render(); } }),
    el('button', { class: 'rbq-btn rbq-danger', text: '全部清空', onclick: () => { const n = vars.clearAll(); notify('info', '已清空 ' + n + ' 个变量'); render(); } }),
  ]));
  scroll.appendChild(card);
  // 原生注入（第三条通道）
  {
    const nc = inject.nativeConfig();
    const card = el('div', { class: 'rbq-card' }, [
      el('h4', { text: '原生注入（不依赖宏）' }),
      el('div', { class: 'rbq-hint', text: '开启后由酒馆直接把表格数据放进上下文。' }),
    ]);
    card.appendChild(toggleRow('开启原生注入', nc.enabled, (v) => { inject.setNativeConfig({ enabled: v }); if (!v) { try { inject.clearNativeInjection(); } catch { /* ignore */ } } inject.applyNativeInjection(); render(); }));
    const posRow = el('div', { class: 'rbq-row' }, [el('span', { class: 'rbq-hint', text: '位置' })]);
    for (const [v, label] of [['in_chat', '聊天内'], ['in_prompt', '系统提示内']]) {
      const b = el('button', { class: 'rbq-catchip' + (nc.position === v ? ' rbq-active' : ''), text: label });
      b.addEventListener('click', () => { inject.setNativeConfig({ position: v }); inject.applyNativeInjection(); render(); });
      posRow.appendChild(b);
    }
    card.appendChild(posRow);
    const di = el('input', { class: 'rbq-input', type: 'number', value: String(nc.depth ?? 4), style: 'width:80px' });
    di.addEventListener('change', () => { inject.setNativeConfig({ depth: Number(di.value) || 0 }); inject.applyNativeInjection(); });
    card.appendChild(el('div', { class: 'rbq-row' }, [el('span', { class: 'rbq-hint', text: '深度' }), di]));
    card.appendChild(toggleRow('连表格提示词一起注入', nc.withPrompt, (v) => { inject.setNativeConfig({ withPrompt: v }); inject.applyNativeInjection(); render(); }));
    scroll.appendChild(card);
  }

  // 数据格式
  scroll.appendChild(el('div', { class: 'rbq-card' }, [
    el('h4', { text: '表格数据发给 AI 的格式' }),
    el('div', { class: 'rbq-hint', text: '{{tableData}} 的产出格式。XML 结构化最省 token，也最方便模型照着写回 <data>；表格格式是旧版观感；JSON 给别的插件用。' }),
    (() => {
      const sel = el('select', { class: 'rbq-select' }, DATA_FORMATS.map(([v, label]) => el('option', { value: v, text: label })));
      sel.value = store.getConfigValue('dataFormat.mode', 'xml');
      sel.addEventListener('change', () => { store.updateConfig({ dataFormat: { mode: sel.value } }); notify('success', `已切到 ${sel.value} 格式`); render(); });
      return sel;
    })(),
    el('div', { class: 'rbq-hint', text: '改完可以在「数据」页或控制台用 RBQ.previewTableData() 看实际产出。' }),
  ]));

  pane.appendChild(scroll);
}
/* ------------------------------------------------------------ 附加功能页 */

/** 附加功能页的 Key 过滤（拆分功能页用）：null = 全部 */
let EXTRAS_FILTER = null;

function renderExtrasPane(paneKey = 'extras') {
  const pane = q(`.rbq-pane[data-pane="${paneKey}"]`);
  if (!pane) return;
  pane.textContent = '';
  const scroll = el('div', { class: 'rbq-scroll' });

  scroll.appendChild(el('div', { class: 'rbq-card' }, [
    el('h4', { text: ({ extras: '附加功能', speak: '抢话、时间框与字数', options: '四选一', outline: '大纲' })[paneKey] ?? '附加功能' }),
    paneKey === 'extras' ? el('div', { class: 'rbq-hint', text: '开启后由侧路 API 生成，内容直接进正文；不需要任何变量。' }) : el('div', { class: 'rbq-hint', text: '开启后写入原文变量，供预设引用。' }),
    el('div', { class: 'rbq-row' }, [
      el('span', { class: 'rbq-hint', text: '关掉的功能会写空串（与原版行为一致）' }),
    ]),
  ]));

  const __all = extras.list().filter((x) => !x.hidden && (!EXTRAS_FILTER || EXTRAS_FILTER.includes(x.key)));
  for (const e of __all) {
    const card = el('div', { class: 'rbq-card' }, [
      el('div', { class: 'rbq-row' }, [
        el('h4', { text: e.label, style: 'margin:0' }),
        el('span', { class: 'rbq-spacer' }),
      ]),
    ]);
    // 开关
    const chk = el('input', { type: 'checkbox', ...(e.enabled ? { checked: true } : {}) });
    chk.addEventListener('change', () => {
      extras.set(e.key, { enabled: chk.checked });
      extras.applyAll({ quiet: true });
      notify('success', `${e.label}：${chk.checked ? '已开启（内容会进正文）' : '已关闭'}`);
      // 不再整块重绘（那会闪一下 + 滚动跳）；只就地更新这张卡的状态文字与字数
      try {
        const lab = card.querySelector('.rbq-switch-label, .rbq-hint');
        if (lab) lab.textContent = chk.checked ? '已开启' : '已关闭';
        const cnt = card.querySelector('.rbq-card-count');
        if (cnt) { try { const n = (extras.text?.(e.key) ?? '').length; cnt.textContent = '当前会写进去的内容（' + n + ' 字）'; } catch (er) { /* ignore */ } }
      } catch (e2) { /* ignore */ }
    });
    card.appendChild(el('div', { class: 'rbq-row' }, [
      el('label', { class: 'rbq-switch' }, [chk, el('span', { class: 'rbq-knob' })]),
      el('span', { class: 'rbq-hint', text: e.enabled ? '已开启' : '已关闭' }),
      el('span', { class: 'rbq-spacer' }),
      el('button', { class: 'rbq-btn', text: '还原默认模板', onclick: () => { extras.resetText(e.key); notify('success', '已还原'); render(); } }),
    ]));
    // 专属选项
    const extra = e.extra ?? {};
    if (e.key === 'lengthReq') {
      const mkNum = (k, def) => {
        const i = el('input', { class: 'rbq-input', type: 'number', value: String(extra[k] ?? def) });
        i.style.width = '86px';
        i.addEventListener('change', () => { extras.set('lengthReq', { extra: { ...extra, [k]: Number(i.value) } }); extras.applyAll({ quiet: true }); });
        return i;
      };
      card.appendChild(el('div', { class: 'rbq-row' }, [el('label', { text: '下限' }), mkNum('min', 800), el('label', { text: '上限' }), mkNum('max', 1500)]));
    }
    if (e.key === 'theater') {
      const picked = new Set(extra.types?.length ? extra.types : []);
      const box = el('div', { class: 'rbq-chips' });
      for (const ty of extras.THEATER_TYPES) {
        const on = picked.has(ty);
        const chip = el('button', { class: `rbq-catchip${on ? ' rbq-active' : ''}`, text: ty });
        chip.addEventListener('click', () => {
          if (picked.has(ty)) picked.delete(ty); else picked.add(ty);
          extras.set('theater', { extra: { ...extra, types: [...picked] } });
          extras.applyAll({ quiet: true });
          render();
        });
        box.appendChild(chip);
      }
      const pov = el('select', { class: 'rbq-select' }, [el('option', { value: 'all', text: '不限制' }), el('option', { value: 'male', text: '男性角色' }), el('option', { value: 'female', text: '女性角色' })]);
      pov.value = extra.povGender ?? 'all';
      pov.addEventListener('change', () => { extras.set('theater', { extra: { ...extra, povGender: pov.value } }); extras.applyAll({ quiet: true }); });
      card.append(el('div', { class: 'rbq-hint', text: '要生成哪些类型（点了才算，第一人称类会自动挑一个在场角色当视角）' }), box,
        el('div', { class: 'rbq-row' }, [el('label', { text: '第一人称视角性别' }), pov]));
    }
    if (e.key === 'outline') {
      const ta = el('textarea', { class: 'rbq-input', style: 'width:100%;min-height:90px;box-sizing:border-box' });
      ta.value = extra.outlineText ?? '';
      ta.placeholder = '写下你希望后续剧情朝什么方向发展（这段会填进 {大纲文本}）';
      ta.addEventListener('change', () => { extras.set('outline', { extra: { ...extra, outlineText: ta.value } }); extras.applyAll({ quiet: true }); notify('success', '大纲已保存'); });
      card.appendChild(ta);
    }
    if (e.key === 'timeBox') {
      const i = el('input', { class: 'rbq-input', value: extra.skipTags ?? 'thinking_matrix,thinking', style: 'min-width:200px' });
      i.addEventListener('change', () => { extras.set('timeBox', { extra: { ...extra, skipTags: i.value } }); });
      card.append(
        el('div', { class: 'rbq-row' }, [el('label', { text: '跳过标签（插在它们之后）' }), i]),
        el('div', { class: 'rbq-row' }, [
          el('button', {
            class: 'rbq-btn', text: '给最新一层插入时间框',
            onclick: async () => {
              const c = ctx(); void c;
              const ok = await extras.applyTimeBoxToMessage((window.SillyTavern?.getContext?.()?.chat?.length ?? 1) - 1);
              notify(ok ? 'success' : 'info', ok ? '已插入（记得刷新那一层）' : '这一层不需要插（已有时' + '间框或没开启）');
            },
          }),
          el('button', { class: 'rbq-btn', text: '预览时间框', onclick: () => notify('info', extras.buildText('timeBox') || '（未开启）') }),
        ]),
      );
    }
    // 模板编辑（时间框也给它，方便改样式）
    const ta = el('textarea', { class: 'rbq-input', style: 'width:100%;min-height:130px;box-sizing:border-box;font-family:monospace;margin-top:6px' });
    ta.value = e.text;
    ta.addEventListener('change', () => { extras.set(e.key, { text: ta.value }); extras.applyAll({ quiet: true }); notify('success', `${e.label} 模板已保存并写入变量`); });
    card.appendChild(ta);
    // 当前会写进去的值
    const built = extras.buildText(e.key);
    card.appendChild(el('details', { class: 'rbq-librow-more' }, [
      el('summary', { text: `当前会写进去的内容（${built.length} 字）` }),
      el('pre', { class: 'rbq-pre', text: built || '（未开启，写空串）' }),
    ]));
    scroll.appendChild(card);
  }

  
  pane.appendChild(scroll);
}

/* ------------------------------------------------------------ 设置页 */

function renderSettingsPane() {
  try { RBQ.personaStatus().then((s) => { state.personaInfo = s; }).catch(() => {}); } catch (e) { /* ignore */ }
  const pane = q('.rbq-pane[data-pane="settings"]');
  if (!pane) return;
  pane.textContent = '';
  const cfg = store.getConfig();
  const scroll = el('div', { class: 'rbq-scroll' });
  scroll.appendChild(    el('div', { class: 'rbq-card' }, [
      el('h4', { text: '界面大小与面板' }),
      el('div', { class: 'rbq-hint', text: '改字号后立即生效；面板可以按住左上角的 ⠿ 拖动、右下角 ◢ 缩放。' }),
      (() => {
        const row = el('div', { class: 'rbq-row' }, [el('span', { class: 'rbq-hint', text: '字号' })]);
        const cur = shell.uiConfig().fontSize;
        for (const n of shell.FONT_SIZES) {
          const b = el('button', { class: 'rbq-catchip' + (Number(cur) === n ? ' rbq-active' : ''), text: String(n) + 'px' });
          b.addEventListener('click', () => { shell.setFontSize(n); render(); });
          row.appendChild(b);
        }
        return row;
      })(),
      el('div', { class: 'rbq-row' }, [
        el('button', { class: 'rbq-btn', text: '复位位置与大小', onclick: () => { shell.resetShell(); notify('info', '已复位'); } }),
      ]),
    ]),);


  scroll.appendChild(el('div', { class: 'rbq-card' }, [
    el('h4', { text: '输入框按钮' }),
    toggleRow('显示按钮', cfg.inputButton.enabled, (v) => {
      store.updateConfig({ inputButton: { enabled: v } });   // 不再整块重绘（消除闪烁）
    }),
    el('div', { class: 'rbq-row' }, [
      el('label', { text: '位置' }),
      (() => {
        const sel = el('select', { class: 'rbq-select' }, [
          el('option', { value: 'before', text: '发送键左侧（与旧版一致）' }),
          el('option', { value: 'after', text: '发送键右侧' }),
        ]);
        sel.value = cfg.inputButton.placement;
        sel.addEventListener('change', () => {
          store.updateConfig({ inputButton: { placement: sel.value } });
          notify('info', '位置已切换，重新注入按钮…');
          import('./inputButton.js?v=2940').then((m) => { m.stopInputButton(); m.startInputButtonInjection(); });
          render();
        });
        return sel;
      })(),
    ]),
  ]));

  scroll.appendChild(el('div', { class: 'rbq-card' }, [
    /* 【用户问过这批选项还有没有用 ✓】结论：
       · 模糊匹配 / 模糊距离上限 / 保留撤销轮数 → **有用** ✓
         侧路写进来时"这一行是谁"就是靠它定位的 ✓（写错一两个字也能对上 ✓）
       · 逐条应用 / 修复方式 / 必须出现的标签 / 最多尝试次数 / 允许整轮重新生成
         → 属于**旧的"正文里写表格"容错流程** ✗ 现在填表只走侧路 API ✓ 那套已经没人用 → 删掉 ✓
       （并发 / 重试 / 超时在【侧路 API】页里 ✓ 那才是控制侧路的 ✓） */
    el('h4', { text: '表格写入（侧路写入时的匹配规则）' }),
    el('div', { class: 'rbq-hint', html: '侧路 API 写好后由插件决定<b>写到哪一行</b>；下面两项控制这个判断的宽容度 ✓（重试/超时/并发在「侧路 API」页 ✓）' }),
    toggleRow('模糊匹配（名字写错一两个字也能定位）', cfg.dataProtocol.fuzzyMatch, (v) => {
      store.updateConfig({ dataProtocol: { fuzzyMatch: v } }); render();
    }),
    el('div', { class: 'rbq-row' }, [
      el('label', { text: '模糊距离上限' }),
      (() => {
        const inp = el('input', { class: 'rbq-input', type: 'number', min: '0', max: '4', value: String(cfg.dataProtocol.fuzzyMaxDistance) });
        inp.style.width = '70px';
        inp.addEventListener('change', () => store.updateConfig({ dataProtocol: { fuzzyMaxDistance: Number(inp.value) } }));
        return inp;
      })(),
    ]),
    el('div', { class: 'rbq-row' }, [
      el('label', { text: '保留撤销轮数' }),
      (() => {
        const inp = el('input', { class: 'rbq-input', type: 'number', min: '0', max: '200', value: String(cfg.dataProtocol.keepUndoRounds) });
        inp.style.width = '70px';
        inp.addEventListener('change', () => store.updateConfig({ dataProtocol: { keepUndoRounds: Number(inp.value) } }));
        return inp;
      })(),
    ]),


    /* 【已删除】旧的"正文修复"选项：逐条应用 / 修复方式 / 必须出现的标签 / 最多尝试次数 / 允许整轮重新生成 ✓
       现在填表只走侧路 API ✓ 这些已经没有读取方了 → 一并移除（模糊匹配与撤销轮数保留在上一段 ✓） */
  ]));

  scroll.appendChild(el('div', { class: 'rbq-card' }, [
    el('h4', { text: '用户角色设定（Persona）' }),
    el('div', { class: 'rbq-hint', text: '把「你的角色设定」用 <{{user}}角色设定> 标签包起来，并把插入位置改成「聊天内 · 深度 0」（比放在提示词里更靠近正文，权重更实）。' }),
    /* 【老 RBQ 的功能】把 {{user}} 角色设定用 <{{user}}角色设定> 标签包起来 ✓
       并把插入位置改成「聊天内 · 深度 0」（比放在提示词里更靠近正文 ✓ 权重更实 ✓） */
    toggleRow('包裹{{user}}角色设定 + 移到聊天内（深度 0）', store.getConfigValue('persona.wrap', true) !== false, (v) => {
      store.updateConfig({ persona: { wrap: v } });
      try {
        if (v) {
          RBQ.personaApply({}).then((r) => notify('success', '已处理：包标签 ' + r.wrapped + ' 条 / 改插入位置 ' + r.moved + ' 条 ✓')).catch((e) => notify('warning', '处理失败：' + e.message));
        } else {
          RBQ.personaUnwrap().then((r) => notify('info', '已去掉包裹标签（' + r.unwrapped + ' 条）✓')).catch((e) => notify('warning', '处理失败：' + e.message));
        }
      } catch (e) { notify('warning', '处理失败：' + (e && e.message)); }
      render();
    }),
    /* 让用户**看得见**这个功能到底有没有生效 ✓（他说测试没生效 ✗ → 这里直接回显状态 ✓） */
    el('div', { class: 'rbq-row' }, [
      el('span', { class: 'rbq-hint', text: (() => { try { const s = state.personaInfo; if (!s) return '角色设定：点一下右边的按钮查一下 ✓'; return '角色设定：共 ' + s.total + ' 条 · 已包标签 ' + s.wrapped + ' 条 · 已移到聊天内 ' + s.atDepth + ' 条' + (s.current ? '（当前：' + s.current + '）' : ''); } catch (e) { return '角色设定：读不到'; } })() }),
      el('span', { class: 'rbq-spacer' }),
      el('button', { class: 'rbq-btn rbq-btn-sm', text: '立即应用', onclick: async () => {
        try {
          const r = await RBQ.personaApply({ onlyCurrent: false });
          state.personaInfo = await RBQ.personaStatus();
          notify('success', '已应用：包标签 ' + r.wrapped + ' 条 / 改插入位置 ' + r.moved + ' 条（共 ' + (r.ids || []).length + ' 条设定）✓');
        } catch (e) { notify('warning', '应用失败：' + (e && e.message)); }
        render();
      } }),
      el('button', { class: 'rbq-btn rbq-btn-sm', text: '查状态', onclick: async () => { try { state.personaInfo = await RBQ.personaStatus(); notify('info', JSON.stringify(state.personaInfo).slice(0, 160)); } catch (e) { notify('warning', '读不到'); } render(); } }),
    ]),
    toggleRow('允许整轮重新生成', cfg.repair.autoRegen, (v) => {
      store.updateConfig({ repair: { autoRegen: v } }); render();
    }),
    el('div', { class: 'rbq-row' }, [
      el('label', { text: '最多尝试次数' }),
      (() => {
        const inp = el('input', { class: 'rbq-input', type: 'number', min: '1', max: '5', value: String(cfg.repair.maxAttempts) });
        inp.style.width = '70px';
        inp.addEventListener('change', () => store.updateConfig({ repair: { maxAttempts: Number(inp.value) } }));
        return inp;
      })(),
    ]),
    el('div', { class: 'rbq-row' }, [
      el('label', { text: '必须出现的标签' }),
      (() => {
        const inp = el('input', {
          class: 'rbq-input', type: 'text', style: 'min-width:220px',
          placeholder: '留空则只在写入失败时修复，例：data',
          value: (cfg.repair.requiredTags ?? []).join(','),
        });
        inp.addEventListener('change', () => {
          const tags = inp.value.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
          store.updateConfig({ repair: { requiredTags: tags } });
        });
        return inp;
      })(),
      el('span', { class: 'rbq-hint', text: '这些标签没出现时会触发一次补数据' }),
    ]),
  ]));


  /* ---------------- 外观 ---------------- */
  scroll.appendChild(el('div', { class: 'rbq-card' }, [
    el('h4', { text: '外观：主题与背景' }),
    el('div', { class: 'rbq-row' }, [
      el('label', { text: '配色' }),
      (() => {
        const sel = el('select', { class: 'rbq-select' },
          [...Object.entries(THEMES).map(([k, v]) => el('option', { value: k, text: v.label })), el('option', { value: 'follow', text: '跟随酒馆' })]);
        sel.value = currentTheme();
        sel.addEventListener('change', () => { setTheme(sel.value); render(); });
        return sel;
      })(),
    ]),
    toggleRow('动态背景（纯 CSS 渐变，不加载外部资源）', dynamicBackground(), (v) => { setDynamicBackground(v); render(); }),
  ]));



  scroll.appendChild(el('div', { class: 'rbq-card' }, [
    el('h4', { text: '宏' }),
    toggleRow('注册表格宏（{{tableData}} / {{tablePrompt}} / {{GET_ALL_TABLES_JSON}}）', cfg.macros.enabled, (v) => {
      store.updateConfig({ macros: { enabled: v } });
      notify('info', v ? '已开启，刷新页面后生效。' : '已关闭，刷新页面后生效。');
    }),
    el('div', { class: 'rbq-hint', text: '宏名与旧插件完全一致，所以你的预设与状态栏都不用改。' }),
  ]));

    scroll.appendChild(el('div', { class: 'rbq-card' }, [
    el('h4', { text: '诊断' }),
    toggleRow('调试日志（控制台多打一些过程信息）', store.getConfigValue('debug', false) === true, (v) => {
      store.updateConfig({ debug: v }); render();
    }),
    el('div', { class: 'rbq-row' }, [
      el('button', { class: 'rbq-btn', onclick: () => { const r = store.roundTripCheck(); notify(r.ok ? 'success' : 'error', r.ok ? '导出/导入往返一致 ✅' : '往返不一致 ❌'); }, text: '往返自检' }),
      el('button', { class: 'rbq-btn rbq-danger', onclick: resetData, text: '清空本聊天的表格数据' }),
    ]),
  ]));

  pane.appendChild(scroll);
}

/* ------------------------------------------------------------ 诊断动作 */

async function runImportFromPlugin() {
  try {
    const g = win();
    if (typeof api !== 'function') {
      return;
    }
    const json = api();
    const res = store.importPluginJson(json, { replace: true });
    await store.commit({ persist: true, audit: [{ op: 'import', table: '-', tableName: `从插件导入 ${res.imported} 张表` }] });
    notify('success', `已导入 ${res.imported} 张表${res.skipped.length ? `，跳过 ${res.skipped.length} 项` : ''}。`);
    render();
  } catch (e) {
    notify('error', `导入失败：${e?.message ?? e}`);
  }
}

async function resetData() {
  const w = win();
  if (w?.confirm && !w.confirm('确定清空本聊天的表格数据？此操作不可撤销（建议先导出备份）。\n\n同时会清掉各楼层的回滚锚点（旧版本记错的锚点会把脏数据带回来）。')) return;
  // 用 store.clearAllTables()：它会清空 + 打「禁止自动回退」标记 ✓
  // （以前只清当前档 ✗ → 读取时又自动切回存着旧数据的档 → 看起来"没清掉" ✗）
  await store.clearAllTables();
  /* 【重要】连锚点一起清掉 ✓ —— 否则那些用旧版本记下的（beforeRev 记错 / 没有快照）锚点，
     会在下次"重新生成"时把脏数据"还原"回来 ✗✓ */
  try {
    const n = store.clearAllAnchors?.() ?? 0;
    if (n) notify('info', `同时清掉了 ${n} 个旧回滚锚点。`);
  } catch (e) { /* ignore */ }
  notify('success', '已清空（表格 + 回滚锚点）。');
  render();
}

/* ------------------------------------------------------------ 对外刷新 */

export function refreshPanel() {
  if (panelEl && !panelEl.classList.contains('rbq-hidden')) renderDebounced();
  refreshBadge();

  try { ensureUpdateBanner(); } catch { /* ignore */ }
  try { ensurePresetBanner(); } catch { /* ignore */ }
}

export { state as panelState };

/* ---------------------------------------------------------------- 视口夹取 */
/* 窄屏或从更宽的窗口保存过位置时，面板可能超出视口：打开/缩放后夹一次  __viewportClamp */
function __clampPanelToViewport() {
  try {
    const el = document.getElementById(PANEL_ID);
    if (!el) return;
    const de = document.documentElement;
    const vw = de.clientWidth || window.innerWidth || 0;
    const vh = de.clientHeight || window.innerHeight || 0;
    if (window.innerWidth < 520) el.classList.add('rbq-narrow'); else el.classList.remove('rbq-narrow');
    const maxW = Math.max(260, vw - 16);
    // 窗口变大后要能回到上限：先清掉上一次夹紧写的内联宽度
    if (el.style.width && vw - 16 > 640) el.style.width = '';
    if ((el.offsetWidth || 0) > maxW) el.style.width = maxW + 'px';
    // 用【屏幕坐标】判断：offsetTop 是相对定位父级的，面板可能整体跑出视口却看不出来
    const r = el.getBoundingClientRect();
    const w = Math.round(r.width) || el.offsetWidth || 0;
    const h = Math.round(r.height) || el.offsetHeight || 0;
    if (r.left < 4 || r.right > vw - 4) el.style.left = Math.max(4, Math.round((vw - Math.min(w, vw - 8)) / 2)) + 'px';
    if (r.top < 4 || r.bottom > vh - 4 || r.top > vh - 60) {
      el.style.top = Math.max(4, Math.round((vh - Math.min(h, vh - 8)) / 2)) + 'px';
    }
  } catch { /* ignore */ }
}
try {
  document.addEventListener('click', (e) => {
    const hit = e.target && e.target.closest && e.target.closest('#rbq-input-btn, #rbq-fab-btn, #rbq-panel .rbq-tab, #rbq-panel .rbq-compass-item');
    if (hit) setTimeout(__clampPanelToViewport, 320);
  }, true);
  window.addEventListener('resize', () => {
    setTimeout(__clampPanelToViewport, 120);
    // 宽度变化后让当前视图按新尺寸重排（地图/轮盘/背包分栏）
    try { setTimeout(() => { const vb = doc?.querySelector?.('#rbq-panel .rbq-hud-vbody'); if (vb && typeof renderViewportInto === 'function') renderViewportInto(state.view, vb); }, 260); } catch (e) { /* ignore */ }
  });
  setTimeout(__clampPanelToViewport, 600);
} catch { /* ignore */ }
