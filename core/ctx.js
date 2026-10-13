/**
 * ctx.js —— SillyTavern 上下文适配层
 *
 * 设计目标：
 *  1. 所有对外部 API 的依赖都收敛在这里，其它模块不直接碰 window / SillyTavern。
 *  2. 兼容新旧酒馆版本（宏注册有两套 API；事件对象有 eventSource / event_types）。
 *  3. 兼容"扩展在顶层文档"与"扩展被塞进 iframe"两种运行形态（旧酒馆助手脚本的历史包袱）。
 */

const STATE = {
  ctx: null,
  doc: null,
  win: null,
};

/** 取 SillyTavern 全局对象（可能在 window 或 window.parent 上） */
function findSillyTavern() {
  const candidates = [];
  try { if (typeof window !== 'undefined') candidates.push(window); } catch { /* ignore */ }
  try { if (typeof window !== 'undefined' && window.parent && window.parent !== window) candidates.push(window.parent); } catch { /* ignore */ }
  try { if (typeof window !== 'undefined' && window.top && window.top !== window.parent) candidates.push(window.top); } catch { /* ignore */ }
  for (const w of candidates) {
    try {
      if (w && w.SillyTavern && typeof w.SillyTavern.getContext === 'function') return w.SillyTavern;
    } catch { /* ignore */ }
  }
  return null;
}

export function st() {
  return findSillyTavern();
}

/** 主上下文；取不到时返回一个安全空壳，避免调用处到处判空 */
export function ctx() {
  if (STATE.ctx) {
    try {
      // getContext() 的结果可能随聊天切换而变化，每次重新取，但缓存失败结果以便快速返回
      const fresh = st()?.getContext?.();
      if (fresh) STATE.ctx = fresh;
    } catch { /* 保留旧值 */ }
    return STATE.ctx;
  }
  try {
    STATE.ctx = st()?.getContext?.() ?? null;
  } catch {
    STATE.ctx = null;
  }
  return STATE.ctx;
}

/**
 * 解析出"界面所在的文档"。
 * 优先用 #send_form 所属文档，因为我们要把按钮插到那里 —— 这样按钮/面板/样式一定同域。
 */
export function doc() {
  try {
    if (typeof document !== 'undefined') {
      const send = document.querySelector?.('#send_form, #send_but');
      if (send?.ownerDocument) return send.ownerDocument;
    }
  } catch { /* ignore */ }
  if (STATE.doc) return STATE.doc;
  try {
    if (typeof window !== 'undefined' && window.parent && window.parent !== window && window.parent.document?.body) {
      STATE.doc = window.parent.document;
      return STATE.doc;
    }
  } catch { /* 跨域，忽略 */ }
  if (typeof document !== 'undefined') STATE.doc = document;
  return STATE.doc;
}

export function win() {
  const d = doc();
  try { return d?.defaultView || (typeof window !== 'undefined' ? window : null); } catch { return null; }
}

/* ------------------------------------------------------------------ 事件 */

export function eventSource() {
  const c = ctx();
  return c?.eventSource ?? st()?.eventSource ?? null;
}

export function eventTypes() {
  const c = ctx();
  return c?.eventTypes ?? st()?.eventTypes ?? {};
}

/**
 * 安全注册事件；事件名不存在时静默跳过并记录，避免"写错事件名永远不触发"这种静默失败。
 * @returns {boolean} 是否注册成功
 */
const eventWarnings = new Set();
export function on(eventName, handler) {
  const src = eventSource();
  if (!src || typeof src.on !== 'function') return false;
  if (!eventName) return false;
  if (eventTypes() && Object.values(eventTypes()).length > 0 && !Object.values(eventTypes()).includes(eventName)) {
    if (!eventWarnings.has(eventName)) {
      eventWarnings.add(eventName);
      console.warn(`[RBQ] 当前酒馆没有事件 "${eventName}"，该监听已跳过。`);
    }
    return false;
  }
  src.on(eventName, handler);
  return true;
}

/** 用常量名注册事件（优先 event_types.X，取不到再用字符串 X） */
export function onType(typeKey, handler) {
  const t = eventTypes()?.[typeKey];
  return on(t ?? typeKey, handler);
}

/* ------------------------------------------------------------- 聊天/存储 */

export function chat() {
  const c = ctx();
  return Array.isArray(c?.chat) ? c.chat : [];
}

export function chatMetadata() {
  const c = ctx();
  if (!c) return null;
  if (!c.chatMetadata) c.chatMetadata = {};
  return c.chatMetadata;
}

export function chatId() {
  const c = ctx();
  return c?.getCurrentChatId?.() ?? c?.chatId ?? c?.chatMetadata?.chat_id ?? '';
}

export async function saveChat() {
  const c = ctx();
  /* 【别在没聊天文件时乱存】还没有 chat_id / 聊天是空的时侯调酒馆的 saveChat()，
     酒馆会刷一串 warning：`saveChat called without chat_name and no chat file found` ✗
     （页面控制台被它刷满，用户会以为插件出错了 ✓）
     所以：没有聊天标识就跳过 ✓（数据在 chatMetadata 里已经改好了，等有聊天了自然会被保存 ✓） */
  try {
    const hasChat = Boolean(c?.getCurrentChatId?.() ?? c?.chatId ?? c?.chatMetadata?.chat_id) || (Array.isArray(c?.chat) && c.chat.length > 1);
    if (!hasChat) return undefined;
  } catch (e) { /* ignore */ }
  try {
    if (typeof c?.saveChat === 'function') return await c.saveChat();
  } catch (e) {
    console.warn('[RBQ] saveChat 失败', e);
  }
  return undefined;
}

export function extensionSettings() {
  const c = ctx();
  if (c && !c.extensionSettings) c.extensionSettings = {};
  return c?.extensionSettings ?? null;
}

export function saveSettings() {
  const c = ctx();
  try {
    if (typeof c?.saveSettingsDebounced === 'function') return c.saveSettingsDebounced();
    if (typeof c?.saveSettings === 'function') return c.saveSettings();
  } catch (e) {
    console.warn('[RBQ] saveSettings 失败', e);
  }
  return undefined;
}

/* ------------------------------------------------------------------ 宏 */

/**
 * 注册宏。返回 true 表示成功。
 * 支持三种宿主形态：新 API（macros.registry）、旧 API（registerMacro(name, fn)）、
 * 以及 registerMacro(name, {handler}) 中间形态。
 */
export function registerMacro(name, handler, description = '') {
  const c = ctx();
  const s = st();
  // 新版本
  try {
    const registry = c?.macros?.registry ?? s?.macros?.registry;
    if (registry && typeof registry.registerMacro === 'function') {
      registry.registerMacro(name, { description, handler });
      return true;
    }
  } catch (e) { console.warn(`[RBQ] 注册宏 ${name}（新 API）失败`, e); }
  // 旧版本
  try {
    const fn = c?.registerMacro ?? s?.registerMacro;
    if (typeof fn === 'function') {
      try {
        fn.call(c ?? s, name, handler);
      } catch {
        fn.call(c ?? s, name, { description, handler });
      }
      return true;
    }
  } catch (e) { console.warn(`[RBQ] 注册宏 ${name}（旧 API）失败`, e); }
  return false;
}

/* ------------------------------------------------------------- 其它小工具 */

export function toastr() {
  const w = win();
  return w?.toastr ?? (typeof window !== 'undefined' ? window.toastr : null) ?? null;
}

export function notify(kind, message, title = 'RBQ', opts = {}) {
  const t = toastr();
  if (t && typeof t[kind] === 'function') {
    try {
      // sticky：一直显示到我们自己关掉（用于"侧路运行中…"这类进度）
      const o = opts.sticky
        ? { timeOut: 0, extendedTimeOut: 0, tapToDismiss: false, closeButton: true, progressBar: false, newestOnTop: true }
        : Object.assign({ closeButton: true, progressBar: true, newestOnTop: true }, opts);
      const el = t[kind](message, title, o);
      if (opts.sticky) return el;                     // 返回元素，完成时 .remove()
      return el;
    } catch { /* ignore */ }
  }
  console.log('[RBQ][' + kind + '] ' + title + ': ' + message);
  return null;
}

/** 关掉一个 notify 返回的吐司（jQuery 元素或 DOM 节点都兼容） */
export function closeNotify(el) {
  try { if (!el) return; if (typeof el.remove === 'function') el.remove(); else if (el[0] && el[0].remove) el[0].remove(); } catch { /* ignore */ }
}

export function popupType(key, fallback) {
  return ctx()?.POPUP_TYPE?.[key] ?? fallback;
}

/** 换聊天时清掉缓存，强制重新取上下文 */
export function invalidate() {
  STATE.ctx = null;
  STATE.doc = null;
}
