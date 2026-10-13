/**
 * sideApi.js —— 侧路 API 客户端（独立于主 API）
 *
 * 设计要点（与用户约定）：
 *   · 默认**开启**；但**没填 URL/Key 时自动回退用主 API**（ctx.generateRaw），避免"默认报错"。
 *   · 支持超时、指数退避重试、最大并发（信号量）、AbortController 取消。
 *   · 四个任务各自可开关：填表 / 记忆提炼 / 大总结 / 附加功能（默认前三开，附加关）。
 *   · 提示词模板存在配置里（可改成"优化模板"）。
 *
 * 测试友好：__setMock(fn) 可注入假传输层。
 */

import * as store from './store.js';
import { ctx } from './ctx.js';

/* ------------------------------------------------------------------ 默认配置 */

export const DEF_PROMPTS = {
  fill: [
    '你是数据抽取器。任务：阅读下面这段已经写完的正文，把**其中真实发生的事实**写进数据库。',
    '只输出 <data> 表格写入指令，不要解释、不要复述正文、不要输出别的文字。',
    '',
    '正文里真实发生的事实**一个都不要漏**（位置/时间/天气变化、登场、离场、受伤、态度变化、得失物品、',
    '技能、任务、异常状态、大事件……）；也不要概括、不要只挑重要的写、不要写“等”“之类”。',
    '确实没有变化的项目不要写。',
    '',
    '================ 一、写入协议（必须严格遵守）================',
    '{协议}',
    '',
    '================ 二、当前数据（写之前先看这里，避免重复/冲突）================',
    '{当前数据}',
    '',
    '================ 三、本轮正文（要抽取的事实都在这里）================',
    '{正文}',
    '',
  ].join('\n'),

  memory: [
    '阅读下面的正文，为**在场的每个角色**各写一段角色记忆。',
    '在场角色（只给这些角色写）：{在场角色}',
    '严格按这个格式输出（可以有多段；没有可写的就不输出）：',
    '<character_memory name="角色名">',
    '【感知】',
    '【情绪】',
    '【意图】',
    '【记忆锚点】',
    '</character_memory>',
    '',
    '规则：',
    '1. 必须是**第一人称**（角色自己的口吻），每条 15-40 字。',
    '2. 只写角色**亲身经历/感知**到的事，不要写别人的内心。',
    '3. 禁极端词（"永远""绝对"），写具体细节。',
    '',
    '正文：',
    '{正文}',
  ].join('\n'),

  summary: [
    '根据下面这一区间的「每轮小总结」，为表12（宏观纪事录压缩封包表）生成**一条** <epoch> 记录。',
    '只输出 <data> 里的 <epoch …/> 标签，不要解释、不要复述。',
    '',
    '标签写法（属性名用中文列名，值写在引号里）：',
    '{表12写法}',
    '',
    '本次要总结的轮次范围：{范围}',
    '',
    '下面是这一区间每一轮的小总结（时间顺序）：',
    '{正文}',
  ].join(String.fromCharCode(10)),
  extras: [
    '阅读下面的正文，按下面要求的格式输出。',
    '只输出要求的标签，不要解释、不要复述正文。',
    '',
    '{要写的}',
    '',
    '正文：',
    '{正文}',
  ].join(String.fromCharCode(10)),
};

export const DEF = {
  enabled: true,
  url: '',
  key: '',
  model: '',
  maxConcurrency: 3,        // 用户要求：默认并发 3 ✓
  timeoutMs: 120000,         // 用户要求：默认 120 秒超时 ✓
  retries: 3,
  backoffMs: 1000,
  skipMainTableSegment: true, // 开了侧路就不再让主 API 填表（省 token）
  tasks: { fill: true, memory: true, summary: true, extras: false },
  prompts: DEF_PROMPTS,
};

/* ------------------------------------------------------------------ 配置读写 */

/** 老版本存过的填表模板（缺"你的职责"段）→ 一律换新默认，用户不用手动改 */
const STALE_FILL_MARKERS = ['正文里真实发生的事实'];

/* 防自触发回环：侧路走酒馆主 API（generateRaw）时会**再触发一次 GENERATION_ENDED**，
   如果不忽略，就会被当成"新一轮生成结束"而重复处理（参考 xingv2.6 的 planningGuard_ACU 做法）。 */
let ignoreNextGenerationEnded = 0;

/** 取一次"忽略"配额（返回 true 表示这次事件应被忽略） */
export function takeIgnoreGenerationEnded() {
  if (ignoreNextGenerationEnded > 0) { ignoreNextGenerationEnded -= 1; return true; }
  return false;
}

/* 最近一次侧路失败的原因（面板上直接显示 ✓ 用户不用开控制台也能看到） */
let lastErr = { message: '', url: '', status: 0, at: 0 };
export function lastError() { return { ...lastErr }; }
export function clearLastError() { lastErr = { message: '', url: '', status: 0, at: 0 }; }
function lastErrorSet(message, info = {}) {
  lastErr = { message: String(message || ''), url: String(info.url || ''), status: Number(info.status) || 0, at: Date.now() };
  try { console.warn('[RBQ] 侧路失败：' + lastErr.message); } catch (e) { /* ignore */ }
}
function lastErrorClear() { lastErr = { message: '', url: '', status: 0, at: 0 }; }

export function config() {
  const c = store.getConfigValue('sideApi', {}) ?? {};
  return {
    ...DEF,
    ...c,
    // 一次性迁移：老版本把默认值存成过 false，导致"侧路没默认开启"→ 复位为 true（只做一次）
    enabled: (() => {
      try {
        const REV = 1;
        const rev = Number(c.configRev ?? 0);
        if (rev !== REV) { store.updateConfig({ sideApi: { ...c, enabled: true, configRev: REV } }); return true; }
      } catch (e) { /* ignore */ }
      return c.enabled === undefined ? DEF.enabled : !!c.enabled;
    })(),
    tasks: { ...DEF.tasks, ...(c.tasks ?? {}) },
    prompts: (() => {
      const merged = { ...DEF_PROMPTS, ...(c.prompts ?? {}) };
      // 迁移：老填表模板（没有"你的职责"段）直接换成新默认
      try {
        const f = String(merged.fill ?? '');
        // 新版协议：不再兼容任何旧提示词模板 → 版本号变了就整体复位（一次性）
        const REV = 2;
        if (Number(merged.promptsRev ?? 0) !== REV) {
          merged.fill = DEF_PROMPTS.fill;
          merged.summary = DEF_PROMPTS.summary;
          merged.extras = DEF_PROMPTS.extras;
          merged.promptsRev = REV;
        }
        if (f.trim() && !STALE_FILL_MARKERS.some((m) => f.includes(m))) merged.fill = DEF_PROMPTS.fill;
      } catch { /* ignore */ }
      return merged;
    })(),
  };
}

export function setConfig(patch = {}) {
  const cur = config();
  const next = {
    ...cur,
    ...patch,
    tasks: { ...cur.tasks, ...(patch.tasks ?? {}) },
    prompts: { ...cur.prompts, ...(patch.prompts ?? {}) },
  };
  store.updateConfig({ sideApi: next });
  return next;
}

export function setTask(name, on) { return setConfig({ tasks: { [name]: !!on } }); }
export function setPrompt(name, text) { return setConfig({ prompts: { [name]: String(text ?? '') } }); }
export function isConfigured() { const c = config(); return !!(String(c.url).trim() && String(c.key).trim()); }

/** 酒馆里有没有配好可用的 API（有 generateRaw 就能用） */
export function hasMainApi() {
  try { return typeof ctx()?.generateRaw === 'function'; } catch { return false; }
}

/** 侧路能不能干活：要么填了独立接口，要么用酒馆当前的 API */
export function isUsable() { return isConfigured() || hasMainApi(); }

/** 这一轮会走哪条通道 */
export function channel() { return isConfigured() ? 'side' : (hasMainApi() ? 'main' : 'none'); }
export function enabled() { return config().enabled !== false; }

/* ------------------------------------------------------------------ 测试注入 */

let mock = null;
export function __setMock(fn) { mock = fn; }
export function __clearMock() { mock = null; }
export function __hasMock() { return !!mock; }

/* ------------------------------------------------------------------ 并发闸 */

const gate = { active: 0, waiters: [] };
async function acquire(max) {
  if (gate.active < max) { gate.active++; return; }
  await new Promise((r) => gate.waiters.push(r));
  gate.active++;
}
function release() {
  gate.active = Math.max(0, gate.active - 1);
  const w = gate.waiters.shift();
  if (w) w();
}
export function gateState() { return { active: gate.active, waiting: gate.waiters.length }; }

/* ------------------------------------------------------------------ 工具 */

export function sleep(ms, signal = null) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal?.addEventListener) {
      signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
    }
  });
}

export function withTimeout(promise, ms, onTimeout) {
  if (!ms || ms <= 0) return promise;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { try { onTimeout?.(); } catch { /* ignore */ } reject(new Error('侧路超时（' + ms + 'ms）')); }, ms);
    Promise.resolve(promise).then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/** 指数退避 + 抖动重试 */
export async function withRetry(fn, { retries = 3, backoffMs = 1000, onAttempt = null, signal = null } = {}) {
  let last = null;
  for (let i = 0; i <= retries; i++) {
    try {
      onAttempt?.(i + 1, null);          // 每次尝试开始就报数（成功也算一次）
      return await fn(i);
    } catch (e) {
      last = e;
      try { onAttempt?.(i + 1, e); } catch { /* ignore */ }
      if (i >= retries) break;
      if (signal?.aborted) break;
      const wait = Math.round(backoffMs * Math.pow(2, i) * (0.7 + Math.random() * 0.6));
      await sleep(Math.min(wait, 15000), signal);
    }
  }
  throw last ?? new Error('侧路调用失败');
}

/* ------------------------------------------------------------------ 错误诊断 */

/** 把常见失败翻译成人话（面板直接显示） */
export function hintOf(err) {
  const m = String((err && err.message) || err || '');
  if (/Failed to fetch|NetworkError|ERR_|load failed/i.test(m)) {
    return '网络不可达，或被浏览器 CORS 拦截（地址要填到 …/v1 为止；跨域需服务端允许）';
  }
  if (/\b401\b|\b403\b/.test(m)) return 'Key 无效或没权限（检查 Key 是否正确、是否带 Bearer）';
  if (/\b404\b/.test(m)) return '路径不对（地址应填到 …/v1，插件会自动加 /chat/completions）';
  if (/\b429\b/.test(m)) return '被限流（降低并发或稍后重试）';
  if (/\b5\d\d\b/.test(m)) return '对方服务端错误（稍后重试）';
  if (/超时/.test(m)) return '超时（模型太慢或地址不通，可在本页调大超时）';
  if (/未配置/.test(m)) return '没填 URL/Key：侧路不会运行';
  return m;
}

/* ------------------------------------------------------------------ 主调用 */

/**
 * 调一次侧路。未配置时回退主 API（ctx.generateRaw）。
 * @returns {Promise<string>} 模型输出文本
 */
/** 参考 xingv2.6：让模型先"进入填表状态"（预填 assistant 开头） */
const THOUGHT_PREFILL = '<thought>收到指令，我将一步一步开始思考，并完成填表：先逐张表对照当前数据，看这一轮每张表分别需要新增、更新还是删除，再输出 <data>。</thought>';

export async function call(prompt, { system = '', extras = null, task = 'fill', temperature = 0.3, maxTokens = 1400, signal = null } = {}) {
  /* 【用户要求】侧路这一发**全部按「系统」身份发** ✓
       · 预设标记进来的内容（不管预设里设的是系统/用户/AI 助手）→ 系统 ✓
       · 提示词本体 + 正文 → 也走系统 ✓
     所以最终就是：一条 system（内容全在里面）+ 一条 assistant（思考预填 ✓） */
  const exText = Array.isArray(extras) ? extras.map((x) => String(x?.content ?? '')).filter((x) => x.trim()).join('\n\n') : '';
  const asSystem = [system, exText, prompt].map((x) => String(x ?? '')).filter((x) => x.trim()).join('\n\n');
  if (mock) return await mock(prompt, { system, task, temperature, signal, extras });

  const c = config();
  if (!isConfigured()) {
    // 没填独立接口 → 用酒馆里配置好的那个 API（ST 的 generateRaw 会走它自己的连接设置）
    ignoreNextGenerationEnded += 1;   // 这一发会触发一次 GENERATION_ENDED，先记账
    const g = ctx()?.generateRaw;
    if (typeof g !== 'function') throw new Error('没有可用 API：既没填侧路 URL/Key，酒馆也没配好连接');
    const full = asSystem + '\n\n' + THOUGHT_PREFILL;
    const out = await g({ prompt: full, quietToLoud: false });
    return String(out ?? '');
  }

  await acquire(Math.max(1, Number(c.maxConcurrency) || 3));
  try {
    const url = String(c.url).trim().replace(/\/+$/, '') + '/chat/completions';
    /* 用户可以在面板上填「输出上限」把上限抬高（只抬不降 ✓ 不填就用各任务自带的值） */
    const capUser = Number(c.maxTokens) || 0;
    const useMax = capUser > 0 ? Math.max(capUser, maxTokens) : maxTokens;
    const body = {
      model: c.model || undefined,
      temperature,
      max_tokens: useMax,
      messages: [
        { role: 'system', content: asSystem },
        { role: 'assistant', content: THOUGHT_PREFILL },   // 预填思考开头，逼模型进入填表模式（参考 xingv2.6）
      ],
    };
    /* 【审计发现】以前只在"调用方没给 signal"时才建 AbortController ✗
       → 真实链路一直传 ac.signal → onTimeout 里的 ctrl?.abort() 是空操作 ✗
       → 超时只 reject 不断开 → 槽位提前释放、并发上限被击穿 + 请求泄漏 ✓
       现在：无论有没有调用方 signal 都建一个 ✓ 并把两边串起来（任一中止都能断 ✓） */
    let ctrl = null;
    let sig = signal;
    if (typeof AbortController === 'function') {
      ctrl = new AbortController();
      if (signal && typeof signal.addEventListener === 'function') {
        try { if (signal.aborted) ctrl.abort(); else signal.addEventListener('abort', () => ctrl.abort(), { once: true }); } catch (e) { /* ignore */ }
      }
      sig = ctrl.signal;
    }
    const res = await withTimeout(fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + c.key },
      body: JSON.stringify(body),
      signal: sig,
    }), Number(c.timeoutMs) || DEF.timeoutMs, () => { try { ctrl?.abort(); } catch { /* ignore */ } });
    if (!res.ok) {
      /* 【用户反馈 · 看不到失败原因】以前只带一个 HTTP 码 ✗ 把服务器真正说的话丢了 ✓
         现在把响应体也抓出来（很多坑只能从这里看出来：
           模型名写错 → model not found；key 不对 → invalid api key；
           超过上下文 → context length exceeded；被反代挡了 → 一段 HTML ✓） */
      let detail = '';
      try { detail = await res.text(); } catch (e) { /* ignore */ }
      /* 服务端嫌 max_tokens 太大 → 自动降到 8192 再试一次 ✓（不同服务上限差别很大 ✓） */
      if (res.status === 400 && /max_?tokens/i.test(String(detail)) && useMax > 4096) {
        try {
          /* 逐级下探：24000 → 16000 → 8192 → 4096，哪一档服务端接受就用哪一档 ✓ */
          const ladder = [16000, 8192, 4096].filter((x) => x < useMax);
          for (const step of ladder) {
            try {
              const rs = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + c.key }, body: JSON.stringify({ ...body, max_tokens: step }), signal: sig });
              if (!rs.ok) continue;
              const rawS = await rs.text();
              const jS = JSON.parse(rawS);
              try { console.warn('[RBQ] 服务端不接受 max_tokens=' + useMax + ' → 已自动降到 ' + step + ' 重试成功 ✓'); } catch (e) { /* ignore */ }
              lastErrorClear();
              return String(jS?.choices?.[0]?.message?.content ?? '');
            } catch (e) { /* 继续下一档 */ }
          }
          const res2 = await (async () => null)();
          /* 上面已用逐级下探处理完毕 */
        } catch (e) { /* ignore，继续走原来的报错 */ }
      }
      detail = String(detail || '').replace(/\s+/g, ' ').trim().slice(0, 400);
      const msg = '侧路 HTTP ' + res.status + (detail ? ('：' + detail) : ('：' + hintOf('HTTP ' + res.status)));
      lastErrorSet(msg, { url, status: res.status });
      throw new Error(msg);
    }
    let raw = '';
    try { raw = await res.text(); } catch (e) { /* ignore */ }
    let j = null;
    try { j = JSON.parse(raw); } catch (e) {
      const short = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 300);
      const msg = '侧路返回的不是 JSON（可能是反向代理/登录页/被拦了）：' + short;
      lastErrorSet(msg, { url, status: res.status });
      throw new Error(msg);
    }
    const fin = String(j?.choices?.[0]?.finish_reason ?? '');
    const out = String(j?.choices?.[0]?.message?.content ?? '');
    /* 输出被截断 = <data> 断掉 = 填表失败 ✓ 必须让人一眼看到原因 ✓ */
    if (fin === 'length') {
      const msg = '侧路输出被截断（max_tokens=' + useMax + ' 用完了）—— 表格没填完或者 JSON 断了。'
        + ' 处理：把上面「输出上限」调大，或把「填表」改成只更新必要的表 ✓';
      lastErrorSet(msg, { url, status: res.status });
      try { console.warn('[RBQ] ' + msg); } catch (e) { /* ignore */ }
      /* 截断的输出仍然交给上层去解析（可能还能救回一部分）✓ 但先记下原因 ✓ */
    }
    if (!out && j?.error) {
      const msg = '侧路返回了错误：' + JSON.stringify(j.error).slice(0, 300);
      lastErrorSet(msg, { url, status: res.status });
      throw new Error(msg);
    }
    lastErrorClear();
    return out;
  } finally {
    release();
  }
}

/** 自检：发一句最短的请求，返回 {ok, message} */
export async function testConnection() {
  if (!isConfigured()) return { ok: false, message: '未配置 URL/Key（将回退主 API）' };
  try {
    const out = await withRetry(() => call('回复两个字：可用', { temperature: 0, maxTokens: 16 }), { retries: 1, backoffMs: 500 });
    return { ok: true, message: '侧路可用：' + String(out).slice(0, 20) };
  } catch (e) {
    return { ok: false, message: '侧路失败：' + String(e?.message ?? e) };
  }
}
