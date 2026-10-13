/**
 * map.js —— 地图（真正的空间地图，不是分组列表）
 *
 * 布局：每个「所属大区」是一块区域，按网格铺在平面上；区域内的地点用
 * 名字哈希做确定性抖动散布（每次打开位置一致，但不像列表那样一字排开）。
 * 线：同区域内的已知通路 + 跨区域的长路（虚线）。
 * 当前位置：脉冲光环 + 发光节点，一键"回到当前位置"。
 * 可滚轮缩放、拖动平移，点图标出右侧详情。
 *
 * 纯 SVG 手绘，不引任何依赖。
 */

import * as store from '../../core/store.js';
import { getTable } from '../../core/schema.js';
import { resolveAttr } from '../../core/alias.js';   // 之前漏了这个 import

const NS = 'http://www.w3.org/2000/svg';
const C = { name: 0, region: 1, scale: 2, decor: 3, security: 4, owner: 5, func: 6, assets: 7, clues: 8, damage: 9 };

const cell = (r, i) => String(r?.[i] ?? '').trim();
const rows = (no) => store.getRows(no, { create: false });

function get(no, row, name) {
  const t = getTable(no);
  if (!t || !row) return '';
  const hit = resolveAttr(no, name);
  let i = hit ? hit.index : -1;
  if (i < 0) i = t.columns.findIndex((c) => c === name || c.includes(name) || name.includes(c));
  return i < 0 ? '' : s(row[i]);
}
const mk = (tag, attrs = {}) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
};

/** 名字 → 稳定哈希（同一个地点永远落在同一处） */
function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return Math.abs(h);
}

/** 按职能/损毁挑图标 */
function poiIcon(r) {
  const s = `${cell(r, C.func)}${cell(r, C.damage)}${cell(r, C.name)}`;
  if (/哨|关|门|入口|检查/.test(s)) return '🚪';
  if (/商业|市场|交易|商会|店/.test(s)) return '🏪';
  if (/宗教|神殿|祭|教堂/.test(s)) return '⛩';
  if (/军事|要塞|驻|兵营|堡/.test(s)) return '🏰';
  if (/居住|民居|村|宅/.test(s)) return '🏠';
  if (/废|坍塌|损毁|遗迹|荒/.test(s)) return '🏚';
  if (/山|峰|岭|洞穴|矿/.test(s)) return '⛰';
  if (/水|河|湖|海|港|渡/.test(s)) return '🌊';
  if (/森林|林|树|丛/.test(s)) return '🌲';
  if (/城|塔|宫|殿/.test(s)) return '🏛';
  return '📍';
}

function currentLocation() {
  const t0 = getTable(0);
  const r0 = rows(0)[0];
  const i = t0 ? t0.columns.findIndex((c) => c.includes('绝对位置名称')) : -1;
  return i >= 0 && r0 ? cell(r0, i) : '';
}

export function renderMap(host, api) {
  const { el } = api;
  host.textContent = '';
  const t1 = getTable(1);
  const list = rows(1).filter((r) => cell(r, C.name));
  if (!t1 || !list.length) {
    host.appendChild(el('div', { class: 'rbq-empty', text: '地图还是空的。' }));
    return;
  }

  const here = currentLocation();
  const state = (api.state.map ??= { zoom: 1, panX: 0, panY: 0, selected: here });

  /* ---------------- 布局 ---------------- */
  const groups = new Map();
  for (const r of list) {
    const g = cell(r, C.region) || '未知区域';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(r);
  }
  const regions = [...groups.keys()];
  const cols = Math.max(1, Math.ceil(Math.sqrt(regions.length)));
  const rowsN = Math.ceil(regions.length / cols);
  const ZW = 430; const ZH = 330; const GAP = 46; const PAD = 34;

  const zones = regions.map((reg, i) => ({
    reg,
    x: PAD + (i % cols) * (ZW + GAP),
    y: PAD + Math.floor(i / cols) * (ZH + GAP),
    items: groups.get(reg),
  }));
  const W = cols * ZW + (cols - 1) * GAP + PAD * 2;
  const H = rowsN * ZH + (rowsN - 1) * GAP + PAD * 2;

  const placed = new Map();
  for (const z of zones) {
    const n = z.items.length;
    z.items.forEach((r, k) => {
      const nm = cell(r, C.name);
      const h = hash(nm);
      const base = (Math.PI * 2 * k) / Math.max(1, n) - Math.PI / 2;
      const jitterA = ((h % 100) / 100 - 0.5) * 0.9;
      const rad = n === 1 ? 0 : Math.min(ZW, ZH) * (0.18 + (((h >> 3) % 100) / 100) * 0.22);
      placed.set(nm, {
        row: r,
        x: z.x + ZW / 2 + Math.cos(base + jitterA) * rad,
        y: z.y + ZH / 2 + Math.sin(base + jitterA) * rad * 0.74,
      });
    });
  }

  /* ---------------- 画 ---------------- */
  const svg = mk('svg', { class: 'rbq-map-svg', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'xMidYMid meet', width: '100%' });   // 直接占满宽，别指望 CSS
  const defs = mk('defs');
  const glow = mk('filter', { id: 'rbq-map-glow', x: '-70%', y: '-70%', width: '240%', height: '240%' });
  glow.append(mk('feGaussianBlur', { stdDeviation: '4.5', result: 'b' }));
  const mg = mk('feMerge');
  mg.append(mk('feMergeNode', { in: 'b' }), mk('feMergeNode', { in: 'SourceGraphic' }));
  glow.appendChild(mg);
  defs.appendChild(glow);
  svg.appendChild(defs);

  const root = mk('g', { class: 'rbq-map-root' });
  svg.appendChild(root);

  for (const z of zones) {
    root.appendChild(mk('rect', { x: z.x, y: z.y, width: ZW, height: ZH, rx: 16, class: 'rbq-map-zone' }));
    // 迷雾：盖在区域底图上（道路与地点画在它上面，所以地点依然看得见）
    root.appendChild(mk('rect', { x: z.x, y: z.y, width: ZW, height: ZH, rx: 16, class: 'rbq-map-fog' }));
    const label = mk('text', { x: z.x + 16, y: z.y + 26, class: 'rbq-map-zone-label' });
    label.textContent = `${z.reg}　·　${z.items.length}`;
    root.appendChild(label);
  }

  for (let i = 0; i < zones.length - 1; i++) {
    const a = { x: zones[i].x + ZW / 2, y: zones[i].y + ZH / 2 };
    const b = { x: zones[i + 1].x + ZW / 2, y: zones[i + 1].y + ZH / 2 };
    root.appendChild(mk('path', {
      d: `M ${a.x} ${a.y} Q ${(a.x + b.x) / 2} ${(a.y + b.y) / 2 - 70} ${b.x} ${b.y}`,
      class: 'rbq-map-longroad',
    }));
  }

  const hereZone = zones.find((z) => z.items.some((r) => cell(r, C.name) === here));
  for (const z of zones) {
    const pts = z.items.map((r) => placed.get(cell(r, C.name))).filter(Boolean);
    if (pts.length < 2) continue;
    if (z === hereZone) {
      const me = placed.get(here);
      for (const p of pts) if (p !== me) root.appendChild(mk('line', { x1: me.x, y1: me.y, x2: p.x, y2: p.y, class: 'rbq-map-road' }));
    } else {
      root.appendChild(mk('path', { d: pts.map((p, i) => `${i ? 'L' : 'M'} ${p.x} ${p.y}`).join(' '), class: 'rbq-map-trail' }));
    }
  }

  const nodeEls = new Map();
  for (const [nm, p] of placed) {
    const isHere = nm === here;
    const g = mk('g', { class: `rbq-map-poi${isHere ? ' rbq-map-poi-here' : ''}`, style: 'cursor:pointer' });
    if (isHere) {
      g.appendChild(mk('circle', { cx: p.x, cy: p.y, r: 21, class: 'rbq-map-pulse' }));
      g.appendChild(mk('circle', { cx: p.x, cy: p.y, r: 14, class: 'rbq-map-pulse rbq-map-pulse-b' }));
    }
    g.appendChild(mk('circle', { cx: p.x, cy: p.y, r: isHere ? 15 : 11, class: 'rbq-map-node', filter: isHere ? 'url(#rbq-map-glow)' : '' }));
    const icon = mk('text', { x: p.x, y: p.y + 5, class: 'rbq-map-icon' });
    icon.textContent = poiIcon(p.row);
    g.appendChild(icon);
    const label = mk('text', { x: p.x, y: p.y + (isHere ? 35 : 28), class: `rbq-map-label${isHere ? ' rbq-map-label-here' : ''}` });
    label.textContent = nm;
    g.appendChild(label);
    const title = mk('title');
    title.textContent = [nm, cell(p.row, C.region), cell(p.row, C.func), cell(p.row, C.security)].filter(Boolean).join(' · ');
    g.appendChild(title);
    g.addEventListener('click', () => {
      state.selected = nm;
      for (const [, n2] of nodeEls) n2.classList.remove('rbq-map-poi-sel');
      g.classList.add('rbq-map-poi-sel');
      renderDetail();
    });
    nodeEls.set(nm, g);
    root.appendChild(g);
  }

  /* ---------------- 缩放 / 平移 ---------------- */
  const applyView = () => root.setAttribute('transform', `translate(${state.panX} ${state.panY}) scale(${state.zoom})`);
  applyView();
  let drag = null;
  svg.addEventListener('mousedown', (e) => { drag = { x: e.clientX, y: e.clientY, px: state.panX, py: state.panY }; });
  svg.addEventListener('mousemove', (e) => {
    if (!drag) return;
    state.panX = drag.px + (e.clientX - drag.x);
    state.panY = drag.py + (e.clientY - drag.y);
    applyView();
  });
  window.addEventListener('mouseup', () => { drag = null; });
  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    state.zoom = Math.max(0.45, Math.min(3, state.zoom * (e.deltaY > 0 ? 0.9 : 1.1)));
    applyView();
  }, { passive: false });

  /* ---------------- 详情 ---------------- */
  const detail = el('div', { class: 'rbq-map-detail' });
  function renderDetail() {
    detail.textContent = '';
    const nm = state.selected;
    const p = placed.get(nm);
    if (!p) { detail.appendChild(el('div', { class: 'rbq-hint', text: '点地图上的地点看详情。' })); return; }
    const r = p.row;
    const isHere = nm === here;
    const assets = cell(r, C.assets).split(/[/、,，]/).map((s) => s.trim()).filter(Boolean);
    const clues = cell(r, C.clues);
    detail.append(
      el('div', { class: 'rbq-map-detail-head' }, [
        el('span', { class: 'rbq-map-detail-icon', text: poiIcon(r) }),
        el('div', { style: 'min-width:0' }, [
          el('div', { class: 'rbq-map-detail-title' }, [
            el('strong', { text: nm }),
            isHere ? el('span', { class: 'rbq-badge rbq-ok', text: '你在这里' }) : null,
          ]),
          el('div', { class: 'rbq-hint', text: [cell(r, C.region), cell(r, C.func)].filter(Boolean).join(' · ') }),
        ]),
      ]),
      el('dl', { class: 'rbq-kv' }, [
        el('dt', { text: '规模' }), el('dd', { text: cell(r, C.scale) || '—' }),
        el('dt', { text: '警戒' }), el('dd', { text: cell(r, C.security) || '—' }),
        el('dt', { text: '归属' }), el('dd', { text: cell(r, C.owner) || '—' }),
        el('dt', { text: '状态' }), el('dd', { text: cell(r, C.damage) || '—' }),
      ]),
      cell(r, C.decor) ? el('div', { class: 'rbq-map-detail-decor', text: cell(r, C.decor) }) : null,
      assets.length ? el('div', { class: 'rbq-chips' }, assets.map((a) => el('span', { class: 'rbq-chip', text: a }))) : null,
      clues ? el('details', { class: 'rbq-spoiler' }, [
        el('summary', { text: '线索（剧透）' }),
        el('div', { class: 'rbq-hint', text: clues }),
      ]) : null,
    );
  }
  renderDetail();

  /* ---------------- 组装 ---------------- */
  const tool = el('div', { class: 'rbq-viewbar' }, [
    el('span', { class: 'rbq-hint', text: `${list.length} 个地点 · ${regions.length} 个区域` }),
    el('span', { class: 'rbq-spacer' }),
    here ? el('span', { class: 'rbq-badge rbq-ok', text: `📍 ${here}` }) : el('span', { class: 'rbq-badge rbq-warn', text: '未记录当前位置' }),
    el('button', {
      class: 'rbq-btn', text: '回到当前位置',
      onclick: () => {
        const p = placed.get(here);
        if (!p) return;
        state.zoom = 1.7;
        state.panX = W / 2 - state.zoom * p.x;   // 修正：变换是 translate(pan) scale(zoom) → 应为 中心 - zoom*p（原来写成除法）
        state.panY = H / 2 - state.zoom * p.y;
        applyView();
      },
    }),
    el('button', { class: 'rbq-btn', text: '复位', onclick: () => { state.zoom = 1; state.panX = 0; state.panY = 0; applyView(); } }),
  ]);
  host.append(tool, el('div', { class: 'rbq-map-layout' }, [el('div', { class: 'rbq-map-wrap' }, [svg]), detail]));
  host.appendChild(el('div', { class: 'rbq-hint', text: '滚轮缩放 · 拖动平移 · 点图标看详情。虚线＝跨区域长路，细线＝同区域内已知通路，脉冲＝你当前所在。' }));
}
