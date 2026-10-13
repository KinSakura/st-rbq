/**
 * regexWorkshop.js —— 正则工坊（照你 RBQ 配置菜单里的「🔧正则」做的）
 *
 * 你的原版是七步向导：
 *   ① 检索类型   标签 / 文本 / 符号 / 高级正则
 *   ② 内容       标签名（不含 <>）/ 要检索的文本 / 符号（逗号分隔）/ 完整正则
 *   ③ 标签处理模式（仅"标签"时）  整个块（含内容）/ 仅标签本身（保留内容）/ 保留标签，清空内容
 *   ④ 处理方式   完全删除 / 对用户隐藏 / 对AI隐藏 / 替换为
 *   ⑤ 作用范围   AI 输出 / 用户输入 / 斜杠命令
 *   ⑥ 脚本名称   自动加 `RBQ-` 前缀
 *   ⑦ 预览
 *   高级：runOnEdit / 深度限制 minDepth~maxDepth
 *
 * 这里把同样的逻辑实现成可编程的 buildScript(spec)，界面在设置页里。
 */

import { ctx, notify } from './ctx.js';

/** ST 正则的 placement：1=用户输入 2=AI 输出 3=斜杠命令 */
export const SOURCE_TO_PLACEMENT = { user: 1, ai: 2, slash: 3 };

/** ④ 处理方式 → ST 的两个开关 */
const ACTION_FLAGS = {
  // 完全删除：显示和提示词都去掉
  delete: { markdownOnly: false, promptOnly: false },
  // 对用户隐藏：用户看不到，AI 仍能收到 → 只作用于显示
  hideUser: { markdownOnly: true, promptOnly: false },
  // 对AI隐藏：AI 收不到，用户仍能看到 → 只作用于提示词
  hideAI: { markdownOnly: false, promptOnly: true },
  // 替换为：两边都替换
  replace: { markdownOnly: false, promptOnly: false },
};

export const ACTIONS = [
  ['delete', '完全删除', '显示和提示词都去掉'],
  ['hideUser', '对用户隐藏', '用户看不到，但 AI 仍能收到'],
  ['hideAI', '对AI隐藏', 'AI 收不到，但用户仍能看到'],
  ['replace', '替换为', '两边都替换成你写的文本'],
];

export const TAG_MODES = [
  ['block', '整个块（含内容）', '把 <tag>…</tag> 连内容一起处理'],
  ['tagOnly', '仅标签本身（保留内容）', '只去掉 <tag> 和 </tag>，内容留下'],
  ['keepTagClearContent', '保留标签，清空内容', '标签还在，里面变空'],
];

export const SEARCH_TYPES = [
  ['tag', '标签', '输入不带尖括号的标签名，例如 data 会匹配 <data>…</data>'],
  ['text', '文本', '要检索的文本，特殊字符自动转义'],
  ['symbol', '符号', '要处理的符号，多个用逗号分隔，例如 *,_ ,~'],
  ['advanced', '高级正则', '直接写完整正则，形如 /<data[\\s\\S]*?<\\/data>/gsi'],
];

/** 正则里要转义的字符 */
const esc = (s) => String(s ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 把向导里的七步编译成一条酒馆正则脚本。
 * @param {object} spec
 * @param {string} spec.searchType  tag|text|symbol|advanced
 * @param {string} spec.content     标签名 / 文本 / 符号串 / 完整正则
 * @param {string} [spec.tagMode]   block|tagOnly|keepTagClearContent
 * @param {string} spec.action      delete|hideUser|hideAI|replace
 * @param {string} [spec.replaceText]
 * @param {string[]} spec.sources   ['ai','user','slash'] 的子集
 * @param {string} spec.name        会加 RBQ- 前缀
 * @param {boolean} [spec.runOnEdit]
 * @param {number|null} [spec.minDepth]
 * @param {number|null} [spec.maxDepth]
 * @returns {{ok:boolean, script?:object, error?:string}}
 */
export function buildScript(spec = {}) {
  const {
    searchType = 'tag', content = '', tagMode = 'block', action = 'delete',
    replaceText = '', sources = ['ai'], name = '未命名',
    runOnEdit = false, minDepth = null, maxDepth = null,
  } = spec;

  if (!String(content).trim()) return { ok: false, error: '② 内容没填' };
  if (!sources.length) return { ok: false, error: '⑤ 作用范围至少要选一个' };

  let findRegex = '';
  let replaceString = '';

  if (searchType === 'advanced') {
    const raw = String(content).trim();
    if (!/^\/.+\/[a-z]*$/i.test(raw)) return { ok: false, error: '高级正则要写成 /pattern/flags 的形式' };
    findRegex = raw;
  } else if (searchType === 'tag') {
    const tag = String(content).trim().replace(/^<|>$/g, '').replace(/[^\w\u4e00-\u9fa5-]/g, '');
    if (!tag) return { ok: false, error: '标签名不合法' };
    if (tagMode === 'block') {
      findRegex = `/<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>/gi`;
    } else if (tagMode === 'tagOnly') {
      findRegex = `/<${tag}\\b[^>]*>|<\\/${tag}>/gi`;
    } else {
      findRegex = `/<${tag}\\b([^>]*)>[\\s\\S]*?<\\/${tag}>/gi`;
      replaceString = `<${tag}$1></${tag}>`;
    }
  } else if (searchType === 'text') {
    findRegex = `/${esc(String(content).trim())}/gi`;
  } else if (searchType === 'symbol') {
    const syms = String(content).split(/[,，]/).map((x) => x.trim()).filter(Boolean).map(esc);
    if (!syms.length) return { ok: false, error: '没解析出符号' };
    findRegex = `/[${syms.join('')}]/g`;
  } else {
    return { ok: false, error: '未知的检索类型' };
  }

  // 替换文本：只有"替换为"和"保留标签清空内容"才用得上
  if (action === 'replace') replaceString = String(replaceText ?? '');
  else if (action !== 'delete' && !replaceString) replaceString = '';

  const flags = ACTION_FLAGS[action] ?? ACTION_FLAGS.delete;
  const placement = sources.map((s) => SOURCE_TO_PLACEMENT[s]).filter(Boolean).sort((a, b) => a - b);

  return {
    ok: true,
    script: {
      id: `rbq-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}`,
      scriptName: String(name).startsWith('RBQ-') ? String(name) : `RBQ-${String(name || '未命名').trim()}`,
      findRegex,
      replaceString,
      trimStrings: [],
      placement,
      disabled: false,
      markdownOnly: flags.markdownOnly,
      promptOnly: flags.promptOnly,
      runOnEdit: !!runOnEdit,
      substituteRegex: 0,
      minDepth: minDepth === '' || minDepth === null || minDepth === undefined ? null : Number(minDepth),
      maxDepth: maxDepth === '' || maxDepth === null || maxDepth === undefined ? null : Number(maxDepth),
    },
  };
}

/** 给界面用的预览文本 */
export function previewOf(spec) {
  const r = buildScript(spec);
  if (!r.ok) return `⚠ ${r.error}`;
  const s = r.script;
  const flags = [s.markdownOnly ? '仅显示' : '', s.promptOnly ? '仅提示词' : '', (!s.markdownOnly && !s.promptOnly) ? '显示+提示词' : ''].filter(Boolean).join(' / ');
  const scope = Object.entries(SOURCE_TO_PLACEMENT).filter(([, v]) => s.placement.includes(v)).map(([k]) => ({ ai: 'AI 输出', user: '用户输入', slash: '斜杠命令' }[k])).join(' + ');
  return [
    `脚本名：${s.scriptName}`,
    `findRegex：${s.findRegex}`,
    `replaceString：${s.replaceString === '' ? '（空）' : s.replaceString}`,
    `处理方式：${actionLabel(s)}（${flags}）`,
    `作用范围：${scope || '—'}`,
    s.runOnEdit ? '编辑消息时也应用：是' : null,
    s.minDepth != null || s.maxDepth != null ? `深度：${s.minDepth ?? '不限'} ~ ${s.maxDepth ?? '不限'}` : null,
  ].filter(Boolean).join('\n');
}

function actionLabel(s) {
  if (s.markdownOnly) return '对用户隐藏';
  if (s.promptOnly) return '对AI隐藏';
  return '完全删除 / 替换';
}

/* ---------------------------------------------------------------- 安装 / 管理 */

const PREFIX = 'RBQ-';

/**
 * 让酒馆的「正则」扩展重新渲染它自己的列表 ✓
 *   实测：往 extension_settings.regex 里 push 之后，ST 的扩展页不会自动更新 ✗
 *   → 必须刷新页面才看得到 ✗（用户报的就是这个 ✓）
 *   酒馆正则扩展导出 `init()` ✓ 调它就会重建界面 ✓
 */
async function refreshSTRegexUI() {
  try {
    const mod = await import('/scripts/extensions/regex/index.js');
    if (typeof mod?.init === 'function') {
      await mod.init();
      console.log('[RBQ] 已让酒馆正则扩展重新渲染列表 ✓');
      return true;
    }
  } catch (e) { /* 环境没有这个扩展就算了 ✓ */ }
  return false;
}

export async function install(scripts, { overwrite = true } = {}) {
  const c = ctx();
  try {
    const es = c?.extensionSettings;
    if (!es) return { ok: false, reason: '当前环境没有正则扩展（可能是酒馆版本或环境差异）' };
    if (!Array.isArray(es.regex)) es.regex = [];
    let added = 0; let replaced = 0;
    for (const sc of [].concat(scripts)) {
      const i = es.regex.findIndex((r) => r.scriptName === sc.scriptName);
      if (i >= 0) {
        if (!overwrite) continue;
        es.regex[i] = { ...es.regex[i], ...sc, id: es.regex[i].id ?? sc.id };
        replaced++;
      } else {
        es.regex.push(sc);
        added++;
      }
    }
    if (typeof c.saveSettingsDebounced === 'function') c.saveSettingsDebounced();
    /* 【用户实测】装完要**刷新页面**才看得到 ✗ ——
       ST 的正则扩展页不会自动重渲染 ✓ 所以这里直接调它自己的 init() 让它重建列表 ✓ */
    await refreshSTRegexUI();
    if (added || replaced) notify('success', `装好了：新增 ${added} 条、更新 ${replaced} 条。`);
    else notify('info', '没有变化（同名已存在且未允许覆盖）。');
    return { ok: true, added, replaced };
  } catch (e) {
    console.warn('[RBQ] 安装正则失败', e);
    return { ok: false, reason: e?.message ?? String(e) };
  }
}

/** 列出之前用本工坊建的正则（认 RBQ- 前缀） */
export function installed() {
  try {
    const es = ctx()?.extensionSettings;
    return (es?.regex ?? []).filter((r) => String(r.scriptName ?? '').startsWith(PREFIX));
  } catch { return []; }
}

export function removeOne(scriptName) {
  try {
    const c = ctx();
    const es = c?.extensionSettings;
    if (!es?.regex) return false;
    const before = es.regex.length;
    es.regex = es.regex.filter((r) => r.scriptName !== scriptName);
    if (typeof c.saveSettingsDebounced === 'function') c.saveSettingsDebounced();
    return es.regex.length < before;
  } catch { return false; }
}

export function removeAll() {
  try {
    const c = ctx();
    const es = c?.extensionSettings;
    if (!es?.regex) return 0;
    const before = es.regex.length;
    es.regex = es.regex.filter((r) => !String(r.scriptName ?? '').startsWith(PREFIX));
    if (typeof c.saveSettingsDebounced === 'function') c.saveSettingsDebounced();
    return before - es.regex.length;
  } catch { return 0; }
}

export function exportJson(scripts) {
  return JSON.stringify([].concat(scripts), null, 2);
}

/** 常用例子：点一下把向导字段填好（不是直接装） */
export const EXAMPLES = [
  { label: '隐藏 <data>（对用户隐藏）', spec: { searchType: 'tag', content: 'data', tagMode: 'block', action: 'hideUser', sources: ['ai'], name: '隐藏data' } },
  { label: '剔除 <data>（对AI隐藏）', spec: { searchType: 'tag', content: 'data', tagMode: 'block', action: 'hideAI', sources: ['ai'], name: '剔除data' } },
  { label: '隐藏 <RP_OPTIONS>', spec: { searchType: 'tag', content: 'RP_OPTIONS', tagMode: 'block', action: 'hideUser', sources: ['ai'], name: '隐藏四选一标签' } },
  { label: '清空 <thinking> 内容', spec: { searchType: 'tag', content: 'thinking', tagMode: 'keepTagClearContent', action: 'hideUser', sources: ['ai'], name: '清空思维链' } },
  { label: '合并多余空行', spec: { searchType: 'advanced', content: '/\\n{3,}/g', action: 'replace', replaceText: '\n\n', sources: ['ai'], name: '合并空行' } },
];
