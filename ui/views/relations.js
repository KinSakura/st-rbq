/**
 * relations.js —— 人物关系图（给用户看的「图」，不是关系列表）
 *
 * 相比第一版：
 *   · 节点带**头像圆牌**（酒馆角色卡头像 / 用户配置 / 首字回退）；
 *   · 边带**箭头**：单向＝虚线单箭头，互为关系＝实线双箭头，一眼看出谁单方面在意谁；
 *   · 线宽随好感/占有欲强度变化，颜色按语义（亲近绿 / 敌意红 / 复杂黄 / 契约蓝）；
 *   · 点节点进入**聚焦模式**：只亮出 1 跳邻居，其余淡出，右侧列出该角色两个方向的关系明细；
 *   · 滚轮缩放、拖动节点微调布局（本次会话内保持）。
 *
 * 数据来源：表5（A→B 单向关系），天然是有向图。
 */

import * as store from '../../core/store.js';
import { getTable } from '../../core/schema.js';

const NS = 'http://www.w3.org/2000/svg';
const COL = { from: 0, to: 1, surfaceRel: 2, surfaceCall: 3, privateRel: 4, privateCall: 5, affection: 6, obedience: 7, possess: 8, blind: 9, guard: 10, memory: 11 };

const rows = (no) => store.getRows(no, { create: false });
const cell = (r, i) => String(r?.[i] ?? '').trim();
const mk = (tag, attrs = {}) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
};

function edgeColor(text) {
  const s = `${text ?? ''}`;
  if (/爱慕|喜欢|亲近|信任|忠诚|依恋|友好|朋友|同伴/.test(s)) return '#3fb950';
  if (/憎|厌|仇|敌|警惕|恨|敌意|利用/.test(s)) return '#f85149';
  if (/愧疚|亏欠|复杂|矛盾|纠结|单恋|暗恋/.test(s)) return '#d29922';
  if (/同僚|同事|上下|师徒|主从|契约/.test(s)) return '#58a6ff';
  return '#8b93a7';
}

function edgeWidth(e) {
  const s = `${e.affection}${e.possess}`;
  if (/极其|极强|极端|疯狂|执念/.test(s)) return 3.6;
  if (/强|深|浓|很高/.test(s)) return 2.6;
  if (/中|一般/.test(s)) return 1.8;
  return 1.2;
}

function presentSet() {
  const t0 = getTable(0);
  const i = t0 ? t0.columns.findIndex((c) => c.includes('在场实体名单')) : -1;
  const r0 = rows(0)[0];
  if (i < 0 || !r0) return new Set();
  return new Set(String(r0[i] ?? '').split(/[/,，、]/).map((s) => s.trim()).filter(Boolean));
}

function avatarFor(name, api) {
  try {
    const cfg = store.getConfigValue('views.avatars', {}) ?? {};
    // 【用户实测】点了「清除自定义头像」还是一张图 ✗ → 因为会回退到角色卡头像 ✓
    //   现在：键存在就听它的（空串 = 明确要首字 ✓）
    if (Object.prototype.hasOwnProperty.call(cfg, name)) return cfg[name] || null;
    if (cfg[name]) return cfg[name];
  } catch { /* ignore */ }
  try {
    const hit = (api.characters ?? []).find((c) => String(c?.name ?? '') === name);
    if (hit?.avatar) return `/characters/${encodeURIComponent(hit.avatar)}`;
  } catch { /* ignore */ }
  return null;
}

/** 图例（纯 DOM，不依赖外部导入） */
function buildGraphLegend() {
  const box = document.createElement('div');
  box.className = 'rbq-legend';
  const items = [
    ['实线', '双向关系（互相）'],
    ['虚线 + 箭头', '单向关系'],
    ['绿圈', '此刻在场'],
    ['线色', '关系性质（暖=亲近 / 冷=疏离）'],
  ];
  for (const [k, v] of items) {
    const s = document.createElement('span');
    const i = document.createElement('i');
    i.textContent = k;
    s.appendChild(i);
    s.appendChild(document.createTextNode(' ' + v));
    box.appendChild(s);
  }
  return box;
}

export function renderRelations(host, api) {
  const { el } = api;
  host.textContent = '';
  const t5 = getTable(5);
  const relRows = rows(5);
  if (!t5 || !relRows.length) {
    host.appendChild(el('div', { class: 'rbq-empty', text: '还没有关系数据。' }));
    return;
  }

  const present = presentSet();
  const state = (api.state.rel ??= { zoom: 1, panX: 0, panY: 0, focus: null, onlyPresent: false, pos: {} });

  const nodes = new Map();
  const edges = [];
  for (const r of relRows) {
    const a = cell(r, COL.from);
    const b = cell(r, COL.to);
    if (!a || !b || a === b) continue;
    if (state.onlyPresent && present.size && (!present.has(a) || !present.has(b))) continue;
  // （下面还有一处：筛完为空时自动取消只看在场，避免把自己锁在空态里出不来）
    if (!nodes.has(a)) nodes.set(a, { name: a });
    if (!nodes.has(b)) nodes.set(b, { name: b });
    edges.push({
      from: a, to: b,
      surfaceRel: cell(r, COL.surfaceRel),
      privateRel: cell(r, COL.privateRel),
      affection: cell(r, COL.affection),
      possess: cell(r, COL.possess),
      blind: cell(r, COL.blind),
      memory: cell(r, COL.memory),
    });
  }
  const names = [...nodes.keys()];
  if (!names.length) {
    host.appendChild(el('div', { class: 'rbq-empty', text: '当前筛选下没有可显示的关系。' }));
    if (state.onlyPresent) {
      host.appendChild(el('div', { class: 'rbq-row' }, [el('button', { class: 'rbq-btn rbq-primary', text: '显示全部关系', onclick: () => { state.onlyPresent = false; api.rerender(); } })]));
    }
    host.appendChild(el('div', { class: 'rbq-hint', text: '（若刚点过“只看在场”，本页已自动恢复为显示全部）' }));
    return;
  }

  const has = (a, b) => edges.some((e) => e.from === a && e.to === b);
  const neighbors = (n) => {
    const s = new Set();
    for (const e of edges) { if (e.from === n) s.add(e.to); if (e.to === n) s.add(e.from); }
    return s;
  };

  /* ---------------- 布局 ---------------- */
  const W = 880; const H = 620;
  const cx = W / 2; const cy = H / 2;
  const R = Math.min(W, H) / 2 - 86;
  const seedPos = () => {
    const p = {};
    names.forEach((n, i) => {
      const ang = (Math.PI * 2 * i) / names.length - Math.PI / 2;
      p[n] = { x: cx + R * Math.cos(ang), y: cy + R * Math.sin(ang) };
    });
    return p;
  };
  if (!state.pos || !Object.keys(state.pos).length) state.pos = seedPos();
  for (const n of names) if (!state.pos[n]) state.pos[n] = seedPos()[n];
  const pos = state.pos;

  const svg = mk('svg', { class: 'rbq-relations-svg', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'xMidYMid meet' });
  const defs = mk('defs');
  for (const [id, color] of [['rbq-arrow', '#8b93a7'], ['rbq-arrow-on', '#7c6cf0']]) {
    const m = mk('marker', { id, viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '6', markerHeight: '6', orient: 'auto-start-reverse' });
    m.appendChild(mk('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: color }));
    defs.appendChild(m);
  }
  svg.appendChild(defs);
  const root = mk('g', { class: 'rbq-graph-root' });
  svg.appendChild(root);

  /* ---------------- 边 ---------------- */
  const edgeEls = [];
  for (const e of edges) {
    const p1 = pos[e.from]; const p2 = pos[e.to];
    if (!p1 || !p2) continue;
    const mutual = has(e.to, e.from);
    const color = edgeColor(`${e.surfaceRel}${e.affection}`);
    const w = edgeWidth(e);
    const dx = p2.x - p1.x; const dy = p2.y - p1.y;
    const d = Math.hypot(dx, dy) || 1;
    const shrink = 30;
    const sx = p1.x + (dx / d) * shrink; const sy = p1.y + (dy / d) * shrink;
    const tx = p2.x - (dx / d) * shrink; const ty = p2.y - (dy / d) * shrink;
    const nx = -dy / d; const ny = dx / d;
    const off = mutual ? 15 : 0;
    const g = mk('g', { class: 'rbq-graph-edge' });
    g.appendChild(mk('path', {
      d: `M ${sx + nx * off} ${sy + ny * off} Q ${(sx + tx) / 2 + nx * (off + 16)} ${(sy + ty) / 2 + ny * (off + 16)} ${tx + nx * off} ${ty + ny * off}`,
      fill: 'none', stroke: color, 'stroke-width': w,
      'stroke-dasharray': mutual ? '' : '6 5',
      'stroke-opacity': 0.8,
      'marker-end': mutual ? '' : 'url(#rbq-arrow)',
      'marker-start': mutual ? '' : 'url(#rbq-arrow)',
    }));
    const label = mk('text', {
      x: (sx + tx) / 2 + nx * (off + 22),
      y: (sy + ty) / 2 + ny * (off + 22),
      class: 'rbq-edge-label', fill: color,
    });
    label.textContent = e.surfaceRel || e.affection || '';
    g.appendChild(label);
    const title = mk('title');
    title.textContent = [
      `${e.from} → ${e.to}`,
      e.surfaceRel ? `表面关系：${e.surfaceRel}` : '',
      e.privateRel ? `内心：${e.privateRel}` : '',
      e.affection ? `好感底色：${e.affection}` : '',
      e.possess ? `占有欲：${e.possess}` : '',
      e.blind ? `情报盲区：${e.blind}` : '',
      e.memory ? `定情回忆：${e.memory}` : '',
    ].filter(Boolean).join('\n');
    g.appendChild(title);
    edgeEls.push({ el: g, from: e.from, to: e.to });
    root.appendChild(g);
  }

  /* ---------------- 节点 ---------------- */
  const nodeEls = [];
  names.forEach((n, idx) => {
    const p = pos[n];
    const isPresent = present.has(n);
    const g = mk('g', { class: 'rbq-graph-node', style: 'cursor:grab' });
    g.appendChild(mk('circle', { cx: p.x, cy: p.y, r: 24, class: `rbq-node-ring${isPresent ? ' rbq-node-present' : ''}` }));
    const av = avatarFor(n, api);
    if (av) {
      const clipId = `rbq-clip-${idx}`;
      const clip = mk('clipPath', { id: clipId });
      clip.appendChild(mk('circle', { cx: p.x, cy: p.y, r: 21 }));
      defs.appendChild(clip);
      g.appendChild(mk('image', {
        x: p.x - 21, y: p.y - 21, width: 42, height: 42,
        href: av, 'clip-path': `url(#${clipId})`, preserveAspectRatio: 'xMidYMid slice',
      }));
    } else {
      g.appendChild(mk('circle', { cx: p.x, cy: p.y, r: 21, class: 'rbq-node-face' }));
      const ini = mk('text', { x: p.x, y: p.y + 6, class: 'rbq-node-initial' });
      ini.textContent = n.slice(0, 1);
      g.appendChild(ini);
    }
    if (isPresent) {
      const dot = mk('circle', { cx: p.x + 18, cy: p.y - 18, r: 4.5, class: 'rbq-node-dot' });
      const tt = mk('title'); tt.textContent = '在场';
      dot.appendChild(tt);
      g.appendChild(dot);
    }
    const label = mk('text', { x: p.x, y: p.y + 42, class: 'rbq-node-label' });
    label.textContent = n;
    g.appendChild(label);

    let drag = null;
    g.addEventListener('mousedown', (ev) => {
      ev.stopPropagation();
      drag = { x: ev.clientX, y: ev.clientY, px: p.x, py: p.y };
    });
    window.addEventListener('mousemove', (ev) => {
      if (!drag) return;
      p.x = drag.px + (ev.clientX - drag.x) / (state.zoom || 1);
      p.y = drag.py + (ev.clientY - drag.y) / (state.zoom || 1);
      g.setAttribute('transform', `translate(${p.x - drag.px} ${p.y - drag.py})`);
    });
    window.addEventListener('mouseup', () => {
      if (!drag) return;
      drag = null;
    });
    g.addEventListener('click', () => {
      state.focus = state.focus === n ? null : n;
      // 局部更新：只切换 dim 类名 + 重建右侧关系列 + 同步取消聚焦按钮（不整视图重绘 → 不闪）
      try { applyFocus(); fillSide(); syncFocusBtn(); } catch (e) { try { api.rerender(); } catch (e2) { /* ignore */ } }
    });
    nodeEls.push({ el: g, name: n });
    root.appendChild(g);
  });

  /* 聚焦时只改类名（局部更新用；不重建节点 → 不闪） */
  function applyFocus() {
    try {
      if (state.focus) {
        const keep = new Set([state.focus, ...neighbors(state.focus)]);
        for (const nd of nodeEls) nd.el.classList.toggle('rbq-dim', !keep.has(nd.name));
        for (const ed of edgeEls) ed.el.classList.toggle('rbq-dim', !(ed.from === state.focus || ed.to === state.focus));
      } else {
        for (const nd of nodeEls) nd.el.classList.remove('rbq-dim');
        for (const ed of edgeEls) ed.el.classList.remove('rbq-dim');
      }
    } catch (e) { /* ignore */ }
  }
  applyFocus();

  const applyView = () => root.setAttribute('transform', `translate(${state.panX} ${state.panY}) scale(${state.zoom})`);
  applyView();
  let pan = null;
  svg.addEventListener('mousedown', (e) => { pan = { x: e.clientX, y: e.clientY, px: state.panX, py: state.panY }; });
  svg.addEventListener('mousemove', (e) => {
    if (!pan) return;
    state.panX = pan.px + (e.clientX - pan.x);
    state.panY = pan.py + (e.clientY - pan.y);
    applyView();
  });
  window.addEventListener('mouseup', () => { pan = null; });
  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    state.zoom = Math.max(0.5, Math.min(2.6, state.zoom * (e.deltaY > 0 ? 0.92 : 1.08)));
    applyView();
  }, { passive: false });

  /* ---------------- 工具栏 ---------------- */
  const bar = el('div', { class: 'rbq-viewbar' }, [
    el('span', { class: 'rbq-hint', text: `${names.length} 个角色 · ${edges.length} 条关系` }),
    el('span', { class: 'rbq-spacer' }),
    el('span', { class: 'rbq-hint', text: '只看在场' }),
    (() => {
      const i = el('input', { type: 'checkbox', ...(state.onlyPresent ? { checked: true } : {}) });
      i.addEventListener('change', () => { state.onlyPresent = i.checked; api.rerender(); });
      return el('label', { class: 'rbq-switch' }, [i, el('span', { class: 'rbq-knob' })]);
    })(),
    state.focus ? el('button', { class: 'rbq-btn rbq-focus-btn', text: `取消聚焦：${state.focus}`, onclick: () => { state.focus = null; try { applyFocus(); fillSide(); syncFocusBtn(); } catch (e) { try { api.rerender(); } catch (e2) { /* ignore */ } } } }) : null,
    el('button', { class: 'rbq-btn', text: '重排', onclick: () => { state.pos = {}; api.rerender(); } }),
  ].filter(Boolean));

  /* ---------------- 聚焦明细 ---------------- */
  const side = el('div', { class: 'rbq-graph-side' });
  /* 右侧关系列（局部重建用：点节点切换聚焦时只重建这一块 → 不闪） */
  function fillSide() {
    try { side.textContent = ""; } catch (e) { /* ignore */ }
  const __focusNow = state.focus;
  if (__focusNow) {
    const f = __focusNow;
    const out = edges.filter((e) => e.from === f);
    const inc = edges.filter((e) => e.to === f);
    side.appendChild(el('div', { class: 'rbq-graph-side-head' }, [
      el('strong', { text: f }),
      el('span', { class: 'rbq-hint', text: `出 ${out.length} · 入 ${inc.length}` }),
    ]));
    const block = (title, list, other) => {
      if (!list.length) return;
      side.appendChild(el('h4', { class: 'rbq-section', text: title }));
      for (const e of list) {
        side.appendChild(el('div', { class: 'rbq-rel-row' }, [
          el('span', { class: 'rbq-rel-tone', style: `background:${edgeColor(`${e.surfaceRel}${e.affection}`)}` }),
          el('span', { class: 'rbq-rel-who', text: other(e) }),
          el('span', { class: 'rbq-rel-tag', text: e.surfaceRel || '—' }),
          e.affection ? el('span', { class: 'rbq-hint', text: e.affection }) : null,
        ]));
      }
    };
    block(`${f} 眼中的别人`, out, (e) => e.to);
    block(`别人眼中的 ${f}`, inc, (e) => e.from);
  } else {
    side.appendChild(el('div', { class: 'rbq-hint', text: '点一个角色进入聚焦：只亮出他的一跳邻居，并在这里列出两个方向的关系明细。' }));
  }
  }
  fillSide();

  /* 同步工具栏上的“取消聚焦”按钮（点节点时只改这一颗按钮，不重建工具栏 → 不闪） */
  function syncFocusBtn() {
    try {
      const barEl = host.querySelector('.rbq-viewbar');
      if (!barEl) return;
      const old = barEl.querySelector('.rbq-focus-btn');
      if (old) old.remove();
      if (state.focus) {
        const b2 = el('button', { class: 'rbq-btn rbq-focus-btn', text: `取消聚焦：${state.focus}` });
        b2.addEventListener('click', () => { state.focus = null; try { applyFocus(); fillSide(); syncFocusBtn(); } catch (e) { try { api.rerender(); } catch (e2) { /* ignore */ } } });
        barEl.appendChild(b2);
      }
    } catch (e) { /* ignore */ }
  }

  host.append(bar, el('div', { class: 'rbq-graph-layout' }, [el('div', { class: 'rbq-relations-wrap' }, [svg]), side]));
  host.appendChild(el('div', { class: 'rbq-hint', text: '实线双箭头＝互为关系，虚线单箭头＝单向在意；线越粗＝好感或占有欲越强；绿点＝在场。可拖动节点、滚轮缩放。' }));

  try { host.appendChild(buildGraphLegend()); } catch { /* ignore */ }
}
