/**
 * legacyVars.js —— 兼容层：把原版 rbq.js 的**全部变量面**补齐
 *
 * 为什么要它：原版有 34 个聊天变量 + 36 个全局变量，用户的预设里直接引用这些名字。
 * 我重构时只实现了其中一部分，导致预设取不到值。这里按原版逐一补齐（名字与语义照抄）。
 */
import * as store from './store.js';
import * as summaryMod from './summary.js';
import { ctx, chat } from './ctx.js';
import * as extras from './extras.js';

/* ---------------------------------------------------- 原版常量（逐字取自 rbq.js） */

// 校验枚举（审查用）
const VALID_GENDERS = ['男','女','双性','无性']
const VALID_BODY_HAIR = ['白虎','稀疏','正常','浓密']
const VALID_ATMOSPHERE = ['安全区','警戒区','高危区']
const VALID_ALIVE = ['Alive','Dead','Undead']

// 四选一方向 / 脚本前缀
const DIRECTION_KEYS = ['good', 'bad', 'mixed', 'adventure']
export const SCRIPT_PREFIX = 'RBQ-';

// 名器 / 生理周期关键词（审查与生理模块用）
const FEMALE_MEIKI_LIST = ["鸾凤凰吟","金城汤池","九环玉壶","飞龙穴","一枝独秀","三江春水","四季玉涡","五龙戏珠","六面埋伏","七窍玲珑","八方风雨","九曲回廊","十重天宫","鹰勾穴","盆子穴","鸡雉穴","葵蕊蜜壶","融雪膏","春露蛞蝓"]
const PHYSIOLOGY_CYCLE_KEYWORDS = ['常规态','正常','健康','稳定','疲劳','困倦','睡眠不足','体力透支','魔力透支','灵力枯竭','精神力耗竭','能量不足','燃油不足','电量低','饥饿','脱水','营养不良','发情期','排卵期','安全期','月经期','孕期','哺乳期','更年期','发情期前','发情期后','假性发情','强制发情','抑制发情','生病','感冒','发烧','感染','中毒','醉酒','宿醉','药物影响','致幻','麻醉','疾病','瘟疫','诅咒发作','受伤','轻伤','重伤','濒死','失血','骨折','内伤','失明','失聪','失语','瘫痪','昏迷','冬眠','休眠','蜕皮','换毛','换羽','结茧','蛹化','羽化','分裂','再生','重组','融合','魔力暴走','魔力反噬','诅咒生效','祝福生效','附身','灵体化','实体化','妖化','魔化','神化','觉醒','封印松动','封印强化','过载','冷却中','系统维护','系统故障','病毒入侵','格式化中','升级中','零件损坏','能源泄漏','核心过热','灵魂不稳','执念淡化','怨念增强','死气侵蚀','活尸化','尸变','吸血冲动','嗜血','满月狂化','兽化','返祖','血统觉醒','元素化','影化','情绪不稳定','抑郁','焦虑','狂躁','精神污染','理智丧失','洗脑状态','催眠状态','人格切换','衰老加速','衰老减缓','时间冻结','急速状态','慢速状态','时间回溯中','高原反应','减压病','冻伤','中暑','辐射病','缺氧','醉氧','深海反应','太空适应']

export const VALID = {
};

export const DEFAULT_REQUIRED_TAGS = ['This_round_events', 'data_reasoning', 'data'];

/** 全局设置变量：名字 + 原版默认值（undefined 时才写默认） */
export const GLOBAL_DEFAULTS = {
  dataProcessingEnabled: true,
  autoRegenerateOnNoData: false,
  maxRegenRetries: 3,
  debugMode: false,
  tableReviewPopupEnabled: false,
  memoryRecallEnabled: true,
  memoryRecallMaxEntries: 0,   // 0 = 全部召回（默认）,   // 0 = 全部（原版 if (maxEntries > 0) 才截断）
  rpOptionEnabled: false,
  rpAutoSelectEnabled: false,
  rpAutoSelectMode: 'random',
  rpFixedDirection: 'good',
  lengthRequirementEnabled: false,
  lengthRequirementMin: 800,
  lengthRequirementMax: 1200,
  roundReminderThreshold: 50,
  inspirationEnabled: true,
  inspirationMinInterval: 3,
  inspirationMaxInterval: 7,
  inspirationTestMode: false,
  requiredTags: null,          // 数组，见 syncGlobals
  physiologyCycleKeywords: '常规态丨正常丨健康丨稳定丨疲劳丨困倦丨睡眠不足丨体力透支丨魔力透支丨灵力枯竭丨精神力耗竭丨能量不足丨燃油不足丨电量低丨饥饿丨脱水丨营养不良丨发情期丨排卵期丨安全期丨月经期丨孕期丨哺乳期丨更年期丨发情期前丨发情期后丨假性发情丨强制发情丨抑制发情丨生病丨感冒丨发烧丨感染丨中毒丨醉酒丨宿醉丨药物影响丨致幻丨麻醉丨疾病丨瘟疫丨诅咒发作丨受伤丨轻伤丨重伤丨濒死丨失血丨骨折丨内伤丨失明丨失聪丨失语丨瘫痪丨昏迷丨冬眠丨休眠丨蜕皮丨换毛丨换羽丨结茧丨蛹化丨羽化丨分裂丨再生丨重组丨融合丨魔力暴走丨魔力反噬丨诅咒生效丨祝福生效丨附身丨灵体化丨实体化丨妖化丨魔化丨神化丨觉醒丨封印松动丨封印强化丨过载丨冷却中丨系统维护丨系统故障丨病毒入侵丨格式化中丨升级中丨零件损坏丨能源泄漏丨核心过热丨灵魂不稳丨执念淡化丨怨念增强丨死气侵蚀丨活尸化丨尸变丨吸血冲动丨嗜血丨满月狂化丨兽化丨返祖丨血统觉醒丨元素化丨影化丨情绪不稳定丨抑郁丨焦虑丨狂躁丨精神污染丨理智丧失丨洗脑状态丨催眠状态丨人格切换丨衰老加速丨衰老减缓丨时间冻结丨急速状态丨慢速状态丨时间回溯中丨高原反应丨减压病丨冻伤丨中暑丨辐射病丨缺氧丨醉氧丨深海反应丨太空适应',   // 原版词库（data/vocab.js 同源）
  rbqCreatedRegexIds: null,    // 数组
};

/** 原版聊天状态变量（名字 + 说明） */
export const CHAT_NAMES = [
  'effectivePresentList', 'presentNPCs', 'presentCharsFixed',
  'tableDataIssueReport', 'divinationEvent', 'divinationEventActive',
  'lastInspirationRound', 'nextInspirationRound',
  'characterMemories', 'characterMemoriesText', 'recalledMemorySummary',
  'narration_data', 'cg_data', 'theater_data',
  'isUpdating', 'lastPopupRound',
];

export const GLOBAL_NAMES = Object.keys(GLOBAL_DEFAULTS);

function cvar(name, value) { return extras.writeVar(name, value, "chat"); }
function gvar(name, value) { return extras.writeVar(name, value, "global"); }
function gget(name) { try { return ctx()?.variables?.global?.get?.(name); } catch { return undefined; } }

/** 写全局设置变量：只补 undefined 的默认值 + 用当前配置覆盖已存在的项 */
export function syncGlobals() {
  const done = [];
  for (const [k, v] of Object.entries(GLOBAL_DEFAULTS)) {
    if (k === 'requiredTags') {
      if (gget(k) === undefined || gget(k) === null || gget(k) === '') gvar(k, DEFAULT_REQUIRED_TAGS.join(','));
      continue;
    }
    if (k === 'physiologyCycleKeywords') {
      if (gget(k) === undefined || gget(k) === null || gget(k) === '') gvar(k, PHYSIOLOGY_CYCLE_KEYWORDS.join('丨'));
      continue;
    }
    if (k === 'rbqCreatedRegexIds') {
      if (gget(k) === undefined || gget(k) === null || gget(k) === '') gvar(k, '[]');
      continue;
    }
    if (gget(k) === undefined || gget(k) === null || gget(k) === '') { gvar(k, v); done.push(k); }
  }
  // 用我自己的配置回填（用户若在面板里改过，以面板为准）
  try {
    const cfgRp = store.getConfigValue('features.options', null);
    if (cfgRp !== null) gvar('rpOptionEnabled', !!cfgRp);
    const auto = store.getConfigValue('features.autoRp', null);
    if (auto !== null) gvar('rpAutoSelectEnabled', !!auto);
    const mode = store.getConfigValue('features.autoRpMode', null);
    if (mode) gvar('rpAutoSelectMode', mode);
    const n = store.getConfigValue('summary.bigThreshold', null);
    if (n) gvar('roundReminderThreshold', Number(n));
    const lr = store.getConfigValue('extras.lengthReq', null);
    if (lr && typeof lr === 'object') {
      gvar('lengthRequirementEnabled', !!lr.enabled);
      if (lr.extra?.min) gvar('lengthRequirementMin', Number(lr.extra.min));
      if (lr.extra?.max) gvar('lengthRequirementMax', Number(lr.extra.max));
    }
    const debug = store.getConfigValue('debug', null);
    if (debug !== null) gvar('debugMode', !!debug);
  } catch { /* ignore */ }
  return done;

  // 补写：原脚本里有、插件以前没写的变量（用户预设直接引用它们，缺了就是空值）
  try {
    const g = (k, v) => { if (v !== undefined && v !== null && v !== '') { try { gvar(k, String(v)); } catch { /* ignore */ } } };
    const cfgOf = (k, d) => { try { return store.getConfigValue(k, d); } catch { return d; } };
    // 时间框
    g('timeBoxEnabled', true);
    g('timeBoxSkipTags', cfgOf('extras.timeBox.skipTags', 'thinking_matrix,thinking'));
    // 抢话禁令
    g('userSpeakBanEnabled', !!cfgOf('features.speakBan', false));
    g('userSpeakBanText', cfgOf('extras.speakBan.text', '并且绝对禁止代替 {{user}} 角色生成除指令以外的台词'));
    // 全自动 RP 提示词（预设可能引用）
    g('rpPromptActive', !!cfgOf('features.autoRp', false));
    g('rpPromptNormal', cfgOf('extras.rp.text', ''));
    g('rpPromptFastForward', cfgOf('extras.rpFastForward.text', ''));
    // 离场 / 怪物阈值
    g('departureThreshold', cfgOf('departure.threshold', 50));
    g('monsterDespawnThreshold', cfgOf('monster.threshold', 50));
  } catch { /* ignore */ }
}

/** 写聊天状态变量：在场名单 / 审查报告 / 灵感 / 记忆文本 */
export function syncChat(roundOverride = null) {
  const out = { ok: true };
  let round = Number(roundOverride);
  if (!Number.isFinite(round)) {
    try { const r = store.getRows(0, { create: false })[0]; round = parseInt(String(r?.[0] ?? '').replace(/[^0-9]/g, ''), 10) || 0; } catch { round = 0; }
    // __floorFallback：表0 没有系统轮次时用"楼层 ÷ 2"兜底（一轮 = 用户一层 + AI 一层）
    if (!Number.isFinite(round)) { try { round = Math.max(0, Math.floor((chat() ?? []).length / 2)); } catch { round = 0; } }
  }
  // 在场名单：原版三个变量（斜杠分隔 / 顿号分隔 / 修正后的）
  try {
    const names = extras.presentNames();
    const slash = names.join(' / ');
    const comma = names.join('、');
    cvar('effectivePresentList', slash);
    cvar('presentNPCs', comma);
    cvar('presentCharsFixed', slash);
    out.present = names.length;
  } catch { /* ignore */ }
  // 灵感（间隔轮次：lastInspirationRound / nextInspirationRound）
  try {
    const min = Number(gget('inspirationMinInterval') ?? 3);
    const max = Number(gget('inspirationMaxInterval') ?? 7);
    const span = Math.max(1, max - min + 1);
    const jitter = Math.abs((round * 7919) % span);
    const next = round + min + jitter;
    cvar('nextInspirationRound', String(next));
    const last = Number(store.getConfigValue('inspiration.lastRound', 0)) || 0;
    cvar('lastInspirationRound', String(last));
    out.inspirationNext = next;
  } catch { /* ignore */ }
  // 杂项状态
  cvar('isUpdating', 'false');
  cvar('lastPopupRound', '0');
  return out;

  // 大总结进度（原脚本的 roundSummaryCount / roundSummaryRange）
  try {
    const done = store.getRows(12, { create: false })?.length ?? 0;
    const th = (() => { try { return summaryMod.getThreshold?.() ?? 50; } catch { return 50; } })() || 50;
    const r = Number(round) || 0;
    const from = r > 0 ? Math.max(1, Math.floor((r - 1) / th) * th + 1) : 1;
    cvar('roundSummaryCount', String(done));
    cvar('roundSummaryRange', from + '-' + (r || th));
  } catch { /* ignore */ }

  // 轮次（原脚本的 systemRound / systemRoundFormatted）
  try {
    const r = Number(round) || 0;
    cvar('systemRound', r);
    cvar('systemRoundFormatted', '第 ' + r + ' 轮');
  } catch { /* ignore */ }
}

/** 变量管理页用：把我实现的与原版补齐的合起来列 */
export function list() {
  const rows = [];
  for (const [k, v] of Object.entries(GLOBAL_DEFAULTS)) {
    const cur = gget(k);
    rows.push({ name: k, scope: 'global', desc: '原版全局设置变量', value: cur === undefined ? v : cur, usage: '{{getglobalvar::' + k + '}}', legacy: true });
  }
  for (const k of CHAT_NAMES) {
    let cur = null;
    try { cur = ctx()?.variables?.chat?.get?.(k); } catch { /* ignore */ }
    rows.push({ name: k, scope: 'chat', desc: '原版聊天状态变量', value: cur, usage: '{{getvar::' + k + '}}', legacy: true });
  }
  return rows;
}
