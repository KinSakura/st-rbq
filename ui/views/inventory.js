/**
 * inventory.js —— 背包与装备（做成"格子"和"纸娃娃"，不是列表）
 *
 * · 背包：像游戏背包一样的方格网。每个格子是一个图标牌，边框颜色＝稀有度，
 *   右下角数量角标，悬停出提示，点开右侧详情。可按类别筛、可搜索。
 * · 装备：一个纸娃娃（人形轮廓 + 部位锚点），装备中的东西贴在对应部位上；
 *   下方才是"背包里还能穿的东西"。
 *
 * 表9 没有"部位"列，部位靠「物理类别」文字推断（见 panels.js 的 slotOf）。
 */

import * as store from '../../core/store.js';
import { getTable } from '../../core/schema.js';
import { slotOf } from './panels.js';

const C = { name: 0, holder: 1, category: 2, amount: 3, volume: 4, rarity: 5, stat: 6, bonus: 7, legality: 8, state: 9, hidden: 10, story: 11 };
const rows = (no) => store.getRows(no, { create: false });
const cell = (r, i) => String(r?.[i] ?? '').trim();
const num = (v) => { const n = Number(String(v ?? '').replace(/[^\d.-]/g, '')); return Number.isFinite(n) ? n : 0; };

const RARITY = [
  [/神器|神话|传说/i, 'legend'],
  [/史诗|epic/i, 'epic'],
  [/稀有|rare/i, 'rare'],
  [/精良|优秀|uncommon/i, 'uncommon'],
  [/普通|common/i, 'common'],
];
const rarityOf = (v) => (RARITY.find(([re]) => re.test(String(v ?? '')))?.[1]) ?? 'common';
const RARITY_CN = { legend: '传说', epic: '史诗', rare: '稀有', uncommon: '精良', common: '普通' };

const CAT_ICON = [
  [/武器|兵器|刀|剑|枪|弓|匕首|锤|斧|杖/, '⚔️'],
  [/防具|护甲|盾|甲|袍|披风|斗篷/, '🛡️'],
  [/饰|戒指|项链|耳|护符|手镯/, '💍'],
  [/药|丹|药剂|回复|绷带|创可贴/, '🧪'],
  [/书|卷轴|文献|笔记|地图/, '📜'],
  [/钥匙|门卡|通行|令牌/, '🔑'],
  [/食|粮|料理|肉|面包/, '🍖'],
  [/材料|素材|矿石|木|皮/, '🪵'],
  [/货币|钱|金币|钻石|银币/, '💰'],
  [/工具|装置|零件|配件/, '🔧'],
  [/通讯|电话|手机|终端/, '📱'],
  [/衣|裤|裙|袜|鞋|上装|下装/, '👕'],
];
const iconOf = (v) => (CAT_ICON.find(([re]) => re.test(String(v ?? '')))?.[1]) ?? '📦';

function statClass(v) {
  const s = String(v ?? '');
  if (/已装备|装备中|正常|完好|是/.test(s)) return 'rbq-ok';
  if (/损毁|损坏|破碎|失效|断裂/.test(s)) return 'rbq-danger';
  if (/磨损|陈旧|不足|待修/.test(s)) return 'rbq-warn';
  return '';
}

/** 耐久 82/100 → 百分比 */
function durabilityPct(v) {
  const m = String(v ?? '').match(/(\d+)\s*\/\s*(\d+)/);
  if (!m) return null;
  const a = Number(m[1]); const b = Number(m[2]);
  return b > 0 ? Math.max(0, Math.min(100, Math.round((a / b) * 100))) : null;
}

/* ============================================================ 背包（方格） */

export function renderInventory(host, api) {
  const { el } = api;
  host.textContent = '';
  const t = getTable(9);
  const all = rows(9).filter((r) => cell(r, C.name));
  if (!t || !all.length) {
    host.appendChild(el('div', { class: 'rbq-empty', text: '背包是空的。' }));
    return;
  }

  const state = (api.state.inv ??= { holder: 'all', cat: 'all', keyword: '', selected: all[0] && cell(all[0], C.name) });
  const holders = [...new Set(all.map((r) => cell(r, C.holder)).filter(Boolean))];
  const cats = [...new Set(all.map((r) => cell(r, C.category).split(/[/／]/)[0]).filter(Boolean))];

  let list = computeList();

  /* 过滤 + 排序（抽成函数；筛选/搜索/归属切换时复用它 → 只重建网格与详情） */
  function computeList() {
    let l = all.slice();
    if (state.holder !== 'all') l = l.filter((r) => cell(r, C.holder) === state.holder);
    if (state.cat !== 'all') l = l.filter((r) => cell(r, C.category).startsWith(state.cat));
    if (state.keyword) l = l.filter((r) => `${cell(r, C.name)}${cell(r, C.category)}${cell(r, C.bonus)}`.includes(state.keyword));
    const ORDER = { legend: 0, epic: 1, rare: 2, uncommon: 3, common: 4 };
    l.sort((a, b) => (ORDER[rarityOf(cell(a, C.rarity))] - ORDER[rarityOf(cell(b, C.rarity))]) || cell(a, C.name).localeCompare(cell(b, C.name)));
    return l;
  }

  /* 工具栏 */
  const holderSel = el('select', { class: 'rbq-select' }, [
    el('option', { value: 'all', text: `全部持有者（${all.length}）` }),
    ...holders.map((h) => el('option', { value: h, text: h })),
  ]);
  holderSel.value = state.holder;
  holderSel.addEventListener("change", () => { state.holder = holderSel.value; rebuildList(); });

  const catBar = el('div', { class: 'rbq-catbar' }, [
    (() => {
      const b = el('button', { class: `rbq-catchip${state.cat === 'all' ? ' rbq-active' : ''}`, text: '全部' });
      b.addEventListener("click", () => { state.cat = "all"; rebuildList(); });
      return b;
    })(),
    ...cats.map((c) => {
      const b = el('button', { class: `rbq-catchip${state.cat === c ? ' rbq-active' : ''}`, text: `${iconOf(c)} ${c}` });
      b.addEventListener("click", () => { state.cat = c; rebuildList(); });
      return b;
    }),
  ]);

  const search = el('input', { class: 'rbq-input', type: 'search', placeholder: '搜索…', style: 'min-width:130px' });
  search.value = state.keyword;
  let timer = null;
  search.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => { state.keyword = search.value.trim(); rebuildList(); }, 260);
  });

  const bar = el('div', { class: 'rbq-viewbar' }, [
    holderSel, search,
    el('span', { class: 'rbq-spacer' }),
    el('span', { class: 'rbq-hint', text: `${list.length} 件` }),
  ]);

  /* 格子 */
  const grid = el('div', { class: 'rbq-invgrid' });
  /* 铺格子（抽成函数，供筛选时局部重建） */
  function fillGrid() {
    try { grid.textContent = ""; } catch (e) { /* ignore */ }
    for (const r of list) {
    const nm = cell(r, C.name);
    const amountRaw = String(cell(r, C.amount) ?? '').trim();
    const qty = /^\d+$/.test(amountRaw) ? num(amountRaw) : 1;   // 只在纯数字时当数量（'1/1' 是耐久，走下面的耐久条）
    const rar = rarityOf(cell(r, C.rarity));
    const pct = durabilityPct(cell(r, C.amount));
    const slot = el('div', { class: `rbq-invslot rbq-r-${rar}${state.selected === nm ? ' rbq-selected' : ''}`, title: `${nm}\n${cell(r, C.category)}\n${cell(r, C.bonus)}` }, [
      el('span', { class: 'rbq-invslot-icon', text: iconOf(cell(r, C.category) || nm) }),
      qty > 1 ? el('span', { class: 'rbq-invslot-qty', text: String(qty) }) : null,
      el('span', { class: 'rbq-invslot-name', text: nm }),
      pct != null ? el('span', { class: `rbq-invslot-bar${pct < 30 ? ' rbq-low' : ''}`, style: `width:${pct}%` }) : null,
      /装备中|已装备/.test(cell(r, C.state)) ? el('span', { class: 'rbq-invslot-worn', text: 'E' }) : null,
    ]);
    // 只切选中样式，不整块重绘（消除闪烁；详情区就地更新）
  // 点物品：只重建右侧【详情】块（左侧网格完全不动 → 零闪烁）
  slot.addEventListener('click', () => {
    state.selected = nm;
    try { state.selHolder = cell(r, C.holder); } catch (e) { /* ignore */ }
    let localOk = false;
    try {
      // 内联求值：视图渲染在离屏 stage 里，提交后 stage 已空 → 必须取"当前真实容器"
      const lh = (host && host.isConnected) ? host : (document.querySelector('#rbq-panel .rbq-hud-vbody') || host);   // 形参名是 host（不是 host）
      for (const s2 of lh.querySelectorAll('.rbq-invslot')) s2.classList.remove('rbq-selected');
      slot.classList.add('rbq-selected');
      const det = lh.querySelector('.rbq-invdetail');
      if (det) { det.replaceChildren(...buildDetail(nm)); localOk = true; }
    } catch (e) {
      try { console.warn('[RBQ] 详情局部更新失败，回退整块重绘：', e); } catch (e2) { /* ignore */ }
    }
    // 保底：只要局部更新没成功，就走整块重绘（宁可闪一下，也绝不"点了没反应"）
    if (!localOk) { try { api.rerender(); } catch (e3) { /* ignore */ } }
  });
      grid.appendChild(slot);
    }
  }
  fillGrid();

  /* 局部重建：筛选/搜索/归属只动【网格 + 详情 + 件数】——工具栏与外壳不动 → 不闪、搜索框不失焦 */
  function rebuildList() {
    try {
      list = computeList();
      fillGrid();
      const lh = (host && host.isConnected) ? host : (document.querySelector('#rbq-panel .rbq-hud-vbody') || host);
      const det = lh.querySelector('.rbq-invdetail');
      if (det) det.replaceChildren(...buildDetail());
      const cnt = lh.querySelector('.rbq-viewbar .rbq-hint');
      if (cnt) cnt.textContent = list.length + " 件";
      // 同步分类按钮的选中高亮（只改类名，不重建节点 → 依然不闪）
      try {
        const cur = state.cat === 'all' ? '全部' : state.cat;
        for (const b2 of lh.querySelectorAll('.rbq-catchip')) {
          const label = String(b2.textContent || '').trim();
          b2.classList.toggle('rbq-active', label === '全部' ? state.cat === 'all' : label.endsWith(state.cat));
        }
      } catch (e) { /* ignore */ }
    } catch (e) { try { api.rerender(); } catch (e2) { /* ignore */ } }
  }

  /* 详情：抽成函数 —— 点物品时只重建这一块（网格不动，不闪） */
  function buildDetail(name) {
  const safe = (fn, dflt = '—') => { try { const v = fn(); return (v === undefined || v === null || v === '') ? dflt : v; } catch (e) { return dflt; } };   // 单个字段出错不再影响整块详情
    const want = name === undefined ? state.selected : name;
    const sel = list.find((r) => cell(r, C.name) === want && (!state.selHolder || cell(r, C.holder) === state.selHolder)) ?? list.find((r) => cell(r, C.name) === want) ?? list[0];
    if (!sel) return [];
    const rar = rarityOf(cell(sel, C.rarity));
    return [
      el('div', { class: `rbq-invdetail-head rbq-r-${rar}` }, [
        el('span', { class: 'rbq-invdetail-icon', text: safe(() => iconOf(cell(sel, C.category) || cell(sel, C.name)), '📦') }),
        el('div', { style: 'min-width:0' }, [
          el('div', { class: 'rbq-tile-title', text: safe(() => cell(sel, C.name), '未知物品') }),
          el('div', { class: 'rbq-hint', text: [safe(() => cell(sel, C.category), ''), (RARITY_CN && RARITY_CN[rar]) || ''].filter(Boolean).join(' · ') }),
        ]),
      ]),
      el('dl', { class: 'rbq-kv' }, [
        el('dt', { text: '持有' }), el('dd', { text: safe(() => cell(sel, C.holder)) }),
        el('dt', { text: '数量/耐久' }), el('dd', { text: safe(() => cell(sel, C.amount)) }),
        el('dt', { text: '伤害/护甲' }), el('dd', { text: safe(() => cell(sel, C.stat)) }),
        el('dt', { text: '合法性' }), el('dd', { text: safe(() => cell(sel, C.legality)) }),
        el('dt', { text: '状态' }), el('dd', {}, [el('span', { class: `rbq-badge ${statClass(cell(sel, C.state))}`, text: safe(() => cell(sel, C.state)) })]),
      ]),
      safe(() => cell(sel, C.bonus), '') ? el('div', { class: 'rbq-invdetail-bonus', text: safe(() => cell(sel, C.bonus), '') }) : null,
      safe(() => cell(sel, C.story), '') ? el('div', { class: 'rbq-hint', text: `剧情绑定：${safe(() => cell(sel, C.story), '')}` }) : null,
      safe(() => cell(sel, C.hidden), '') ? el('details', { class: 'rbq-spoiler' }, [
        el('summary', { text: '隐藏属性（剧透）' }),
        el('div', { class: 'rbq-hint', text: safe(() => cell(sel, C.hidden), '') }),
      ]) : null,
    ];
  }
  const detail = el('div', { class: 'rbq-invdetail' }, buildDetail());

  host.append(bar, catBar, el('div', { class: 'rbq-inv-layout' }, [grid, detail]));
}

/* ========================================================== 装备（纸娃娃） */

/* 穿戴来自**表4 的真实装备列**（表9 没有"部位"这种列，所以不能拿它当槽位） */
/* 表4 列分类：真装备 vs 身体状态（必须在 EQUIP_COLS 之前定义，否则 TDZ 报错） */
const __EQUIP_RE = /装备|持物|外衣|内层|上装|下装|头部|颈部|足部|腿部|裹覆|下肢|主手|副手|饰品|披风|鞋|靴|帽|盔|护甲|武器|手甲|腰|背|肩/;

export function renderEquipment(host, api) {
  const { el } = api;
  host.textContent = '';
  const t4 = getTable(4);
  /* 槽位分栏每次渲染实时计算：模块加载时 schema 可能还没就绪（之前就是因此走了兜底名单，
     导致装备页的「身体状态」小卡是空的）。表4 = 角色即时状态表，混了真装备与身体状态。 */
  const __slots4 = (() => {
    const cols = (t4?.columns ?? []).map((c) => String(c)).filter((c) => c !== '角色名称' && c !== '微观坐标' && c !== '离场状态');
    return cols.length ? cols : ['头部装备', '颈部附加', '上装外衣', '上装内层', '双手持物', '下装外层', '下装内层', '腿部裹覆', '足部', '下肢约束'];
  })();
  const EQUIP_COLS = __slots4.filter((c) => __EQUIP_RE.test(c));
  const __bodySlots = __slots4.filter((c) => !__EQUIP_RE.test(c));
  const __midSlots = EQUIP_COLS.filter((c) => /双手|持物|手持|约束|下肢|腰部|背部/.test(c));
  const __restSlots = EQUIP_COLS.filter((c) => !__midSlots.includes(c));
  const __half = Math.ceil(__restSlots.length / 2);
  const LEFT_SLOTS = __restSlots.slice(0, __half);
  const RIGHT_SLOTS = __restSlots.slice(__half);
  const BODY_SLOTS = __midSlots.map((s2) => ({ slot: s2 }));
  const t9 = getTable(9);
  if (!t4) { host.appendChild(el('div', { class: 'rbq-empty', text: '没有表4（角色即时状态表），无法显示穿戴。' })); return; }
  const i4 = (nm) => t4.columns.indexOf(nm);
  const i9 = (nm) => (t9 ? t9.columns.indexOf(nm) : -1);
  const rows4 = rows(4);
  const people = rows4.map((r) => String(r[i4('角色名称')] ?? '').trim()).filter(Boolean);
  const state = (api.state.equip ??= { who: '' });
  if (!state.who || !people.includes(state.who)) state.who = people[0] ?? '';
  if (!people.length) {
    host.appendChild(el('div', { class: 'rbq-empty', text: '表4 里还没有角色行，所以没有可显示的身穿戴。' }));
    return;
  }
  const row4 = rows4.find((r) => String(r[i4('角色名称')] ?? '').trim() === state.who) ?? null;
  const owned = t9 ? rows(9).filter((r) => i9('当前归属') >= 0 && String(r[i9('当前归属')] ?? '').trim() === state.who) : [];
  const cellDoll = (slot) => (row4 ? String(row4[i4(slot)] ?? '').trim() : '');

  const whoSel = el('select', { class: 'rbq-select' }, people.map((h) => el('option', { value: h, text: h })));
  whoSel.value = state.who;
  const wornCount = EQUIP_COLS.filter((c) => cellDoll(c)).length;
  const bar = el('div', { class: 'rbq-viewbar' }, [
    el('span', { class: 'rbq-hint', text: '看谁' }), whoSel,
    el('span', { class: 'rbq-spacer' }),
    el('span', { class: 'rbq-hint', text: `已穿戴 ${wornCount}/${EQUIP_COLS.length} · 随身物 ${owned.length}` }),
  ]);

  const slotBox = (slot) => {
    const val = cellDoll(slot);
    const m = /^(.+?)[（(](.+?)[)）]\s*$/.exec(val);
    const name = m ? m[1].trim() : val;
    const bonus = m ? m[2].trim() : '';
    return el('div', { class: `rbq-doll-slot${val ? ' rbq-filled' : ''}` }, [
      el('div', { class: 'rbq-doll-slot-label', text: slot }),
      val
        ? el('div', { class: 'rbq-doll-item' }, [
          el('div', { class: 'rbq-doll-item-main' }, [
            el('div', { class: 'rbq-doll-item-name', text: name }),
            bonus ? el('div', { class: 'rbq-hint', text: bonus }) : null,
          ]),
        ])
        : el('div', { class: 'rbq-doll-empty', text: '空' }),
    ]);
  };

  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 200 400');
  svg.setAttribute('class', 'rbq-doll-svg');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', [
    'M100 22 a20 20 0 1 1 0.1 0 Z',
    'M72 70 q28 -16 56 0 l8 62 q-36 12 -72 0 Z',
    'M72 70 l-20 56 6 74 14 2 6 -66',
    'M128 70 l20 56 -6 74 -14 2 -6 -66',
    'M78 136 l-8 96 12 78 16 -2 4 -74',
    'M122 136 l8 96 -12 78 -16 -2 -4 -74',
  ].join(' '));
  path.setAttribute('class', 'rbq-doll-body');
  svg.appendChild(path);

  const body = el('div', { class: 'rbq-doll-bodywrap' }, [svg]);
  for (const b of BODY_SLOTS) body.appendChild(el('div', { class: 'rbq-doll-marker', style: `top:${b.y}px` }, [slotBox(b.slot)]));

  const doll = el('div', { class: 'rbq-doll' }, [
    el('div', { class: 'rbq-doll-col' }, LEFT_SLOTS.map(slotBox)),
    body,
    el('div', { class: 'rbq-doll-col' }, RIGHT_SLOTS.map(slotBox)),
  ]);
  host.append(bar, doll);
  /* 表4 里不属于装备的列（身体状态）—— 装备页只做一览，详情在角色卡的「身体状态」区块 */
  if (__bodySlots.length) {
    try {
      host.appendChild(el('div', { class: 'rbq-card rbq-bodybox' }, [
        el('h4', { text: '身体状态（表4 非装备列）' }),
        el('div', { class: 'rbq-chips' }, __bodySlots.map((c) => el('span', { class: 'rbq-chip', text: `${c}：${String(cellDoll(c) || '—')}` }))),
      ]));
    } catch (e) { try { console.warn('[RBQ] 身体状态小卡渲染失败：', e); } catch (e2) { /* ignore */ } }
  }

  if (owned.length) {
    host.appendChild(el('h4', { class: 'rbq-section', text: `随身物品（表9，归属=${state.who}）：${owned.length} 件` }));
    const grid = el('div', { class: 'rbq-invgrid' });
    const g9 = (r, nm) => { const i = i9(nm); return i >= 0 ? String(r[i] ?? '') : ''; };
    for (const r of owned) {
      const nm = g9(r, '物品名称');
      grid.appendChild(el('div', { class: `rbq-invslot rbq-r-${rarityOf(g9(r, '稀有度'))}`, title: [nm, g9(r, '物理类别'), g9(r, '属性加成')].filter(Boolean).join('\n') }, [
        el('span', { class: 'rbq-invslot-icon', text: iconOf(g9(r, '物理类别') || nm) }),
        el('span', { class: 'rbq-invslot-name', text: nm }),
      ]));
    }
    host.appendChild(grid);
  } else {
    host.appendChild(el('div', { class: 'rbq-hint', text: '表9 里没有归属他的物品（随身物为空）。' }));
  }
}
