/**
 * ui/views/extrasLines.js —— 旁白 / CG / 小剧场：读"挂在楼层上"的数据，最新在前
 *  数据来源：每条 AI 消息的 msg.rbqdb_extra = { aside, cg, zilla, at, round }
 *  这样即使回退/删除楼层，剩余楼层上的内容还在（不会因为删了末尾就全看不到）
 */
const s = (v) => String(v ?? '').trim();

function collect(kind) {
  try {
    const c = globalThis.SillyTavern?.getContext?.();
    const chat = c?.chat ?? [];
    const out = [];
    chat.forEach((m, i) => {
      if (!m || m.is_user) return;
      const box = m.rbqdb_extra ?? null;
      if (!box) return;
      // 兼容三种键：新存法（对象）/ 旧存法（字符串）
      let val = '';
      if (typeof box === 'string') val = box;
      else if (kind === 'aside') val = box.aside ?? '';
      else if (kind === 'cg') val = box.cg ?? '';
      else val = box.zilla ?? '';
      const txt = s(val);
      if (txt) out.push({ floor: i, round: box.round ?? null, at: box.at ?? null, text: txt, name: box.name ?? '' });
    });
    return out.reverse();
  } catch { return []; }
}

function shell(host, title, hint, list, render) {
  host.textContent = '';
  const head = document.createElement('div');
  head.className = 'rbq-card';
  const h = document.createElement('h4');
  h.textContent = title + (list.length ? '（共 ' + list.length + ' 条，最新在前）' : '');
  head.appendChild(h);
  if (hint) {
    const p = document.createElement('div');
    p.className = 'rbq-hint';
    p.textContent = hint;
    head.appendChild(p);
  }
  host.appendChild(head);

  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'rbq-card';
    const e = document.createElement('div');
    e.className = 'rbq-hint';
    e.textContent = '还没有内容。开启「附加功能」里对应的开关后，侧路 API 生成的内容会挂在这一层楼里，回退楼层也不会丢。';
    empty.appendChild(e);
    host.appendChild(empty);
    return;
  }

  for (const item of list) {
    const card = document.createElement('div');
    card.className = 'rbq-card';
    const meta = document.createElement('div');
    meta.className = 'rbq-hint';
    meta.textContent = '第 ' + (item.floor + 1) + ' 楼' + (item.round ? ' · 第 ' + item.round + ' 轮' : '') + (item.at ? ' · ' + new Date(item.at).toLocaleTimeString() : '');
    card.appendChild(meta);
    const body = document.createElement('div');
    body.className = 'rbq-line-body';
    render(body, item);
    card.appendChild(body);
    host.appendChild(card);
  }
}

const textRenderer = (body, item) => {
  body.textContent = '';
  for (const line of String(item.text).split(/\n+/)) {
    const p = document.createElement('div');
    p.textContent = line;
    body.appendChild(p);
  }
};

export function renderAside(host) { shell(host, '旁白点评', '侧路 API 按楼层生成，随楼层保留。', collect('aside'), textRenderer); }
export function renderCg(host) { shell(host, 'CG 画面', '侧路 API 按楼层生成，随楼层保留。', collect('cg'), textRenderer); }
export function renderZilla(host) { shell(host, '小剧场', '侧路 API 按楼层生成，随楼层保留。', collect('zilla'), textRenderer); }

/**
 * 合并入口：只渲染"已开启"的附加内容（旁白 / CG / 小剧场）。
 * 面板的「附加」视图调用它。
 */
export function renderExtras(host, sub) {
  const on = enabledKinds(sub);
  if (!on.length) {
    const box = document.createElement("div");
    box.className = "rbq-empty";
    box.textContent = "还没有开启任何附加内容（旁白 / CG / 小剧场）。开启后这里会按楼层列出。";
    host.appendChild(box);
    return;
  }
  if (on.indexOf("narration") >= 0) renderAside(host);
  if (on.indexOf("cg") >= 0) renderCg(host);
  if (on.indexOf("theater") >= 0) renderZilla(host);
}

/** 已开启的附加种类：兼容 extras.get(k).enabled / extras.isEnabled(k) / 聊天变量三种形状 */
function enabledKinds(sub) {
  const KEYS = ["narration", "cg", "theater"];
  const out = [];
  for (const k of KEYS) {
    let on = false;
    try {
      const ex = sub && sub.extras;
      if (ex) {
        if (typeof ex.isEnabled === "function") on = !!ex.isEnabled(k);
        else if (typeof ex.get === "function") { const v = ex.get(k); on = !!(v && (v.enabled === undefined ? v : v.enabled)); }
      }
    } catch (e) { /* ignore */ }
    out.push(on ? k : null);
  }
  if (out.some(Boolean)) return out.filter(Boolean);
  // 兜底：看聊天变量（与原 rbq.js 一致）
  try {
    const st = window.SillyTavern && window.SillyTavern.getContext && window.SillyTavern.getContext();
    const vars = (st && st.chatMetadata && st.chatMetadata.variables) || {};
    const map = { narration: "narrationPromptActive", cg: "cgPromptActive", theater: "theaterPromptActive" };
    for (const k of KEYS) { const v = String(vars[map[k]] || "").trim(); if (v) out.push(k); }
  } catch (e) { /* ignore */ }
  return out.filter(Boolean);
}
