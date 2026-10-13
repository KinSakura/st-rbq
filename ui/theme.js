/**
 * theme.js —— 主题与动态背景
 *
 * 三套内置配色 + 跟随酒馆；动态背景纯 CSS（渐变 + 缓慢漂移的星点），
 * 不加载任何外部图片/字体，避免拖慢酒馆。
 *
 * 配色令牌（对齐参考状态栏的纸面质感，同时保留暗色可用性）：
 *   --rbq-bg / --rbq-bg-elev / --rbq-bg-sunken / --rbq-border / --rbq-border-strong
 *   --rbq-text / --rbq-text-dim / --rbq-text-mut / --rbq-accent / --rbq-ok / --rbq-warn / --rbq-danger
 */

import * as store from '../core/store.js';
import { doc, win } from '../core/ctx.js';

export const THEMES = {
  midnight: {
    label: '午夜',
    vars: {
      '--rbq-bg': '#0f1117', '--rbq-bg-elev': '#171a22', '--rbq-bg-sunken': '#0b0d12',
      '--rbq-border': '#262b36', '--rbq-border-strong': '#3a4150',
      '--rbq-text': '#e6e8ee', '--rbq-text-dim': '#a9b0bf', '--rbq-text-mut': '#7b8296',
      '--rbq-accent': '#d9a441', '--rbq-ok': '#4fbf7f', '--rbq-warn': '#d29922', '--rbq-danger': '#e0574c',
      '--rbq-bg-image': 'radial-gradient(1200px 620px at 18% -12%, rgba(217,164,65,0.18), transparent 62%), radial-gradient(900px 520px at 108% 8%, rgba(120,86,32,0.16), transparent 60%)',
    },
  },
  parchment: {
    label: '纸面（参考状态栏）',
    vars: {
      '--rbq-bg': '#eae5da', '--rbq-bg-elev': '#f0f7f4', '--rbq-bg-sunken': '#e0dbcf',
      '--rbq-border': '#b3bfb8', '--rbq-border-strong': '#7e8d85',
      '--rbq-text': '#2f3a33', '--rbq-text-dim': '#4d5a52', '--rbq-text-mut': '#7e8d85',
      '--rbq-accent': '#3c493f', '--rbq-ok': '#2f7d4f', '--rbq-warn': '#9a6b1f', '--rbq-danger': '#a83a33',
      '--rbq-bg-image': 'linear-gradient(180deg, rgba(60,73,63,0.06), transparent 40%)',
    },
  },
  crimson: {
    label: '血色',
    vars: {
      '--rbq-bg': '#141011', '--rbq-bg-elev': '#1e1719', '--rbq-bg-sunken': '#0d0a0b',
      '--rbq-border': '#33262a', '--rbq-border-strong': '#4d383d',
      '--rbq-text': '#f0e7e6', '--rbq-text-dim': '#bda9a8', '--rbq-text-mut': '#8a7575',
      '--rbq-accent': '#d4574f', '--rbq-ok': '#4aa96c', '--rbq-warn': '#d9a441', '--rbq-danger': '#e0453c',
      '--rbq-bg-image': 'radial-gradient(1000px 520px at 15% -15%, rgba(212,87,79,0.18), transparent 60%)',
    },
  },
  jade: {
    label: '青玉',
    vars: {
      '--rbq-bg': '#0d1414', '--rbq-bg-elev': '#141d1d', '--rbq-bg-sunken': '#0a1010',
      '--rbq-border': '#22302f', '--rbq-border-strong': '#354846',
      '--rbq-text': '#e3eeec', '--rbq-text-dim': '#a6bab7', '--rbq-text-mut': '#768986',
      '--rbq-accent': '#3fb8a8', '--rbq-ok': '#4bbf7a', '--rbq-warn': '#d0a63f', '--rbq-danger': '#e2635a',
      '--rbq-bg-image': 'radial-gradient(1100px 560px at 80% -10%, rgba(63,184,168,0.16), transparent 62%)',
    },
  },
};

export function currentTheme() {
  return store.getConfigValue('theme.name', 'follow') || 'follow';
}
export function dynamicBackground() {
  return store.getConfigValue('theme.dynamicBackground', true) !== false;
}

/** 从酒馆当前主题里猜一个底色（跟随模式用） */
function probeHostTheme() {
  try {
    const d = doc();
    if (!d) return null;
    const cs = win()?.getComputedStyle?.(d.body);
    if (!cs) return null;
    const bg = cs.getPropertyValue('background-color');
    const fg = cs.getPropertyValue('color');
    if (!bg) return null;
    const isLight = (() => {
      const m = bg.match(/(\d+)\D+(\d+)\D+(\d+)/);
      if (!m) return false;
      const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
      return (r * 299 + g * 587 + b * 114) / 1000 > 150;
    })();
    return { bg, fg, isLight };
  } catch { return null; }
}

/**
 * 应用主题到面板根节点（以及浮层，因为浮层挂在 body 上）。
 */
export function applyTheme(root) {
  const name = currentTheme();
  const d = doc();
  if (!d) return;
  const targets = [root, d.getElementById('rbq-panel'), d.getElementById('rbq-input-btn')].filter(Boolean);
  const theme = THEMES[name];
  for (const t of targets) {
    if (!t.style) continue;
    // 先清掉旧的
    for (const k of Object.keys(THEMES.midnight.vars)) t.style.removeProperty(k);
    if (theme) {
      for (const [k, v] of Object.entries(theme.vars)) t.style.setProperty(k, v);
    } else if (name === 'follow') {
      // 跟随酒馆：只覆盖底色/文字，强调色保留
      const h = probeHostTheme();
      if (h) {
        t.style.setProperty('--rbq-bg', h.bg);
        t.style.setProperty('--rbq-text', h.fg);
        t.style.setProperty('--rbq-text-dim', h.fg);
      }
    }
    t.dataset.rbqTheme = name;
    t.dataset.rbqDynamicBg = dynamicBackground() ? 'on' : 'off';
  }
}

export function setTheme(name) {
  store.updateConfig({ theme: { name } });
  applyTheme(doc()?.getElementById('rbq-panel'));
}

export function setDynamicBackground(on) {
  store.updateConfig({ theme: { dynamicBackground: !!on } });
  applyTheme(doc()?.getElementById('rbq-panel'));
}
