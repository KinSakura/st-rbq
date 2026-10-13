/**
 * characterCard.js —— 角色卡（一个角色的全部东西，装在一张卡里）
 *
 * 为什么这样设计：
 *   之前我把同一个人的信息拆到「档案/生理/状态/属性/关系/持有/技能」七个标签页里，
 *   点一次角色要翻七次 —— 用户说"分得太散"。
 *   参考 DND 沉浸式仪表盘的做法：头像点开就是一张卡，卡里从上到下是
 *   身份 → 资源 → 属性 → 状态 → 装备 → 技能 → 关系 → 记忆 → 背景，
 *   技能/专长是可点的标签，点开浮出细节，不占版面。
 *
 * 取数一律走列名/别名解析，改表名不崩。
 */

import * as store from '../../core/store.js';
import { getTable } from '../../core/schema.js';
import { resolveAttr } from '../../core/alias.js';
import { openAvatarPicker } from './dossier.js';
import * as memory from '../../core/memory.js';
import { slotOf } from './panels.js';

const rows = (no) => store.getRows(no, { create: false });
const s = (v) => String(v ?? '').trim();
const num = (v) => { const n = Number(s(v).replace(/[^\d.-]/g, '')); return Number.isFinite(n) ? n : 0; };

/** 语义名 → 单元格文本（先别名解析，再包含匹配） */
function get(no, row, name) {
  const t = getTable(no);
  if (!t || !row) return '';
  const hit = resolveAttr(no, name);
  let i = hit ? hit.index : -1;
  if (i < 0) i = t.columns.findIndex((c) => c === name || c.includes(name) || name.includes(c));
  return i < 0 ? '' : s(row[i]);
}
function findRow(no, name) {
  const t = getTable(no);
  if (!t) return null;
  return rows(no).find((r) => get(no, r, 'name') === s(name)) ?? null;
}
function avatarFor(name) {
  try {
    const cfg = store.getConfigValue('views.avatars', {}) ?? {};
    if (cfg[name]) return cfg[name];
  } catch { /* ignore */ }
  try {
    const ch = (window.SillyTavern?.getContext?.()?.characters ?? []).find((c) => s(c?.name) === s(name));
    if (ch?.avatar) return `/characters/${encodeURIComponent(ch.avatar)}`;
  } catch { /* ignore */ }
  return null;
}

const ATTRS = [
  ['力量(STR)', '力量'], ['体质(CON)', '体质'], ['敏捷(DEX)', '敏捷'], ['智力(INT)', '智力'],
];
const DERIVED = ['物理攻击(ATK)', '物理防御(DEF)', '魔法攻击(MATK)', '魔法防御(MDEF)', '速度(AGI)', '负重上限'];

function barLabel(label, cur, max, cls) {
  const pct = max > 0 ? Math.max(0, Math.min(100, Math.round((cur / max) * 100))) : 0;
  const d = document.createElement('div');
  d.className = 'rbq-cc-bar';
  d.innerHTML = `<div class="rbq-cc-bar-top"><span>${label}</span><span>${cur}<i>/${max}</i></span></div>
    <div class="rbq-cc-bar-track"><div class="rbq-cc-bar-fill ${cls}" style="width:${pct}%"></div></div>`;
  return d;
}

/**
 * 渲染一张角色卡。
 * @param {HTMLElement} host 容器（通常是悬浮层）
 * @param {string} name 角色名
 * @param {{el:Function, onClose?:Function, onPickCharacter?:Function}} api
 */
const CC_FOLD = {};   // 模块级：api.state 每次渲染都是新对象，存这里才留得住

export function renderCharacterCard(host, name, api) {
  const { el } = api;
  host.textContent = '';
  if (!name) { host.appendChild(el('div', { class: 'rbq-hint', text: '没有可显示的角色。' })); return; }

  const p2 = findRow(2, name);
  const p3 = findRow(3, name);
  const p4 = findRow(4, name);
  const p13 = findRow(13, name);

  const av = avatarFor(name);
  const race = get(2, p2, '种族');
  const job = get(2, p2, '公开身份/职业');
  const level = get(2, p2, '等级');
  const alive = get(2, p2, '存活状态');
  const gender = get(3, p3, '性别');
  const age = get(2, p2, '年龄') || get(2, p2, '生理年龄') || get(3, p3, '生理年龄');   // 年龄在表2（以前错读表3 的「生理年龄」→ 永远空 → 卡片第三项显示成了身高）
  const height = get(3, p3, '身高');
  /* 【用户要求】表3 新增「容貌描述」→ 角色卡要显示出来 ✓（剧情里靠它区分不同角色 ✓） */
  const looks = get(3, p3, '容貌描述') || get(3, p3, '外貌') || get(3, p3, '容貌');
  const hp = num(get(13, p13, 'HP(当前)')); const mhp = num(get(13, p13, 'HP(上限)'));
  const mp = num(get(13, p13, 'MP(当前)')); const mmp = num(get(13, p13, 'MP(上限)'));
  const sp = num(get(13, p13, 'SP(当前)')); const msp = num(get(13, p13, 'SP(上限)'));

  /* ---- 头部：头像 + 身份 ---- */
  const head = el('div', { class: 'rbq-cc-head' }, [
    (() => {
      const node = av
        ? el('img', { class: 'rbq-cc-portrait', src: av, alt: name, title: '点击改头像' })
        : el('div', { class: 'rbq-cc-portrait rbq-cc-portrait-fallback', text: name.slice(0, 1), title: '点击上传头像' });
      node.style.cursor = 'pointer';
      node.addEventListener('click', (e) => {
        e.stopPropagation();
        openAvatarPicker(name, () => {
          const nv = avatarFor(name);
          if (node.tagName === 'IMG') { if (nv) node.src = nv; else { node.replaceWith(el('div', { class: 'rbq-cc-portrait rbq-cc-portrait-fallback', text: name.slice(0, 1) })); } }
          else if (nv) { const im = el('img', { class: 'rbq-cc-portrait', src: nv, alt: name }, node); node.replaceWith(im); }
        });
      });
      return node;
    })(),
    el('div', { class: 'rbq-cc-ident' }, [
      el('div', { class: 'rbq-cc-name' }, [
        el('strong', { text: name }),
        level ? el('span', { class: 'rbq-cc-level', text: s(level).replace(/^Lv\.?/i, 'Lv.') }) : null,
        alive && alive !== 'Alive' ? el('span', { class: 'rbq-badge rbq-danger', text: alive }) : null,
      ]),
      el('div', { class: 'rbq-cc-sub' }, [
        [race, gender, age ? `${age} 岁` : ''].filter(Boolean).join(' · ') || '—',   // 用户要求：年龄后面不要身高
      ]),
      job ? el('div', { class: 'rbq-cc-job', text: job }) : null,
      looks ? el('div', { class: 'rbq-cc-look', text: looks, title: '容貌描述（表3）' }) : null,
    ]),
    el('button', {
      class: 'rbq-icon-btn', text: '✕', title: '关闭',
      onclick: () => api.onClose?.(),
    }),
  ]);

  /* ---- 资源条 ---- */
  const vitals = el('div', { class: 'rbq-cc-vitals' }, [
    barLabel('HP', hp, mhp, 'rbq-hp'),
    barLabel('MP', mp, mmp, 'rbq-mp'),
    barLabel('SP', sp, msp, 'rbq-sp'),
  ]);

  /* ---- 四维 + 派生 ---- */
  const attrBox = el('div', { class: 'rbq-cc-attrs' });
  for (const [key, label] of ATTRS) {
    const v = num(get(13, p13, key));
    attrBox.appendChild(el('div', { class: 'rbq-cc-attr' }, [
      el('span', { class: 'rbq-cc-attr-label', text: label }),
      el('span', { class: 'rbq-cc-attr-value', text: v ? String(v) : '—' }),
    ]));
  }
  const coef = get(2, p2, '四维系数') || get(13, p13, '四维系数');
  if (coef) attrBox.appendChild(el('div', { class: 'rbq-cc-attr rbq-cc-attr-wide' }, [
    el('span', { class: 'rbq-cc-attr-label', text: '系数' }),
    el('span', { class: 'rbq-cc-attr-value rbq-small', text: coef }),
  ]));

  const derived = el('div', { class: 'rbq-cc-derived' });
  for (const d of DERIVED) {
    const v = get(13, p13, d);
    if (!v) continue;
    derived.appendChild(el('span', { class: 'rbq-cc-der' }, [
      el('b', { text: d.replace(/\(.*\)/, '') }),
      el('span', { text: v }),
    ]));
  }

  /* ---- 详情弹窗（状态/技能的胶囊点开后弹出，不再用 title 提示 / 内联详情） ---- */
  const openModal = (title, nodes) => {
    try {
      const oldMask = document.querySelector('.rbq-modal-mask');
      if (oldMask) oldMask.remove();
      const onKey = (e) => { if (e.key === "Escape") close(); };
      const close = () => {
        try { mask.remove(); } catch (e) { /* ignore */ }
        try { document.removeEventListener("keydown", onKey); } catch (e) { /* ignore */ }
      };
      const mask = el('div', { class: 'rbq-modal-mask' });
      mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
      const box = el('div', { class: 'rbq-modal' }, [
        el('div', { class: 'rbq-modal-head' }, [
          el('strong', { class: 'rbq-modal-title', text: String(title ?? '') }),
          el('span', { class: 'rbq-modal-x', text: '✕', title: '关闭', onclick: close }),
        ]),
        el('div', { class: 'rbq-modal-body' }, nodes),
      ]);
      mask.appendChild(box);
      // 挂到 <html>：body 上可能有 transform/filter，会让 position:fixed 相对 body 定位 → 弹窗跑到页面顶部
      (document.documentElement || document.body).appendChild(mask);
      document.addEventListener("keydown", onKey);
    } catch (e) { /* ignore */ }
  };
  /* 表的某一行的完整字段 → dl（弹窗正文用） */
  const rowToDl = (no, row) => {
    const dl = el('dl', { class: 'rbq-kv' });
    try {
      const tt = getTable(no);
      (tt?.columns ?? []).forEach((c, i) => { const v = s(row?.[i]); if (v && i > 0) dl.append(el("dt", { text: c }), el("dd", { text: v })); });
    } catch (e) { /* ignore */ }
    return dl;
  };
  /* ---- 状态（表8） ---- */
  const effs = rows(8).filter((r) => get(8, r, 'host') === name);
  const statusBox = el('div', { class: 'rbq-cc-tags' });
  for (const r of effs) {
    const nm8 = get(8, r, 'name') || s(r[0]);
    const tag8 = el('span', {
      class: `rbq-tag ${/减益|异常|负面/.test(s(r[2])) ? 'rbq-tag-danger' : 'rbq-tag-ok'}`,
      text: nm8,
      title: '点击查看详情',
    });
    tag8.addEventListener('click', () => openModal(`状态 · ${nm8}`, [rowToDl(8, r)]));
    statusBox.appendChild(tag8);
  }

  if (!effs.length) statusBox.appendChild(el('span', { class: 'rbq-hint', text: '当前没有异常状态。' }));

/* ---- 装备位（表9 已装备） ---- */
  const worn = rows(9).filter((r) => get(9, r, 'holder') === name && /装备中|已装备/.test(get(9, r, '外显状态')));
  const equipBox = el('div', { class: 'rbq-cc-equip' });
  // 装备值直接来自表4 的行（表4 才是穿戴的权威；不再用表9 的 DND 槽位映射）
  const dollVal = (col) => String(get(4, p4, col) ?? '').trim();
  // 槽位 = 表4 的真实列（不再写死 DND 的主手/副手/…）
  const SLOTS = (() => {
    try {
      const t4 = getTable(4);
      const cols = (t4?.columns ?? []).map((c) => String(c)).filter((c) => c !== '角色名称' && c !== '微观坐标' && c !== '离场状态');
      if (cols.length) return cols;
    } catch (e) { /* ignore */ }
    return ['头部装备', '颈部附加', '上装外衣', '上装内层', '双手持物', '下装外层', '下装内层', '腿部裹覆', '足部', '下肢约束'];
  })();
  for (const slot of SLOTS) {
    const val = dollVal(slot);
    equipBox.appendChild(el('div', { class: `rbq-cc-slot${val ? ' rbq-filled' : ''}` }, [
      el('span', { class: 'rbq-cc-slot-name', text: slot }),
      val ? el('span', { class: 'rbq-cc-slot-item', text: val, title: val }) : el('span', { class: 'rbq-cc-slot-empty', text: '空' }),
    ]));
  }

  /* ---- 技能标签（表2 技能池 → 表10 详情） ---- */
  const pool = s(get(2, p2, '技能池')).replace(/[[\]]/g, '').split(/[丨|,，、]/).map((x) => x.trim()).filter(Boolean);
  const skillBox = el('div', { class: 'rbq-cc-tags' });
  const showSkill = (nm, row) => {
    detail.textContent = '';
    if (!row) { detail.appendChild(el('div', { class: 'rbq-hint', text: `表10 里还没有「${nm}」的档案。` })); return; }
    const t = getTable(10);
    const dl = el('dl', { class: 'rbq-kv' });
    t.columns.forEach((c, i) => { const v = s(row[i]); if (v && i > 0) dl.append(el('dt', { text: c }), el('dd', { text: v })); });
    detail.append(el('div', { class: 'rbq-cc-detail-title', text: nm }), dl);
  };
  for (const sk of pool) {
    const row = findRow(10, sk);
    const tag = el('span', { class: 'rbq-tag rbq-tag-skill', text: sk, title: '点击查看详情' });
    tag.addEventListener('click', () => {
      if (!row) { openModal(`技能 · ${sk}`, [el('div', { class: 'rbq-hint', text: '表10 里还没有这条技能档案。' })]); return; }
      openModal(`技能 · ${sk}`, [rowToDl(10, row)]);
    });
    skillBox.appendChild(tag);
  }
  if (!pool.length) skillBox.appendChild(el('span', { class: 'rbq-hint', text: '技能池为空。' }));

  /* ---- 关系（表5 双向） ---- */
  const relBox = el('div', { class: 'rbq-cc-rel' });
  /* 名字宽容匹配：表2 的角色名常带后缀（如「样本1·测试者」），而表5 里可能只写「样本1」→
     严格相等会一条都匹配不上（用户反馈“关系没正确显示”）。这里做归一化 + 前缀兜底。 */
  const normName = (v) => s(v).replace(/[「」【】\[\]（）()]/g, " ").split(/[·・,，|/→←]/)[0].trim();
  const sameName = (a, b) => {
    const x = normName(a); const y = normName(b);
    if (!x || !y) return false;
    if (x === y) return true;
    return x.startsWith(y) || y.startsWith(x);
  };
  const out = rows(5).filter((r) => sameName(r[0], name));
  const inc = rows(5).filter((r) => sameName(r[1], name));
  for (const r of out) {
    relBox.appendChild(el('div', { class: 'rbq-cc-rel-row' }, [
      el('span', { class: 'rbq-cc-rel-dir', text: '→' }),
      el('span', { class: 'rbq-cc-rel-who', text: s(r[1]), title: '点击跳过去' }),
      el('span', { class: 'rbq-cc-rel-tag', text: s(r[2]) || '—' }),
      s(r[4]) && s(r[4]) !== s(r[2]) ? el('span', { class: 'rbq-cc-rel-tag rbq-rel-secret', text: `私下 ${s(r[4])}` }) : null,
      s(r[6]) ? el('span', { class: 'rbq-hint', text: s(r[6]) }) : null,
    ]));
    relBox.lastChild.querySelector('.rbq-cc-rel-who').addEventListener('click', () => api.onPickCharacter?.(s(r[1])));
  }
  for (const r of inc) {
    relBox.appendChild(el('div', { class: 'rbq-cc-rel-row rbq-dim-row' }, [
      el('span', { class: 'rbq-cc-rel-dir', text: '←' }),
      el('span', { class: 'rbq-cc-rel-who', text: s(r[0]), title: '点击跳过去' }),
      el('span', { class: 'rbq-cc-rel-tag', text: s(r[2]) || '—' }),
      s(r[4]) && s(r[4]) !== s(r[2]) ? el('span', { class: 'rbq-cc-rel-tag rbq-rel-secret', text: `私下 ${s(r[4])}` }) : null,
    ]));
    relBox.lastChild.querySelector('.rbq-cc-rel-who').addEventListener('click', () => api.onPickCharacter?.(s(r[0])));
  }
  if (!out.length && !inc.length) relBox.appendChild(el('span', { class: 'rbq-hint', text: '表5 里还没有与他相关的关系行。' }));

  /* ---- 生理 / 着装 / 背景 ---- */
  const detailList = (no, pack, skip = 0) => {
    const t = getTable(no);
    if (!t || !pack) return null;
    const dl = el('dl', { class: 'rbq-kv' });
    t.columns.forEach((c, i) => {
      if (i < skip) return;
      const v = s(pack[i]);
      if (v) dl.append(el('dt', { text: c }), el('dd', { text: v }));
    });
    return dl;
  };

  const section = (title, node, extra = null) => {
    if (!node) return null;
    return el('div', { class: 'rbq-cc-section' }, [el('h4', { class: 'rbq-cc-section-title', text: title }), node, extra].filter(Boolean));
  };

  // 先把 生理 / 此刻 的数据取出来（下面要重排顺序）
  const d3 = detailList(3, p3, 1);
  // 折叠区块：默认收起，点击标题才展开（用户要求状态/技能不要直接铺开）
  const foldState = CC_FOLD;   // 模块级折叠状态（不受重绘影响）
  const fold = (title, node) => {
    if (!node) return null;
    const key = String(title).replace(/（.*?）/, "");
    const box = el("div", { class: "rbq-cc-section rbq-cc-fold" });
    const head = el("div", { class: "rbq-cc-section-title rbq-cc-fold-head", text: title });
    const body = el("div", { class: "rbq-cc-fold-body" }, [node]);
    body.style.display = foldState[key] ? "" : "none";
    // 纯 JS 手动开关：不依赖 <details> 默认行为，也不怕外层点击打断
    head.addEventListener("click", (ev) => {
      try { ev.stopPropagation(); } catch (e) { /* ignore */ }
      const open = body.style.display === "none";
      body.style.display = open ? "" : "none";
      head.setAttribute("data-open", open ? "1" : "");
      foldState[key] = open;
    });
    head.setAttribute("data-open", foldState[key] ? "1" : "");
    box.appendChild(head);
    box.appendChild(body);
    return box;
  };

  /* 原生 append(null) 会把 null 当文本插进去（用户看到状态下面多个 "null"）→ 收进数组后跳过空值 */
  for (const __node of [
    head,
    /* 微观坐标 / 离场状态：原来埋在「此刻」里，现在提到最上面（此刻已删） */
    (() => {
      const where = String(get(4, p4, '微观坐标') ?? '').trim();
      const leave = String(get(4, p4, '离场状态') ?? '').trim();
      const leaveShow = leave && !/^(正常|在场|未离场|无|—|-)$/.test(leave) ? `离场：${leave}` : '';
      const parts = [where ? `📍 ${where}` : '', leaveShow].filter(Boolean);
      if (!parts.length) return null;
      return el('div', { class: 'rbq-cc-where' }, [el('span', { class: 'rbq-chip', text: parts.join(' · ') })]);
    })(),
    /* 背景：用户要求放在「坐标」与 HP/MP/SP 之间，并且**不折叠**（直接铺开） */
    (() => {
      const bg = get(2, p2, '背景履历') || get(2, p2, '背景');
      if (!bg) return null;
      return el('div', { class: 'rbq-cc-section rbq-cc-bgsec' }, [
        el('h4', { class: 'rbq-cc-section-title', text: '背景' }),
        el('div', { class: 'rbq-cc-bg', text: String(bg) }),
      ]);
    })(),
    vitals,
    section('属性', attrBox),
    derived.childElementCount ? section('派生数值', derived) : null,
    fold(effs.length ? `状态（${effs.length}）` : '状态', statusBox),
    fold('生理', d3),                                  // ← 生理紧跟状态（用户要求）
    section('装备（' + SLOTS.filter((c) => dollVal(c)).length + '）', equipBox),
    (() => {
      // 表4 里混着真装备与身体状态（躯干姿势/约束距离/表层面具/潜意识漏出/伪装标识…）→ 身体状态单独成块
const __EQUIP_RE = /装备|持物|外衣|内层|上装|下装|头部|颈部|足部|腿部|裹覆|下肢|主手|副手|饰品|披风|鞋|靴|帽|盔|护甲|武器|手甲|腰|背|肩/;
      let cols = [];
      try {
        const t4 = getTable(4);
        cols = (t4?.columns ?? []).map((c) => String(c)).filter((c) => c !== '角色名称' && c !== '微观坐标' && c !== '离场状态');
      } catch (e) { /* ignore */ }
      const bodyCols = cols.filter((c) => !__EQUIP_RE.test(c));
      if (!bodyCols.length) return null;
      const box = el('div', { class: 'rbq-cc-tags' });
      for (const c of bodyCols) {
        const v = String(get(4, p4, c) ?? '').trim() || '—';
        const tg = el('span', { class: 'rbq-tag rbq-tag-body', text: `${c}：${v}`, title: '点击查看详情' });
        tg.addEventListener('click', () => openModal(`身体状态 · ${c}`, [el('div', { class: 'rbq-kv-row', text: v })]));
        box.appendChild(tg);
      }
      return section('身体状态', box);
    })(),
    fold('技能', skillBox),   // ← 技能点击才展开
    fold(`关系（${out.length + inc.length}）`, relBox),   // 关系默认收起（用户要求可折叠）
    (() => {
      // 背景已按用户要求移到「坐标」与资源条之间（且不折叠），这里不再重复渲染
      return null;
    })(),
  ]) { if (__node) host.appendChild(__node); }
}

/** 一行简略摘要（给角色坞的悬停提示用） */
export function characterSummary(name) {
  const p2 = findRow(2, name);
  const p13 = findRow(13, name);
  const bits = [
    get(2, p2, '种族'),
    get(2, p2, '公开身份/职业'),
    get(2, p2, '等级'),
  ].filter(Boolean);
  const hp = num(get(13, p13, 'HP(当前)')); const mhp = num(get(13, p13, 'HP(上限)'));
  if (mhp) bits.push(`HP ${hp}/${mhp}`);
  return bits.join(' · ');
}

export { get as cardGet };
