/**
 * util.js —— 无依赖的小工具集合
 */

/* ------------------------------------------------------------------ 哈希 */

/** FNV-1a 32 位；输出 6 位 base36，用于"这一格和上一轮比变了没" */
export function hashCell(value) {
  const s = value == null ? '' : String(value);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(36).padStart(6, '0');
}

export function hashRow(row) {
  return hashCell((row ?? []).join('\u0001'));
}

/** 整表哈希：列签名 + 每行签名，用于快速判断表是否被外部改动 */
export function hashTable(rows) {
  const parts = [];
  for (const r of rows ?? []) parts.push(hashRow(r));
  return hashCell(parts.join('\u0002'));
}

/* ------------------------------------------------------------------ 字符串 */

/** 归一化：去空白、去全角/半角差异、去常见标点、转小写 */
export function normalize(s) {
  if (s == null) return '';
  return String(s)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[·・.,，。;；:：!！?？"'“”‘’()（）\[\]【】{}<>《》\/\\|_\-—~～`^*+]/g, '');
}

/** 编辑距离（带上限，超过 limit 直接返回 limit+1 以省时间） */
export function editDistance(a, b, limit = 3) {
  const s = String(a ?? ''), t = String(b ?? '');
  if (s === t) return 0;
  if (Math.abs(s.length - t.length) > limit) return limit + 1;
  const m = s.length, n = t.length;
  let prev = new Array(n + 1);
  let cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= n; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > limit) return limit + 1;
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

/** 把任意值安全转成"单元格字符串"（与旧插件一致：统一 String 化） */
export function cellStr(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try { return JSON.stringify(v); } catch { return String(v); }
}

/* ------------------------------------------------------------------ 深拷贝 */

export function clone(v) {
  if (v == null || typeof v !== 'object') return v;
  try {
    return structuredClone(v);
  } catch {
    try { return JSON.parse(JSON.stringify(v)); } catch { return v; }
  }
}

/* ------------------------------------------------------------------ 异步 */

export function debounce(fn, wait = 300) {
  let timer = null;
  const wrapped = (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fn(...args); }, wait);
  };
  wrapped.cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
  return wrapped;
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 轮询等待条件成立（替代"睡固定毫秒"的写法）
 * @returns {Promise<boolean>} 是否在超时前满足
 */
export async function waitFor(check, { timeout = 3000, interval = 60 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    let ok = false;
    try { ok = !!check(); } catch { ok = false; }
    if (ok) return true;
    if (Date.now() >= deadline) return false;
    await sleep(interval);
  }
}

/* ------------------------------------------------------------------ 文本 */

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 取一段文本的"可读截断" */
export function truncate(s, n = 120) {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/** 生成短 id */
export function uid(prefix = '') {
  const r = Math.random().toString(36).slice(2, 8);
  return `${prefix}${Date.now().toString(36)}${r}`;
}
