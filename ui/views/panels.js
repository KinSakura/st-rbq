/**
 * panels.js —— 视图层：把表格数据渲染成"给人看的界面"
 *
 * 设计原则：
 *   1. 一律**按列名取数**（不用固定下标），所以你在「结构」页改了表名列名也不会崩。
 *   2. 每张卡都是"一眼看懂"：主标题 → 徽章（状态/稀有度/危险度）→ 关键数值 → 细节折叠。
 *   3. 空状态要告诉用户"怎么才会有数据"，而不是干巴巴一句"暂无"。
 *   4. 颜色有语义：绿=好/在场/成功，蓝=中，黄=注意，红=危险/失败，紫=稀有/重要。
 */

import * as store from '../../core/store.js';
import { getTable } from '../../core/schema.js';
import { resolveAttr } from '../../core/alias.js';
import { COL_ALIAS as DOMAIN_COL_ALIAS } from '../../core/domain.js';
import * as memory from '../../core/memory.js';
import { escapeHtml } from '../../core/util.js';

/* ------------------------------------------------------------------ 工具 */

/**
 * 语义名 → 真实列名。
 * 视图里写的是"人话"（任务状态 / 持有者 / 截止期限…），表里的列名是另一套说法
 * （推进状态 / 当前归属 / 过期死线…）。统一在这里映射，改表名时只动这一张表。
 */
const COL_ALIAS = DOMAIN_COL_ALIAS;


function pack(no) {
  const t = getTable(no);
  if (!t) return null;
  const rows = store.getRows(no, { create: false });
  return {
    no,
    name: t.name,
    columns: t.columns,
    rows,
    /** 语义名 → 真实列下标：先查映射表，再走别名/列名解析，最后退回包含匹配 */
    colIndex(colName) {
      const real = COL_ALIAS[no]?.[colName] ?? colName;
      const hit = resolveAttr(no, real);
      if (hit) return hit.index;
      return t.columns.findIndex((c) => c === real || c.includes(real) || real.includes(c));
    },
    idx(colName) { return this.colIndex(colName); },
    cell(row, colName) {
      const real = COL_ALIAS[no]?.[colName] ?? colName;
      const hit = resolveAttr(no, real);
      const at = hit ? hit.index : t.columns.findIndex((c) => c === real || c.includes(real) || real.includes(c));
      return at < 0 ? '' : String(row?.[at] ?? '').trim();
    },
  };
}
const nonEmpty = (p) => (p ? p.rows.filter((r) => r.some((c) => String(c ?? '').trim())) : []);

/** 稀有度配色 */
const RARITY = [
  [/神器|神话|传说|Legend/i, 'rbq-r-legend'],
  [/史诗|Epic/i, 'rbq-r-epic'],
  [/稀有|Rare/i, 'rbq-r-rare'],
  [/精良|优秀|Uncommon/i, 'rbq-r-uncommon'],
  [/普通|Common/i, 'rbq-r-common'],
];
function rarityClass(v) {
  for (const [re, cls] of RARITY) if (re.test(String(v ?? ''))) return cls;
  return '';
}
/** 状态配色 */
function statusClass(v) {
  const s = String(v ?? '');
  if (/进行中|进行|装备中|已装备|是|active|在场|正常|健康|成功/.test(s)) return 'rbq-ok';
  if (/已完成|完成|已结算|已结案/.test(s)) return 'rbq-info';
  if (/失败|已失败|dead|defeated|重伤|濒死|危险|敌对|通缉|违规/.test(s)) return 'rbq-danger';
  if (/暂停|搁置|待办|未开始|fled|逃跑|冷却|封印|轻伤/.test(s)) return 'rbq-warn';
  return '';
}

function bar(label, cur, max, cls = '') {
  const pct = max > 0 ? Math.max(0, Math.min(100, Math.round((cur / max) * 100))) : 0;
  const d = document.createElement('div');
  d.className = 'rbq-stat';
  d.innerHTML = `<div class="rbq-stat-top"><span>${escapeHtml(label)}</span><span>${cur} / ${max}</span></div>
    <div class="rbq-stat-track"><div class="rbq-stat-fill ${cls}" style="width:${pct}%"></div></div>`;
  return d;
}

function num(v) { const n = Number(String(v ?? '').replace(/[^\d.-]/g, '')); return Number.isFinite(n) ? n : 0; }

/** 通用空状态 */
function empty(el, host, title, hint) {
  // hint 不传时以前会渲染出字面的 "undefined"（空状态页面上真的会显示）→ 现在只在不空时才加第二行
  const h = hint === undefined || hint === null ? '' : String(hint).trim();
  const html = h
    ? `${escapeHtml(title)}<br><span class="rbq-hint">${escapeHtml(h)}</span>`
    : escapeHtml(title);
  host.appendChild(el('div', { class: 'rbq-empty', html }));
}

/* ------------------------------------------------------------ 任务面板 */

export function renderQuests(host, api) {
  const { el } = api;
  host.textContent = '';
  const p = pack(7);
  const rows = nonEmpty(p);
  if (!rows.length) return empty(el, host, '还没有任务');

  const state = (api.state.panels ??= {});
  let filter = state.questFilter ?? 'all';
  const buckets = { active: [], paused: [], done: [], failed: [], other: [] };
  for (const r of rows) {
    const st = p.cell(r, '任务状态') || p.cell(r, '状态') || '';
    if (/完成|已结算|已结案/.test(st)) buckets.done.push(r);
    else if (/失败|作废|违约/.test(st)) buckets.failed.push(r);
    else if (/暂停|搁置|未开始/.test(st)) buckets.paused.push(r);
    else if (/进行|进行中|active/.test(st) || !st) buckets.active.push(r);
    else buckets.other.push(r);
  }

  const bar2 = el('div', { class: 'rbq-viewbar' });
  const tabs = [['all', `全部 ${rows.length}`], ['active', `进行中 ${buckets.active.length}`], ['paused', `搁置 ${buckets.paused.length}`], ['done', `已完成 ${buckets.done.length}`], ['failed', `失败 ${buckets.failed.length}`]];
  for (const [k, label] of tabs) {
    bar2.appendChild(el('button', {
      class: `rbq-viewtab${filter === k ? ' rbq-active' : ''}`, text: label, 'data-quest-key': k,
      onclick: () => { state.questFilter = k; filter = k; syncTabs(); fillCards(); },
    }));
  }
  host.appendChild(bar2);

  const grid = el('div', { class: 'rbq-cardgrid' });
  /* 铺任务卡片（抽成函数：切分类时只重建这一块 → 不闪） */
  function fillCards() {
    const list = filter === 'all' ? rows : (buckets[filter] ?? []);
    try { grid.textContent = ''; } catch (e) { /* ignore */ }
    if (!list.length) { grid.appendChild(el('div', { class: 'rbq-empty', text: '这个分类下没有任务' })); return; }
    {   /* 【审计修】这里重复写了一层同款 for → 卡片数会变成 N² ✗ 现在只保留内层一层 ✓ */
    for (const r of list) {
      const name = p.cell(r, '任务名称') || p.cell(r, '名称');
      const st = p.cell(r, '任务状态') || p.cell(r, '状态');
      const cat = p.cell(r, '任务类别') || p.cell(r, '类别');
      const progress = p.cell(r, '进度') || p.cell(r, '完成度');
      const deadline = p.cell(r, '截止期限') || p.cell(r, '死线');
      const goal = p.cell(r, '达成目标') || p.cell(r, '目标');
      const members = p.cell(r, '参与成员') || p.cell(r, '成员');
      const reward = p.cell(r, '报酬与资产') || p.cell(r, '报酬') || p.cell(r, '奖励');
      const rule = p.cell(r, '约束与违约条款') || p.cell(r, '约束');
      const issuer = p.cell(r, '发布者') || p.cell(r, '委托人');

      const card = el('div', { class: `rbq-tile ${statusClass(st)}` }, [
        el('div', { class: 'rbq-tile-head' }, [
          el('span', { class: 'rbq-tile-title', text: name || '（未命名任务）' }),
          st ? el('span', { class: `rbq-badge ${statusClass(st)}`, text: st }) : null,
        ]),
        el('div', { class: 'rbq-tile-meta' }, [cat, issuer ? `发布：${issuer}` : '', deadline ? `期限：${deadline}` : ''].filter(Boolean).map((s) => el('span', { text: s }))),
        progress ? (() => {
          const m = String(progress).match(/(\d+)\s*\/\s*(\d+)/);
          if (m) return bar('进度', Number(m[1]), Number(m[2]), 'rbq-mp');
          return el('div', { class: 'rbq-hint', text: `进度：${progress}` });
        })() : null,
        goal ? el('div', { class: 'rbq-tile-body', text: goal }) : null,
        members ? el('div', { class: 'rbq-chips' }, String(members).split(/[/、,，]/).map((s) => s.trim()).filter(Boolean).map((s) => el('span', { class: 'rbq-chip', text: s }))) : null,
        reward ? el('div', { class: 'rbq-hint', text: `报酬：${reward}` }) : null,
        rule ? (() => el('details', { class: 'rbq-spoiler' }, [el('summary', { text: '约束条款' }), el('div', { class: 'rbq-hint', text: rule })]))() : null,
      ]);
      grid.appendChild(card);
    }
    }
  }
  /* 同步分类标签的高亮（只改类名） */
  function syncTabs() {
    try {
      for (const b of bar2.querySelectorAll('.rbq-viewtab')) {
        b.classList.toggle('rbq-active', String(b.dataset.questKey || '') === String(filter));
      }
    } catch (e) { /* ignore */ }
  }
  fillCards();
  host.appendChild(grid);
}

/* ------------------------------------------------------------ 背包面板 */

const CATEGORY_ICON = [
  [/武器|兵器|刀剑|枪|弓/, '⚔️'], [/防具|护甲|盾/, '🛡️'], [/饰|首饰|戒指|项链/, '💍'],
  [/药|丹|药剂|回复/, '🧪'], [/书|卷轴|文献|笔记/, '📜'], [/钥匙|门卡|通行/, '🔑'],
  [/食|粮|料理/, '🍖'], [/材料|素材/, '🪵'], [/货币|钱|金币|钻石/, '💰'], [/工具|装置|零件/, '🔧'],
];
const iconOf = (v) => (CATEGORY_ICON.find(([re]) => re.test(String(v ?? '')))?.[1]) ?? '📦';

export function renderInventory(host, api) {
  const { el } = api;
  host.textContent = '';
  const p = pack(9);
  const rows = nonEmpty(p);
  if (!rows.length) return empty(el, host, '背包是空的');

  const state = (api.state.panels ??= {});
  let holder = state.invHolder ?? 'all';
  let keyword = state.invKeyword ?? '';

  const holders = [...new Set(rows.map((r) => p.cell(r, '当前持有者') || p.cell(r, '持有者')).filter(Boolean))];
  const bar2 = el('div', { class: 'rbq-viewbar' });
  const sel = el('select', { class: 'rbq-select' });
  sel.appendChild(el('option', { value: 'all', text: `全部持有者（${rows.length}）` }));
  for (const h of holders) sel.appendChild(el('option', { value: h, text: h }));
  sel.value = holder;
  sel.addEventListener('change', () => { state.invHolder = sel.value; holder = sel.value; fillList(); });
  const search = el('input', { class: 'rbq-input', type: 'search', placeholder: '搜索物品…', style: 'min-width:160px' });
  search.value = keyword;
  let timer = null;
  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => { state.invKeyword = search.value.trim(); keyword = state.invKeyword; fillList(); }, 250);
  });
  bar2.append(el('span', { class: 'rbq-hint', text: '持有者' }), sel, search);
  host.appendChild(bar2);

  const grid = el('div', { class: 'rbq-cardgrid rbq-cardgrid-tight' });
  /* 铺物品列表（抽成函数：切持有者/搜索时只重建这一块 → 不闪） */
  function fillList() {
    const list = rows
      .filter((r) => holder === 'all' || (p.cell(r, '当前持有者') || p.cell(r, '持有者')) === holder)
      .filter((r) => !keyword || `${p.cell(r, '物品名称')}${p.cell(r, '类别')}${p.cell(r, '备注与属性加成')}`.includes(keyword));
    try { grid.textContent = ''; } catch (e) { /* ignore */ }
    if (!list.length) { grid.appendChild(el('div', { class: 'rbq-empty', text: '没有符合条件的物品' })); return; }
    {   /* 【审计修】这里重复写了一层同款 for → 卡片数会变成 N² ✗ 现在只保留内层一层 ✓ */
    for (const r of list) {
      const name = p.cell(r, '物品名称') || p.cell(r, '名称');
      const cat = p.cell(r, '类别');
      const qty = p.cell(r, '数量');
      const rarity = p.cell(r, '稀有度');
      const dur = p.cell(r, '耐久度');
      const bonus = p.cell(r, '备注与属性加成') || p.cell(r, '属性加成');
      const stateV = p.cell(r, '实时状态') || p.cell(r, '状态');
      const holderV = p.cell(r, '当前持有者') || p.cell(r, '持有者');
      grid.appendChild(el('div', { class: `rbq-item ${rarityClass(rarity)}` }, [
        el('div', { class: 'rbq-item-icon', text: iconOf(cat || name) }),
        el('div', { class: 'rbq-item-main' }, [
          el('div', { class: 'rbq-tile-head' }, [
            el('span', { class: 'rbq-tile-title', text: name || '（未命名）' }),
            qty && num(qty) > 1 ? el('span', { class: 'rbq-badge', text: `×${qty}` }) : null,
            rarity ? el('span', { class: 'rbq-badge', text: rarity }) : null,
          ]),
          el('div', { class: 'rbq-tile-meta' }, [cat, holderV ? `持有：${holderV}` : '', dur ? `耐久 ${dur}` : ''].filter(Boolean).map((s) => el('span', { text: s }))),
          bonus ? el('div', { class: 'rbq-hint', text: bonus }) : null,
          stateV && !/正常|完好/.test(stateV) ? el('span', { class: `rbq-badge ${statusClass(stateV)}`, text: stateV }) : null,
        ]),
      ]));
    }
    }
  }
  fillList();
  host.appendChild(grid);
}

/* ------------------------------------------------------------ 装备面板 */

/**
 * 表9 没有"部位"列，装备格要靠「物理类别」的文字推断（武器/防具/饰品/披风…）。
 * 这里是唯一一处"猜字段含义"的地方，改表结构时改它即可。
 */
const SLOT_RULES = [
  [/副手|盾|副武器/, '副手'],
  [/头|盔|帽|冠|面具/, '头部'],
  [/披风|斗篷|大氅/, '披风'],
  [/上装|上衣|甲|袍|衣/, '上装'],
  [/下装|裤|裙|腿/, '下装'],
  [/足|靴|鞋/, '足部'],
  [/饰|戒指|项链|耳|护符/, '饰品'],
  [/主手|武器|匕首|刀|剑|枪|弓|杖|锤|斧/, '主手'],
];
export function slotOf(categoryText) {
  const s = String(categoryText ?? '');
  for (const [re, slot] of SLOT_RULES) if (re.test(s)) return slot;
  return '';
}
const SLOTS = ['主手', '副手', '头部', '上装', '下装', '足部', '饰品', '披风'];

export function renderEquipment(host, api) {
  const { el } = api;
  host.textContent = '';
  const p = pack(9);
  const rows = nonEmpty(p);
  const goods = rows.filter((r) => slotOf(p.cell(r, '物理类别')) || /武器|防具|装备|饰|盾|甲|袍|靴|刃|剑/.test(p.cell(r, '物理类别')));
  if (!goods.length) return empty(el, host, '还没有装备');

  const state = (api.state.panels ??= {});
  let who = state.equipWho ?? (goods.map((r) => p.cell(r, '当前持有者')).find(Boolean) ?? '');
  const holders = [...new Set(goods.map((r) => p.cell(r, '当前持有者')).filter(Boolean))];
  const bar2 = el('div', { class: 'rbq-viewbar' });
  const sel = el('select', { class: 'rbq-select' });
  for (const h of holders) sel.appendChild(el('option', { value: h, text: h }));
  sel.value = who;
  sel.addEventListener('change', () => { state.equipWho = sel.value; who = sel.value; fillEquip(); });
  bar2.append(el('span', { class: 'rbq-hint', text: '看谁' }), sel, el('span', { class: 'rbq-spacer' }), el('span', { class: 'rbq-hint', text: '装备中 = 实时状态含「装备中/已装备」' }));
  host.appendChild(bar2);

  const body = el('div', { class: 'rbq-equipbody' });
  /* 装备体（抽成函数：切“看谁”时只重建这一块 → 不闪） */
  function fillEquip() {
    try { body.textContent = ''; } catch (e) { /* ignore */ }
    const mine = goods.filter((r) => !who || p.cell(r, '当前持有者') === who);
    const equipped = mine.filter((r) => /装备中|已装备/.test(p.cell(r, '实时状态') || p.cell(r, '状态')));
    const bag = mine.filter((r) => !equipped.includes(r));

    const grid = el('div', { class: 'rbq-slotgrid' });
    for (const slot of SLOTS) {
      const hit = equipped.find((r) => (p.cell(r, '部位') || p.cell(r, '类别')).includes(slot.replace('主手', '武器').replace('副手', '副手')));
      grid.appendChild(el('div', { class: `rbq-slot${hit ? ' rbq-slot-on' : ''}` }, [
        el('div', { class: 'rbq-slot-name', text: slot }),
        hit
          ? el('div', { class: 'rbq-slot-item' }, [
            el('span', { text: iconOf(p.cell(hit, '类别')) }),
            el('span', { class: 'rbq-tile-title', text: p.cell(hit, '物品名称') }),
            p.cell(hit, '稀有度') ? el('span', { class: `rbq-badge ${rarityClass(p.cell(hit, '稀有度'))}`, text: p.cell(hit, '稀有度') }) : null,
            p.cell(hit, '备注与属性加成') ? el('div', { class: 'rbq-hint', text: p.cell(hit, '备注与属性加成') }) : null,
            p.cell(hit, '耐久度') ? el('div', { class: 'rbq-hint', text: `耐久 ${p.cell(hit, '耐久度')}` }) : null,
          ])
          : el('div', { class: 'rbq-hint', text: '空' }),
      ]));
    }
    body.appendChild(el('h4', { class: 'rbq-section', text: '装备栏' }));
    body.appendChild(grid);

    if (bag.length) {
      body.appendChild(el('h4', { class: 'rbq-section', text: `背包里的可用装备（${bag.length}）` }));
      const g2 = el('div', { class: 'rbq-cardgrid rbq-cardgrid-tight' });
      for (const r of bag) {
        g2.appendChild(el('div', { class: `rbq-item ${rarityClass(p.cell(r, '稀有度'))}` }, [
          el('div', { class: 'rbq-item-icon', text: iconOf(p.cell(r, '类别')) }),
          el('div', { class: 'rbq-item-main' }, [
            el('div', { class: 'rbq-tile-head' }, [
              el('span', { class: 'rbq-tile-title', text: p.cell(r, '物品名称') }),
              p.cell(r, '稀有度') ? el('span', { class: 'rbq-badge', text: p.cell(r, '稀有度') }) : null,
            ]),
            el('div', { class: 'rbq-tile-meta' }, [p.cell(r, '物理类别')].filter(Boolean).map((s) => el('span', { text: s }))),
            p.cell(r, '备注与属性加成') ? el('div', { class: 'rbq-hint', text: p.cell(r, '备注与属性加成') }) : null,
          ]),
        ]));
      }
      body.appendChild(g2);
    }
    host.appendChild(body);
  }
  fillEquip();
}

/* ------------------------------------------------------------ 技能面板 */

export function renderSkills(host, api) {
  const { el } = api;
  host.textContent = '';
  const p = pack(10);
  const rows = nonEmpty(p);
  if (!rows.length) return empty(el, host, '还没有技能档案');

  const state = (api.state.panels ??= {});
  let own = state.skillOwner ?? 'all';
  const p2 = pack(2);
  const owners = nonEmpty(p2).map((r) => p2.cell(r, '角色名称')).filter(Boolean);
  const poolOf = (name) => {
    const r = nonEmpty(p2).find((x) => p2.cell(x, '角色名称') === name);
    return r ? String(p2.cell(r, '技能池')).replace(/[\[\]]/g, '').split(/[丨|,，、]/).map((s) => s.trim()).filter(Boolean) : [];
  };

  const bar2 = el('div', { class: 'rbq-viewbar' });
  const sel = el('select', { class: 'rbq-select' });
  sel.appendChild(el('option', { value: 'all', text: `全部技能（${rows.length}）` }));
  for (const o of owners) {
    const cnt = poolOf(o).length;
    if (cnt) sel.appendChild(el('option', { value: o, text: `${o}（${cnt}）` }));
  }
  sel.value = own;
  sel.addEventListener('change', () => { state.skillOwner = sel.value; own = sel.value; fillList(); });
  bar2.append(el('span', { class: 'rbq-hint', text: '按角色' }), sel);
  host.appendChild(bar2);

  const grid = el('div', { class: 'rbq-cardgrid' });
  /* 铺技能列表（抽成函数：切角色时只重建这一块 → 不闪） */
  function fillList() {
    const list = own === 'all' ? rows : (() => {
      const pool = poolOf(own);
      return rows.filter((r) => pool.some((sk) => p.cell(r, '技能名称').includes(sk) || sk.includes(p.cell(r, '技能名称'))));
    })();
    try { grid.textContent = ''; } catch (e) { /* ignore */ }
    if (!list.length) { grid.appendChild(el('div', { class: 'rbq-empty', text: '这个角色没有匹配的技能' })); return; }
    {   /* 【审计修】这里重复写了一层同款 for → 卡片数会变成 N² ✗ 现在只保留内层一层 ✓ */
    for (const r of list) {
      const name = p.cell(r, '技能名称') || p.cell(r, '名称');
      const type = p.cell(r, '检定类型') || p.cell(r, '类型');
      const src = p.cell(r, '来源/流派') || p.cell(r, '来源');
      const mastery = p.cell(r, '掌握度');
      const mp = num(p.cell(r, 'MP消耗'));
      const sp = num(p.cell(r, 'SP消耗'));
      const dmg = p.cell(r, '基础伤害/治疗量');
      const cd = p.cell(r, 'CD冷却');
      const range = p.cell(r, '覆盖范围');
      const seal = p.cell(r, '封印状态');
      grid.appendChild(el('div', { class: `rbq-tile${seal && !/未封印|正常/.test(seal) ? ' rbq-warn' : ''}` }, [
        el('div', { class: 'rbq-tile-head' }, [
          el('span', { class: 'rbq-tile-title', text: `${iconOf(type)} ${name || '（未命名）'}` }),
          type ? el('span', { class: 'rbq-badge', text: type }) : null,
          seal && !/未封印|正常/.test(seal) ? el('span', { class: 'rbq-badge rbq-danger', text: seal }) : null,
        ]),
        el('div', { class: 'rbq-tile-meta' }, [src, mastery ? `掌握 ${mastery}` : '', cd ? `冷却 ${cd}` : '', range].filter(Boolean).map((s) => el('span', { text: s }))),
        el('div', { class: 'rbq-chips' }, [
          dmg ? el('span', { class: 'rbq-chip', text: `⚔ 基础 ${dmg}` }) : null,
          mp ? el('span', { class: 'rbq-chip rbq-chip-mp', text: `MP ${mp}` }) : null,
          sp ? el('span', { class: 'rbq-chip rbq-chip-sp', text: `SP ${sp}` }) : null,
        ].filter(Boolean)),
        p.cell(r, '效果描述') || p.cell(r, '描述') ? el('div', { class: 'rbq-hint', text: p.cell(r, '效果描述') || p.cell(r, '描述') }) : null,
      ]));
    }
    }
  }
  fillList();
  host.appendChild(grid);
}

/* ------------------------------------------------------------ 敌人面板 */

export function renderMonsters(host, api) {
  const { el } = api;
  host.textContent = '';
  const p = pack(14);
  const rows = nonEmpty(p);
  if (!rows.length) return empty(el, host, '场上还没有敌人');

  const state = (api.state.panels ??= {});
  let hide = state.monsterHideDead ?? true;
  const bar2 = el('div', { class: 'rbq-viewbar' }, [
    el('span', { class: 'rbq-hint', text: '隐藏已击败/已消失' }),
    (() => {
      const i = el('input', { type: 'checkbox', ...(hide ? { checked: true } : {}) });
      i.addEventListener('change', () => { state.monsterHideDead = i.checked; hide = i.checked; fillList(); });
      return el('label', { class: 'rbq-switch' }, [i, el('span', { class: 'rbq-knob' })]);
    })(),
  ]);
  host.appendChild(bar2);

  const grid = el('div', { class: 'rbq-cardgrid' });
  /* 铺敌人列表（抽成函数：切“隐藏已击败”时只重建这一块 → 不闪） */
  function fillList() {
    const list = rows.filter((r) => !hide || !/defeated|fled|despawned|已击败|已逃跑/.test(p.cell(r, '状态')));
    try { grid.textContent = ''; } catch (e) { /* ignore */ }
    if (!list.length) { grid.appendChild(el('div', { class: 'rbq-empty', text: '这个筛选下没有敌人' })); return; }
    {   /* 【审计修】这里重复写了一层同款 for → 卡片数会变成 N² ✗ 现在只保留内层一层 ✓ */
    for (const r of list) {
      const name = p.cell(r, '怪物名称') || p.cell(r, '实体名称') || p.cell(r, '名称');
      const st = p.cell(r, '状态');
      const lv = p.cell(r, '等级');
      const hp = num(p.cell(r, 'HP(当前)'));
      const mhp = num(p.cell(r, 'HP(上限)'));
      const desc = p.cell(r, '简要描述') || p.cell(r, '描述');
      const drops = p.cell(r, '掉落物品');
      const card = el('div', { class: `rbq-tile ${st === 'active' ? 'rbq-danger' : ''}` }, [
        el('div', { class: 'rbq-tile-head' }, [
          el('span', { class: 'rbq-tile-title', text: `👹 ${name || '（未命名）'}` }),
          lv ? el('span', { class: 'rbq-badge', text: lv }) : null,
          st ? el('span', { class: `rbq-badge ${statusClass(st)}`, text: st }) : null,
        ]),
        mhp ? bar('HP', hp, mhp, 'rbq-hp') : null,
        el('div', { class: 'rbq-tile-meta' }, [
          p.cell(r, '物理攻击(ATK)') ? `ATK ${p.cell(r, '物理攻击(ATK)')}` : '',
          p.cell(r, '物理防御(DEF)') ? `DEF ${p.cell(r, '物理防御(DEF)')}` : '',
          p.cell(r, '速度(AGI)') ? `AGI ${p.cell(r, '速度(AGI)')}` : '',
        ].filter(Boolean).map((s) => el('span', { text: s }))),
        desc ? el('div', { class: 'rbq-hint', text: desc }) : null,
        drops ? el('div', { class: 'rbq-chips' }, String(drops).split(/[/、,，]/).map((s) => s.trim()).filter(Boolean).map((s) => el('span', { class: 'rbq-chip', text: `🎁 ${s}` }))) : null,
      ]);
      grid.appendChild(card);
    }
    }
  }
  fillList();
  host.appendChild(grid);
}

/* ------------------------------------------------------------ 势力面板 */

export function renderFactions(host, api) {
  const { el } = api;
  host.textContent = '';
  const p = pack(11);
  const rows = nonEmpty(p);
  if (!rows.length) return empty(el, host, '还没有势力/律法记录');

  const grid = el('div', { class: 'rbq-cardgrid' });
  for (const r of rows) {
    const name = p.cell(r, '势力/法则名称') || p.cell(r, '名称');
    const type = p.cell(r, '类型');
    const leader = p.cell(r, '核心领袖');
    const territory = p.cell(r, '势力范围');
    const rep = p.cell(r, '声望评级');
    const host_ = p.cell(r, '对玩家敌对度');
    const benefit = p.cell(r, '成员福利');
    const redline = p.cell(r, '组织红线');
    const punish = p.cell(r, '违规惩罚');
    grid.appendChild(el('div', { class: `rbq-tile ${statusClass(host_)}` }, [
      el('div', { class: 'rbq-tile-head' }, [
        el('span', { class: 'rbq-tile-title', text: name || '（未命名）' }),
        type ? el('span', { class: 'rbq-badge', text: type }) : null,
        host_ ? el('span', { class: `rbq-badge ${statusClass(host_)}`, text: host_ }) : null,
      ]),
      el('div', { class: 'rbq-tile-meta' }, [leader ? `领袖 ${leader}` : '', territory, rep ? `声望 ${rep}` : ''].filter(Boolean).map((s) => el('span', { text: s }))),
      benefit ? el('div', { class: 'rbq-hint', text: `福利：${benefit}` }) : null,
      (redline || punish) ? (() => el('details', { class: 'rbq-spoiler' }, [
        el('summary', { text: '红线与惩罚' }),
        el('div', { class: 'rbq-hint', text: [redline && `红线：${redline}`, punish && `惩罚：${punish}`].filter(Boolean).join('\n') }),
      ]))() : null,
    ]));
  }
  host.appendChild(grid);
}

/* ------------------------------------------------------------ 纪事面板 */

export function renderChronicle(host, api) {
  const { el } = api;
  host.textContent = '';
  const p = pack(12);
  const rows = nonEmpty(p);
  if (!rows.length) return empty(el, host, '还没有纪事记录');

  host.appendChild(el('div', { class: 'rbq-hint', text: `${rows.length} 段纪事，从旧到新` }));
  const line = el('div', { class: 'rbq-timeline' });
  rows.forEach((r, i) => {
    const idx = `${i + 1}`;
    const range = p.cell(r, '时间跨度') || p.cell(r, '阶段索引');
    const route = p.cell(r, '路线标记');
    const summary = p.cell(r, '纪事概要');
    const deaths = p.cell(r, '死亡与伤亡');
    const faction = p.cell(r, '势力与格局变动');
    const emotion = p.cell(r, '情感与关系沉淀');
    const suspense = p.cell(r, '遗留伏笔与悬念');
    line.appendChild(el('div', { class: 'rbq-tl-item' }, [
      el('div', { class: 'rbq-tl-dot' }, [el('span', { text: idx })]),
      el('div', { class: 'rbq-tl-body' }, [
        el('div', { class: 'rbq-tile-head' }, [
          el('span', { class: 'rbq-tile-title', text: range || `第 ${idx} 段` }),
          route ? el('span', { class: 'rbq-badge', text: route }) : null,
        ]),
        summary ? el('div', { class: 'rbq-tl-summary', text: summary }) : null,
        el('div', { class: 'rbq-chips' }, [
          deaths ? el('span', { class: 'rbq-chip rbq-chip-warn', text: `☠ ${deaths}` }) : null,
          faction ? el('span', { class: 'rbq-chip', text: `🏛 ${faction}` }) : null,
          emotion ? el('span', { class: 'rbq-chip', text: `❤ ${emotion}` }) : null,
          suspense ? el('span', { class: 'rbq-chip rbq-chip-warn', text: `❓ ${suspense}` }) : null,
        ].filter(Boolean)),
      ]),
    ]));
  });
  host.appendChild(line);
}

/* ------------------------------------------------------------ 记忆面板 */

export function renderMemory(host, api) {
  const { el, notify } = api;
  host.textContent = '';
  const s = memory.stats();
  if (!s.total) {
    return empty(el, host, '还没有长期记忆');
  }

  const state = (api.state.panels ??= {});
  let who = state.memWho ?? s.byChar[0]?.name ?? '';
  let kw = state.memKeyword ?? '';

  const bar2 = el('div', { class: 'rbq-viewbar' });
  const sel = el('select', { class: 'rbq-select' });
  sel.appendChild(el('option', { value: '__all__', text: `全部角色（${s.total} 条）` }));
  for (const c of s.byChar) sel.appendChild(el('option', { value: c.name, text: `${c.name}（${c.count}）` }));
  sel.value = who === '' ? '__all__' : who;
  sel.addEventListener('change', () => { state.memWho = sel.value === '__all__' ? '' : sel.value; who = state.memWho; fillList(); });
  const search = el('input', { class: 'rbq-input', type: 'search', placeholder: '搜记忆内容…', style: 'min-width:180px' });
  search.value = kw;
  let t2 = null;
  search.addEventListener('input', () => { clearTimeout(t2); t2 = setTimeout(() => { state.memKeyword = search.value.trim(); kw = state.memKeyword; fillList(); }, 250); });
  bar2.append(el('span', { class: 'rbq-hint', text: '角色' }), sel, search,
    el('span', { class: 'rbq-spacer' }),
    el('button', {
      class: 'rbq-btn', text: '召回测试',
      onclick: () => {
        const q = prompt('输入一句话，看会召回哪些记忆（模拟下一轮的相关度排序）：', '');
        if (q == null) return;
        const hits = memory.recall({ query: q, limit: 8 });
        if (!hits.length) { notify('warning', '没有超过阈值的记忆。'); return; }
        console.log('[RBQ] 召回结果', hits);
        alert(hits.map((h, i) => `${i + 1}. [${h.name}｜第${h.entry.round}轮｜${h.score.toFixed(2)}] ${h.entry.raw.slice(0, 80)}`).join('\n'));
      },
    }));
  host.appendChild(bar2);

  const wrap = el('div', { class: 'rbq-memwrap' });
  /* 铺记忆卡片（抽成函数：切角色/搜索/删单条时只重建这一块 → 不闪） */
  function fillList() {
    try { wrap.textContent = ''; } catch (e) { /* ignore */ }
  const names = who ? [who] : s.byChar.map((c) => c.name);
  for (const n of names) {
    const list = memory.memoriesOf(n)
      .filter((e) => !kw || String(e.raw).includes(kw))
      .slice()
      .reverse();
    if (!list.length) continue;
    const card = el('div', { class: 'rbq-card' }, [
      el('h4', { text: `${n}　${list.length} 条` }),
      el('button', {
        class: 'rbq-btn rbq-danger rbq-icon', text: '清空这个角色的记忆',
        onclick: () => { if (confirm(`清空「${n}」的全部记忆？`)) { memory.clearCharacter(n); store.commit({ persist: true }); api.rerender(); } },
      }),
    ]);
    for (const e of list) {
      const f = e.fields ?? {};
      card.appendChild(el('div', { class: 'rbq-mem-item' }, [
        el('div', { class: 'rbq-mem-head' }, [
          el('span', { class: 'rbq-badge', text: `第 ${e.round} 轮` }),
          e.important ? el('span', { class: 'rbq-badge rbq-warn', text: '重要' }) : null,
          /* 【用户要求】这里显示「这一轮的表0时间框」✓ 跟时间框一模一样的格式 ✓
             （不再显示真实时钟 ✗；老数据没这个字段时才退回真实时间 ✓） */
          el('span', { class: 'rbq-hint', text: e.t ? String(e.t) : (Number.isFinite(Number(e.at)) ? new Date(Number(e.at)).toLocaleTimeString() : '（没有时间）'), title: e.t ? '这一轮的表0时间' : '旧数据（没有表0时间）' }),
          el('span', { class: 'rbq-spacer' }),
          el('button', {
            class: 'rbq-btn rbq-icon rbq-danger', text: '✕', title: '删除这条',
            onclick: () => { memory.removeMemory(n, e.id); store.commit({ persist: true }); fillList(); },
          }),
        ]),
        el('div', { class: 'rbq-mem-body' }, [
          f['感知'] ? el('div', {}, [el('b', { text: '感知　' }), el('span', { text: f['感知'] })]) : null,
          f['情绪'] ? el('div', {}, [el('b', { text: '情绪　' }), el('span', { text: f['情绪'] })]) : null,
          f['意图'] ? el('div', {}, [el('b', { text: '意图　' }), el('span', { text: f['意图'] })]) : null,
          f['记忆锚点'] ? el('div', {}, [el('b', { text: '锚点　' }), el('span', { text: f['记忆锚点'] })]) : null,
          !Object.keys(f).length ? el('div', { text: e.raw }) : null,
        ]),
      ]));
    }
    wrap.appendChild(card);
  }
  }
  fillList();
  host.appendChild(wrap);

  host.appendChild(el('div', { class: 'rbq-hint', text: '记忆会在每轮按相关度自动召回一小段注入提示词（上限 1400 字），表格只装"现状"、记忆装"历史"，两者分开以免互相污染。' }));
}

/** 所有面板的注册表（panel.js 用它生成子标签） */
export const PANELS = [
  ['quests', '任务', renderQuests],
  ['inventory', '背包', renderInventory],
  ['equipment', '装备', renderEquipment],
  ['skills', '技能', renderSkills],
  ['monsters', '敌人', renderMonsters],
  ['factions', '势力与法则', renderFactions],
  ['chronicle', '纪事时间线', renderChronicle],
  ['memory', '长期记忆', renderMemory],
];
