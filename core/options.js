/**
 * options.js —— 行动选项（原 rbq.js 的四选一）
 *
 * RBQ 最招牌的用户向功能：每轮正文之后给玩家 4 个方向（好/坏/好坏参半/奇遇），
 * 点一下就把选项当成玩家输入发出去。
 *
 * 这里按"用户向"重做：
 *   · 面板里有一个专门的卡片显示本轮四个方向；
 *   · 同时（可关）在消息下方注入按钮，和旧版手感一致；
 *   · 点击 = 走酒馆原生发送通道，不再依赖自定义斜杠命令。
 */

import { doc, notify, ctx, chat, win } from '../core/ctx.js';
import * as store from '../core/store.js';
import { escapeHtml } from '../core/util.js';

const DIRS = ['好', '坏', '好坏参半', '奇遇'];
const TAG_RE = /<RP_OPTIONS>([\s\S]*?)<\/RP_OPTIONS>/i;
const CONTAINER_CLASS = 'rbq-options-container';

/* ------------------------------------------------------------------ 解析 */

/** 从一段文本里解析出四个方向 */
export function parseOptions(text) {
  const m = String(text ?? '').match(TAG_RE);
  if (!m) return null;
  const body = m[1];
  const out = {};
  for (const line of body.split('\n')) {
    const mm = line.match(/^\s*([^:：]{1,12})[:：]\s*(.+)$/);
    if (!mm) continue;
    const key = mm[1].trim();
    const val = mm[2].trim();
    if (!val) continue;
    // 先精确命中；再做包含匹配，且**取最长**的方向名 —— 否则「好坏参半」会被「好」抢走
    let hit = DIRS.find((d) => d === key);
    if (!hit) {
      const cands = DIRS.filter((d) => key.includes(d)).sort((a, b) => b.length - a.length);
      hit = cands[0];
    }
    out[hit ?? key] = val;
  }
  return Object.keys(out).length ? out : null;
}

/** 取最新一条 AI 消息上的选项 */
export function latestOptions() {
  const c = chat();
  for (let i = c.length - 1; i >= 0; i--) {
    const m = c[i];
    if (!m || m.is_user === true) continue;
    const opts = parseOptions(m.mes);
    if (opts) return { messageIndex: i, message: m, options: opts };
  }
  return null;
}

/* ------------------------------------------------------------------ 发送 */

/** 把选中的方向作为玩家输入发出去 */
export async function sendOption(dir, text) {
  const payload = `【行动选项·${dir}】${text}`;
  const c = ctx();
  try {
    if (typeof c?.executeSlashCommandsWithOptions === 'function') {
      await c.executeSlashCommandsWithOptions(`/send ${payload}`);
      return true;
    }
  } catch (e) { console.warn('[RBQ] /send 失败', e); }
  try {
    const th = win()?.TavernHelper ?? win()?.parent?.TavernHelper;
    if (typeof th?.triggerSlash === 'function') { await th.triggerSlash(`/send ${payload}`); return true; }
  } catch (e) { console.warn('[RBQ] TavernHelper /send 失败', e); }
  // 最后兜底：直接写进输入框，用户自己按发送
  try {
    const d = doc();
    const ta = d?.querySelector('#send_textarea');
    if (ta) {
      ta.value = payload;
      ta.dispatchEvent(new win().Event('input', { bubbles: true }));
      notify('info', '选项已填进输入框，按发送即可。');
      return true;
    }
  } catch { /* ignore */ }
  notify('error', '找不到可用的发送通道，选项内容：' + payload);
  return false;
}

/* ------------------------------------------------------- 消息内注入按钮 */

/** 在带 <RP_OPTIONS> 的消息下面注入按钮（与旧版手感一致，可在设置里关掉） */
export function injectButtons() {
  // 四选一是**开关功能**：没开就不注入（原版也是启动了才有）
  if (store.getConfigValue('features.options', false) !== true) return 0;
  const d = doc();
  if (!d) return 0;
  const c = chat();
  let n = 0;
  for (let i = 0; i < c.length; i++) {
    const m = c[i];
    if (!m || m.is_user === true) continue;
    const opts = parseOptions(m.mes);
    const block = d.querySelector(`#chat .mes[mesid="${i}"] .mes_text, #chat .mes[mesid="${i}"]`);
    if (!block) continue;
    const exist = block.querySelector(`.${CONTAINER_CLASS}`);
    if (!opts) { exist?.remove(); continue; }
    if (exist?.dataset.sig === JSON.stringify(opts)) continue;
    exist?.remove();
    const box = d.createElement('div');
    box.className = CONTAINER_CLASS;
    box.dataset.sig = JSON.stringify(opts);
    for (const [dir, text] of Object.entries(opts)) {
      const b = d.createElement('button');
      b.className = 'rbq-option-btn';
      b.type = 'button';
      b.title = text;
      b.innerHTML = `<b>${escapeHtml(dir)}</b><span>${escapeHtml(String(text).slice(0, 60))}</span>`;
      b.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        sendOption(dir, text);
      });
      box.appendChild(b);
    }
    if (i > 0 || opts) block.appendChild(box);
    n++;
  }
  return n;
}

export function clearButtons() {
  doc()?.querySelectorAll(`.${CONTAINER_CLASS}`).forEach((x) => x.remove());
}


/* ------------------------------------------------------- 全自动 RP（原版功能） */

export function optionsEnabled() {
  return store.getConfigValue('features.options', false) === true;
}
export function setOptionsEnabled(on) {
  store.updateConfig({ features: { options: !!on } });
  if (!on) clearButtons();
  return optionsEnabled();
}
export function autoRpEnabled() {
  return store.getConfigValue('features.autoRp', false) === true;
}
export function setAutoRp(on) {
  store.updateConfig({ features: { autoRp: !!on } });
  return autoRpEnabled();
}
export function autoRpMode() {
  return store.getConfigValue('features.autoRpMode', 'random') || 'random';
}
export function setAutoRpMode(m) {
  store.updateConfig({ features: { autoRpMode: m } });
  return autoRpMode();
}

/**
 * 全自动 RP：开了四选一并开了自动，就在最新楼层有选项时自动替你选一个发出去。
 * 同一层只自动选一次，避免循环生成。
 */
export async function maybeAutoRp() {
  if (!optionsEnabled() || !autoRpEnabled()) return null;
  const latest = latestOptions();
  if (!latest) return null;
  const last = Number(store.getConfigValue('features.autoRpLastMessage', -1));
  if (last === latest.messageIndex) return null;
  const entries = Object.entries(latest.options);
  if (!entries.length) return null;
  const pick = autoRpMode() === 'first' ? entries[0] : entries[Math.floor(Math.random() * entries.length)];
  store.updateConfig({ features: { autoRpLastMessage: latest.messageIndex } });
  console.log(`[RBQ] 全自动 RP：选了「${pick[0]}」`);
  notify('info', `全自动 RP：选了「${pick[0]}」`);
  await sendOption(pick[0], pick[1]);
  return { dir: pick[0], text: pick[1] };
}
