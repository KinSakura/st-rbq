/**
 * extras.js —— 附加功能（对应你 RBQ 配置菜单里的那一批）
 *
 * 关键：**沿用你原来的变量名**，所以你的预设不用改一行：
 *   旁白点评   → 聊天变量 narrationPromptActive      （{{getvar::narrationPromptActive}}）
 *   CG 描述    → 聊天变量 cgPromptActive             （{{getvar::cgPromptActive}}）
 *   小剧场     → 聊天变量 theaterPromptActive + theaterTypeHint
 *   四选一     → 全局变量 rpPromptActive             （{{getglobalvar::rpPromptActive}}）
 *   字数要求   → 全局变量 lengthRequirementText
 *   人设大纲   → 全局变量 userOutlineActiveText
 *   时间框     → 直接插进 AI 回复正文开头（跳过 thinking 类标签），不是变量
 *
 * 模板文本全部取自你 rbq.js 的原文（NARRATION_TEMPLATE / CG_TEMPLATE / 小剧场模板 / 字数要求 / 大纲），
 * 只把 {角色名单}、{类型详细要求}、{min}、{max} 这些占位符在生成时替换。
 */

import * as store from './store.js';
import { cellS as C } from './cells.js';
import { ctx, notify, chat } from './ctx.js';

/* ------------------------------------------------------------------ 常量 */

export const NARRATION_TEMPLATE = `<aside_reviews>
【旁白点评任务】
你需要为以下角色各写一段旁白点评：{角色名单}
如果名单为空，则不生成任何内容。

对名单中的每个角色：
1. 以第三人称、调皮戏谑的小恶魔口吻，对角色进行毒舌又充满欣赏的点评。
2. 篇幅：每人200-300字。
3. 结构：
   - 开篇（约20%）：一句话点出角色当前状态与身份的落差感。
   - 主体（约60%）：具体描写身体反应。必须包含：
     · 身体敏感部位的生理反应（如颤抖、绷紧、泛红、汗湿）。
     · 服装的衬托效果（滑落、皱褶、敞开）。
     · 身份与当前事件带来的色情反差。
   - 收尾（约20%）：一句调侃收束，暗示好戏还在后头。
4. 禁忌：不使用"邪魅""眼底闪过危险的光""似乎""仿佛"等八股词汇，不写角色的内心独白，只从外部观察者角度写。

输出格式（必须严格遵守）：
<aside name="角色名">
（你的点评正文）
</aside>
<!-- 每个角色一条aside -->
</aside_reviews>`;

export const CG_TEMPLATE = `<cg_descriptions>
【CG描述任务】
你需要为以下角色各写一段CG画面描述：{角色名单}
如果名单为空，则不生成任何内容。

对名单中的每个角色：
1. 以第三人称、游戏CG定格的视角，客观、细致、富有画面感地描绘角色此刻与{{user}}互动的瞬间。
2. 篇幅：150-200字。
3. 按以下层次组织：
   - 构图（约10%）：角色在画面中的位置、与{{user}}的相对关系、光源方向。
   - 形体（约40%）：整体姿势、头部角度、视线方向、表情、上半身姿态、下半身姿态。
   - 细节（约40%）：2-3个高冲击力的局部特写。包括皮肤质感（汗珠、潮红）、衣物状态（褶皱、滑落）、体液或环境互动（泪痕、唾液、抓紧的布料）。
   - 色调（约10%）：画面主色调与光影氛围（暖黄、冷蓝、暗红等）。
4. 禁忌：不写角色内心活动，不写对话，不使用"仿佛""似乎"等模糊词，每句都必须可视觉化。

输出格式（必须严格遵守）：
<cg name="角色名">
（你的CG描述正文）
</cg>
<!-- 每个角色一条cg -->
</cg_descriptions>`;

export const THEATER_TEMPLATE = `<small_theater>
【小剧场生成任务】
你需要为下面列出的每个类型各生成一个独立的小剧场。注意：每个类型只生成一个小剧场，不是每个角色。
小剧场是纯粹的独立叙事，绝对不影响主线剧情，不引入主线记忆，仅作为附加内容存在。

类型列表（必须严格按照此顺序生成）：
{类型详细要求}

输出格式（绝对不可更改，每个类型一个 Zilla 标签）：
<Zilla type="类型名称（仅写类型名，不要包含第一/三人称等标记）" title="动态生成的标题" pov="仅第一人称需填写角色名">
正文（300-500字）
</Zilla>

重要规则：
1. type 属性必须使用上面给出的类型名称原文，不得添加其他文字。
2. 第一人称类型必须包含 pov 属性，其值为指定的角色名。标题中也要体现出该角色。
3. 第三人称类型不包含 pov 属性。
4. 每个小剧场篇幅 300-500 字，严禁任何特写镜头，只进行正常叙事描写。
5. 禁止继承前文剧情，每个小剧场独立成篇。
</small_theater>`;

export const LENGTH_TEMPLATE = '【字数要求】每轮叙事正文控制在 {min}-{max} 字之间，对话、动作、环境描写均衡分布。低于下限则信息量不足，超过上限则节奏拖沓。';

export const OUTLINE_TEMPLATE = '【剧情大纲】\n玩家希望后续剧情朝以下方向发展：\n{大纲文本}\n\n（这是玩家期望的方向，AI 应自然地朝这个方向引导剧情，但不必生硬推进。若剧情发展中出现与大纲冲突的强烈逻辑，优先遵循剧情逻辑。）';

export const RP_TEMPLATE = '【行动选项】请在正文之后输出 <RP_OPTIONS>，包含「好 / 坏 / 好坏参半 / 奇遇」四个方向，每个方向一句话。';

/* 四选一：三段原文（rbq.js CONSTANTS） */
/* 原文照抄自 rbq.js 的 CONSTANTS.DEFAULT_PROMPT_NORMAL */
export const RP_PROMPT_NORMAL = `在每次正文的最后，请根据当前剧情进展、世界观和角色设定与状态，生成四个方向的剧情行动引导选项供玩家选择。格式如下：

<RP_OPTIONS>
好：具体的好的方向行动描述，要结合当前剧情
坏：具体的坏的方向行动描述，要结合当前剧情
好坏参半：具体的好坏参半方向行动描述，要结合当前剧情
奇遇：具体的奇遇方向行动描述，要结合当前剧情
</RP_OPTIONS>

注意：选项要以第三人称视角，准确指向角色名，明确说明哪个角色对哪个角色做了什么，而不是以"她/他/你/我"指代。选项要具体、有代入感，不要过于笼统，要能自然地引导剧情发展。`;

/* 原文照抄自 rbq.js 的 CONSTANTS.DEFAULT_PROMPT_FASTFORWARD */
export const RP_PROMPT_FASTFORWARD = `在每次正文的最后，请根据当前剧情进展、世界观和角色设定与状态，生成四个方向的宏观剧情推进选项，用于快速跳过当前细节进入下一个剧情节点。格式如下：

<RP_OPTIONS>
好：宏观的好方向剧情推进描述，导向有利的剧情转折
坏：宏观的坏方向剧情推进描述，导向不利的剧情转折
好坏参半：宏观的混合方向剧情推进描述，好坏兼有
奇遇：宏观的奇遇方向剧情推进描述，导向意外的事件
</RP_OPTIONS>

注意：选项要以第三人称视角，准确指向角色名，明确说明哪个角色对哪个角色做了什么。描述应聚焦于剧情的大方向转折而非细节，要能让剧情快速推进到下一个阶段。`;

export const RP_DISABLED = '【当前四选一功能已禁用，请勿生成 RP_OPTIONS 标签】';

/* 抢话 / 时间框 / 快进：原文文本与变量名 */
export const SPEAK_BAN_TEXT = '并且绝对禁止代替 {{user}} 角色生成除指令以外的台词';
export const FASTFORWARD_TEXT = '时间快进，跳过当前正在进行的剧情，一笔带过，直接开始下一个剧情。';
export const TIMEBOX_SKIP_DEFAULT = 'thinking_matrix,thinking';

/** 小剧场可用类型（原版的那批） */
export const THEATER_TYPES = ['日记', '聊天记录', '自白', '独白', '回忆', '内心', '视角', '书信', '遗书', '情书', '忏悔录', 'if线', '平行世界', '未来', '梦境'];

const FIRST_PERSON_KEYWORDS = THEATER_TYPES.slice(0, 11);

export const DEFS = [
  { key: 'narration', label: '旁白点评', varName: 'narrationPromptActive', scope: 'chat', placeholders: ['{角色名单}'], defaultText: NARRATION_TEMPLATE },
  { key: 'cg', label: 'CG 描述', varName: 'cgPromptActive', scope: 'chat', placeholders: ['{角色名单}'], defaultText: CG_TEMPLATE },
  { key: 'theater', label: '小剧场', varName: 'theaterPromptActive', scope: 'chat', placeholders: ['{类型详细要求}'], defaultText: THEATER_TEMPLATE },
  { key: 'rp', hidden: true, label: '四选一提示词（普通）', varName: 'rpPromptActive', scope: 'global', placeholders: [], defaultText: RP_PROMPT_NORMAL },
  { key: 'rpFastForward', hidden: true, label: '四选一提示词（快进模式）', varName: 'rpPromptFastForward', scope: 'global', placeholders: [], defaultText: RP_PROMPT_FASTFORWARD },
  { key: 'speakBan', label: '防{{user}}抢话', varName: 'userSpeakBanText', scope: 'global', placeholders: [], defaultText: SPEAK_BAN_TEXT },
  { key: 'fastForward', hidden: true, label: '快进模式标志', varName: 'fastForward', scope: 'chat', placeholders: [], defaultText: FASTFORWARD_TEXT },
  { key: 'lengthReq', label: '字数要求', varName: 'lengthRequirementText', scope: 'global', placeholders: ['{min}', '{max}'], defaultText: LENGTH_TEMPLATE },
  { key: 'outline', label: '人设大纲', varName: 'userOutlineActiveText', scope: 'global', placeholders: ['{大纲文本}'], defaultText: OUTLINE_TEMPLATE },
  { key: 'timeBox', label: '时间框（插进正文开头）', varName: null, scope: 'message', placeholders: ['{时间}', '{地点}', '{天气}', '{氛围}'], defaultText: '『{时间} - {地点} - {天气} - {氛围}』' },
];

/* ------------------------------------------------------------------ 读写配置 */

/** 这些功能原版默认就是开的（timeBoxEnabled ?? true） */
const DEFAULT_ENABLED_KEYS = ['timeBox'];

/** 我早期自造的文本（要用原文替换掉，不能因为配置里存过就继续用） */
const STALE_TEXT_MARKERS = ['【行动选项】请在正文之后输出', '<RP_OPTIONS>，包含「好 / 坏 / 好坏参半 / 奇遇」'];

function cfg(key) {
  const v = store.getConfigValue(`extras.${key}`, null);
  const def = DEFS.find((d) => d.key === key);
  if (v && typeof v === 'object') {
    const text = (typeof v.text === 'string' && !STALE_TEXT_MARKERS.some((m) => v.text.includes(m)))
      ? v.text
      : (def?.defaultText ?? '');
    const enabled = v.enabled === undefined ? DEFAULT_ENABLED_KEYS.includes(key) : !!v.enabled;
    return { enabled, text, extra: v.extra ?? {} };
  }
  return { enabled: DEFAULT_ENABLED_KEYS.includes(key), text: def?.defaultText ?? '', extra: {} };
}

export function get(key) {
  const d = DEFS.find((x) => x.key === key);
  return { ...d, ...cfg(key) };
}

export function set(key, patch) {
  const cur = cfg(key);
  store.updateConfig({ extras: { [key]: { ...cur, ...patch } } });
  return get(key);
}

export function list() {
  return DEFS.map((d) => get(d.key));
}

export function resetText(key) {
  const d = DEFS.find((x) => x.key === key);
  return set(key, { text: d?.defaultText ?? '' });
}

/* ------------------------------------------------------------------ 变量写入 */

/**
 * 写聊天变量 / 全局变量。
 * 优先用酒馆原生 variables API，退回到斜杠命令。
 */
export function writeVar(name, value, scope = 'chat') {
  if (name === undefined || name === null || String(name).trim() === '') return false;   // 空名直接跳过（酒馆 API 会抛错）
  const c = ctx();
  try {
    const bucket = c?.variables?.[scope === 'global' ? 'global' : 'chat'];
    if (bucket?.set) { bucket.set(name, value); return true; }
  } catch (e) { /* 落到斜杠命令 */ }
  try {
    const cmd = scope === 'global' ? `/setglobalvar ${name}=${value}` : `/setvar ${name}=${value}`;
    if (typeof c?.executeSlashCommandsWithOptions === 'function') {
      // 该方法返回 Promise：必须接住，否则会变成 unhandled rejection
      try { Promise.resolve(c.executeSlashCommandsWithOptions(cmd)).catch(() => {}); } catch { /* ignore */ }
      return true;
    }
  } catch (e) { console.warn('[RBQ] 写变量失败', name, e); }
  return false;
}

/** 在场角色名单（排除 user） */
export function presentNames() {
  try {
    const t0 = (store.getRows(0, { create: false }) ?? [])[0] ?? [];
    // 在场实体名单是第4列（以前这里写死第6列，读到的是「安全氛围」→ 一直把"安全区"当角色名）
    const raw = C(0, t0, '在场实体名单', 4);
    const userName = (() => { try { return ctx()?.name1 ?? ''; } catch { return ''; } })();
    return raw.split(/[/,，、]/).map((x) => x.trim()).filter((x) => x && x !== userName);
  } catch { return []; }
}

/** 按性别筛（all / male / female 由表3 的性别列判断，缺数据就全放） */
function filterByGender(names, want) {
  if (!want || want === 'all') return names;
  try {
    const t3 = store.getTable?.(3);
    void t3;
    const rows = store.getRows(3, { create: false });
    return names.filter((n) => {
      const r = rows.find((x) => C(3, x, '角色名称', 0).trim() === n);
      if (!r) return true;
      const g = C(3, r, 'gender', 1);
      if (!g) return true;
      const isMale = /男/.test(g);
      const isFemale = /女/.test(g);
      if (want === 'male') return isMale;
      if (want === 'female') return isFemale;
      return true;
    });
  } catch { return names; }
}

/** 小剧场类型 → 详细要求行 */
function theaterTypeLines(types, povGender) {
  return (types ?? []).map((type) => {
    const firstPerson = FIRST_PERSON_KEYWORDS.some((k) => String(type).includes(k));
    if (!firstPerson) return `${type}（第三人称）`;
    const pool = filterByGender(presentNames(), povGender);
    const povName = pool.length ? pool[Math.floor(Math.random() * pool.length)] : '当前场景中除{{user}}以外的角色';
    return `${type}（第一人称，请围绕角色 ${povName} 进行生成，标题中体现角色名）`;
  });
}

/** 组装某个功能的最终文本 */
/**
 * 【v2.18.0】"这个开关现在到底会往变量里写什么" —— 完全照 applyAll 的规则算真值
 *   注意抢话是【反向】的：关着才写禁令（见 applyAll 里的注释）
 *   时间框不是变量（写进正文开头）→ 返回空串
 */
export function previewWritten(key) {
  try {
    const e = get(key);
    if (!e) return "";
    if (!e.varName) return "";
    if (key === "speakBan") return e.enabled ? "" : String(e.text || SPEAK_BAN_TEXT);
    if (key === "fastForward") return e.enabled ? FASTFORWARD_TEXT : "";
    if (key === "rp") {
      const ff = get("fastForward");
      if (!e.enabled) return RP_DISABLED;
      return String((ff && ff.enabled ? (get("rpFastForward") || {}).text : e.text) || "");
    }
    return buildText(key);
  } catch (err) { return ""; }
}

export function buildText(key) {
  const e = get(key);
  if (!e.enabled) return '';
  let t = e.text || '';
  const names = presentNames().join('、');
  const extras = e.extra ?? {};
  t = t.replace(/\{角色名单\}/g, names || '（无）');
  if (key === 'theater') {
    const types = (extras.types?.length ? extras.types : THEATER_TYPES.slice(0, 3));
    t = t.replace(/\{类型详细要求\}/g, theaterTypeLines(types, extras.povGender).join('\n'));
  }
  if (key === 'lengthReq') {
    const min = Number(extras.min ?? 800); const max = Number(extras.max ?? 1500);
    t = t.replace(/\{min\}/g, String(min)).replace(/\{max\}/g, String(max));
  }
  if (key === 'outline') t = t.replace(/\{大纲文本\}/g, String(extras.outlineText ?? '（还没写大纲）'));
  if (key === 'timeBox') {
    // 表0 列顺序可能是：系统轮次 / 时空坐标 / 绝对位置名称 / 环境气象 / 在场实体名单 / 世界法则 / 安全氛围
    // —— 原来的 4/5 是「在场实体名单 / 世界法则」，取错了；这里改成**按列名解析**，改表结构也不会错。
    const w0 = (store.getRows(0, { create: false }) ?? [])[0] ?? [];
    const cols = (() => { try { return store.getTable(0)?.columns ?? []; } catch { return []; } })();
    const at = (name, fallbackIdx) => {
      const i = cols.findIndex((c) => String(c).includes(name));
      const idx = i >= 0 ? i : fallbackIdx;
      return String(w0[idx] ?? '').trim();
    };
    t = t.replace(/\{时间\}/g, at('时空坐标', 1) || at('时间', 1) || '—')
      .replace(/\{地点\}/g, at('绝对位置', 2) || at('地点', 2) || '—')
      .replace(/\{天气\}/g, at('环境气象', 3) || at('天气', 3) || '—')
      .replace(/\{氛围\}/g, at('安全氛围', 6) || at('氛围', 6) || '—');
  }
  return t;
}

/**
 * 附加内容挂到"楼层"上（存在消息里）：回退/删除末尾楼层后，剩余楼层的内容依旧可读
 * @param {number} index 消息下标
 * @param {{aside?:string,cg?:string,zilla?:string,round?:number,name?:string}} patch
 */
export function writeFloorExtras(index, patch = {}) {
  try {
    const c = ctx();
    const msg = c?.chat?.[index];
    if (!msg || msg.is_user) return false;
    const cur = (msg.rbqdb_extra && typeof msg.rbqdb_extra === 'object') ? msg.rbqdb_extra : {};
    const next = Object.assign({}, cur, patch, { at: Date.now() });
    Object.keys(next).forEach((k) => { if (next[k] === '' || next[k] == null) delete next[k]; });
    msg.rbqdb_extra = next;
    try { if (typeof c.saveChat === 'function') c.saveChat(); } catch { /* ignore */ }
    return true;
  } catch { return false; }
}

/** 读某层楼的附加内容 */
export function readFloorExtras(index) {
  try { const m = ctx()?.chat?.[index]; return (m && typeof m.rbqdb_extra === 'object') ? m.rbqdb_extra : null; } catch { return null; }
}

/** 把全部附加功能的变量写一遍（关掉的写空串，和原版行为一致） */
export function applyAll({ quiet = true } = {}) {
  const done = [];
  for (const d of DEFS) {
    if (!d.varName) continue;
    const text = buildText(d.key);
    const ok = writeVar(d.varName, text, d.scope);
    done.push({ key: d.key, varName: d.varName, scope: d.scope, chars: text.length, ok });
  }
  // —— 原文语义的特殊变量（与普通开关不同，必须单独处理）——
  try {
    // 抢话：开启=变量写空（不限制）；关闭=写禁止代说台词的文本
    const sb = cfg('speakBan');
    writeVar('userSpeakBanEnabled', !!sb.enabled, 'global');
    writeVar('userSpeakBanText', sb.enabled ? '' : SPEAK_BAN_TEXT, 'global');
    // 快进：开启=写提示文本；关闭=清空（原版是 deleteChatVar）
    const ff = cfg('fastForward');
    writeVar('rpFastForwardEnabled', !!ff.enabled, 'global');
    writeVar('fastForward', ff.enabled ? FASTFORWARD_TEXT : '', 'chat');
    // 四选一：开启时按快进开关选模板；关闭时写原文的禁用提示词（不是空串）
    const rp = cfg('rp');
    const rpText = rp.enabled ? (ff.enabled ? cfg('rpFastForward').text : rp.text) : RP_DISABLED;
    writeVar('rpPromptActive', rpText, 'global');
    writeVar('rpPromptNormal', rp.text, 'global');
    writeVar('rpPromptFastForward', cfg('rpFastForward').text, 'global');
    // 时间框：开关 + 跳过标签（原版是全局变量）
    const tb = cfg('timeBox');
    writeVar('timeBoxEnabled', !!tb.enabled, 'global');
    writeVar('timeBoxSkipTags', String(tb.extra?.skipTags ?? TIMEBOX_SKIP_DEFAULT), 'global');
    done.push({ key: 'original-switches', varName: 'userSpeakBanText/rpPromptActive/timeBoxEnabled', scope: 'global', chars: rpText.length, ok: true });
  } catch (e) { console.warn('[RBQ] 附加开关变量写入失败', e); }
  if (!quiet) {
    const bad = done.filter((x) => !x.ok);
    if (bad.length) notify('warning', `有 ${bad.length} 个变量没写进去（酒馆变量接口不可用）。`);
    else notify('success', `已写入 ${done.filter((x) => x.chars).length} 个变量。`);
  }
  return done;
}

/* ------------------------------------------------------------------ 时间框 */

const TIMEBOX_RE = /『[^』]*』/;

/** 把时间框插进正文（跳过 thinking 类标签之后）；返回新文本，没变化就原样返回 */
export function insertTimeBox(text, { force = false } = {}) {
  const e = get('timeBox');
  if (!e.enabled && !force) return text;
  const src = String(text ?? '');
  const box0 = buildText('timeBox');
  if (TIMEBOX_RE.test(src)) {
    // 已经插过：force 时用**新数据重写**这个框（否则填表后的新时间/地点永远不会生效）
    if (!force) return src;
    if (!box0 || /\{/.test(box0)) return src;
    return src.replace(TIMEBOX_RE, box0);
  }
  const box = box0;
  if (!box || /\{/.test(box)) return src;
  // 跳过标签：优先读全局变量 timeBoxSkipTags（原版行为），退回配置里的值
  const skipRaw = (() => { try { const v = ctx()?.variables?.global?.get?.('timeBoxSkipTags'); return v || e.extra?.skipTags; } catch { return e.extra?.skipTags; } })();
  const skip = String(skipRaw ?? 'thinking_matrix,thinking').split(/[,，]/).map((x) => x.trim()).filter(Boolean);
  let at = 0;
  for (const tag of skip) {
    const re = new RegExp(`</${tag}>`, 'i');
    const m = re.exec(src);
    if (m) at = Math.max(at, m.index + m[0].length);
  }
  const head = src.slice(0, at);
  const tail = src.slice(at);
  return `${head}${head && !/\n$/.test(head) ? '\n' : ''}${box}\n${tail.replace(/^\n+/, '')}`;
}

/**
 * 单独取"当前时间框文字"（就是『时间 - 地点 - 天气 - 氛围』那一串 ✓）
 *   【用户要求】记忆条目上要显示这个 ✓ 而且**跟时间框一模一样** ✓
 *   所以直接复用 timeBox 的模板 + 表0 取值逻辑 ✓（不重复实现一套 ✓）
 *   ⚠️ 不受"时间框功能开关"影响 ✓（时间框关着也照样能取 ✓）
 */
export function timeBoxText() {
  const e = get('timeBox');
  const was = e.enabled;
  try {
    e.enabled = true;
    const t = buildText('timeBox');
    if (!t || /\{/.test(t)) return '';
    /* 表0 还没数据时会是『— - — - — - —』这种 ✗ → 这种不算有效时间 ✓ 返回空让界面走退路 ✓ */
    const body = String(t).replace(/[『』\s\-—|｜/·]/g, '');
    if (!body) return '';
    return String(t).trim();
  } finally { e.enabled = was; }
}

/** 给某条消息插时间框（写回消息） */
export async function applyTimeBoxToMessage(index, { force = false } = {}) {
  const c = chat();
  const msg = c?.[index];
  if (!msg || msg.is_user) return false;
  const before = String(msg.mes ?? '');
  const after = insertTimeBox(before, { force });
  if (after === before) return false;
  msg.mes = after;
  try {
    const cx = ctx();
    if (typeof cx?.saveChat === 'function') await cx.saveChat();
    /* 关键：改完消息必须让酒馆重渲染这一条，否则用户要关掉面板重进才看到时间框 */
    try {
      if (typeof cx?.updateMessageBlock === 'function') cx.updateMessageBlock(index, msg);
    } catch (e) { console.warn('[RBQ] updateMessageBlock 失败', e); }
    try {
      const es = cx?.eventSource;
      const ev = cx?.eventTypes?.MESSAGE_UPDATED;
      if (es && typeof es.emit === 'function' && ev) es.emit(ev, index);
    } catch (e) { /* 没有 eventSource 就算了 */ }
  } catch (e) { console.warn('[RBQ] 保存时间框失败', e); }
  return true;
}
