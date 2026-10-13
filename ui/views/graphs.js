/**
 * graphs.js —— 图形化的五个视口（任务看板 / 技能轮盘 / 威胁牌 / 阵营图 / 年代带）
 *
 * 原则：**不再用卡片网格**。每一种数据配一种"形状"：
 *   任务 → 看板（三列泳道 + 进度环）
 *   技能 → 轮盘（SVG 放射布局，按流派分环，点开细节）
 *   敌人 → 威胁牌（大血条 + 威胁度条，按血量排序）
 *   势力 → 阵营图（你为中心的星形图，友好/敌对分色）
 *   纪事 → 年代带（横向时间轴 + 上下交错的事件卡）
 */

import * as store from '../../core/store.js';
import { getTable } from '../../core/schema.js';
import { resolveAttr } from '../../core/alias.js';

const NS = 'http://www.w3.org/2000/svg';
const rowsOf = (no) => store.getRows(no, { create: false });
const s = (v) => String(v ?? '').trim();
const numOf = (v) => { const n = Number(s(v).replace(/[^\d.-]/g, '')); return Number.isFinite(n) ? n : 0; };
const mk = (tag, attrs = {}) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
};

function get(no, row, name) {
  const t = getTable(no);
  if (!t || !row) return '';
  const hit = resolveAttr(no, name);
  let i = hit ? hit.index : -1;
  if (i < 0) i = t.columns.findIndex((c) => c === name || c.includes(name) || name.includes(c));
  return i < 0 ? '' : s(row[i]);
}
const nonEmpty = (list) => list.filter((r) => (r ?? []).some((c) => s(c)));

/* ============================================================ 任务看板 */

/** 进度环（SVG） */
function progressRing(done, total, size = 34) {
  const svg = mk('svg', { viewBox: '0 0 36 36', class: 'rbq-ring', width: size, height: size });
  const pct = total > 0 ? Math.max(0, Math.min(1, done / total)) : 0;
  svg.appendChild(mk('circle', { cx: 18, cy: 18, r: 15, class: 'rbq-ring-bg' }));
  const c = mk('circle', { cx: 18, cy: 18, r: 15, class: 'rbq-ring-fg' });
  const len = 2 * Math.PI * 15;
  c.setAttribute('stroke-dasharray', `${(len * pct).toFixed(1)} ${len.toFixed(1)}`);
  c.setAttribute('transform', 'rotate(-90 18 18)');
  svg.appendChild(c);
  const t = mk('text', { x: 18, y: 21.5, class: 'rbq-ring-text' });
  t.textContent = total > 0 ? `${Math.round(pct * 100)}` : '—';
  svg.appendChild(t);
  return svg;
}

export function renderQuestBoard(host, api) {
  const { el } = api;
  host.textContent = '';
  const list = nonEmpty(rowsOf(7)).filter((r) => get(7, r, 'name') || s(r[0]));
  if (!list.length) {
    host.appendChild(el('div', { class: 'rbq-empty', text: '还没有任务。' }));
    return;
  }

  const LANES = [
    ['active', '进行中', /进行|推进|active|探索/],
    ['paused', '搁置 / 待办', /暂停|搁置|未开始|待/],
    ['done', '已完成 / 失败', /完成|已结|失败|作废|违约/],
  ];
  const buckets = { active: [], paused: [], done: [] };
  for (const r of list) {
    const st = get(7, r, '推进状态');
    const hit = LANES.find(([, , re]) => re.test(st));
    buckets[hit ? hit[0] : 'active'].push(r);
  }

  const board = el('div', { class: 'rbq-kanban' });
  for (const [key, label] of LANES) {
    const items = buckets[key];
    const lane = el('div', { class: `rbq-lane rbq-lane-${key}` }, [
      el('div', { class: 'rbq-lane-head' }, [
        el('span', { class: 'rbq-lane-title', text: label }),
        el('span', { class: 'rbq-lane-count', text: String(items.length) }),
      ]),
    ]);
    for (const r of items) {
      const name = get(7, r, '任务名称') || get(7, r, 'name') || s(r[0]);
      const cat = get(7, r, '行动类别');
      const progress = get(7, r, '推进状态');
      const deadline = get(7, r, '过期死线');
      const goal = get(7, r, '物理目标');
      const members = get(7, r, '挂载角色');
      const m = progress.match(/(\d+)\s*[/／]\s*(\d+)/);
      lane.appendChild(el('div', { class: 'rbq-qcard' }, [
        el('div', { class: 'rbq-qcard-top' }, [
          progressRing(m ? Number(m[1]) : 0, m ? Number(m[2]) : 0),
          el('div', { class: 'rbq-qcard-body' }, [
            el('div', { class: 'rbq-qcard-name', text: name }),
            el('div', { class: 'rbq-qcard-meta' }, [cat, deadline ? `期限 ${deadline}` : ''].filter(Boolean).join(' · ')),
          ]),
        ]),
        goal ? el('div', { class: 'rbq-qcard-goal', text: goal }) : null,
        members ? el('div', { class: 'rbq-chips' }, s(members).split(/[/、,，]/).map((x) => x.trim()).filter(Boolean).map((x) => el('span', { class: 'rbq-chip', text: x }))) : null,
      ]));
    }
    if (!items.length) lane.appendChild(el('div', { class: 'rbq-lane-empty', text: '空' }));
    board.appendChild(lane);
  }
  host.appendChild(board);
}

/* ============================================================ 技能轮盘 */

export function renderSkillWheel(host, api) {
  const { el } = api;
  host.textContent = '';
  const list = nonEmpty(rowsOf(10)).filter((r) => get(10, r, 'name') || s(r[0]));
  if (!list.length) {
    host.appendChild(el('div', { class: 'rbq-empty', text: '还没有技能档案。' }));
    return;
  }

  const state = (api.state.wheel ??= { selected: s(list[0][0]), source: 'all' });
  const sources = [...new Set(list.map((r) => get(10, r, '觉醒溯源')).filter(Boolean))];
  let shown = state.source === 'all' ? list : list.filter((r) => get(10, r, '觉醒溯源') === state.source);

  const bar = el('div', { class: 'rbq-viewbar' }, [
    el('span', { class: 'rbq-hint', text: `${shown.length} 个技能` }),
    el('span', { class: 'rbq-spacer' }),
    el('span', { class: 'rbq-hint', text: '流派' }),
    (() => {
      const sel = el('select', { class: 'rbq-select' }, [el('option', { value: 'all', text: '全部流派' }), ...sources.map((x) => el('option', { value: x, text: x }))]);
      sel.value = state.source;
      sel.addEventListener('change', () => {
        state.source = sel.value;
        // 局部更新：只重建【节点层】+ 详情 + 两处计数（轮盘外环/工具栏不动 → 不闪）
        try {
          shown = state.source === 'all' ? list : list.filter((r) => get(10, r, '觉醒溯源') === state.source);
          // 视图渲染在离屏 stage 里，提交后 stage 已空 → 必须取"当前真实容器"
          const lh = (host && host.isConnected) ? host : (document.querySelector('#rbq-panel .rbq-hud-vbody') || host);
          const cnt = lh.querySelector('.rbq-viewbar .rbq-hint');
          if (cnt) cnt.textContent = shown.length + " 个技能";
          core.textContent = shown.length + " 技能";
          refillNodes();
          showDetail(shown.find((r) => (get(10, r, '技能名称') || s(r[0])) === state.selected) ?? shown[0]);
        } catch (e) { try { api.rerender(); } catch (e2) { /* ignore */ } }
      });
      return sel;
    })(),
  ]);

  const W = 560; const H = 420; const cx = W / 2; const cy = H / 2;
  const svg = mk('svg', { class: 'rbq-wheel-svg', viewBox: `0 0 ${W} ${H}`, width: '100%' });
  svg.appendChild(mk('circle', { cx, cy, r: 52, class: 'rbq-wheel-core' }));
  addGraphDefs(svg);
  svg.appendChild(mk('circle', { cx, cy, r: 66, class: 'rbq-wheel-outer', fill: 'url(#rbq-gold-soft)' }));
  svg.appendChild(mk('circle', { cx, cy, r: 52, class: 'rbq-wheel-rim', stroke: 'url(#rbq-gold-grad)' }));
  for (let i = 0; i < 24; i++) {
    const a = (Math.PI * 2 * i) / 24;
    const r1 = i % 6 === 0 ? 56 : 59;
    svg.appendChild(mk('line', {
      x1: cx + Math.cos(a) * r1, y1: cy + Math.sin(a) * r1,
      x2: cx + Math.cos(a) * 64, y2: cy + Math.sin(a) * 64,
      class: i % 6 === 0 ? 'rbq-wheel-tick rbq-wheel-tick-major' : 'rbq-wheel-tick',
    }));
  }
  const emblem = mk('text', { x: cx, y: cy - 6, class: 'rbq-wheel-emblem', 'text-anchor': 'middle' });
  emblem.textContent = '技';
  svg.appendChild(emblem);
  const core = mk('text', { x: cx, y: cy + 16, class: 'rbq-wheel-core-text' });
  core.textContent = `${shown.length} 技能`;
  svg.appendChild(core);

  const detail = el('div', { class: 'rbq-wheel-detail' });
  // 重新按当前 state.selected 填充详情（点节点时只重建这一块 → 不闪）
  const fillWheelDetail = () => {
    // 直接复用原本的详情构建（之前这里只重建了标题，把详情内容弄丢了）
    try {
      // 用作用域内的 list（原来引用了不存在的 t10 → 每次点节点都抛错 → 回退整块重绘 → 闪）
      const r2 = list.find((rr) => (get(10, rr, '技能名称') || get(10, rr, 'name') || s(rr[0])) === state.selected) || list[0];
      if (r2) showDetail(r2);
    } catch (e) { try { api.rerender(); } catch (e2) { /* ignore */ } }
  };
  const showDetail = (r) => {
    detail.textContent = '';
    const t = getTable(10);
    if (!r) { detail.appendChild(el('div', { class: 'rbq-hint', text: '点轮盘上的技能看细节。' })); return; }
    detail.appendChild(el('div', { class: 'rbq-wheel-detail-title', text: get(10, r, '技能名称') }));
    const dl = el('dl', { class: 'rbq-kv' });
    t.columns.forEach((c, i) => { const v = s(r[i]); if (v && i > 0) dl.append(el('dt', { text: c }), el('dd', { text: v })); });
    detail.appendChild(dl);
  };

  /* 节点层：流派分环 + 技能节点（抽成函数 —— 换流派时只重建这一层，不动外环/工具栏 → 不闪） */
  function refillNodes() {
    try { for (const old of svg.querySelectorAll('.rbq-wheel-layer')) old.remove(); } catch (e) { /* ignore */ }
    const layer = mk('g', { class: 'rbq-wheel-layer' });
  const bySource = new Map();
  for (const r of shown) {
    const src = get(10, r, '觉醒溯源') || '未归类';
    if (!bySource.has(src)) bySource.set(src, []);
    bySource.get(src).push(r);
  }
  const srcList = [...bySource.keys()];
  srcList.forEach((src, ring) => {
    const items = bySource.get(src);
    const R = 106 + ring * 62;
    // 这个流派的环：一段金色弧 + 流派名（放在弧的左端上方）
    const a0 = -Math.PI * 0.5 - Math.PI * 0.78;
    const a1 = -Math.PI * 0.5 + Math.PI * 0.78;
    layer.appendChild(mk('path', { d: arcPath(cx, cy, R, a0, a1), class: 'rbq-wheel-arc', fill: 'none' }));
    const rl = mk('text', { x: cx + Math.cos(a0) * R, y: cy + Math.sin(a0) * R - 8, class: 'rbq-wheel-ring-label', 'text-anchor': 'middle' });
    rl.textContent = (String(String(src ?? '通用') || "").length > 8 ? String(String(src ?? '通用') || "").slice(0, 8) + "…" : String(src ?? '通用'));
    layer.appendChild(rl);
    items.forEach((r, k) => {
      const ang = (Math.PI * 2 * k) / items.length + (ring * Math.PI) / 6 - Math.PI / 2;
      const x = cx + Math.cos(ang) * R;
      const y = cy + Math.sin(ang) * R;
      const name = get(10, r, '技能名称') || get(10, r, 'name') || s(r[0]);
      const g = mk('g', { class: `rbq-wheel-node${state.selected === name ? ' rbq-sel' : ''}`, style: 'cursor:pointer' });
      g.appendChild(mk('line', { x1: cx, y1: cy, x2: x, y2: y, class: 'rbq-wheel-spoke' }));
      g.appendChild(mk('circle', { cx: x, cy: y, r: 19, class: 'rbq-wheel-dot' }));
    const ini = mk('text', { x, y: y + 4, class: 'rbq-wheel-initial', 'text-anchor': 'middle' });
    ini.textContent = String(name ?? '?').slice(0, 1);
    g.appendChild(ini);
      const label = mk('text', { x, y: y + 34, class: 'rbq-wheel-label' });
      // 长技能名直接画会变成一长条竖排文字（与别的标签叠在一起）→ 截断 + 悬停看全名
      const full = String(name || "");
      label.textContent = full.length > 6 ? (full.slice(0, 6) + "…") : full;
      g.appendChild(label);
      const title = mk('title');
      title.textContent = [name, get(10, r, '检定类型'), src, get(10, r, 'CD冷却')].filter(Boolean).join(' · ');
      g.appendChild(title);
      g.addEventListener('click', () => {
        state.selected = name;
        try {
          // 只改类名 + 只重建详情（不整视图重绘 → 不闪）
          for (const n2 of svg.querySelectorAll('.rbq-wheel-node')) n2.classList.remove('rbq-sel');
          g.classList.add('rbq-sel');
          fillWheelDetail();
        } catch (e) { api.rerender(); }
      });   // 点节点切换详情
      layer.appendChild(g);
    });
  });
    svg.appendChild(layer);
  }
  refillNodes();

  showDetail(shown.find((r) => (get(10, r, '技能名称') || s(r[0])) === state.selected) ?? shown[0]);
  host.append(bar, el('div', { class: 'rbq-wheel-layout' }, [el('div', { class: 'rbq-wheel-wrap' }, [svg]), detail]));
}

/* ============================================================ 威胁牌 */


/** 统一的 SVG defs：金色渐变 + 光晕（三个图形视口共用） */
function addGraphDefs(svg) {
  if (!svg || svg.querySelector('defs[data-rbq]')) return;
  const defs = mk('defs', { 'data-rbq': '1' });
  const grad = mk('linearGradient', { id: 'rbq-gold-grad', x1: '0', y1: '0', x2: '1', y2: '1' });
  grad.appendChild(mk('stop', { offset: '0%', 'stop-color': '#d8c096' }));
  grad.appendChild(mk('stop', { offset: '100%', 'stop-color': '#8a7550' }));
  defs.appendChild(grad);
  const soft = mk('radialGradient', { id: 'rbq-gold-soft' });
  soft.appendChild(mk('stop', { offset: '0%', 'stop-color': 'rgba(194,168,120,0.45)' }));
  soft.appendChild(mk('stop', { offset: '100%', 'stop-color': 'rgba(194,168,120,0)' }));
  defs.appendChild(soft);
  const glow = mk('filter', { id: 'rbq-gold-glow', x: '-50%', y: '-50%', width: '200%', height: '200%' });
  glow.appendChild(mk('feGaussianBlur', { stdDeviation: '3', result: 'b' }));
  const merge = mk('feMerge');
  merge.appendChild(mk('feMergeNode', { in: 'b' }));
  merge.appendChild(mk('feMergeNode', { in: 'SourceGraphic' }));
  glow.appendChild(merge);
  defs.appendChild(glow);
  svg.insertBefore(defs, svg.firstChild);
}
/** 画一段圆弧（流派分环用） */
function arcPath(cx, cy, r, a0, a1) {
  const p0 = { x: cx + Math.cos(a0) * r, y: cy + Math.sin(a0) * r };
  const p1 = { x: cx + Math.cos(a1) * r, y: cy + Math.sin(a1) * r };
  const large = Math.abs(a1 - a0) > Math.PI ? 1 : 0;
  return `M ${p0.x} ${p0.y} A ${r} ${r} 0 ${large} 1 ${p1.x} ${p1.y}`;
}

export function renderThreats(host, api) {
  const { el } = api;
  host.textContent = '';
  const list = nonEmpty(rowsOf(14)).filter((r) => get(14, r, 'name') || s(r[0]));
  if (!list.length) {
    host.appendChild(el('div', { class: 'rbq-empty', text: '场上没有敌人。' }));
    return;
  }

  const state = (api.state.threats ??= { hideDead: true });
  const bar = el('div', { class: 'rbq-viewbar' }, [
    el('span', { class: 'rbq-hint', text: '隐藏已击败 / 已消失' }),
    (() => {
      const i = el('input', { type: 'checkbox', ...(state.hideDead ? { checked: true } : {}) });
      i.addEventListener('change', () => { state.hideDead = i.checked; fillBoard(); });
      return el('label', { class: 'rbq-switch' }, [i, el('span', { class: 'rbq-knob' })]);
    })(),
  ]);

  const board = el('div', { class: 'rbq-threats' });
  /* 铺威胁牌（抽成函数：切“隐藏已击败”时只重建这一块 → 不闪） */
  function fillBoard() {
  const alive = list.filter((r) => !state.hideDead || !/defeated|fled|despawned|已击败|已逃跑|已消失/.test(get(14, r, '状态')));
  // 威胁度：血量百分比 × 攻击力 → 排序
  const scored = alive.map((r) => {
    const hp = numOf(get(14, r, 'HP(当前)'));
    const mhp = numOf(get(14, r, 'HP(上限)')) || 1;
    const atk = numOf(get(14, r, '物理攻击(ATK)'));
    return { r, hp, mhp, atk, threat: (hp / mhp) * (atk || 1) };
  }).sort((a, b) => b.threat - a.threat);
  const maxThreat = Math.max(1, ...scored.map((x) => x.threat));

    try { board.textContent = ''; } catch (e) { /* ignore */ }
  for (const { r, hp, mhp, atk, threat } of scored) {
    const name = get(14, r, '实体名称') || s(r[0]);
    const lv = get(14, r, '等级');
    const st = get(14, r, '状态');
    const pct = Math.max(0, Math.min(100, Math.round((hp / mhp) * 100)));
    const danger = pct > 60 ? 'rbq-danger-high' : pct > 25 ? 'rbq-danger-mid' : 'rbq-danger-low';
    const chips = ['物理防御(DEF)', '魔法攻击(MATK)', '速度(AGI)']
      .map((k) => (get(14, r, k) ? `${k.replace(/\(.*\)/, '')} ${get(14, r, k)}` : '')).filter(Boolean);
    board.appendChild(el('div', { class: `rbq-threat ${danger}` }, [
      el('div', { class: 'rbq-threat-head' }, [
        el('span', { class: 'rbq-threat-name', text: name }),
        lv ? el('span', { class: 'rbq-badge', text: s(lv) }) : null,
        st ? el('span', { class: `rbq-badge ${/active/.test(st) ? 'rbq-danger' : ''}`, text: st }) : null,
      ]),
      el('div', { class: 'rbq-threat-hp' }, [
        el('span', { class: 'rbq-threat-hp-fill', style: `width:${pct}%` }),
        el('span', { class: 'rbq-threat-hp-text', text: `${hp} / ${mhp}` }),
      ]),
      el('div', { class: 'rbq-threat-meter', title: '威胁度（血量比例 × 攻击力，横向对比）' }, [
        el('span', { style: `width:${Math.round((threat / maxThreat) * 100)}%` }),
      ]),
      chips.length ? el('div', { class: 'rbq-chips' }, chips.map((c) => el('span', { class: 'rbq-chip', text: c }))) : null,
      get(14, r, '简要描述') ? el('div', { class: 'rbq-hint', text: get(14, r, '简要描述') }) : null,
      get(14, r, '掉落物品') ? el('div', { class: 'rbq-chips' }, s(get(14, r, '掉落物品')).split(/[/、,，]/).map((x) => x.trim()).filter(Boolean).map((x) => el('span', { class: 'rbq-chip rbq-chip-warn', text: `🎁 ${x}` }))) : null,
    ]));
  }
  }
  fillBoard();
  host.append(bar, board);
}

/* ============================================================ 阵营图 */

export function renderFactionWeb(host, api) {
  const { el } = api;
  host.textContent = '';
  const list = nonEmpty(rowsOf(11)).filter((r) => s(r[0]));
  if (!list.length) {
    host.appendChild(el('div', { class: 'rbq-empty', text: '还没有势力/法则。' }));
    return;
  }

  const state = (api.state.web ??= { selected: s(list[0][0]) });
  const tone = (v) => {
    const x = s(v);
    if (/友好|同盟|亲密|友善|合作/.test(x)) return { cls: 'rbq-ally', color: '#3fb950' };
    if (/敌对|仇视|通缉|战争|紧张/.test(x)) return { cls: 'rbq-enemy', color: '#f85149' };
    if (/中立|观望|未知/.test(x)) return { cls: 'rbq-neutral', color: '#8b93a7' };
    return { cls: 'rbq-neutral', color: '#d29922' };
  };

  const W = 620; const H = 420; const cx = W / 2; const cy = H / 2;
  const svg = mk('svg', { class: 'rbq-web-svg', viewBox: `0 0 ${W} ${H}` });
  svg.appendChild(mk('circle', { cx, cy, r: 34, class: 'rbq-web-me' }));
  addGraphDefs(svg);
  svg.appendChild(mk('circle', { cx, cy, r: 44, class: 'rbq-web-ring', stroke: 'url(#rbq-gold-grad)' }));
  const meT = mk('text', { x: cx, y: cy + 5, class: 'rbq-web-me-text', 'text-anchor': 'middle' });
  meT.textContent = '你';
  svg.appendChild(meT);
  const me = mk('text', { x: cx, y: cy + 5, class: 'rbq-web-me-text' });
  me.textContent = '你';
  svg.appendChild(me);

  const detail = el('div', { class: 'rbq-web-detail' });
  const showDetail = (r) => {
    detail.textContent = '';
    if (!r) { detail.appendChild(el('div', { class: 'rbq-hint', text: '点网上的势力看细节。' })); return; }
    const t = getTable(11);
    detail.appendChild(el('div', { class: 'rbq-wheel-detail-title', text: s(r[0]) }));
    const dl = el('dl', { class: 'rbq-kv' });
    t.columns.forEach((c, i) => { const v = s(r[i]); if (v && i > 0) dl.append(el('dt', { text: c }), el('dd', { text: v })); });
    detail.appendChild(dl);
  };

  const R = 150;
  list.forEach((r, i) => {
    const name = s(r[0]);
    const hostile = get(11, r, '敌对关联');
    const { color, cls } = tone(hostile);
    const ang = (Math.PI * 2 * i) / list.length - Math.PI / 2;
    const x = cx + Math.cos(ang) * R;
    const y = cy + Math.sin(ang) * R;
    svg.appendChild(mk('line', { x1: cx, y1: cy, x2: x, y2: y, class: `rbq-web-edge ${cls}` }));
    const g = mk('g', { class: `rbq-web-node${state.selected === name ? ' rbq-sel' : ''}`, style: 'cursor:pointer' });
    g.appendChild(mk('circle', { cx: x, cy: y, r: 22, class: 'rbq-web-dot', stroke: color }));
    const label = mk('text', { x, y: y + 38, class: 'rbq-web-label' });
    label.textContent = (String(name || "").length > 6 ? String(name || "").slice(0, 6) + "…" : name);
    g.appendChild(label);
    const sub = mk('text', { x, y: y + 51, class: 'rbq-web-sub', fill: color });
    sub.textContent = hostile || '';
    g.appendChild(sub);
    /* __webClick：点节点切换右侧详情（之前没有绑定 → 点了没反应） */
    g.addEventListener('click', () => {
      state.selected = name;
      try { showDetail(list.find((r) => s(r[0]) === name) ?? list[0]); } catch (e) { try { api.rerender(); } catch (e2) { /* ignore */ } }
    });
    svg.appendChild(g);
  });

  showDetail(list.find((r) => s(r[0]) === state.selected) ?? list[0]);
  host.append(
    el('div', { class: 'rbq-viewbar' }, [
      el('span', { class: 'rbq-hint', text: `${list.length} 个势力 / 法则` }),
      el('span', { class: 'rbq-spacer' }),
      el('span', { class: 'rbq-badge rbq-ok', text: '友好' }),
      el('span', { class: 'rbq-badge rbq-danger', text: '敌对' }),
      el('span', { class: 'rbq-badge', text: '中立' }),
    ]),
    el('div', { class: 'rbq-wheel-layout' }, [el('div', { class: 'rbq-wheel-wrap' }, [svg]), detail]),
  );
}

/* ============================================================ 年代带 */

export function renderEraTimeline(host, api) {
  const { el } = api;
  host.textContent = '';
  const list = nonEmpty(rowsOf(12)).filter((r) => s(r[0]));
  if (!list.length) {
    host.appendChild(el('div', { class: 'rbq-empty', text: '还没有纪事。' }));
    return;
  }

  const wrap = el('div', { class: 'rbq-era' });
  const band = el('div', { class: 'rbq-era-band' });
  list.forEach((r, i) => {
    const name = get(12, r, '纪元封包名') || s(r[0]);
    const span = get(12, r, '时间轴区间');
    const node = el('div', { class: 'rbq-era-seg', style: `flex:${Math.max(1, Math.round(100 / list.length))}` }, [
      el('span', { class: 'rbq-era-idx', text: String(i + 1) }),
      el('div', { class: 'rbq-era-idx-body' }, [
        el('div', { class: 'rbq-era-name', text: name }),
        el('div', { class: 'rbq-era-span', text: span || '—' }),
      ]),
    ]);
    band.appendChild(node);
  });
  wrap.appendChild(band);

  const cards = el('div', { class: 'rbq-era-cards' });
  list.forEach((r, i) => {
    const summary = get(12, r, '剧情压缩');
    const deaths = get(12, r, '死亡名单');
    const faction = get(12, r, '派系崩塌与格局重构');
    const emotion = get(12, r, '情感质变');
    const suspense = get(12, r, '继承悬念');
    const route = get(12, r, '地理迁徙路线');
    const card = el('div', { class: `rbq-era-card${i % 2 ? ' rbq-era-card-alt' : ''}` }, [
      el('div', { class: 'rbq-era-card-head' }, [
        el('span', { class: 'rbq-badge', text: `第 ${i + 1} 段` }),
        route ? el('span', { class: 'rbq-badge rbq-info', text: route }) : null,
      ]),
      summary ? el('div', { class: 'rbq-era-summary', text: summary }) : null,
      el('div', { class: 'rbq-chips' }, [
        deaths ? el('span', { class: 'rbq-chip rbq-chip-warn', text: `☠ ${deaths}` }) : null,
        faction ? el('span', { class: 'rbq-chip', text: `🏛 ${faction}` }) : null,
        emotion ? el('span', { class: 'rbq-chip', text: `❤ ${emotion}` }) : null,
        suspense ? el('span', { class: 'rbq-chip rbq-chip-warn', text: `❓ ${suspense}` }) : null,
      ].filter(Boolean)),
    ]);
    cards.appendChild(card);
  });
  wrap.appendChild(cards);
  host.appendChild(wrap);
  host.appendChild(el('div', { class: 'rbq-hint', text: '从左到右按顺序；下面的事件卡与上面的分段一一对应，交替排布以免连成一片。' }));
}
