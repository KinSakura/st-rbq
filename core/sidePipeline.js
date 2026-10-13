/**
 * sidePipeline.js —— 侧路任务调度器
 *
 * 运行时机：主 API 写完正文之后（index.js 处理完该层消息时触发）。
 *
 * 任务与依赖（与用户约定）：
 *   ① 填表     ┐
 *   ② 记忆提炼 ├─ 三者并发（各自重试、各自状态）
 *   ④ 附加功能 ┘（默认关）
 *   ③ 大总结   ── **必须等 ① 填表完成**（它要读刚更新的表与状态）
 *
 * 工程约束：
 *   · 幂等键 = messageId：同一条消息只跑一次；重试沿用同一个键。
 *   · in-flight 去重：同一 id 正在跑就复用同一个 promise。
 *   · 结果只产出文本协议（<data> / <character_memory>），交给 txn/memory 应用
 *     → 自动继承现有的五层清洗、主键去重、单例表保护。
 *   · 失败只记状态，不弹错、不阻塞。
 */

import { ctx } from './ctx.js';   // 需要读当前聊天（系统轮次、消息条数等）
import * as store from './store.js';
import { extractProse, extractProseStrict } from './prose.js';
import * as extrasMod from './extras.js';
import * as schema from './schema.js';
import * as prompts from '../prompts/prompts.js';
import * as summaryStore from './summary.js';
import * as extras from './extras.js';
import * as sideApi from './sideApi.js';
import * as memory from './memory.js';
import * as protocol from './protocol.js';
import * as expandMod from './expand.js';
import * as txn from './txn.js';

/* ------------------------------------------------------------------ 状态 */

const records = new Map();   // messageId -> record
const inflight = new Map();  // messageId -> Promise
const MAX_RECORDS = 40;

export function status() {
  return [...records.values()].sort((a, b) => b.id - a.id).slice(0, MAX_RECORDS);
}
export function statusOf(id) { return records.get(Number(id)) ?? null; }
export function clearStatus() { records.clear(); }
export function inflightCount() { return inflight.size; }

/* ------------------------------------------------------------------ 提示词组装 */

function tableSkeleton(maxChars = 9600) {
  const out = [];
  let used = 0;
  let tables = [];
  try { tables = (schema.getTables?.() ?? store.getTables?.() ?? []); } catch { tables = []; }
  for (const t of tables) {
    const line = '表' + t.no + '「' + (t.name ?? '') + '」: ' + (t.columns ?? []).join(' / ');
    if (used + line.length > maxChars) break;
    out.push(line);
    used += line.length + 1;
  }
  return out.join('\n');
}

/** 指南（用户原《表格数据说明》19k）里已有的段落，就别在侧路提示词里重复塞 */
function dedupeAgainstGuide(guide) {
  const s = String(guide ?? '');
  const guideText = (() => {
    try {
      const only = s.slice(0, s.indexOf('## <data> 标签速查'));   // 只拿"指南原文"部分比对
      return only || '';
    } catch { return ''; }
  })();
  const cut = (text, heading) => {
    const i = text.indexOf(heading);
    if (i < 0) return text;
    const rest = text.slice(i + heading.length);
    const NLc = String.fromCharCode(10);
    const nextIdx = rest.indexOf(NLc + '### ');
    const end = nextIdx >= 0 ? i + heading.length + nextIdx : text.length;
    return text.slice(0, i) + text.slice(end);
  };
  let out = s;
  // 指南自己写了属性/列说明 → 删掉重复的别名表
  if (guideText.includes('属性名') || guideText.includes('datetime')) out = cut(out, '### 常用属性名');
  // 指南自己给了 <status .../> 之类的示例 → 删掉重复的数值变化示例
  if (guideText.includes('<status')) out = cut(out, '### 数值变化两种写法');
  return out.split(String.fromCharCode(10) + String.fromCharCode(10) + String.fromCharCode(10)).join(String.fromCharCode(10) + String.fromCharCode(10));
}

/** 从协议段里剔除「长期记忆」小节（记忆由独立任务负责） */
function stripMemorySection(guide) {
  const s = String(guide ?? '');
  const start = s.indexOf('### 长期记忆');
  if (start < 0) return s;
  const NL = String.fromCharCode(10);
  const rest = s.slice(start + 8);
  const idx = rest.indexOf(NL + '### ');
  const end2 = idx >= 0 ? start + 8 + idx : s.length;
  return (s.slice(0, start) + s.slice(end2)).split(NL + NL + NL).join(NL + NL);
}

/**
 * 指南的"抽取器版本"（侧路专用，独立自包含）：
 *  · 把"不关心表格如何更新（系统会自动处理）"改成直白要求
 *  · 去掉只对写正文的人有意义的条目（禁止正文提数值等）
 */
function guideForExtractor(guide) {
  let s = String(guide ?? '');
  const NLx = String.fromCharCode(10);
  s = s.replace(/标签只描述[\s\S]{0,12}?不关心表格如何更新[^。]*。/g,
    '标签要写清“发生了什么、谁对谁、值是多少”，具体落到哪张表哪一行由脚本处理，不用你算。');
  // 只给写正文的人看的整节（核心规则 1-5 条）→ 抽取器不需要
  const dropSection = (text, heading) => {
    const i2 = text.indexOf(heading);
    if (i2 < 0) return text;
    const j2 = text.indexOf(NLx + '## ', i2 + heading.length);
    return text.slice(0, i2) + text.slice(j2 >= 0 ? j2 : text.length);
  };
  /* 【重要】以前把「## 核心规则」整节删掉了 ✗ —— 那节里的第 6/7 条正是"任务书"：
     新实体即刻建档 + 上一轮遗漏本轮必须补建 + 实体唯一性。
     真 API 实测：删掉它之后 AI 只肯写 3~8 张表（表4/5/6/13 常年缺），恢复后才像老 RBQ 那样一次写全。 */
  // s = dropSection(s, '## 核心规则');   ← 不要删！
  // 开场那句叙事要求
  s = s.replace(/这些数据是剧情推演的绝对参考基准，必须严格依照数据状态进行叙事。/g, '');
  s = s.replace(/本系统使用 15 张数据表记录当前世界的全部状态。\s*/g, '');
  // 删掉整节：表12 / 大总结（它由独立任务在到点时单独发）
  const dropSectionByHeading = (text, re) => {
    const lines = text.split(NLx);
    const out = [];
    let skipping = false;
    for (const line of lines) {
      const isHeading = /^#{2,3} /.test(line);
      if (isHeading) skipping = re.test(line);
      if (!skipping) out.push(line);
    }
    return out.join(NLx);
  };
  s = dropSectionByHeading(s, /表12|大总结|宏观纪事|纪事录|封包|纪元总结/);

  // 标签书写规范里可能还有单独的 <epoch …> 示例行
  s = s.split(NLx).filter((l) => !/^\s*<epoch\b/.test(l)).join(NLx);
  const a = s.indexOf(NLx + '3. 绝对禁止在剧情正文中');
  if (a >= 0) {
    const b2 = s.indexOf(NLx + '## ', a + 1);
    s = s.slice(0, a) + s.slice(b2 >= 0 ? b2 : s.length);
  }
  // 预设原文里手写的 XML 示例（<world mode="init">…</world> 等）已经过时：
  // 它们把表0 和表6 的列混在一起，而脚本现在会按"每列只属于自己那张表"同源生成一份。
  // 留着两套只会让 AI 混乱 → 删掉手写的，指向标签速查。
  // 顺带把"世界初始化"那节里的引导句也收一下（避免只剩半句话）
  return s;
}

/** 本轮必写清单：放在提示词最前面（真 API 实测：埋在中间的要求会被忽略 ✗） */
const MUST_WRITE_HEAD = [
  "======== 本轮必写清单（缺任何一项都算这次填表失败）========",
  "1. 表0：单例一行 —— 系统轮次 / 时空坐标 / 绝对位置名称 / 环境气象 / 在场实体名单 / 世界法则 / 安全氛围。",
  "2. 表2：**每个在场角色各一行** —— 含存活状态 / 种族 / 公开身份 / 等级 / 四维系数 / 背景履历。",
  "3. 表3：**每个在场角色各一行**（生理与阈值）。",
  "4. 表4：**每个在场角色各一行**（微观坐标 / 离场状态 / 各装备位 / 躯干姿势）。",
  "5. 表5：**每个角色对每个角色的单向关系各一条**（A→B 与 B→A 都要，两行内容不同）。",
  "6. 表6：单例一行 —— 终极宏愿 / 宏愿进度 / 当前篇章 / 篇章状态 / 即时焦点 / 焦点反馈。",
  "7. 表13：**每个在场角色各一行** —— HP / MP / SP 的当前值与上限。",
  "8. 正文里出现过的物品→表9、技能→表10、任务→表7、异常状态→表8、势力→表11。",
  "8a. **主角（用户）一律写 {{user}}**，不要自己编名字（不要 write「未命名」「主角」之类）。",
  "8b. 表6 即使本轮没有大变化，**首轮也必须建档**（终极宏愿/当前篇章/即时焦点先写上，之后再改）。",
  "8c. 表5 每一条都要带 participantA 与 participantB（两个角色名），缺了这条关系就作废。",
  "9. 表2 的「四维系数」**必须写**，格式 力量|体质|敏捷|智力（如 1.2|1.0|1.1|0.9）—— 表13 的派生值全靠它算。",
  "9a. 实在判断不出来就写 `1.0|1.0|1.0|1.0`（基准值）—— **绝对不允许留空**。",
  "9b. 年龄判断不出来就按出生日期和当前年份算；出生日期必须是「纪年前缀+阿拉伯数字年份+月+日」。",
  "10. **空表要初始化**：如果某张表当前一行都没有（例如表4 即时状态、表6 剧情大纲），必须按角色设定与当前剧情先建出一行，不许留空表。",
  "11. **空格子必须按人设编出来**：绝对雷区、核心偏好、深层软肋、特殊体征、核心性癖、情境偏好、性雷区、装备位、姿态…**一律按这个角色的身份/种族/性格/职业编出具体可信的内容**（例如医者的绝对雷区写「践踏草木生灵/背弃医者本分」，性雷区写「被当作泄欲工具」）。**禁止写「未探明」「未知」来搪塞**（只有确实没有的装备位才写「无」）。",
  "11b. **四维系数必须跟这个角色的定位对得上**，不许都写 1.0|1.0|1.0|1.0，也不要都写一样的数字。格式：力量|体质|敏捷|智力。",
  "     力量/近战/重武器/狂战 → 第1位 1.3~2.0；体质/坦克/耐打/苦修 → 第2位 1.3~2.0；",
  "     敏捷/刺客/远程/暗器/盗贼 → 第3位 1.3~2.0；智力/法师/学者/医者/军师 → 第4位 1.3~2.0；",
  "     与定位无关的那一项写 0.7~1.0（可以是短板）。例：医者→1.0|1.0|1.1|1.6；刺客→1.0|0.9|1.7|1.1；重装战士→1.7|1.5|0.9|0.8。",
  "     写完后自问一句：这个系数和表2 的「四维偏好与战斗风格」说的是同一个人吗？不是就改。",
  "11a. 四维系数、技能池、装备位这类格式/结构类列，实在判断不出来才用 1.0|1.0|1.0|1.0 / [] / 无。",
  "12a. **「系统轮次」这一格由脚本自动填**（不是你的活），你不用写它，写错了脚本也会覆盖。",
  "12b. **无名配角 / 龙套 / 只有称呼没有名字的（如「守卫」「文书」「路人」「伙计」）一律写进表14（怪物与临时实体）**，不要进表2 / 表3 / 表5。",
  "     表2 / 表3 / 表5 只放【有名字、有身份、会反复出现】的正式角色 —— 要么把他的完整设定写齐，要么就别记。",
  "12c. **绝对不要写占位符实体**（npc / npc_var / 路人甲 / 未知 / 无）：表5 的关系双方必须都是有名字的实体；",
  "     已经在表2 建过档的角色，也不要再往表14 里写一份（脚本会自动删掉这种重复）。",
  "12. 【最重要】**你新建了哪一行，就必须把那一行写全** —— 绝对禁止建一个只写了名字、其余列全空的空行！",
  "     新建角色 / 技能 / 物品 / 怪物 / 任务 / 地点时，必须把它那张表的最小列集（见下文对应表）一次性写齐。",
  "     自检方法：写完后回头看每一个你新建的标签，问自己一句『这一行的每一列都有值吗？』没有就补上。",
  "先把上面这些全部写完，再考虑其它表；写完后逐条自查一遍再输出。",
  "",
].join(String.fromCharCode(10));

/**
 * 【健壮性】调用方可能只传半个配置（例如只看预览的测试 ✓）→ 缺 prompts 时补上酒馆里的真配置 ✓
 * 这样 fillPrompt/memoryPrompt/... 就不会因为 cfg.prompts 不存在而抛错 ✓
 */
function normCfg(cfg) {
  if (cfg && cfg.prompts && typeof cfg.prompts === "object") return cfg;
  try { const real = sideApi.config(); if (real && real.prompts) return Object.assign({}, real, cfg || {}); } catch (e) { /* ignore */ }
  return cfg || {};
}

/**
 * 提示词去重（同一段一模一样的内容只留第一份）
 *   用户实测：填表提示词里「本轮必写清单」整段出现两次（我们的规范 + 预设里还有一份）
 *   → 请求白白变大变慢 → 上游超过网关的 100 秒 → HTTP 524 ✗
 */
function dedupeBlocks(text) {
  const parts = String(text || "").split(/\n{2,}/);
  const seen = new Set();
  const out = [];
  let dropped = 0;
  for (const p of parts) {
    const key = p.trim();
    if (key.length > 40) {
      if (seen.has(key)) { dropped++; continue; }
      seen.add(key);
    }
    out.push(p);
  }
  return { text: out.join(String.fromCharCode(10) + String.fromCharCode(10)), dropped };
}

export function fillPrompt(rawText, cfg) {
  cfg = normCfg(cfg);
  const text = cleanInput(rawText);
  const guide = (() => {
    try {
      const guide = guideForExtractor(prompts.buildTablePromptGuide?.() ?? '');
      const spec = prompts.buildTablePromptSpec?.({ withTags: true, withMemory: false, excludeTables: [12], withDefs: true }) ?? '';
      const cols = (prompts.dataWriteSpecV2 && prompts.dataWriteSpecV2()) || "";
      const mustCover = [
        "### 本轮必须覆盖（缺任何一项都算这次填表失败，必须补齐再输出）",
        "1) 表0 单例表必须全部写到：系统轮次、时空坐标、绝对位置名称、环境气象、在场实体名单、世界法则、安全氛围。",
        "2) **每个在场角色都要有自己的一行**：表2（存活状态/种族/公开身份/等级/**四维系数**）、表3（生理）、表4（微观坐标/离场状态/各装备位）、表5（与其他人/主角的关系）、表13（HP/MP/SP 的当前值与上限）。",
"2a) **四维系数**是整套派生数值的输入，必须写，格式固定：`力量|体质|敏捷|智力`，例如 `<c name=\"⟨角色名⟩\" coef=\"1.5|1.2|0.8|0.6\"/>`（每项 0.5~2.0，普通人是 1.0）。**不写它 → 表13 的攻击/防御/速度/负重全都算不出来**。",
    "2d) **出生日期的纪年前缀必须与表0「时空坐标」用的那一套完全一致**（例如表0 写「大陆历1244年」，出生日期就写「大陆历1219年04月12日」），禁止自创新历法。年龄由脚本按两者年份自动计算，你写不写都行。",
    "2b) 表13 里 **ATK/DEF/MATK/MDEF/AGI/负重上限** 这些派生列由脚本按「等级 + 四维系数」自动计算 —— **你不要写它们**；你只写 HP/MP/SP 的当前值与上限（战斗或受伤后）。",
        "3) 正文里出现的：物品→表9、技能→表10、任务→表7、势力或世界法则→表8、地点→表1、关系变化→表5。",
        "4) 凡是该表要求的事实在本轮剧情里出现过，就必须给出值；实在无法确定的写「未知」，禁止整表不写。",
        "5) 自检：输出前对照上面 1-4 逐项确认，缺的补上再输出。",
  "6) 逐列检查：每张涉及的表里，**只要有任意一列为空就必须补值**——能从角色设定/剧情合理推断的（发色、发型、体毛、体香、性经验状态、名器类型、性器官特征、三围、四维系数、四维偏好等）一律按角色人设推断填写；实在无法推断的写「未知」。允许整列为空只有一种情况：该列明确与本轮无关（如已离场角色）。",
  "7) 输出格式：每张表用一条独立标签，同一张表的多个角色/物品分多条写，禁止把多张表合并在一个标签里。",
      ].join(String.fromCharCode(10));
      return [MUST_WRITE_HEAD, guide, spec, cols, mustCover, MUST_WRITE_HEAD].filter((x) => String(x || "").trim()).join(String.fromCharCode(10) + String.fromCharCode(10));
    } catch { return tableSkeleton(); }
  })();
  const data = (() => {
    try {
      const xml = String(prompts.buildTableDataXml({ for: 'fill' }) ?? '');   // 填表要全量列
      // buildTableDataXml 末尾会附加召回的记忆段；填表只需要表格，剔掉
      let out = xml;
      // 召回的记忆段同样不给填表 AI
      const i = out.indexOf('## 长期记忆');
      if (i >= 0) out = out.slice(0, i);
      return out.trimEnd();
    } catch { return ''; }
  })();
  const core = String(cfg.prompts.fill ?? '')
    .replace(/\{协议\}/g, guide)
    .replace(/\{当前数据\}/g, data)
    .replace(/\{表格\}/g, tableSkeleton())   // 兼容旧模板
    .replace(/\{正文\}/g, text);
  /* 按预设位置标记包起来：🔒↓ 的提示词放上面 / 🔒↑ 的放下面 ✓ */
  const built = withPresetBlocks(core);
  const dd = dedupeBlocks(built);
  try {
    const chars = dd.text.length;
  } catch (e) { /* ignore */ }
  return dd.text;
}

/**
 * 【关键修正】一条提示词到底"开着还是关着"，不能看它自己身上的 `enabled` ✗
 *   酒馆把开关存在 **prompt_order** 里（`oai_settings.prompt_order = [{character_id, order:[{identifier, enabled}]}]` ✓
 *   见 SillyTavern/public/scripts/PromptManager.js 的 getPromptsForCharacter / isPromptDisabledForActiveCharacter ✓）
 *   而提示词对象自带的 `enabled` 是**导出预设时的快照**，经常会和真实开关不一致 ✗
 *   → 所以这里：**优先用 prompt_order** ✓，没有对应条目时才退回提示词自带的 enabled ✓
 * @returns {Map<string,boolean>|null} identifier → 是否启用
 */
/**
 * 【用户实测】预设标记进来的内容里，宏是【原样】的 ✗：
 *   {{roll 1d99999}} / {{getvar::AI_role}} / {{getglobalvar::userSpeakBanText}} …
 *   → 这些是酒馆的宏，交给酒馆自己解析 ✓（ctx().substituteParams 是酒馆的官方入口 ✓）
 *   解析不了的（酒馆没这个入口 / 宏不存在）就原样留着 ✓ 不会把内容弄丢 ✓
 */
/* 【用户实测 · 关键根因】ctx().oai_settings 是**克隆** ✗（prompts / prompt_order 都读不到 ✗）
   → 所以预设标记只能靠运气读到（有时只读到一部分 ✗ —— 比如只读到 🔒↓、读不到 🔒↑ ✓）
   修法：从 /scripts/openai.js 模块里拿**真对象** ✓ 它是 live 引用 ✓ 之后你怎么改预设它都会跟着变 ✓
   （模块导入是异步的 ✗ → 启动时先 await 一次存起来 ✓ 之后同步函数直接用这个引用 ✓） */
let __realOai = null;
export async function initPresetSource() {
  try {
    const m = await import('/scripts/openai.js');
    if (m?.oai_settings) { __realOai = m.oai_settings; console.log('[RBQ] 已拿到酒馆真实的 oai_settings（预设 ' + (Array.isArray(__realOai.prompts) ? __realOai.prompts.length : 0) + ' 条 / order ' + (Array.isArray(__realOai.prompt_order) ? __realOai.prompt_order.length : 0) + ' 份）'); }
  } catch (e) { /* 拿不到就退回 ctx ✓ */ }
  return !!__realOai;
}
function realOai() {
  if (__realOai) return __realOai;
  try { const c = ctx(); if (Array.isArray(c?.oai_settings?.prompts) || Array.isArray(c?.oai_settings?.prompt_order)) return c.oai_settings; } catch (e) { /* ignore */ }
  return null;
}

function resolveMacros(text) {
  const s = String(text ?? "");
  if (!s.includes("{{")) return s;
  try {
    const c = ctx();
    const fn = c?.substituteParams;
    if (typeof fn === "function") { const out = fn(s); if (typeof out === "string" && out) return out; }
  } catch (e) { /* ignore */ }
  try {
    const g = (typeof window !== "undefined" && window.substituteParams) ? window.substituteParams : null;
    if (typeof g === "function") { const out = g(s); if (typeof out === "string" && out) return out; }
  } catch (e) { /* ignore */ }
  return s;
}

function promptOrderMap(orderOverride = null) {
  try {
    const po = Array.isArray(orderOverride) ? orderOverride : (realOai()?.prompt_order ?? ctx()?.oai_settings?.prompt_order);
    if (!Array.isArray(po) || !po.length) return null;
    const c = ctx();
    const curAvatar = (() => { try { return (c?.characters ?? [])[c?.this_chid]?.avatar ?? null; } catch (e) { return null; } })();
    /* 优先当前角色那份 → 其次全局（酒馆里全局用的 id 是 100001 / 'global'）→ 再次第一条 ✓ */
    /* 【用户实测】🔒↑ 那条明明开着却没进来 ✗ —— 说明"某一份 order"里没有它 ✗
       （酒馆可同时存"全局一份 + 每个角色一份"，各份内容可能不一样）
       → 所以不只看一份：当前角色的那份优先 ✓，其次全局 ✓，再其次**任何一份里出现过它**的 ✓
       全都没提到 → 交给调用方退回提示词自带的 enabled ✓ */
    const m = new Map();
    const put = (list, onlyIfAbsent) => {
      for (const e of (Array.isArray(list) ? list : [])) {
        if (!e || !e.identifier) continue;
        const k = String(e.identifier);
        if (onlyIfAbsent && m.has(k)) continue;
        m.set(k, e.enabled !== false);
      }
    };
    const globalEntry = po.find((x) => String(x?.character_id) === '100001' || String(x?.character_id) === 'global');
    const charEntry = curAvatar ? po.find((x) => String(x?.character_id) === String(curAvatar)) : null;
    if (globalEntry) put(globalEntry.order, false);          // 全局打底 ✓
    if (charEntry) put(charEntry.order, false);              // 当前角色覆盖全局 ✓（酒馆就是这个优先级）
    for (const x of po) { if (x !== globalEntry && x !== charEntry) put(x.order, true); }   // 其余只补缺 ✓
    try { globalThis.__rbqOrderReport = { 份数: po.length, 全局条数: globalEntry ? (globalEntry.order || []).length : 0, 当前角色: curAvatar, 当前角色条数: charEntry ? (charEntry.order || []).length : 0, 合并后: m.size }; } catch (e) { /* ignore */ }
    return m.size ? m : null;
  } catch (e) { return null; }
}

/**
 * 【用户要求 · 预设位置标记】✓
 *   预设里提示词的**名字**带位置标记时，自动把它的内容拼到侧路提示词的上面/下面：
 *     名字含【🔒↓】 → 放到侧路提示词【上面】（前缀 ✓）
 *     名字含【🔒↑】 → 放到侧路提示词【下面】（后缀 ✓）
 *   最终侧路提示词 =
 *       （🔒↓ 那些提示词的内容）
 *       （侧路提示词本体）
 *       （🔒↑ 那些提示词的内容）
 *   基础符号可改（侧路页「预设注入标记」，默认 🔒 ✓）；只写基础符号没带箭头时按"下面"处理 ✓
 *   ⚠️ 开关以 prompt_order 为准 ✓（见 promptOrderMap 的说明 ✓）
 * @returns {{above:string, below:string, extras:Array}}
 */
export function presetMarkedBlocks(listOverride = null, orderOverride = null) {
  const none = { above: '', below: '', extras: [] };
  try {
    if (store.getConfigValue('sideApi.markerEnabled', true) === false) return none;
    const base = String(store.getConfigValue('sideApi.marker', '🔒') || '🔒');
    if (!base) return none;
    const MARK_DOWN = base + '↓';   // 放上面
    const MARK_UP = base + '↑';     // 放下面
    const c = ctx();
    const list = Array.isArray(listOverride) ? listOverride : (
      realOai()?.prompts
      ?? c?.oai_settings?.prompts
      ?? c?.chatCompletionSettings?.prompts
      ?? c?.oai_settings?.prompt_manager?.prompts
      ?? []);
    const ord = promptOrderMap(orderOverride);
    const above = [];
    const below = [];
    const seen = [];
    for (const p of (Array.isArray(list) ? list : [])) {
      const name = String(p?.name ?? p?.identifier ?? '');
      if (!name.includes(base)) continue;
      if (p?.marker === true) continue;               // 分隔符类提示词没有真内容 ✓
      /* 开关：prompt_order 说了算 ✓，它没有这条时才看提示词自己带的 enabled ✓ */
      const id = String(p?.identifier ?? '');
      /* 【用户实测】🔒↑ 那条明明在 UI 里开着，却没进来 ✗
         原因：它在【任何一份 prompt_order 里都查不到】✗ → 而我以前退回看提示词自带的
               `enabled`（那是导出预设时的快照 ✗ 常常是 false）✗ → 被误跳过 ✗
         现在：只要 order 里**明确说关着**才跳过 ✓；order 里没这条 → 按"开着"处理 ✓
               （名字里写 🔒 本身就是你明确的意愿：要它发给侧路 ✓） */
      /* 两段式判断 ✓（既尊重酒馆的开关，也不冤枉你标了 🔒 的条目）：
         · 有 prompt_order 信息 且 里面明确说这条关着 → 跳过 ✓
         · 有 prompt_order 信息 但里面根本没这条 → 按开着（你标了 🔒 就是明确要发 ✓）
         · 完全没有 prompt_order 信息 → 退回提示词自带的 enabled ✓（老行为 ✓） */
      const fromOrder = (ord && id) ? ord.get(id) : undefined;
      const on = ord ? (fromOrder === undefined ? true : fromOrder) : (p?.enabled !== false);
      if (!on) { seen.push('✗' + name + '（prompt_order 说关着）'); continue; }
      const content = String(p?.content ?? '').trim();
      if (!content) continue;
      /* 【用户要求】不管预设里那条提示词的「消息归属」是什么（系统 / 用户 / AI 助手），
         一律当【系统】处理 ✓ 并进侧路提示词正文 ✓（不再按身份拆成多条消息 ✗） */
      if (name.includes(MARK_DOWN)) { above.push(resolveMacros(content)); seen.push('↑' + name); }
      else { below.push(resolveMacros(content)); seen.push('↓' + name); }   // 含 🔒↑、或只写了 🔒 → 都放下面 ✓
    }
    if (seen.length) {
      console.log('[RBQ] 预设标记（开关以 prompt_order 为准）：' + seen.join(' ｜ '));
    }
    if (above.length || below.length) {
      console.log('[RBQ] 预设标记：上面 ' + above.length + ' 条 / 下面 ' + below.length + ' 条（标记「' + MARK_DOWN + '」「' + MARK_UP + '」）→ 一律按系统身份并进侧路提示词');
    }
    return { above: above.join('\n\n'), below: below.join('\n\n'), extras: [] };
  } catch (e) { return none; }
}

/** 兼容旧调用点：现在不再按身份拆消息了，恒返回空数组 ✓ */
export function presetExtras() { return []; }

/** 把侧路提示词本体按预设标记包起来（上面 + 本体 + 下面 ✓） */
export function withPresetBlocks(core, listOverride = null) {
  const { above, below } = presetMarkedBlocks(listOverride);
  const parts = [];
  if (above) parts.push(above);
  parts.push(String(core ?? ''));
  if (below) parts.push(below);
  return parts.filter((x) => String(x ?? '').trim()).join('\n\n');
}
/**
 * 【用户实测】发给侧路的「正文」里居然还带着整块 <thinking_matrix> 和 <This_round_events> ✗
 *   → 说明调用方传进来的可能是【原始消息】而不是清洗过的正文 ✗
 *   这里在侧路的最底层再兜一次清洗 ✓（幂等 ✓ 清过的再清一次也不会坏 ✓）
 */
function cleanInput(text) {
  const s = String(text ?? "");
  try {
    const cleaned = extractProseStrict(s);
    /* 【审计发现】以前抽空时把【原文】回传 ✗ → 被标签包裹的内容照样进提示词 ✓
       现在：抽空就返回空串 ✓（宁可这轮没正文，也不把标签内容发出去 ✓）*/
    if (cleaned && cleaned.trim().length >= 1) return cleaned;
    console.warn('[RBQ] 这条消息几乎全是标签包裹的内容 → 侧路这一轮按空正文处理 ✓');
    return '';
  } catch (e) { return s; }
}

function memoryPrompt(rawText, cfg) {
  cfg = normCfg(cfg);
  const text = cleanInput(rawText);
  const cast = (() => {
    try {
      const names = extras.presentNames();
      // 【用户实测】AI 从没给 {{user}} 写过记忆 ✗ —— 名单里必须包含主角 ✓
      if (!names.includes('{{user}}')) names.unshift('{{user}}');
      return names.join('、') || '{{user}}';
    } catch { return '{{user}}'; }
  })();
  const core = String(cfg.prompts.memory ?? '')
    .replace(/\{在场角色\}/g, cast)
    .replace(/\{正文\}/g, text);
  return withPresetBlocks(core);
}
/** 表12 的标签写法：属性名 = 中文列名（从 schema 生成，AI 不会写错字段） */
function epochSpec() {
  /* 交给 prompts.js 生成（那边 getTable/columnDefsFor 实测可用；
     本模块顶部的 schema 实例在某些加载顺序下拿不到表12 → 一直退回骨架）。 */
  const fallback = '<epoch 封包名="…" 时间轴区间="…" 剧情压缩="…" />';
  try { return prompts.epochWriteSpec?.() || fallback; } catch (e) { return fallback; }
}

function summaryPrompt(text, cfg, range) {
  cfg = normCfg(cfg);
  /* 【审计修】预设标记（🔒↓ 上面 / 🔒↑ 下面）以前只有 fill/memory 生效 ✗ → 大总结也套上 ✓ */
  return withPresetBlocks(String(cfg.prompts.summary ?? '')
    .replace(/\{表12写法\}/g, epochSpec())
    .replace(/\{范围\}/g, String(range ?? ''))
    .replace(/\{正文\}/g, text));
}
/** 开了哪些附加功能（旁白 / CG / 小剧场）——只写开了的那几个 */
function enabledExtras() {
  // extras 没有 isEnabled，只有 get(key)（返回该功能的开启状态/配置）
  const on = (k) => { try { const v = extras.get?.(k); return typeof v === 'boolean' ? v : !!(v && (v.enabled ?? v.on ?? true) !== false); } catch { return false; } };
  const list = [];
  if (on('narration')) list.push(['旁白点评（第三人称、调皮戏谑、毒舌又欣赏，每人 200-300 字，只写外部观察）', 'aside']);
  if (on('cg')) list.push(['CG 画面描述（镜头、光线、构图、材质细节，画面感第一）', 'cg']);
  if (on('theater')) list.push(['小剧场（角色之间的短对话/内心独白片段）', 'Zilla']);
  return list;
}

function extrasPrompt(text, cfg) {
  cfg = normCfg(cfg);
  text = cleanInput(text);   // 附加功能的正文也要剔除标签 ✓
  const want = enabledExtras();
  const spec = want.map(([desc, tag]) => '- ' + desc + String.fromCharCode(10) +
    '  <' + tag + ' name="角色名">' + String.fromCharCode(10) + '  （内容）' + String.fromCharCode(10) + '  </' + tag + '>').join(String.fromCharCode(10));
  return withPresetBlocks(String(cfg.prompts.extras ?? '')
    .replace(/\{要写的\}/g, spec)
    .replace(/\{正文\}/g, text));
}

/* ------------------------------------------------------------------ 四个任务 */

/** ① 填表：侧路输出 → 协议解析 → txn 应用 */
/** 扫描"该有值却空着"的单元格：表0 全列 + 表2/3/4/13 同名行（跳过机械列） */
function missingCells(limit = 40) {
  const out = [];
  const mech = (() => { try { return new Set(prompts.MECHANICAL_COLUMNS ?? []); } catch { return new Set(); } })();
  const colsOf = (no) => { try { return (schema.getTable(no)?.columns ?? []).slice(); } catch { return []; } };
  const rowsOf = (no) => { try { return store.getRows(no, { create: false }) ?? []; } catch { return []; } };
  const cell = (r, i) => String(r?.[i] ?? "").trim();
  try {
    const r0 = rowsOf(0)[0];
    if (r0) colsOf(0).forEach((c, i) => { const n = String(c); if (!mech.has(n) && !cell(r0, i)) out.push({ no: 0, key: "", col: n }); });
  } catch (e) { /* ignore */ }
  let names = [];
  try { names = rowsOf(2).map((r) => cell(r, 0)).filter(Boolean); } catch (e) { /* ignore */ }
  for (const no of [2, 3, 4, 13]) {
    try {
      const cols = colsOf(no);
      for (const r of rowsOf(no)) {
        const key = cell(r, 0);
        if (!key) continue;
        if (no !== 2 && names.length && names.indexOf(key) < 0) continue;   // 只补有档案/在场上的人
        cols.forEach((c, i) => { if (i === 0) return; const n = String(c); if (!mech.has(n) && !cell(r, i)) out.push({ no, key, col: n }); });
      }
    } catch (e) { /* ignore */ }
  }
  return out.slice(0, limit);
}

/**
 * 【记忆补跑】用户实测：并发时"记忆"常常比"填表"先跑完 ✗，
 * 而记忆的在场名单是**开跑前**算的 → 本轮新登场的角色永远拿不到记忆 ✗
 * 这里在**填表结束之后**再对一次名单：凡是在场、但一条记忆都没有的角色，
 * 单独再发一次记忆请求补上 ✓（不改并发 ✓ 只是补一次 ✓）
 */
export async function taskMemoryFollowUp(text, cfg, signal = null) {
  text = cleanInput(text);   // 记忆补跑的正文也要剔除标签 ✓
  try {
    const want = (() => {
      const set = new Set();
      try { for (const n of extras.presentNames()) if (n) set.add(String(n)); } catch (e) { /* ignore */ }
      set.add('{{user}}');
      // 表2 / 表4 里在场的人也一起算（表0 的在场名单可能还没被 AI 更新 ✓）
      for (const no of [2, 4]) {
        try {
          const rows = store.getRows(no, { create: false }) ?? [];
          for (const r of rows) {
            const nm = String(r?.[0] ?? '').trim();
            if (!nm || /^(未命名\d*|unknown)$/i.test(nm)) continue;
            const state = String(r?.[1] ?? '') + String(r?.[2] ?? '');
            if (/离场|已死|dead|gone/i.test(state)) continue;
            set.add(nm);
          }
        } catch (e) { /* ignore */ }
      }
      return [...set];
    })();
    const missing = want.filter((n) => { try { return (memory.memoriesOf(n) ?? []).length === 0; } catch (e) { return false; } });
    console.log('[RBQ] 记忆校验：在场 ' + want.length + ' 人（' + want.join('、') + '），其中 ' + missing.length + ' 人还没有记忆');
    if (!missing.length) return { applied: 0, missing: [], checked: want };
    console.log('[RBQ] 记忆补跑：这些角色在场但还没有任何记忆 → ' + missing.join('、'));
    const base = memoryPrompt(text, cfg);
    const prompt = base + '\n\n【补写要求】只给下面这些角色写（他们本轮刚登场，还没有记忆）：' + missing.join('、') +
      '\n**必须包含 ' + missing.join('、') + ' 每一个人**，每人一段 <character_memory>。';
    const out = await sideApi.call(prompt, { task: 'memory', temperature: 0.4, maxTokens: 7200, signal, extras: presetExtras() });
    /* 【修 bug】以前这里写的是 memory.parseMemoryBody(out) ✗ ——
       那个函数返回的是"字段对象"（给单条正文用的 ✓），根本不是条目数组 ✗
       → addMemories 收到对象直接抛 `(items ?? []) is not iterable` ✗
       → 补跑"静默失败"，用户只看到"还是只有 {{user}} 的记忆" ✗✓（实测日志抓到 ✓）
       正确做法与主记忆任务一致：正则抠 <character_memory name="X">…</character_memory> ✓ */
    const items = [];
    const re = /<character_memory\s+name\s*=\s*"([^"]+)"\s*>([\s\S]*?)<\/character_memory>/gi;
    let m2;
    while ((m2 = re.exec(out)) !== null) {
      const nm = String(m2[1]).trim();
      const body = String(m2[2]).trim();
      if (!nm || !body) continue;
      let fields = null;
      try { fields = memory.parseMemoryBody(body); } catch (e) { fields = null; }
      items.push({ name: nm, fields: fields ?? { 感知: body }, raw: body });
    }
    if (!items.length) {
      console.warn('[RBQ] 记忆补跑：模型没按格式返回 <character_memory> ✗（前 120 字：' + out.slice(0, 120).replace(/\n/g, ' ') + '）');
      return { applied: 0, missing, checked: want, error: '补跑返回里没有 <character_memory>' };
    }
    const added = memory.addMemories(items, cfg && cfg.msgId);
    console.log('[RBQ] 记忆补跑完成：新写 ' + (added?.added ?? items.length ?? 0) + ' 条（' + items.map((x) => x.name).join('、') + '）');
    return { applied: added?.added ?? items.length ?? 0, missing, checked: want, names: items.map((x) => x.name) };
  } catch (e) {
    console.warn('[RBQ] 记忆补跑失败（不影响其它任务）：' + String(e?.message ?? e));
    return { applied: 0, missing: [], error: String(e?.message ?? e) };
  }
}

/** 定向补充提示词：只让它补这些空单元格 */
function supplementPrompt(list, text) {
  const lines = list.map((x) => "- 表" + x.no + (x.key ? "（" + x.key + "）" : "") + " 的列「" + x.col + "」");
  const data = (() => { try { return prompts.buildTableDataXml ? prompts.buildTableDataXml({ for: "fill" }) : ""; } catch { return ""; } })();
  return [
    "你是填表助手。下面这些单元格目前是空的，请**只补这些**，不要输出其它表或其它列。",
    "填写规则：能按角色人设/剧情合理推断的（发色、发型、体毛、体香、性经验状态、名器类型、性器官特征、三围、四维系数、四维偏好等）直接推断填写；确实无法判断的写「未知」。",
    "输出格式与正常填表一致：用 <data> 包住对应标签，属性名写成该列的列名，多个值可写在同一条标签里。",
    "",
    "待补清单：",
  ].concat(lines).concat([
    "",
    "当前数据（供参考，别重复写已有的）：",
    data,
    "",
    "正文（用来推断）：",
    String(text ?? "").slice(0, 24000),
  ]).join(String.fromCharCode(10));
}
/* 【用户反馈 · 点了终止不会马上停】收口定时器要能被"终止"立刻叫停 ✓ */
let __cancelled = false;
export function cancelPending() {
  __cancelled = true;
  try { console.log('[RBQ] 已取消待跑的收口（终止后不再写回表格）'); } catch (e) { /* ignore */ }
  return true;
}
export function resumeAfterCancel() { __cancelled = false; }

export async function taskFill(text, cfg, signal = null) {
  if (isFrozen()) { console.log("[RBQ] 冻结期内，跳过本轮填表"); return { applied: 0, ops: 0, frozen: true }; }
  // 自愈：开头先把上一轮漏下的兜底补上（收尾时机不对时会有残留，这里兜住）
  try { fixDerivedFields(); } catch (e) { /* ignore */ }
  try { finalFill(); } catch (e) { /* ignore */ }
  await new Promise((r) => setTimeout(r, 800));   // 让 applyOps 落盘，别和新写入打架
  const out = await sideApi.call(fillPrompt(text, cfg), { task: 'fill', temperature: 0.2, maxTokens: 24000, signal, extras: presetExtras() });
  /* 诊断：真 API 常被 max_tokens / 预设回复长度截断 → 把"返回多长、有没有收尾"打出来 */
  try {
    const __s = String(out ?? '');
    /* 关系行诊断：看 AI 到底用什么属性名写表5 的键 */
    try {
      const rels = __s.match(/<relation[^>]*>/gi) || [];
      if (rels.length) console.log('[RBQ] 关系行诊断（' + rels.length + ' 条）：' + rels.slice(0, 3).map((r) => r.slice(0, 140)).join(' ｜ '));
      else console.log('[RBQ] 关系行诊断：本轮没有 <relation> 标签');
    } catch (e) { /* ignore */ }
    try { window.__rbqLastFill = __s; } catch (e) { /* ignore */ }
    console.log('[RBQ] 填表返回 ' + __s.length + ' 字' + (/<\/data>\s*$/.test(__s) ? '（有 </data> 收尾 ✓）' : '（**没有 </data> 收尾 → 被截断了** ✗）') + ' 末尾：' + __s.slice(-90).replace(/\s+/g, ' '));
  } catch (e) { /* ignore */ }
  const ops = (() => {
    try {
      const parsed = protocol.parseAll(out);
      if (Array.isArray(parsed)) return parsed;
      if (parsed?.ops) return parsed.ops;
      if (parsed?.expanded?.ops) return parsed.expanded.ops;
      return [];
    } catch { return []; }
  })();
  /* 【v1.95】把"技能 / 战斗 / 离场 / 记忆"这类要走规则引擎的事实也展开并入 ✓
     （它们以前只在正文解析路径里展开 ✗ —— 现在填表只走侧路，不搬过来这些功能就死了 ✓） */
  try {
    const __pr = protocol.parseAll(out);
    const __un = (Array.isArray(__pr) ? [] : (__pr?.unparsed ?? []));
    if (__un.length) {
      const ex = await expandMod.expandUnparsed(__un);
      const more = (ex?.ops ?? []);
      if (more.length) { console.log("[RBQ] 侧路额外展开 " + more.length + " 条（技能/战斗/离场/记忆）"); ops.push(...more); }
      if (ex?.notes?.length) console.log("[RBQ] " + ex.notes.join("；"));
    }
  } catch (e) { console.warn("[RBQ] 展开技能/离场失败", e); }
  if (!ops.length) return { applied: 0, ops: 0, raw: out.slice(0, 200) };
  const r = await txn.applyOps(ops, { source: 'side' });
  // 补空列：一遍不够就定向补一次（用户反馈"每张表都缺一点"）
  const sup = { tried: false, missing: 0, applied: 0 };
  try {
    const miss = missingCells();
    if (miss.length) {
      sup.tried = true; sup.missing = miss.length;
      const out2 = await sideApi.call(supplementPrompt(miss, cleanInput(text)), { task: "fill", temperature: 0.2, maxTokens: 18000, signal });
      let ops2 = [];
      try { const pr = protocol.parseAll(out2); ops2 = Array.isArray(pr) ? pr : (pr?.ops ?? pr?.expanded?.ops ?? []); } catch { ops2 = []; }
      if (ops2.length) { const r2 = await txn.applyOps(ops2, { source: "side" }); sup.applied = r2?.applied ?? 0; }
    }
  } catch (e) { sup.error = String(e?.message ?? e).slice(0, 120); }
  /* 持续收口：填表/补写的写入是异步落盘的，收口只跑一次会被后来的写入覆盖 ✗
     → 从现在起 60 秒内每 4 秒收口一次（只补空格，不会改已有值），保证最后一笔写入之后仍然没有空格 ✓ */
  try {
    __cancelled = false;   // 新一轮收口开始 → 解除上次的"已终止" ✓
    let n = 0;
    const timer = setInterval(() => {
      if (__cancelled) { try { clearInterval(timer); } catch (e) { /* ignore */ } return; }
      n += 1;
      /* 【审计修 · 关键】回滚只冻结 15 秒 ✗ 而收口要跑 60 秒 ✓
         冻结一过，final-fill / derived 这些来源都不在冻结白名单里 →
         会把兜底值、系统轮次**写回刚刚被回滚掉的表** ✗
         修法：每次收口前先看"是不是刚回滚过 / 用户点了终止" ✓ 是就跳过这一轮 ✓ */
      try { if (isAbortRequested() || isFrozen()) return; } catch (e) { /* ignore */ }
      try { finalFill(); } catch (e) { /* ignore */ }
      try { fixDerivedFields(); } catch (e) { /* ignore */ }
      if (n >= 15) { try { clearInterval(timer); } catch (e) { /* ignore */ } }
    }, 4000);
    console.log('[RBQ] 开始持续收口（每 4 秒一次，共 60 秒；回滚/终止期间自动跳过 ✓）');
  } catch (e) { /* ignore */ }
  return { applied: r?.applied ?? 0, ops: ops.length, failed: (r?.failed ?? []).length, supplement: sup };
}

/** ② 记忆提炼：侧路输出 → 逐角色记忆条目 */
export async function taskMemory(text, cfg, signal = null, msgId = null) {
  const out = await sideApi.call(memoryPrompt(text, cfg), { task: 'memory', temperature: 0.4, maxTokens: 6000, signal, extras: presetExtras() });
  const items = [];
  const re = /<character_memory\s+name\s*=\s*"([^"]+)"\s*>([\s\S]*?)<\/character_memory>/gi;
  let m;
  while ((m = re.exec(out)) !== null) {
    const name = String(m[1]).trim();
    const body = String(m[2]).trim();
    if (!name || !body) continue;
    let fields = null;
    try { fields = memory.parseMemoryBody(body); } catch { fields = null; }
    items.push({ name, fields: fields ?? { 感知: body }, raw: body });
  }
  if (!items.length) return { added: 0, raw: out.slice(0, 200) };
  /* 【审计修】addMemories 会因为"同 40 字前缀已存在"而一条都不写 ✗
     以前把【解析出的条数】当写入条数 → 面板显示"ok N 条记忆"但一条没入库 ✓ */
  try { const wr = memory.addMemories(items, msgId); return { added: Number(wr?.added ?? 0), parsed: items.length, chars: out.length }; } catch (e) { return { added: 0, error: String(e?.message ?? e) }; }
}

/** 把"指定轮次的小总结"拼成总结任务的输入（数据库里就有，不用重发正文） */
export function summaryInput(fallbackText, round, threshold) {
  /* 【用户要求】大总结/预览用的"退回正文"也要剔除标签 ✓（参数名是 fallbackText ✓） */
  const safeText = cleanInput(fallbackText);
  const from = Math.max(1, Number(round) - Math.max(1, Number(threshold) || 50) + 1);
  const to = Number(round) || 0;
  let events = [];
  try { events = summaryStore.listEvents({ limit: 500 }).filter((e) => Number(e.round) >= from && Number(e.round) <= to); } catch { events = []; }
  if (!events.length) return { text: safeText, from, to, count: 0 };
  const lines = events.map((e) => '- [第' + e.round + '轮] ' + String(e.text ?? '').replace(/\n/g, '；'));
  return { text: lines.join('\n'), from, to, count: events.length };
}

/** ③ 大总结：**依赖 ① 完成**（调用方先 await ①）；输入是这一区间的小总结 */
/** 定向补写：只针对自检报出的缺口再要一次（协议与列定义跟填表完全一致） */
function repairPrompt(missing, text) {
  const NLx2 = String.fromCharCode(10);
  const guide = (() => {
    try {
      const g = guideForExtractor(prompts.buildTablePromptGuide?.() ?? "");
      const spec = prompts.buildTablePromptSpec?.({ withTags: true, withMemory: false, excludeTables: [12], withDefs: true }) ?? "";
      return [g, spec].filter((x) => String(x || "").trim()).join(NLx2);
    } catch (e) { return ""; }
  })();
  return [
    "你是数据抽取器。上一轮填表有遗漏，现在**只补下面的缺口**，不要重复已写过的内容。",
    "只输出 <data> 表格写入指令，不要解释、不要复述正文。",
    "",
    "======== 上一轮**具体哪些格子空着**（逐格列出来了，全部要补）========",
    (() => {
      try {
        const c0 = (schema.getTable(0)?.columns ?? []).map((c) => String(c));
        const r0 = (store.getRows(0, { create: false }) ?? [])[0] ?? [];
        const i = c0.findIndex((c) => c.indexOf("在场") >= 0);
        const raw = i >= 0 ? String(r0[i] ?? "") : "";
        const names = raw.split(/[\/、,，|]/).map((s) => s.trim()).filter(Boolean);
        return names.length ? "======== 当前在场角色（每个都必须有自己的行）========\n" + names.join(" / ") : "";
      } catch (e) { return ""; }
    })(),
    (() => {
      const s = String(missing || "");
      const n = s.split("｜").filter((x) => x.indexOf("为空") >= 0).length;
      if (n > 0 && n <= 6) return "【最后一击】只剩下面这几格了，**这一轮一个字都不许漏**：每一格都要给出具体值，写不全就算失败。";
      return "";
    })(),
    String(missing || ""),
    "======== 怎么补 ========",
    "· 表3（生理）/表4（即时状态）/表13（HP/MP/SP）是**每个在场角色各一行**，用 <physique>/<state>/<status> 标签。",
    "· 表6（剧情大纲）用 <plot>：终极宏愿、宏愿进度、当前篇章、篇章状态、即时焦点、焦点反馈。",
    "· 表2 的「四维系数」格式 力量|体质|敏捷|智力（如 1.2|1.0|1.1|0.9）—— 必须写；判断不了就写 1.0|1.0|1.0|1.0，绝不留空。",
    "· **空的格子必须补**：按角色人设编出**具体可信的内容**（身份/种族/性格/职业都要考虑），**禁止写「未探明」「未知」搪塞**；只有确实没有的装备位才写「无」。",
    "· **整张表为空**（一行都没有）时，按当前剧情初始化出第一行，不许继续留空表。",
    "· **四维系数必须写、且必须跟角色定位一致**（力量|体质|敏捷|智力）：近战/重武器→第1位 1.3~2.0；耐打/苦修→第2位；刺客/远程/暗器→第3位；法师/学者/医者→第4位；无关项 0.7~1.0。",
    "   例：医者 1.0|1.0|1.1|1.6；刺客 1.0|0.9|1.7|1.1；重装战士 1.7|1.5|0.9|0.8。**不要所有角色都写一样的系数。**",
    "· **写每个角色一行的表（表2/3/4/13）时，标签上必须带 name=\"角色名\"**，名字要和表0 在场名单里的一字不差；不带 name 的行会被丢弃。",
    "· 例子：`<state name=\"沈清\" coord=\"屋内-桌边\" departure=\"正常\" outerUpper=\"青色布衣\" …/>`。",
    "",
    "======== 这些表的列定义（只列你缺的那几张）========",
    "（列名与含义都很直白，只写缺口那几列即可，不用重复已写过的内容）",
    "",
    "======== 本轮正文 ========",
    String(text || ""),
    "",
  ].join(NLx2);
}

/** 定向补写：返回 { applied, ops, rest }（rest = 补完后仍缺的） */
/**
 * 按表分批补写：把缺口清单按「表N」拆开，每张表单独发一次补写，串行。
 * 实测依据：一次要求补十几格时 AI 只挑一部分写；拆成每表一次后命中率高很多。
 * @returns {Promise<{applied:number, rest:string, calls:number}>}
 */
export async function taskRepairFillBatched(text, cfg, missing, signal = null) {
  let rest = String(missing || "");
  let applied = 0;
  let calls = 0;
  try {
    // 按表分组（缺口清单形如：表2 张三 的「绝对雷区」为空｜表3 …）
    const groups = {};
    for (const piece of rest.split("｜")) {
      const m = /表(\d+)/.exec(piece);
      if (!m) continue;
      const k = m[1];
      (groups[k] = groups[k] || []).push(piece.trim());
    }
    const keys = Object.keys(groups);
    if (!keys.length) return { applied: 0, rest, calls: 0 };
    for (const k of keys) {
      if (signal && signal.aborted) break;
      const sub = groups[k].join("｜");
      const one = await taskRepairFill(text, cfg, sub, signal);
      calls += 1;
      applied += one?.applied || 0;
      rest = auditAfterFill();
      if (!rest) break;
    }
  } catch (e) { console.warn("[RBQ] 分批补写失败", e); }
  /* 收口定时器：等所有写入落盘之后再收口 + 重算（index.js 的收尾里不一定跑得到，放这里最稳） */
  try {
    for (const d of [3000, 10000, 20000]) {
      setTimeout(() => {
        try { finalFill(); } catch (e) { /* ignore */ }
        try { fixDerivedFields(); } catch (e) { /* ignore */ }
      }, d);
    }
    console.log('[RBQ] 已排三次收口定时器（3s / 10s / 20s）');
  } catch (e) { /* ignore */ }
  return { applied, rest, calls };
}
export async function taskRepairFill(text, cfg, missing, signal = null) {
  if (isFrozen()) return { applied: 0, rest: String(missing || ""), frozen: true };
  const out = await sideApi.call(repairPrompt(missing, cleanInput(text)), { task: "fill", temperature: 0.2, maxTokens: 18000, signal });
  try { window.__rbqLastRepair = String(out ?? ''); console.log('[RBQ] 补写返回 ' + String(out ?? '').length + ' 字：' + String(out ?? '').slice(0, 160).replace(/\s+/g, ' ')); } catch (e) { /* ignore */ }
  const ops = (() => {
    try { const parsed = protocol.parseAll(out); if (Array.isArray(parsed)) return parsed; if (parsed && parsed.ops) return parsed.ops; return []; } catch (e) { return []; }
  })();
  let applied = 0;
  if (ops.length) { try { const r = await txn.applyOps(ops, { source: "side-repair" }); applied = (r && r.applied) || 0; } catch (e) { console.warn("[RBQ] 补写应用失败", e); } }
  let rest = "";
  try { rest = auditAfterFill(); } catch (e) { /* ignore */ }
  return { applied, ops: ops.length, rest };
}

export async function taskSummary(text, cfg, round, signal = null) {
  // 输入优先用"指定轮次的小总结"（数据库 summary.events），没有才退回传进来的正文
  const th = (() => { try { return summaryStore.getThreshold(); } catch { return 50; } })();
  const built = summaryInput(text, round, th);
  const range = '第 ' + built.from + '-' + built.to + ' 轮（' + built.count + ' 条小总结）';
  const out = await sideApi.call(summaryPrompt(built.text, cfg, range), { task: 'summary', temperature: 0.3, maxTokens: 3600, signal });
  const ops = (() => {
    try {
      const parsed = protocol.parseAll(out);
      if (Array.isArray(parsed)) return parsed;
      if (parsed?.ops) return parsed.ops;
      return [];
    } catch { return []; }
  })();
  if (!ops.length) return { applied: 0, raw: out.slice(0, 200) };
  const r = await txn.applyOps(ops, { source: 'side-summary' });
  return { applied: r?.applied ?? 0, ops: ops.length };
}

/** ④ 附加功能（可选）：只产出文本，写进对应变量供预设引用 */
export async function taskExtras(text, cfg, signal = null) {
  const out = await sideApi.call(extrasPrompt(text, cfg), { task: 'extras', temperature: 0.7, maxTokens: 4800, signal });
  try {
    const mod = await import('./extras.js');
    const aside = (out.match(/<aside[\s\S]*?<\/aside>/gi) ?? []).join('\n');
    const cg = (out.match(/<cg[\s\S]*?<\/cg>/gi) ?? []).join('\n');
    const zilla = (out.match(/<Zilla[\s\S]*?<\/Zilla>/gi) ?? []).join('\n');
    // 不再写聊天变量：直接交给调用方挂到"楼层"上（回退楼层也不丢）
    return { chars: out.length, aside: !!aside, cg: !!cg, zilla: !!zilla, asideText: aside, cgText: cg, zillaText: zilla };
  } catch { /* ignore */ }
  return { chars: out.length };
}

/* ------------------------------------------------------------------ 调度 */

/**
 * 为一条消息跑侧路任务（幂等 + 并发 + 依赖）
 * @param {number} id 消息下标（幂等键）
 * @param {string} text 该层正文
 * @param {{round?:number, signal?:AbortSignal}} opts
 */
export function runForMessage(id, text, { round = 0, signal = null, onProgress = null } = {}) {
  const cfg = sideApi.config();
  // 记忆去重需要知道"是哪条消息"：同一条消息重新生成时，用它替换旧记忆而不是追加
  try { if (cfg && typeof cfg === "object") cfg.msgId = id; } catch (e) { /* ignore */ }
  if (!cfg.enabled) return Promise.resolve({ skipped: 'disabled' });
  if (!text || !String(text).trim()) return Promise.resolve({ skipped: 'empty' });
  /* 【用户要求】所有侧路任务都只用"剔除过标签内容"的正文 ✓（不是只给记忆清洗 ✗）*/
  text = cleanInput(text);

  const key = Number(id);
  if (inflight.has(key)) return inflight.get(key);          // in-flight 去重

  const rec = { id: key, at: Date.now(), round: Number(round) || 0, tasks: {} };
  records.set(key, rec);
  while (records.size > MAX_RECORDS) records.delete(records.keys().next().value);

  const p = (async () => {
    // 进度回调（给界面用）：每项调用的开始/结束都报一次
    const prog = (name, state, detail) => { try { onProgress?.(name, state, detail || ''); } catch { /* ignore */ } };
    // 结果判读：**只有真的写进去了才算 ok**，别拿"请求成功"糊弄用户
    const verdict = (name, r) => {
      if (!r) return { state: 'failed', detail: '调用失败' };
      if (name === 'fill') {
        const applied = Number(r.applied) || 0;
        const ops = Number(r.ops) || 0;
        if (applied > 0) return { state: 'ok', detail: '写入 ' + applied + ' 条' };
        if (ops > 0) return { state: 'empty', detail: 'AI 给了 ' + ops + ' 条但一条都没写进去' };
        return { state: 'empty', detail: r.raw ? 'AI 没按协议写：' + String(r.raw).replace(/\s+/g, ' ').slice(0, 70) : 'AI 没给出可写内容' };
      }
      if (name === 'memory') { const a = Number(r.added) || 0; return a > 0 ? { state: 'ok', detail: a + ' 条记忆' } : { state: 'empty', detail: '没有可存记忆' }; }
      if (name === 'extras') {
        const parts = [];
        if (r.aside) parts.push('旁白');
        if (r.cg) parts.push('CG');
        if (r.zilla) parts.push('小剧场');
        return parts.length ? { state: 'ok', detail: parts.join('/') + ' ' + (r.chars || 0) + ' 字' } : { state: 'empty', detail: '没有可写内容' };
      }
      if (name === 'summary') { const a = Number(r.applied) || 0; return a > 0 ? { state: 'ok', detail: '写入大总结 ' + a + ' 条' } : { state: 'empty', detail: '没有可写内容' }; }
      return { state: 'ok', detail: '' };
    };
    const guard = (name, fn) => {
      /* 用户点了终止 → 后面的任务一个都别跑 ✓ */
      if (isAbortRequested()) {
        rec.tasks[name] = { state: 'failed', detail: '用户已中止', aborted: true };
        prog(name, 'failed', '已中止');
        return Promise.resolve(null);
      }
      rec.tasks[name] = { state: 'running', attempts: 0, error: null };
      prog(name, 'running', '进行中…');
      const maxTries = Math.max(1, Number(cfg.retries ?? 2) + 1);
      /* 【审计修 · 重试只能重试"没写过库的那一段"】
         侧路任务是"调 API → 解析 → 写库"一条龙 ✓ 重试包住整条 ✗
         → 若失败发生在写库**之后**（进度回调抛错之类 ✓）重试会把同样的 op 再写一遍 ✗
           （重复建行 + 再叠一个 60 秒收口定时器 ✓）
         修法：每次尝试前记一次写库计数 ✓ 如果**这次尝试自己**写过库又失败了 → 不再重试 ✓
         （必须按"本次尝试"判 ✓ 不能用全局起点 —— 填表/记忆是并发的 ✓
           别人的写入会让全局起点误判成"我写过" ✗ 实测就这样把重试全堵死了 ✓） */
      const fnGuarded = async (...args) => {
        const before = getWriteCount();
        try {
          return await fn(...args);
        } catch (e) {
          if (getWriteCount() !== before) throw new Error('这一轮已经写进表格了，不再重试（避免重复写入）：' + String(e?.message ?? e));
          throw e;
        }
      };
      return sideApi.withRetry(fnGuarded, {
        // 【用户实测】以前默认 0 → 从来不重试 ✗；改成默认 2（= 最多 3 次尝试，与参考实现一致 ✓）
        retries: Number(cfg.retries ?? 2),
        backoffMs: Number(cfg.backoffMs) || 1000,
        signal,
        onAttempt: (n, e) => {
          rec.tasks[name] = { ...rec.tasks[name], attempts: n, error: e ? String(e?.message ?? e) : null, maxTries };
          /* 【用户要求】让用户知道当前处于什么状态 ✓
             失败/超时之后要重试时，卡片上直接写「超时重试 1/3」✓（以前只写"进行中…"✗） */
          if (e) {
            const msg = String(e?.message ?? e);
            const isTo = /超时|timeout|abort/i.test(msg);
            const label = (isTo ? '超时重试 ' : '失败重试 ') + n + '/' + maxTries;
            prog(name, 'running', label);
            console.warn('[RBQ] ' + name + '：第 ' + n + ' 次没成功（' + msg.slice(0, 60) + '）→ ' + label);
          }
        },
      })
        .then((r) => {
          const v = verdict(name, r);
          rec.tasks[name] = { ...rec.tasks[name], state: v.state, detail: v.detail, result: r, error: null };
          prog(name, v.state, v.detail);
          return r;
        })
        .catch((e) => {
          const msg = String(e?.message ?? e);
          // 【诊断】失败原因一定要打出来（以前只记进状态，排查时看不到 ✗）
          // 单行 warn（以前打 console.error + 整个 Error 对象 → 输出里全是堆栈，看着像崩了 ✗）
          try { console.warn('[RBQ] 侧路任务「' + name + '」失败：' + msg); } catch (e2) { /* ignore */ }
          rec.tasks[name] = { ...rec.tasks[name], state: 'failed', detail: msg, error: msg };
          prog(name, 'failed', msg);
          return null;
        });
    };

    // ①②④ 并发
    const jobs = [];
    if (cfg.tasks.fill) jobs.push(guard('fill', () => taskFill(text, cfg, signal)));
    else { rec.tasks.fill = { state: 'off' }; prog('fill', 'off', '未开启'); }
    if (cfg.tasks.memory) jobs.push(guard('memory', () => taskMemory(text, cfg, signal, cfg && cfg.msgId)));
    else { rec.tasks.memory = { state: 'off' }; prog('memory', 'off', '未开启'); }
    const wantExtras = (() => { try { return enabledExtras().length > 0; } catch { return false; } })();
    if (cfg.tasks.extras && wantExtras) jobs.push(guard('extras', () => taskExtras(text, cfg, signal)));
    else { rec.tasks.extras = { state: 'off', reason: wantExtras ? 'none-enabled' : undefined }; prog('extras', 'off', wantExtras ? '附加功能都没开' : '未开启'); }
    await Promise.all(jobs);

    /* 【记忆补跑】并发下"记忆"常比"填表"先跑完 ✗ → 本轮新登场的角色漏记忆 ✗（用户实测 ✓）
       填表结束后对一次名单，给"在场但还没有任何记忆"的角色补一次 ✓（不改并发 ✓） */
    if (cfg.tasks.memory && !isAbortRequested()) {
      try {
        prog('memory', 'running', '校验在场角色的记忆…');
        const fu = await taskMemoryFollowUp(text, cfg, signal);
        if (fu && fu.missing && fu.missing.length) {
          rec.tasks.memory = { ...(rec.tasks.memory ?? {}), state: 'ok', detail: '检测到新角色，已补写 ' + (fu.applied || 0) + ' 条（' + fu.missing.join('、') + '）' };
          prog('memory', 'ok', '补写 ' + (fu.applied || 0) + ' 条（' + fu.missing.join('、') + '）');
        } else {
          /* 【用户要求】没补也要让用户看得见 ✓（否则会以为这个功能没生效 ✗） */
          const all = (fu && fu.checked) ? fu.checked.join('、') : '';
          rec.tasks.memory = { ...(rec.tasks.memory ?? {}), detail: (rec.tasks.memory?.detail || '') + '（在场角色记忆校验：都有 ✓' + (all ? '：' + all : '') + '）' };
          if (fu && fu.error) {
            rec.tasks.memory = { ...(rec.tasks.memory ?? {}), state: 'failed', detail: '补跑失败：' + fu.error };
            prog('memory', 'failed', '补跑失败：' + String(fu.error).slice(0, 40));
          } else {
            prog('memory', rec.tasks.memory?.state === 'failed' ? 'failed' : 'ok', '校验通过 · 无遗漏');
          }
        }
      } catch (e) { console.warn('[RBQ] 记忆校验失败', e); }
    }

    // ③ 大总结：只在"到点"时才发（它是独立任务，不该每条消息都发）
    const bigEvery = (() => { try { return Number(store.getConfigValue('summary.bigThreshold', 20)) || 20; } catch { return 20; } })();
    const r0 = Number(rec.round) || 0;
    const summaryDue = bigEvery > 0 && r0 > 0 && r0 % bigEvery === 0;
    if (!cfg.tasks.summary) { rec.tasks.summary = { state: 'off' }; prog('summary', 'off', '未开启'); }
    else if (!summaryDue) { rec.tasks.summary = { state: 'idle', every: bigEvery }; prog('summary', 'idle', '每 ' + bigEvery + ' 轮一次，本轮不发'); }
    else await guard('summary', () => taskSummary(text, cfg, rec.round, signal));

    rec.doneAt = Date.now();
    // 把附加内容挂到这一层楼上（删楼层/回退都不会让剩下的内容消失）
    try {
      const ex = rec.tasks?.extras?.result;
      if (ex && (ex.asideText || ex.cgText || ex.zillaText)) {
        extrasMod.writeFloorExtras(key, { aside: ex.asideText || '', cg: ex.cgText || '', zilla: ex.zillaText || '', round: rec.round });
      }
    } catch { /* ignore */ }
  try { console.log('[RBQ] 侧路任务结束：' + statusLine(rec)); } catch { /* ignore */ }
    return rec;
  })().finally(() => inflight.delete(key));

  inflight.set(key, p);
  return p;
}

/** 手动重跑（面板"重试"按钮用） */
export function rerun(id, text, opts = {}) {
  records.delete(Number(id));
  return runForMessage(id, text, opts);
}

/** 预览某个任务实际会发出去的提示词（面板用；不调用 API） */
export function preview(task, text = '（这里是你发出去的那一层正文）', round = 0) {
  const cfg = sideApi.config();
  try {
    if (task === 'fill') return fillPrompt(text, cfg);
    if (task === 'memory') return memoryPrompt(text, cfg);
    if (task === 'summary') {
      const th = (() => { try { return summaryStore.getThreshold(); } catch { return 50; } })();
      const built = summaryInput(text, Number(round) || 0, th);
      return summaryPrompt(built.text, cfg, '第 ' + built.from + '-' + built.to + ' 轮（' + built.count + ' 条小总结）');
    }
    if (task === 'extras') return extrasPrompt(text, cfg);
  } catch (e) { return '预览失败：' + String(e?.message ?? e); }
  return '';
}

/** 汇总一行状态文本（面板显示用） */
/**
 * 填表后自检：核对"必填表是否真有数据"，把缺的东西说清楚（返回一句话，空串=齐全）
 *   表0 的在场名单 → 表2/3/4/13 每个在场角色都要有行；表6 至少一行；表2 的四维系数不能空
 */
/**
 * 派生字段补算（不指望 AI）：表2 的「年龄」= 表0 时空坐标里的年份 − 出生日期里的年份
 *   只在该列存在、且能得到两个年份时才写；写不动也不报错。
 */
/**
 * 最终收口：把"最小列集"里仍然空着的格子按推导/合理默认值补上，保证用户看到的表没有空。
 * 注意：能推导的**真推导**（四维系数看战斗风格、年龄看年份差），推不出来的才用词库默认值。
 */
export function finalFill() {
  try {
    const MIN = {
      0: ['时空坐标', '绝对位置名称', '环境气象', '在场实体名单'],
      1: ['地点名称', '所属大区', '物理规模', '核心职能'],
      2: ['四维系数(STR|CON|DEX|INT)', '年龄', '技能池', '绝对雷区', '核心偏好', '深层软肋'],
      3: ['核心性癖', '情境偏好', '性雷区', '特殊体征', '生理周期'],
      4: ['头部装备', '上装外衣', '上装内层', '颈部附加', '下装外层', '下装内层', '腿部裹覆', '足部', '下肢约束', '双手持物', '躯干姿势', '约束距离', '表层面具', '潜意识漏出', '伪装标识', '离场状态'],
      5: ['发起方A', '承受方B', '表面关系', '表面称呼', '私密关系', '私密称呼', '好感底色', '服从结构', '占有欲表现', '情报盲区', '当前防备姿态', '定情回忆'],
      6: ['终极宏愿', '宏愿进度', '当前篇章', '篇章状态', '即时焦点', '焦点反馈'],
      7: ['任务名称', '行动类别', '物理目标', '执行坐标', '挂载角色', '发放方', '推进状态'],
      9: ['物品名称', '当前归属', '物理类别'],
      10: ['技能名称', '检定类型', '物理描述', '熟练阶层', 'MP消耗', 'SP消耗', '基础伤害/治疗量', 'CD冷却', '波及范围', '释放门槛', '封印状态'],
      11: ['名称', '数据分类', '主角声望/参与度'],
      13: ['HP(当前)', 'HP(上限)', 'MP(当前)', 'MP(上限)', 'SP(当前)', 'SP(上限)'],   // 力量/ATK/负重等派生列由 rules.recalcCharacters 算，不在这里收口
      14: ['等级'],
    };
    // 词库默认值（老模板里出现过的合理值，不用「未探明」）
    const DEF = {
      '技能池': '[]', '生理周期': '常规态', '离场状态': '在场', '推进状态': '进行中',
      '行动类别': '日常约定', '检定类型': '主动释放', '物理类别': '杂物', '数据分类': '实体阵营',
      '主角声望/参与度': '未涉足', '熟练阶层': 'Lv.1/初阶', '服从结构': 'A平等对待B', '占有欲表现': '无表现',
      '好感底色': '中性', '当前防备姿态': '常态警惕', '情报盲区': '未知晓对方近期动向', '定情回忆': '尚无',
      '表面关系': '相识', '表面称呼': '直呼其名', '私密关系': '尚未交心', '私密称呼': '无',
      '篇章状态': '进行中', '宏愿进度': '刚起步', '即时焦点': '推进当前事件', '焦点反馈': '未产生变化',
      '物理目标': '按任务描述推进', '执行坐标': '当前所在地', '发放方': '无', '挂载角色': '无',
      '环境气象': '常态', '物理规模': '中小型', '核心职能': '日常起居', '所属大区': '当前区域',
      '核心性癖': '由剧情推进显现', '情境偏好': '安静私密、情绪放松时', '性雷区': '强迫与羞辱',
      '特殊体征': '无', '绝对雷区': '背叛与欺骗', '核心偏好': '被理解与尊重', '深层软肋': '重视之人',
      '躯干姿势': '自然站立', '表层面具': '平静', '潜意识漏出': '无', '伪装标识': '无',
      '约束距离': '无', '下肢约束': '无', '双手持物': '无',
      'MP消耗': '0', 'SP消耗': '0', '基础伤害/治疗量': '0', 'CD冷却': '0',
      '波及范围': '单体', '释放门槛': '无', '封印状态': '就绪可用', '冷却状态': '就绪',
    };
    const EQUIP = ['头部装备', '上装外衣', '上装内层', '颈部附加', '下装外层', '下装内层', '腿部裹覆', '足部', '下肢约束', '双手持物'];

    // 四维系数：读这个角色的"战斗风格 / 职业 / 种族"推断（真推导）
    const coefFrom = (style, job, name) => {
      const s = String(style || "") + " " + String(job || "");
      const score = { STR: 0, CON: 0, DEX: 0, INT: 0 };
      const hit = (keys, k) => { for (const x of keys) if (s.indexOf(x) >= 0) score[k] += 1; };
      hit(["力", "刚", "猛", "重", "武", "刀", "剑", "拳", "斧", "锤", "战", "搏", "近身", "体术"], "STR");
      hit(["耐", "坚", "苦", "守", "护", "扛", "抗", "坦", "体魄"], "CON");
      hit(["刺", "暗器", "轻", "巧", "敏", "疾", "盗", "潜", "闪", "身法", "点穴"], "DEX");
      hit(["医", "药", "针", "学", "谋", "术", "法", "智", "识", "策", "阵", "符", "经", "辩", "文"], "INT");
      const max = Math.max(score.STR, score.CON, score.DEX, score.INT);
      if (max <= 0) return "1.0|1.0|1.0|1.0";
      const v = (k) => (score[k] === max ? "1.6" : (score[k] > 0 ? "1.1" : "0.9"));
      return [v("STR"), v("CON"), v("DEX"), v("INT")].join("|");
    };

    // 年龄：表0 年份 − 出生日期年份
    const ageOf = (birth) => {
      try {
        const s = String(birth || "");
        if (!s) return "";
        const CN = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 百: 100, 千: 1000 };
        const cnNum = (str) => { let sec = 0, num = 0; for (const ch of String(str)) { if (CN[ch] == null) return null; const v = CN[ch]; if (v >= 10) { sec += (num || 1) * v; num = 0; } else num = v; } return sec + num || null; };
        const yearOf = (str) => { const m = String(str).match(/(\d{2,4})\s*年/); if (m) return Number(m[1]); const m2 = String(str).match(/([零一二两三四五六七八九十百千]{1,6})\s*年/); return m2 ? cnNum(m2[1]) : null; };
        const birthYear = yearOf(s);
        if (!birthYear) return "";
        const c0 = (schema.getTable(0)?.columns ?? []).map((x) => String(x));
        const r0 = (store.getRows(0, { create: false }) ?? [])[0] ?? [];
        const iT = c0.findIndex((x) => x.indexOf("时空") >= 0 || x.indexOf("坐标") >= 0);
        const nowYear = iT >= 0 ? yearOf(r0[iT]) : null;
        if (!nowYear) return "";
        const age = nowYear - birthYear;
        return age > 0 && age < 300 ? String(age) : "";
      } catch (e) { return ""; }
    };

    /* 清掉历史遗留的「未命名N」垃圾行（txn 在主键缺失时自动造出来的） */
    try {
      for (const no of [2, 3, 4, 5, 13, 14]) {
        const cols0 = (schema.getTable(no)?.columns ?? []).map((c) => String(c));
        const iN = cols0.findIndex((c) => c.indexOf("名称") >= 0 || c.indexOf("角色") >= 0 || c.indexOf("实体") >= 0);
        if (iN < 0) continue;
        const rows0 = (store.getRows(no, { create: false }) ?? []).slice();
        /* 【审计发现】这里以前是正序 forEach + 按 rowIndex 删 ✗ → 删完一行数组左移 → 后一条删到别人 ✓
       改成倒序（同文件其它三处本来就是倒序 ✓）*/
      [].concat(rows0.map((r, ri) => ({ r, ri }))).reverse().forEach(({ r, ri }) => {
          const k = String(r?.[iN] ?? "").trim();
          if (!/^未命名\d*$/.test(k)) return;
          try {
            txn.applyOps([{ op: "delete", table: no, rowIndex: ri }], { source: "final-fill-cleanup" });
            console.log("[RBQ] 已删除垃圾行：表" + no + " 的「" + k + "」");
          } catch (e) { /* ignore */ }
        });
      }
    } catch (e) { /* ignore */ }
    /* 清掉跨表路由造成的垃圾行（用户实测：表7 出现假任务、表11 出现假势力） */
    try {
      const charNames = new Set();
      try {
        const c2 = (schema.getTable(2)?.columns ?? []).map((x) => String(x));
        const i2 = c2.findIndex((x) => x.indexOf("名称") >= 0);
        for (const r2 of (store.getRows(2, { create: false }) ?? [])) { const v = String(r2?.[i2 >= 0 ? i2 : 0] ?? "").trim(); if (v) charNames.add(v); }
      } catch (e) { /* ignore */ }
      const JUNK = new Set(["未知", "中立", "无", "未定", "待定", "未命名", "未知阵营", "无阵营"]);
      const RULES = [
        { no: 7, keyCol: "任务名称" },
        { no: 11, keyCol: "名称" },
      ];
      for (const { no, keyCol } of RULES) {
        const cols0 = (schema.getTable(no)?.columns ?? []).map((x) => String(x));
        const iK = cols0.indexOf(keyCol);
        if (iK < 0) continue;
        const rows0 = (store.getRows(no, { create: false }) ?? []).slice();
        for (let ri = rows0.length - 1; ri >= 0; ri--) {
          const k = String(rows0[ri]?.[iK] ?? "").trim();
          const junk = !k || JUNK.has(k) || /^未命名\d*$/.test(k) || charNames.has(k);
          if (!junk) continue;
          try {
            txn.applyOps([{ op: "delete", table: no, rowIndex: ri }], { source: "final-fill-junk" });
            console.log("[RBQ] 已删除垃圾行：表" + no + " 的「" + k + "」（路由造成）");
          } catch (e) { /* ignore */ }
        }
      }
    } catch (e) { /* ignore */ }
    /* 清理占位符实体 + 重复建档（用户实测：表5 出现「npc_var」✗、表14 出现已在表2 建过档的正式角色 ✗） */
    try {
      const NAMES = new Set();
      try {
        const c2 = (schema.getTable(2)?.columns ?? []).map((x) => String(x));
        const i2 = c2.findIndex((x) => x.indexOf("名称") >= 0);
        for (const r2 of (store.getRows(2, { create: false }) ?? [])) { const v = String(r2?.[i2 >= 0 ? i2 : 0] ?? "").trim(); if (v) NAMES.add(v); }
      } catch (e) { /* ignore */ }
      const PLACEHOLDER = /^(npc|npc_\w*|NPC\w*|路人|路人甲|龙套|群众|某\w*|未知|无|待定|someone|monster)$/i;
      // 表5：任意一方是占位符 → 整行删掉（关系必须发生在两个"有名字的实体"之间 ✓）
      try {
        const c5 = (schema.getTable(5)?.columns ?? []).map((x) => String(x));
        const rows5 = (store.getRows(5, { create: false }) ?? []).slice();
        for (let ri = rows5.length - 1; ri >= 0; ri--) {
          const a1 = String(rows5[ri]?.[0] ?? "").trim();
          const a2 = String(rows5[ri]?.[1] ?? "").trim();
          if (!PLACEHOLDER.test(a1) && !PLACEHOLDER.test(a2)) continue;
          try { txn.applyOps([{ op: "delete", table: 5, rowIndex: ri }], { source: "final-fill-placeholder" }); console.log("[RBQ] 已删除表5 的占位符关系行：「" + a1 + " ↔ " + a2 + "」"); } catch (e) { /* ignore */ }
        }
      } catch (e) { /* ignore */ }
      // 表14：只留"没在表2 建过档"的临时实体/怪物；正式角色重复记录要删掉
      try {
        if (NAMES.size) {
          const c14 = (schema.getTable(14)?.columns ?? []).map((x) => String(x));
          const i14 = c14.findIndex((x) => x.indexOf("名称") >= 0 || x.indexOf("实体") >= 0);
          const rows14 = (store.getRows(14, { create: false }) ?? []).slice();
          for (let ri = rows14.length - 1; ri >= 0; ri--) {
            const nm = String(rows14[ri]?.[i14 >= 0 ? i14 : 0] ?? "").trim();
            if (!nm || !NAMES.has(nm)) continue;
            try { txn.applyOps([{ op: "delete", table: 14, rowIndex: ri }], { source: "final-fill-dup14" }); console.log("[RBQ] 表14 里的「" + nm + "」已在表2 建档，重复记录已删除"); } catch (e) { /* ignore */ }
          }
        }
      } catch (e) { /* ignore */ }
    } catch (e) { /* ignore */ }
    let filled = 0;
    /* 单例表（0 宏观时空 / 6 剧情大纲）整表为空、而这一局已经开打了 → 直接建出第一行并填上，
       用户要求"不许有空表"。 */
    try {
      const started = (() => { try { return (ctx()?.chat ?? []).filter((m) => m && !m.is_user).length > 0; } catch (e) { return false; } })();
      /* 【用户明确要求】脚本**不再**自己编造表0/表6 的首行 ✗ ——
         那样等于替 AI 定了时间/地点，凭空给它加限制（用户实测：空表却冒出 19:40 的时间 ✗）；
         空表就让它空着，由 AI 按设定自己建 ✓ */
      if (false && started) {
        for (const no of [0, 6]) {
          const rows0 = store.getRows(no, { create: false }) ?? [];
          if (rows0.length) continue;
          const cols0 = (schema.getTable(no)?.columns ?? []).map((c) => String(c));
          const vals = {};
          for (const c of (MIN[String(no)] || [])) { if (cols0.indexOf(c) >= 0) vals[c] = DEF[c] || '无'; }
          if (no === 0) {
            vals['时空坐标'] = '未明确（以剧情当前时刻为准）';
            vals['绝对位置名称'] = '当前所在地';
            vals['环境气象'] = '常态';
            vals['在场实体名单'] = '{{user}}';
          }
          if (no === 6) vals['终极宏愿'] = '按角色设定推进';
          try {
            txn.applyOps([{ op: 'upsert', table: no, values: vals }], { source: 'final-fill-init' });
            filled += Object.keys(vals).length;
            console.log('[RBQ] 最终收口：表' + no + ' 原来整表为空，已建出第一行');
          } catch (e) { /* ignore */ }
        }
      }
    } catch (e) { /* ignore */ }
    for (const noStr of Object.keys(MIN)) {
      const no = Number(noStr);
      const cols = (schema.getTable(no)?.columns ?? []).map((c) => String(c));
      const rows = store.getRows(no, { create: false }) ?? [];
      if (!rows.length) continue;
      const iName = cols.findIndex((c) => c.indexOf("名称") >= 0 || c.indexOf("角色") >= 0);
      rows.forEach((r, ri) => {
        const who = String(r?.[iName >= 0 ? iName : 0] ?? "").trim();
        if (!who) return;
        const patch = {};
        for (const c of MIN[noStr]) {
          const ci = cols.indexOf(c);
          if (ci < 0) continue;
          if (String(r?.[ci] ?? "").trim()) continue;
          let v = "";
          try {
            if (c === "四维系数(STR|CON|DEX|INT)") {
              const iS = cols.findIndex((x) => x.indexOf("战斗风格") >= 0 || x.indexOf("四维偏好") >= 0);
              const iJ = cols.findIndex((x) => x.indexOf("职业") >= 0 || x.indexOf("身份") >= 0);
              v = coefFrom(iS >= 0 ? r[iS] : "", iJ >= 0 ? r[iJ] : "", who);
            } else if (c === "年龄") {
              const iB = cols.findIndex((x) => x.indexOf("出生") >= 0);
              v = ageOf(iB >= 0 ? r[iB] : "");
            } else if (EQUIP.indexOf(c) >= 0) {
              v = "无";
            }
          } catch (e) { /* ignore */ }
          if (!v) v = DEF[c] || (EQUIP.indexOf(c) >= 0 ? "无" : "无");
          if (v) patch[c] = v;
        }
        if (Object.keys(patch).length) {
          filled += Object.keys(patch).length;
          try { txn.applyOps([{ op: "update", table: no, row: who, values: patch }], { source: "final-fill" }); } catch (e) { /* ignore */ }
        }
      });
    }
    if (filled) console.log("[RBQ] 最终收口：补上 " + filled + " 个格子（推导 + 词库默认值）");
    return filled;
  } catch (e) { console.warn("[RBQ] 最终收口失败", e); return 0; }
}
/* ================= 冻结写入 =================
   回滚（重新生成/删楼层）之后，上一轮侧路的"尾部写入"还会陆续落盘 ✗
   （持续收口每 4 秒一次、延迟重算、补写批次…）→ 会把刚回滚干净的表又写回数据 ✓
   所以回滚后调用 freezeFor(15000)：这段时间内所有写表入口直接跳过 ✓ */
// 冻结开关放在中立模块 core/freeze.js（txn 也要用 ✓ 避免循环依赖）
// 冻结开关在 core/freeze.js：既要**本地可用**（模块内部调用 ✓），也要对 index.js 暴露 ✓
import { freezeFor, isFrozen, isAbortRequested, requestAbort, clearAbort, getWriteCount } from './freeze.js';
export { freezeFor, isFrozen, isAbortRequested, requestAbort, clearAbort };

export function fixDerivedFields() {
  /* 系统轮次由脚本写（用户判断正确：这格不该让 AI 填，AI 会填错 ✗）
     值 = 当前聊天的 AI 消息条数；顺手把 systemRound / systemRoundFormatted 变量也写明 */
  try {
    const n = (() => { try { return (ctx()?.chat ?? []).filter((m) => m && !m.is_user).length; } catch (e) { return 0; } })();
    if (n > 0) {
      const c0 = (schema.getTable(0)?.columns ?? []).map((x) => String(x));
      const iR = c0.findIndex((x) => x.indexOf("轮次") >= 0);
      const rows0 = store.getRows(0, { create: false }) ?? [];
      if (iR >= 0 && rows0.length && String(rows0[0]?.[iR] ?? "").trim() !== String(n)) {
        try { txn.applyOps([{ op: "update", table: 0, row: 1, values: { [c0[iR]]: String(n) } }], { source: "script-round" }); } catch (e) { /* ignore */ }
        console.log("[RBQ] 系统轮次 → " + n + "（脚本写）");
      }
      try {
        const vs = ctx()?.variables ?? null;
        if (vs?.chat?.set) {
          vs.chat.set("systemRound", String(n));
          vs.chat.set("systemRoundFormatted", "D" + String(n).padStart(4, "0"));
        }
      } catch (e) { /* ignore */ }
    }
  } catch (e) { /* ignore */ }

  /* 兜底默认值（脚本保证这几列永不空；老模板本身就规定了默认写法）：
       四维系数 → 1.0|1.0|1.0|1.0（基准倍率）、技能池 → []（无技能）、
       绝对雷区/核心偏好/深层软肋/特殊体征 → 未探明 */
  try {
    const DEFAULT_COL = {
      // 四维系数【不兜底】—— 它是内容列，兜底会像「未探明」一样把 AI 的路堵死；
      // 表13 派生数值需要它时，rules.js 内部按 1.0 兜底计算（但不写这一列）。
      '技能池': '[]',
      '生理周期': '常规态',
      '推进状态': '进行中',
      // 表4：老模板原文规定「没有穿的部位填 无」→ 这些装备位空着就填 无
      '头部装备': '无', '上装外衣': '无', '上装内层': '无', '颈部附加': '无', '下装外层': '无',
      '下装内层': '无', '腿部裹覆': '无', '足部': '无', '下肢约束': '无', '双手持物': '无',
      '约束距离': '无', '表层面具': '无', '潜意识漏出': '无', '伪装标识': '无', '离场状态': '在场', '特殊体征': '无', '性器官特征': '无', '肛门特征': '无', '名器类型': '无',
      // 表7/8/10/11 的枚举列，按老模板词库给第一项
      '行动类别': '日常约定', '关键资产': '无', '过期死线': '无', '结算规则': '常规结算', '挂载角色': '无',
      '类别界定': '物理减益(Debuff)', '发作表现': '常规表现', '层数/严重度': '轻度', '面板干预': '无', '数值修正': '无', '显隐性': '显性', '剩余持续': '至解除', '解除条件': '由剧情决定',
      '检定类型': '主动释放', '觉醒溯源': '剧情习得', '熟练阶层': 'Lv.1/初阶', '数据分类': '实体阵营',
      '权力终端/制定者': '无', '辐射辖区': '无', '敌对关联': '无', '内部福利/优势': '无', '红线/禁忌': '无', '监控/探测机制': '无', '处罚/后果': '无' };
    for (const no of [2, 3, 4, 7, 8, 10, 11]) {
      const cols = (schema.getTable(no)?.columns ?? []).map((c) => String(c));
      const rows = store.getRows(no, { create: false }) ?? [];
      const iName = cols.findIndex((c) => c.indexOf("名称") >= 0);
      rows.forEach((r, ri) => {
        cols.forEach((c, ci) => {
          if (!DEFAULT_COL[c]) return;
          if (String(r?.[ci] ?? "").trim()) return;
          const who = String(r?.[iName >= 0 ? iName : 0] ?? "").trim();
          if (!who) return;
          try {
            txn.applyOps([{ op: 'update', table: no, row: who || (ri + 1), values: { [c]: DEFAULT_COL[c] } }], { source: 'default-fill' }).catch(() => {});
            console.log('[RBQ] 兜底默认值：表' + no + ' ' + who + ' 的「' + c + '」→ ' + DEFAULT_COL[c]);
          } catch (e) { /* ignore */ }
        });
      });
    }
  } catch (e) { console.warn("[RBQ] 兜底默认值失败", e); }
  // 派生数值：表13 的 ATK/DEF/MATK/MDEF/AGI/负重上限 由「等级 + 四维系数」算出来
  // （以前只在你手动点「Σ 重算属性」时才算 → 填完表 ATK/DEF 一直是空的）
  try {
    import('./rules.js').then((rules) => {
      try {
        const ops = (rules.recalcCharacters({ fillMax: true }) || []).concat((rules.recalcMonsters ? rules.recalcMonsters({ fillMax: true }) : []) || []);
        if (!ops.length) return;
        return txn.applyOps(ops, { source: 'derived-recalc' });
      } catch (e) { console.warn('[RBQ] 派生数值重算失败', e); }
    }).catch((e) => console.warn('[RBQ] 载入 rules 失败', e));
  } catch (e) { /* ignore */ }
  let n = 0;
  try {
    const row0 = (() => { try { return (store.getRows(0, { create: false }) ?? [])[0] ?? []; } catch (e) { return []; } })();
    const c0 = (schema.getTable(0)?.columns ?? []).map((c) => String(c));
    const iTime = c0.findIndex((c) => c.indexOf("时空") >= 0 || c.indexOf("坐标") >= 0);
    /* 年份解析：优先阿拉伯数字（2024年 / 1244年），再试中文数字（天授前三年 / 景和九年），
       两个都拿不到就返回 null（宁可不写，也不写错） */
    const CN = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 百: 100, 千: 1000 };
    const cnNum = (s) => {
      let total = 0; let section = 0; let num = 0;
      for (const ch of String(s)) {
        if (CN[ch] == null) return null;
        const v = CN[ch];
        if (v >= 10) { section += (num || 1) * v; num = 0; } else { num = v; }
      }
      total += section + num;
      return total || null;
    };
    const yearOf = (s) => {
      try {
        const str = String(s || "");
        const m = str.match(/(\d{2,4})\s*年/);
        if (m) return Number(m[1]);
        const m2 = str.match(/([零一二两三四五六七八九十百千]{1,6})\s*年/);
        if (m2) return cnNum(m2[1]);
        return null;
      } catch (e) { return null; }
    };
    const nowYear = yearOf(iTime >= 0 ? row0[iTime] : "");
    if (!nowYear) return 0;
    const c2 = (schema.getTable(2)?.columns ?? []).map((c) => String(c));
    const iAge = c2.findIndex((c) => c.indexOf("年龄") >= 0);
    const iBirth = c2.findIndex((c) => c.indexOf("出生") >= 0);
    if (iAge < 0 || iBirth < 0) return 0;
    const rows = (() => { try { return store.getRows(2, { create: false }) ?? []; } catch (e) { return []; } })();
    for (let r = 0; r < rows.length; r++) {
      const by = yearOf(rows[r]?.[iBirth]);
      if (!by) continue;
      const age = nowYear - by;
      if (!(age > 0 && age < 1000)) continue;
      if (String(rows[r]?.[iAge] ?? "").trim() === String(age)) continue;
      const key = (() => { try { const ks = schema.keyColumns(2) || []; return ks.length ? String(rows[r]?.[ks[0]] ?? "") : ""; } catch (e) { return ""; } })();
      if (!key) continue;
      txn.applyOps([{ op: "update", table: 2, row: key, values: [{ index: iAge, name: c2[iAge], value: String(age) }] }], { source: "derived" })
        .then(() => { /* 静默 */ }).catch((e) => console.warn("[RBQ] 年龄写回失败", e));
      n++;
    }
  } catch (e) { console.warn("[RBQ] 年龄计算失败", e); }
  return n;
}

/**
 * 填表自检（仿老 RBQ 的 scan()）：**逐格扫描**，把空的单元格列出来。
 * 老代码就是这么干的：把「【表0】时间坐标为空…需在 <data> 中补全」注入提示词，AI 才知道该补哪一格。
 * @returns {string} 缺口清单（空串 = 齐全），每行形如「表2 沈映竹 的「种族」为空」
 */
export function auditAfterFill({ maxItems = 40 } = {}) {
  const miss = [];
  try {
    const rowsOf = (no) => { try { return store.getRows(no, { create: false }) ?? []; } catch (e) { return []; } };
    const colsOf = (no) => { try { return (schema.getTable(no)?.columns ?? []).map((c) => String(c)); } catch (e) { return []; } };
    const isPlaceholder = (s) => /^\{\{.*\}\}$/.test(s) || s === "你" || s === "我";
    /* 在场名单（表0） */
    let present = [];
    try {
      const r0 = rowsOf(0)[0] ?? [];
      const c0 = colsOf(0);
      const idx = c0.findIndex((c) => c.indexOf("在场") >= 0);
      const raw = idx >= 0 ? String(r0[idx] ?? "") : "";
      present = raw.split(/[\/、,，|]/).map((s) => s.trim()).filter(Boolean).filter((s) => !isPlaceholder(s));
    } catch (e) { /* ignore */ }
    /* 单例表：只要有一格空就报（表0/表6） */
    for (const no of [0, 6]) {
      const cols = colsOf(no);
      const rows = rowsOf(no);
      const tname = "表" + no;
      if (!rows.length) { miss.push(tname + " 整表为空（需要初始化）"); continue; }
      const r = rows[0] ?? [];
      cols.forEach((c, ci) => { if (!String(r[ci] ?? "").trim()) miss.push(tname + " 的「" + c + "」为空"); });
    }
    /* 逐角色表：每个在场角色都要有行，且每个"该写的列"都不能空 */
    const PER_CHAR = [2, 3, 4, 13];
    const SKIP_COL = /(临时修正|更新时间戳|碰撞体积|MP消耗|SP消耗|冷却|基础伤害|护甲值|范围|成长)/;
    for (const no of PER_CHAR) {
      const cols = colsOf(no);
      const rows = rowsOf(no);
      const tname = "表" + no;
      const iName = cols.findIndex((c) => c.indexOf("名称") >= 0);
      const names = rows.map((r) => String(r?.[iName >= 0 ? iName : 0] ?? "").trim());
      for (const who of present) {
        if (!names.includes(who)) { miss.push(tname + " 缺 " + who + " 这一行"); continue; }
        const r = rows[names.indexOf(who)] ?? [];
        cols.forEach((c, ci) => {
          if (ci === iName) return;
          if (SKIP_COL.test(c)) return;          // 脚本算/机械列不要求 AI 写
          if (!String(r[ci] ?? "").trim()) miss.push(tname + " " + who + " 的「" + c + "」为空");
        });
      }
    }
    /* 表5：双向关系 */
    try {
      const cols = colsOf(5);
      const rows = rowsOf(5);
      if (!rows.length && present.length >= 2) miss.push("表5 整表为空（在场角色之间应有关系，需要初始化）");
      rows.forEach((r) => {
        if (!String(r?.[0] ?? "").trim() || !String(r?.[1] ?? "").trim()) miss.push("表5 有一行关系缺主键");
      });
    } catch (e) { /* ignore */ }
  } catch (e) { console.warn("[RBQ] 填表自检失败", e); }
  const uniq = [...new Set(miss)];
  // 清单不只报空缺，还要说清"怎么补"（用户要求：剧情没提也要按人设推断生成）
  if (uniq.length) {
    uniq.push("【补法】空的格子必须按角色人设编出**具体可信的内容**（身份/种族/性格/职业都要考虑），**禁止写「未探明」「未知」搪塞**；只有确实没有的装备位才写「无」；整张表一行都没有的，按当前剧情初始化出第一行");
  }
  if (uniq.length > maxItems) return uniq.slice(0, maxItems).join("｜") + "… 等 " + uniq.length + " 项";
  return uniq.join("｜");
}

export function statusLine(rec) {
  if (!rec) return '';
  const names = { fill: '填表', memory: '记忆', summary: '大总结', extras: '附加' };
  const parts = [];
  for (const [k, label] of Object.entries(names)) {
    const t = rec.tasks[k];
    if (!t) continue;
    const mark = t.state === 'ok' ? '✓' : t.state === 'failed' ? '✗' : (t.state === 'off' || t.state === 'idle') ? '—' : '…';
    parts.push(label + mark + (t.attempts > 1 ? '(' + t.attempts + '次)' : ''));
  }
  return parts.join(' ');
}
