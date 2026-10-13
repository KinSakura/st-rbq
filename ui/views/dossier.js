/**
 * dossier.js —— 角色卷宗（原状态栏的核心呈现）
 *
 * 这是"给用户看"的主界面：把分散在表2/3/4/13/5/9/10 里的同一个人的信息聚合成一张人物页。
 * 表格本身不再需要你去看 —— 那是给 AI 的存储格式。
 */

import * as store from '../../core/store.js';
import { getTable } from '../../core/schema.js';
import { resolveAttr } from '../../core/alias.js';   // 之前漏了这个 import → 用到时直接 ReferenceError
import { ctx } from '../../core/ctx.js';

const C5 = { from: 0, to: 1, surfaceRel: 2, privateRel: 4, affection: 6, possess: 8 };
const rows = (no) => store.getRows(no, { create: false });
/* 本文件原本缺这两个小工具（用到就 ReferenceError）—— 补齐，避免遗留渲染器一调用就崩 */
const s = (v) => (v === undefined || v === null ? '' : String(v)).trim();
const notify = (kind, msg) => { try { const c = ctx(); const k = kind === 'warning' ? 'warning' : (kind === 'error' ? 'error' : 'info'); if (c?.toastr?.[k]) c.toastr[k](String(msg ?? '')); } catch (e) { /* ignore */ } };

function get(no, row, name) {
  const t = getTable(no);
  if (!t || !row) return '';
  const hit = resolveAttr(no, name);
  let i = hit ? hit.index : -1;
  if (i < 0) i = t.columns.findIndex((c) => c === name || c.includes(name) || name.includes(c));
  return i < 0 ? '' : s(row[i]);
}
const cell = (r, i) => String(r?.[i] ?? '').trim();
const numOf = (v) => { const n = Number(String(v ?? '').replace(/[^\d.-]/g, '')); return Number.isFinite(n) ? n : 0; };

/** 按名字找行 */
function findRow(no, name) {
  const t = getTable(no);
  if (!t) return null;
  const r = rows(no).find((x) => String(get(no, x, 'name') ?? '').trim() === name);
  return r ? { table: t, row: r } : null;
}

/** 头像：优先酒馆角色卡 → 用户配置的覆盖表 → 首字母 */
export function avatarFor(name) {
  try {
    const cfg = store.getConfigValue('views.avatars', {}) ?? {};
    if (cfg[name]) return cfg[name];
  } catch { /* ignore */ }
  try {
    // 只有 user 或"当前正在扮演的那个角色本人"才读酒馆头像；NPC 一律不读（角色卡可能是多角色）
    const st = ctx?.() ?? null;
    const self = String(st?.name2 ?? st?.name ?? '').trim();
    const isUser = /^(user|你|我)$/i.test(String(name).trim());
    if (isUser || (self && String(name).trim() === self)) {
      const chars = st?.characters ?? [];
      const hit = chars.find((c) => String(c?.name ?? '') === String(name).trim()) ?? (self ? { avatar: st?.characters?.[0]?.avatar } : null);
      if (isUser && st?.userAvatar) return st.userAvatar.startsWith('/') ? st.userAvatar : '/User Avatars/' + encodeURIComponent(st.userAvatar);
      if (hit?.avatar) return '/characters/' + encodeURIComponent(hit.avatar);
    }
  } catch { /* ignore */ }
  return null;
}

function bar(label, cur, max, cls = '') {
  const pct = max > 0 ? Math.max(0, Math.min(100, Math.round((cur / max) * 100))) : 0;
  const wrap = document.createElement('div');
  wrap.className = 'rbq-stat';
  wrap.innerHTML = `<div class="rbq-stat-top"><span>${label}</span><span>${cur} / ${max}</span></div>
    <div class="rbq-stat-track"><div class="rbq-stat-fill ${cls}" style="width:${pct}%"></div></div>`;
  return wrap;
}

export function renderDossier(host, api) {
  const { el, notify } = api;
  host.textContent = '';

  const t2 = getTable(2);
  const chars = rows(2).map((r) => cell(r, 0)).filter(Boolean);
  if (!t2 || !chars.length) {
    host.appendChild(el('div', { class: 'rbq-empty', text: '还没有角色档案。' }));
    return;
  }

  // 在场集合
  let present = new Set();
  try {
    const t0 = getTable(0);
    const i = t0?.columns.indexOf('在场实体名单') ?? -1;
    const r0 = rows(0)[0];
    if (i >= 0 && r0) present = new Set(String(r0[i] ?? '').split(/[/,，、]/).map((s) => s.trim()).filter(Boolean));
  } catch { /* ignore */ }

  const onlyPresent = store.getConfigValue('views.dossierOnlyPresent', false);
  const shown = onlyPresent && present.size ? chars.filter((c) => present.has(c)) : chars;

  const state = api.state?.dossier ?? { name: shown[0] ?? chars[0], tab: 'profile' };
  if (!shown.includes(state.name)) state.name = shown[0] ?? chars[0];
  if (api.state) api.state.dossier = state;

  /* ---- 列表 ---- */
  const list = el('div', { class: 'rbq-dossier-list' });
  for (const c of shown) {
    const av = avatarFor(c);
    list.appendChild(el('div', {
      class: `rbq-dossier-item${c === state.name ? ' rbq-active' : ''}`,
      onclick: () => { state.name = c; api.rerender?.(); },
    }, [
      av
        ? el('img', { class: 'rbq-avatar', src: av, alt: c })
        : el('span', { class: 'rbq-avatar rbq-avatar-fallback', text: c.slice(0, 1) }),
      el('span', { class: 'rbq-dossier-name', text: c }),
      present.has(c) ? el('span', { class: 'rbq-dot', title: '在场' }) : null,
    ]));
  }

  /* ---- 主体 ---- */
  const main = el('div', { class: 'rbq-dossier-main' });
  const name = state.name;
  const p2 = findRow(2, name);
  const p3 = findRow(3, name);
  const p4 = findRow(4, name);
  const p13 = findRow(13, name);

  const colV = (pack, colName, fallback = '') => {
    if (!pack) return fallback;
    const i = pack.table.columns.indexOf(colName);
    return i >= 0 ? cell(pack.row, i) || fallback : fallback;
  };

  // 头部
  const av = avatarFor(name);
  const race = colV(p2, '种族');
  const job = colV(p2, '公开身份/职业');
  const level = colV(p2, '等级');
  const alive = colV(p2, '存活状态', 'Alive');
  main.appendChild(el('div', { class: 'rbq-dossier-head' }, [
    av ? el('img', { class: 'rbq-avatar rbq-avatar-lg', src: av, alt: name })
      : el('span', { class: 'rbq-avatar rbq-avatar-lg rbq-avatar-fallback', text: name.slice(0, 1) }),
    el('div', {}, [
      el('div', { class: 'rbq-dossier-title' }, [
        el('strong', { text: name }),
        race ? el('span', { class: 'rbq-badge', text: race }) : null,
        job ? el('span', { class: 'rbq-badge', text: job }) : null,
        level ? el('span', { class: 'rbq-badge', text: String(level).replace(/^Lv\.?/i, 'Lv.') }) : null,
        present.has(name) ? el('span', { class: 'rbq-badge rbq-ok', text: '在场' }) : el('span', { class: 'rbq-badge', text: '不在场' }),
        alive && alive !== 'Alive' ? el('span', { class: 'rbq-badge rbq-danger', text: alive }) : null,
      ]),
      el('div', { class: 'rbq-hint', text: [colV(p4, '微观坐标'), colV(p4, '躯干姿势'), colV(p4, '约束距离')].filter(Boolean).join(' · ') }),
    ]),
  ]));

  // 资源条
  if (p13) {
    const hp = numOf(colV(p13, 'HP(当前)')); const mhp = numOf(colV(p13, 'HP(上限)'));
    const mp = numOf(colV(p13, 'MP(当前)')); const mmp = numOf(colV(p13, 'MP(上限)'));
    const sp = numOf(colV(p13, 'SP(当前)')); const msp = numOf(colV(p13, 'SP(上限)'));
    const stats = el('div', { class: 'rbq-stats' }, [
      bar('HP', hp, mhp, 'rbq-hp'), bar('MP', mp, mmp, 'rbq-mp'), bar('SP', sp, msp, 'rbq-sp'),
    ]);
    main.appendChild(stats);
    // 异常状态
    try {
      const eff = rows(8).filter((r) => cell(r, 1) === name);
      if (eff.length) {
        main.appendChild(el('div', { class: 'rbq-chips' }, eff.map((r) => el('span', {
          class: 'rbq-chip rbq-chip-warn',
          text: `${cell(r, 0)}${cell(r, 5) ? `（${cell(r, 5)}）` : ''}`,
          title: `来源：${cell(r, 2) || '未知'}｜表现：${cell(r, 4) || '—'}｜剩余：${cell(r, 9) || '—'}`,
        }))));
      }
    } catch { /* ignore */ }
  }

  // 标签页
  const TABS = [
    ['profile', '档案', 2],
    ['physique', '生理', 3],
    ['state', '状态', 4],
    ['stats', '属性', 13],
    ['relations', '关系', 5],
    ['items', '持有', 9],
    ['skills', '技能', 10],
  ];
  const tabs = el('div', { class: 'rbq-subtabs' });
  const pane = el('div', { class: 'rbq-dossier-pane' });

  function renderTab() {
    pane.textContent = '';
    const pack = { profile: p2, physique: p3, state: p4, stats: p13 }[state.tab];

    if (pack) {
      const dl = el('dl', { class: 'rbq-kv' });
      pack.table.columns.forEach((c, i) => {
        const v = cell(pack.row, i);
        if (!v) return;
        dl.append(el('dt', { text: c }), el('dd', { text: v }));
      });
      pane.appendChild(dl);
      return;
    }
    if (state.tab === 'relations') {
      const out = rows(5).filter((r) => cell(r, C5.from) === name);
      const inc = rows(5).filter((r) => cell(r, C5.to) === name);
      if (!out.length && !inc.length) { pane.appendChild(el('div', { class: 'rbq-hint', text: '暂无关系记录。' })); return; }
      if (out.length) {
        const card = el('div', { class: 'rbq-card' }, [el('h4', { text: `${name} 眼中的别人` })]);
        for (const r of out) {
          card.appendChild(el('div', { class: 'rbq-audit-item' }, [
            el('span', { class: 'rbq-badge', text: cell(r, C5.to) }),
            el('span', { text: cell(r, C5.surfaceRel) || '—' }),
            cell(r, C5.privateRel) ? el('span', { class: 'rbq-hint', text: `内心：${cell(r, C5.privateRel)}` }) : null,
            cell(r, C5.affection) ? el('span', { class: 'rbq-hint', text: cell(r, C5.affection) }) : null,
          ]));
        }
        pane.appendChild(card);
      }
      if (inc.length) {
        const card = el('div', { class: 'rbq-card' }, [el('h4', { text: `别人眼中的 ${name}` })]);
        for (const r of inc) {
          card.appendChild(el('div', { class: 'rbq-audit-item' }, [
            el('span', { class: 'rbq-badge', text: cell(r, C5.from) }),
            el('span', { text: cell(r, C5.surfaceRel) || '—' }),
            cell(r, C5.affection) ? el('span', { class: 'rbq-hint', text: cell(r, C5.affection) }) : null,
          ]));
        }
        pane.appendChild(card);
      }
      return;
    }
    if (state.tab === 'items') {
      const mine = rows(9).filter((r) => cell(r, 1) === name);
      if (!mine.length) { pane.appendChild(el('div', { class: 'rbq-hint', text: `${name} 目前没有登记的物品。` })); return; }
      const t9 = getTable(9);
      for (const r of mine) {
        pane.appendChild(el('div', { class: 'rbq-audit-item' }, [
          el('span', { class: 'rbq-badge', text: cell(r, 2) || '物品' }),
          el('span', { text: cell(r, 0) }),
          cell(r, 3) ? el('span', { class: 'rbq-hint', text: `×${cell(r, 3)}` }) : null,
          cell(r, 5) ? el('span', { class: 'rbq-hint', text: cell(r, 5) }) : null,
          cell(r, 9) && cell(r, 9) !== '正常' ? el('span', { class: 'rbq-badge rbq-warn', text: cell(r, 9) }) : null,
        ]));
        void t9;
      }
      return;
    }
    if (state.tab === 'skills') {
      const poolRaw = colV(p2, '技能池');
      const list = String(poolRaw).split(/[丨|,，、[\]]/).map((s) => s.trim()).filter(Boolean);
      if (!list.length) { pane.appendChild(el('div', { class: 'rbq-hint', text: '技能池为空。' })); return; }
      for (const sk of list) {
        const sp = findRow(10, sk);
        const card = el('div', { class: 'rbq-card' }, [
          el('h4', { text: sk }),
          sp
            ? (() => {
              const dl = el('dl', { class: 'rbq-kv' });
              sp.table.columns.forEach((c, i) => {
                const v = cell(sp.row, i);
                if (v && i > 0) dl.append(el('dt', { text: c }), el('dd', { text: v }));
              });
              return dl;
            })()
            : el('div', { class: 'rbq-hint', text: '表10 里还没有这个技能的档案。' }),
        ]);
        pane.appendChild(card);
      }
      return;
    }
    pane.appendChild(el('div', { class: 'rbq-hint', text: '这个角色还没有相应数据。' }));
  }

  for (const [key, label, no] of TABS) {
    const has = !!({ profile: p2, physique: p3, state: p4, stats: p13 }[key]) || key === 'relations' || key === 'items' || key === 'skills';
    tabs.appendChild(el('button', {
      class: `rbq-subtab${state.tab === key ? ' rbq-active' : ''}${has ? '' : ' rbq-dim'}`,
      text: label,
      onclick: () => { state.tab = key; api.rerender?.(); },
    }));
    void no;
  }

  renderTab();
  main.append(tabs, pane);

  const bar2 = el('div', { class: 'rbq-viewbar' }, [
    el('span', { class: 'rbq-hint', text: `${shown.length}/${chars.length} 个角色` }),
    el('span', { class: 'rbq-spacer' }),
    el('span', { class: 'rbq-hint', text: '只看在场' }),
    (() => {
      const i = el('input', { type: 'checkbox', ...(onlyPresent ? { checked: true } : {}) });
      i.addEventListener('change', () => {
        store.updateConfig({ views: { dossierOnlyPresent: i.checked } });
        api.rerender?.();
      });
      return el('label', { class: 'rbq-switch' }, [i, el('span', { class: 'rbq-knob' })]);
    })(),
    el('button', {
      class: 'rbq-btn', text: '给这个角色设头像',
      onclick: () => {
        const url = prompt(`给「${name}」设置头像 URL（留空则清除）：`, store.getConfigValue('views.avatars', {})?.[name] ?? '');
        if (url === null) return;
        const cur = { ...(store.getConfigValue('views.avatars', {}) ?? {}) };
        if (url.trim()) cur[name] = url.trim(); else delete cur[name];
        store.updateConfig({ views: { avatars: cur } });
        notify('success', '头像已更新。');
        api.rerender?.();
      },
    }),
  ]);

  host.appendChild(el('div', { class: 'rbq-dossier' }, [list, main]));
  host.appendChild(bar2);
}

/**
 * 点头像改头像：本地图片 / 图片链接 / 清除。
 * 值存进配置 views.avatars[name]，avatarFor 会优先读它。
 */
export function openAvatarPicker(name, onDone, anchorEl) {
  try {
    const cur = (() => { try { return (store.getConfigValue("views.avatars", {}) ?? {})[name] ?? ""; } catch { return ""; } })();
    const setAv = (val) => {
      try {
        const map = Object.assign({}, store.getConfigValue("views.avatars", {}) ?? {});
        if (val) map[name] = val; else delete map[name];
        /* 【修 bug】以前写成 `store.setConfigValue || store.patchConfig || store.setConfig` ✗
           —— store 里这三个都**不存在** ✓（只有 updateConfig ✓）
           → 走到 else 分支又取一次 undefined ✗ → 头像**根本没写进去** ✗✓（用户实测"上传失败" ✓）
           正确做法：updateConfig 是**浅合并**✓ 所以要把 views 整体带上 ✓ */
        const views = Object.assign({}, store.getConfigValue("views", {}) ?? {});
        views.avatars = map;
        store.updateConfig({ views });
      } catch (e) { console.warn("[RBQ] 写头像失败", e); }
      try { onDone && onDone(); } catch (e) { /* ignore */ }
      /* 【用户实测】上传后角色卡不马上显示 ✗、视图坞头像也不变 ✗
         —— 因为只更新了那一张卡的节点 ✓ 别的视图没重建 ✓
         这里直接让面板整体重绘一次（角色卡与视图坞都在面板里 ✓ 一起更新 ✓） */
      try { if (window.RBQ && typeof RBQ.refresh === "function") RBQ.refresh(); } catch (e) { /* ignore */ }
    };
    const menu = document.createElement("div");
    menu.className = "rbq-avatar-menu";
    const file = document.createElement("input");
    file.type = "file"; file.accept = "image/*"; file.style.display = "none";
    file.addEventListener("change", () => {
      const f = file.files && file.files[0];
      if (!f) return;
      const fr = new FileReader();
      fr.onload = () => { setAv(String(fr.result || "")); menu.remove(); };
      fr.readAsDataURL(f);
    });
    const btn = (text, fn) => { const b = document.createElement("button"); b.type = "button"; b.className = "rbq-avatar-menu-item"; b.textContent = text; b.addEventListener("click", fn); return b; };
    menu.appendChild(btn("上传本地图片", () => file.click()));
    menu.appendChild(btn("填写图片链接", () => { const u = window.prompt("图片地址（http/https 或 data:）", cur || "https://"); if (u !== null) { setAv(u.trim()); menu.remove(); } }));
    if (cur) menu.appendChild(btn("清除自定义头像", () => { setAv(""); menu.remove(); }));
    menu.appendChild(btn("取消", () => menu.remove()));
    menu.appendChild(file);
    // 就近弹出：优先挂在面板里（相对面板定位，绝不用 fixed 居中）
    const panel = document.getElementById('rbq-panel') || document.body;
    panel.appendChild(menu);
    try {
      const pr = panel.getBoundingClientRect();
      const ar = anchorEl && anchorEl.getBoundingClientRect ? anchorEl.getBoundingClientRect() : null;
      const left = ar ? Math.max(8, Math.min(pr.width - 190, ar.left - pr.left + ar.width + 8)) : Math.max(8, pr.width / 2 - 90);
      const top = ar ? Math.max(8, ar.top - pr.top) : Math.max(8, pr.height / 2 - 80);
      menu.style.position = 'absolute';
      menu.style.left = Math.round(left) + 'px';
      menu.style.top = Math.round(top) + 'px';
      menu.style.transform = 'none';
    } catch (e) { /* ignore */ }
    const close = (ev) => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener("mousedown", close); } };
    setTimeout(() => document.addEventListener("mousedown", close), 0);
  } catch (e) { console.warn("[RBQ] 头像菜单失败", e); }
}
