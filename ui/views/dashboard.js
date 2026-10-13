/**
 * dashboard.js —— 沉浸式仪表盘（把所有视图收进"一条 HUD + 一个大视口"）
 *
 * 参考 DND 沉浸式仪表盘的分区，对应到 RBQ：
 *   顶部状态条   轮次徽章 · 地点 · 时间 · 天气/氛围 · 世界法则
 *   大视口       地图 / 关系图 / 纪事 …（整块画布，不是卡片列表）
 *   行动选项     A/B/C/D 四格（原 RBQ 的四选一）
 *   任务条       当前进行中的任务一行
 *   角色坞       一排圆形头像，每个头像下是自己的 HP 条与等级 —— 点开是这个人的角色卡
 *
 * 关键点：**角色相关的东西不再散在多个标签页里**，全部收进角色卡（characterCard.js），
 * 从角色坞点开即得。
 */

import * as store from '../../core/store.js';
import { getTable } from '../../core/schema.js';
import { resolveAttr } from '../../core/alias.js';

const rows = (no) => store.getRows(no, { create: false });
const s = (v) => String(v ?? '').trim();
const num = (v) => { const n = Number(s(v).replace(/[^\d.-]/g, '')); return Number.isFinite(n) ? n : 0; };

function get(no, row, name) {
  const t = getTable(no);
  if (!t || !row) return '';
  const hit = resolveAttr(no, name);
  let i = hit ? hit.index : -1;
  if (i < 0) i = t.columns.findIndex((c) => c === name || c.includes(name) || name.includes(c));
  return i < 0 ? '' : s(row[i]);
}

/** 状态栏 chip：内联 SVG 图标 + 文本（不用 emoji，避免字体把图标渲染成一根竖线/带空白） */
function chipEl(kind, value, extraCls) {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  const __VB = { time: "1 1 14 14", weather: "2 6 13 7", mood: "1 1 14 14", law: "1 1 14 14" };   // 每个图标各自的绘制范围（云朵只占 x2~15、y6~12）
  svg.setAttribute("viewBox", __VB[kind] || "0 0 16 16");
  svg.setAttribute("class", "rbq-chip-ic");
  svg.setAttribute("preserveAspectRatio", "xMinYMid meet");   // 强制左对齐：多余空间一律留到右边，绝不留左边
  const PATH = {
    time: ["M8 3v5l3 2", "M8 15A7 7 0 1 0 8 1a7 7 0 0 0 0 14z"],
    weather: ["M3.5 12h8.5a3 3 0 0 0 .3-6A4.5 4.5 0 0 0 4 7.2 2.6 2.6 0 0 0 3.5 12z"],
    mood: ["M8 15A7 7 0 1 0 8 1a7 7 0 0 0 0 14z", "M5.6 9.6 8 12l2.4-2.4"],
    law: ["M8 2v12", "M3 5h10", "M3 5 1 10h4z", "M13 5l2 5h-4z"],
  };
  for (const d of (PATH[kind] || [])) {
    const pa = document.createElementNS(NS, "path");
    pa.setAttribute("d", d);
    svg.appendChild(pa);
  }
  const box = document.createElement("span");
  box.className = "rbq-hud-chip" + (extraCls ? " " + extraCls : "");
  box.title = String(kind) + "：" + String(value);
  box.appendChild(svg);
  const tx = document.createElement("span");
  tx.className = "rbq-chip-tx";
  tx.textContent = String(value).replace(/[｜丨|]/g, "").trim();
  box.appendChild(tx);
  return box;
}
function avatarFor(name) {
  try {
    const cfg = store.getConfigValue('views.avatars', {}) ?? {};
    // 【用户实测】点了「清除自定义头像」还是一张图 ✗ → 因为会回退到角色卡头像 ✓
    //   现在：键存在就听它的（空串 = 明确要首字 ✓）
    if (Object.prototype.hasOwnProperty.call(cfg, name)) return cfg[name] || null;
    if (cfg[name]) return cfg[name];
  } catch { /* ignore */ }
  try {
    const ch = (window.SillyTavern?.getContext?.()?.characters ?? []).find((c) => s(c?.name) === s(name));
    if (ch?.avatar) return `/characters/${encodeURIComponent(ch.avatar)}`;
  } catch { /* ignore */ }
  return null;
}

/** 在场名单 */
function presentSet() {
  const t0 = getTable(0);
  const r0 = rows(0)[0];
  const v = get(0, r0, '在场实体名单');
  void t0;
  return new Set(s(v).split(/[/,，、]/).map((x) => x.trim()).filter(Boolean));
}

export function renderDashboard(host, api) {
  const { el } = api;
  host.textContent = '';

  const t0 = getTable(0);
  const w0 = t0 ? rows(0)[0] : null;
  const location = get(0, w0, '绝对位置名称') || '未知地点';
  const time = get(0, w0, '时空坐标');
  const weather = get(0, w0, '环境气象');
  const mood = get(0, w0, '安全氛围');
  const law = get(0, w0, '世界法则');
  const roundRaw = s(t0 && w0 ? w0[0] : '');
  // 【用户提醒】空表时不该显示 279（那是消息条数/版本号 ✗）→ 没有真实轮次就显示 1 ✓
  const __hasData = (() => { try { return getTables().some((x) => (store.getRows(x.no, { create: false }) ?? []).length > 0); } catch { return false; } })();
  const round = /^\d+$/.test(roundRaw) && Number(roundRaw) > 0 ? roundRaw : (__hasData ? String(store.getRev()) : '1');

  /* ============================ 顶部状态条 ============================ */
  const top = el('div', { class: 'rbq-hud-top' }, [
    el('div', { class: 'rbq-hud-medal', title: `第 ${round} 轮` }, [
      el('span', { class: 'rbq-hud-medal-num', text: round }),
      el('span', { class: 'rbq-hud-medal-cap', text: '轮' }),
    ]),
    el('div', { class: 'rbq-hud-where' }, [
      el('div', { class: 'rbq-hud-place', text: location }),
      el('div', { class: 'rbq-hud-chips' }, [
        time ? chipEl('time', time) : null,
        weather ? chipEl('weather', weather) : null,
        mood ? chipEl('mood', mood) : null,
        law ? chipEl('law', law, 'rbq-hud-chip-law') : null,
      ].filter(Boolean)),
    ]),
    el('span', { class: 'rbq-spacer' }),
  ]);

  /* ============================ 大视口 ============================ */
  const viewport = el('div', { class: 'rbq-hud-viewport' });
  // 注意：各视图渲染器开头都会 host.textContent = ''，而它们是动态 import、比这里晚执行。
  // 所以内容必须进一个**内层容器**，罗盘/标题挂外层，否则会被擦掉。
  const viewportInner = el('div', { class: 'rbq-hud-vbody' });
  viewport.appendChild(viewportInner);
  try {
    api.renderViewport?.(api.currentView, viewportInner);
  } catch (e) {
    console.error('[RBQ] 视口渲染失败', e);
    viewportInner.appendChild(el('div', { class: 'rbq-empty', text: `渲染出错：${e?.message ?? e}` }));
  }

  // 视图标题 + 右下角罗盘浮钮（不再用一排标签切换）
  viewport.appendChild(el('div', { class: 'rbq-hud-vtitle' }, [
    el('span', { text: (api.views.find(([k]) => k === api.currentView) ?? ['', '视图'])[1] }),
    el('span', { class: 'rbq-hud-vhint', text: '点右下 ✦ 切换' }),
  ]));
  const compass = el('button', { class: 'rbq-compass', title: '切换视图' }, [el('span', { text: '✦' })]);
  const compassMenu = el('div', { class: 'rbq-compass-menu' });
  // 版本号放菜单顶部（菜单每次打开都会重建，不会像标题那样被覆盖）
  compassMenu.appendChild(el('div', { class: 'rbq-ver-head', text: 'RBQ v2.9.6' }));
  for (const [key, label] of api.views) {
    const item = el('button', {
      class: `rbq-compass-item${api.currentView === key ? ' rbq-active' : ''}`,
      text: label,
    });
    // 显式绑定（不依赖 el 对 on* 属性的支持），点击后关掉菜单并切视图
    item.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      compassMenu.classList.remove('rbq-open');
      try { api.setView?.(key); } catch (err) { console.warn('[RBQ] 切视图失败', key, err); }
    });
    compassMenu.appendChild(item);
  }
  compass.addEventListener('click', (e) => { e.stopPropagation(); compassMenu.classList.toggle('rbq-open'); });
  viewport.append(compass, compassMenu);

  /* ============================ 任务条 ============================ */
  const questStrip = el('div', { class: 'rbq-hud-quests' });
  try {
    const list = rows(7).filter((r) => get(7, r, 'name') || s(r[0]));
    const active = list.filter((r) => !/已完成|完成|失败|作废/.test(get(7, r, '推进状态')));
    const show = (active.length ? active : list).slice(0, 3);
    for (const r of show) {
      const name = get(7, r, '任务名称') || get(7, r, 'name') || s(r[0]);
      const cat = get(7, r, '行动类别');
      const state = get(7, r, '推进状态');
      const goal = get(7, r, '物理目标');
      questStrip.appendChild(el('div', { class: 'rbq-hud-quest' }, [
        el('span', { class: 'rbq-hud-quest-icon', text: '⚒' }),
        el('div', { class: 'rbq-hud-quest-main' }, [
          el('div', { class: 'rbq-hud-quest-head' }, [
            el('span', { class: 'rbq-hud-quest-name', text: name }),
            cat ? el('span', { class: 'rbq-hud-quest-cat', text: cat }) : null,
          ]),
          el('div', { class: 'rbq-hud-quest-sub', text: [state, goal].filter(Boolean).join(' · ') || '—' }),
        ]),
      ]));
    }
    if (!show.length) questStrip.appendChild(el('div', { class: 'rbq-hud-quest-empty', text: '当前没有进行中的任务' }));
  } catch (e) {
    questStrip.appendChild(el('div', { class: 'rbq-hud-quest-empty', text: `任务读取失败：${e?.message ?? e}` }));
  }

  /* ============================ 角色坞 ============================ */
  const present = presentSet();
  const allNames = rows(2).map((r) => get(2, r, 'name') || s(r[0])).filter(Boolean);
  const names = allNames.length ? allNames : [...present];
  const order = [...names].sort((a, b) => (present.has(b) ? 1 : 0) - (present.has(a) ? 1 : 0));

  const dock = el('div', { class: 'rbq-hud-dock' });
  for (const n of order) {
    const isPresent = present.has(n);
    const row13 = rows(13).find((r) => get(13, r, 'name') === n) ?? null;
    const hp = num(get(13, row13, 'HP(当前)'));
    const mhp = num(get(13, row13, 'HP(上限)'));
    const mp2 = num(get(13, row13, 'MP(当前)'));
    const mmp = num(get(13, row13, 'MP(上限)'));
    const sp2 = num(get(13, row13, 'SP(当前)'));
    const msp = num(get(13, row13, 'SP(上限)'));
    const lv = get(2, rows(2).find((r) => get(2, r, 'name') === n) ?? null, '等级');
    const pctOf = (a, b) => (b > 0 ? Math.max(0, Math.min(100, (a / b) * 100)) : 0);
    const av = avatarFor(n);
    const btn = el('button', {
      class: `rbq-hud-portrait${isPresent ? ' rbq-present' : ''}${api.selectedCharacter === n ? ' rbq-selected' : ''}`,
      /* 【用户要求】一圈分成三段：HP / MP / SP，各自用对应颜色 ✓ */
      title: `${n}${isPresent ? '（在场）' : ''}`
        + (mhp ? ` · HP ${hp}/${mhp}` : '') + (mmp ? ` · MP ${mp2}/${mmp}` : '') + (msp ? ` · SP ${sp2}/${msp}` : ''),
    }, [
      /* 【修 bug】以前这里写成 `av ? 首字 : 首字` ✗ —— 两边都是首字 ✓
         于是**上传了头像也不会显示** ✗✓（用户实测"下面的头像还是没变" ✓）
         正确：有头像就渲染 <img>，没有才用首字兜底 ✓ */
      av ? el('img', { class: 'rbq-hud-portrait-img', src: av, alt: n, title: n })
        : el('span', { class: 'rbq-hud-portrait-fallback', text: n.slice(0, 1), title: n }),
      (mhp || mmp || msp) ? (() => {
        const NSsvg = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(NSsvg, 'svg');
        svg.setAttribute('viewBox', '0 0 48 48');
        svg.setAttribute('class', 'rbq-hud-hpring rbq-hud-3ring');
        const RR = 21;
        const CC = 2 * Math.PI * RR;
        /* 三段平均分（每段 1/3 圆周，留 5 的缝），每段再按自己的百分比填充 ✓ */
        const segLen = Math.max(4, CC / 3 - 5);
        const parts = [
          [hp, mhp, 'rbq-ring-hp'],
          [mp2, mmp, 'rbq-ring-mp'],
          [sp2, msp, 'rbq-ring-sp'],
        ];
        parts.forEach(([cur, max, cls], i) => {
          const off = (CC / 3) * i;
          const rows2 = [['bg', segLen, 'rbq-ring-bg'], ['fg', segLen * (max > 0 ? pctOf(cur, max) / 100 : 0), cls]];
          for (const [suffix, len, extra] of rows2) {
            const c2 = document.createElementNS(NSsvg, 'circle');
            c2.setAttribute('cx', '24'); c2.setAttribute('cy', '24'); c2.setAttribute('r', String(RR));
            c2.setAttribute('class', 'rbq-hud-hpring-' + suffix + ' ' + extra);
            c2.setAttribute('stroke-dasharray', `${Math.max(0, len).toFixed(1)} ${(CC + 20).toFixed(1)}`);
            c2.setAttribute('stroke-dashoffset', String(-off));
            c2.setAttribute('transform', 'rotate(-90 24 24)');
            svg.appendChild(c2);
          }
        });
        return svg;
      })() : null,
      el('span', { class: 'rbq-hud-name', text: String(n || '').trim().slice(0, 6) || s(lv) }),   // 头像下显示角色名（不要等级）
      isPresent ? el('span', { class: 'rbq-hud-live' }) : null,
    ]);
    btn.addEventListener('click', () => api.pickCharacter?.(n));
    dock.appendChild(btn);
  }
  if (!order.length) dock.appendChild(el('div', { class: 'rbq-hint', text: '还没有角色档案（AI 建角色后这里会出现头像）' }));

  host.append(top, viewport, questStrip, dock);
  // 悬浮球挂在角色坞那一行的最右边（不再压在内容上）
  try { dock.append(compass); } catch { /* ignore */ }
  try { host.append(compassMenu); } catch { /* ignore */ }   // 菜单挂 HUD 层，避免被角色坞的 overflow 裁掉
}
