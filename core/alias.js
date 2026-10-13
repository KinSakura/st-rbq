/**
 * alias.js —— 属性名 → 列下标的统一解析器
 *
 * 单独成模块的原因：协议层（解析 AI 输出）与事务层（校验 ops）都要用它，
 * 而两边又都不该互相依赖。
 *
 * 解析优先级：
 *   1. 中文列名（精确 → 归一化 → 模糊）
 *   2. 英文别名（精确 → 归一化）—— 别名表由 tools/build-aliases.mjs 从 rbq.js 反推
 *   3. 常见同义词（hp/生命/当前HP …）
 *   4. 英文别名模糊（拼错一两个字母）
 */

import ALIASES from '../data/aliases.js';
import { getTable } from './schema.js';
import { matchColumn } from './match.js';
import { normalize } from './util.js';

/** 常见同义词 → 别名表里的正式名 */
export const SYNONYMS = {
  name: ['名称', '名字', '角色', '角色名称', '实体名称', '物品名称', '技能名称', '地点名称', '任务名称', '异常状态名称', '人物'],
  hp: ['HP', '生命', '当前HP', '当前生命', '血量'],
  maxHp: ['HP上限', '最大HP', '生命上限', '最大生命'],
  mp: ['MP', '魔力', '当前MP', '当前魔力'],
  maxMp: ['MP上限', '最大MP', '魔力上限', '最大魔力'],
  sp: ['SP', '体力', '当前SP', '当前体力', '精力'],
  maxSp: ['SP上限', '最大SP', '体力上限', '最大体力'],
  level: ['等级', 'Lv', 'Lv.', '级别'],
  str: ['力量', 'STR'],
  con: ['体质', 'CON'],
  dex: ['敏捷', 'DEX'],
  int: ['智力', 'INT'],
  atk: ['物理攻击', '攻击', 'ATK'],
  def: ['物理防御', '防御', 'DEF'],
  matk: ['魔法攻击', 'MATK'],
  mdef: ['魔法防御', 'MDEF'],
  agi: ['速度', 'AGI'],
  coord: ['微观坐标', '坐标', '位置'],
  departure: ['离场状态', '离场', '退场'],
  personality: ['核心性格', '性格'],
  background: ['背景履历', '履历', '背景'],
  gender: ['性别'],
  height: ['身高'],
  weight: ['体重'],
  race: ['种族'],
  job: ['职业', '身份', '公开身份'],
  age: ['年龄'],
  birthday: ['出生日期', '生日'],
};

function lev(a, b, limit = 2) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > limit) return limit + 1;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let cur = new Array(n + 1);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > limit) return limit + 1;
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

function aliasTableOf(no) {
  return ALIASES.tableAliases?.[no] ?? ALIASES.tableAliases?.[String(no)] ?? null;
}

/**
 * 解析属性名 → {index, name, by}
 * @param {number} no 表号
 * @param {string|number} attr 属性名（英文别名 / 中文列名 / 列下标）
 * @param {{maxDistance?:number}} [opts]
 */
/** 把名字拆成词元集合：camelCase / snake / 括号 / 中文都处理（hpMax → {hp,max}；HP(上限) → {hp,上限}） */
export function tokenSetOf(name) {
  const s = String(name ?? "");
  const out = new Set();
  try {
    for (const part of s.split(/[\s_\-./()（）\[\]{}、,，]+/)) {
      if (!part) continue;
      const words = part.match(/[A-Za-z]+|[0-9]+|[\u4e00-\u9fa5]+/g) || [];
      for (const w of words) {
        // 再拆一次 camelCase：hpMax → hp / Max
        const cams = String(w).match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])|[0-9]+|[\u4e00-\u9fa5]+/g) || [w];
        for (const c of cams) { const k = String(c).toLowerCase(); if (k) out.add(k); }
      }
    }
  } catch (e) { /* ignore */ }
  return out;
}

/** 两边的词元集合是否"等价"（完全相同，或一方完全包含另一方） */
function tokensMatch(a, b) {
  try {
    if (!a.size || !b.size) return false;
    const sub = (x, y) => [...x].every((k) => y.has(k));
    return sub(a, b) || sub(b, a);
  } catch (e) { return false; }
}

export function resolveAttr(no, attr, opts = {}) {
  const maxDistance = opts.maxDistance ?? 2;
  const key = String(attr ?? '').trim();
  if (key === '') return null;

  // 0) 纯数字 = 列下标（旧协议用）
  if (/^\d+$/.test(key)) {
    const idx = Number(key);
    const cols = getTable(no)?.columns ?? [];
    if (idx >= 0 && idx < cols.length) return { index: idx, name: cols[idx], by: 'index' };
    return null;
  }

  const t = aliasTableOf(no);
  const cols = getTable(no)?.columns ?? [];

  // 1) 中文列名（含归一化与模糊）
  const byName = matchColumn(no, key, { maxDistance: 1 });
  if (byName) return { index: byName.index, name: byName.name, by: `col:${byName.level}` };

  if (t) {
    // 2) 英文别名精确
    if (t.aliasToIndex[key] != null) {
      const i = t.aliasToIndex[key];
      return { index: i, name: cols[i], by: 'alias' };
    }
    const nk = normalize(key);
    for (const [alias, idx] of Object.entries(t.aliasToIndex)) {
      if (normalize(alias) === nk) return { index: idx, name: cols[idx], by: 'alias-normalized' };
    }
    // 3) 同义词
    for (const [canon, list] of Object.entries(SYNONYMS)) {
      const hit = normalize(canon) === nk || list.some((s) => normalize(s) === nk);
      if (hit && t.aliasToIndex[canon] != null) {
        const i = t.aliasToIndex[canon];
        return { index: i, name: cols[i], by: `synonym:${canon}` };
      }
    }
    // 4) 别名模糊
    let best = null;
    let bestD = maxDistance + 1;
    for (const [alias, idx] of Object.entries(t.aliasToIndex)) {
      const d = lev(normalize(alias), nk, maxDistance);
      if (d < bestD) { bestD = d; best = { index: idx, alias }; }
    }
    if (best) return { index: best.index, name: cols[best.index], by: `alias-fuzzy:${best.alias}` };
  }

  // 5) 中文列名更宽松的模糊（距离 2）
  const loose = matchColumn(no, key, { maxDistance: 2 });
  if (loose) return { index: loose.index, name: loose.name, by: `col-loose:${loose.level}` };

  return null;
  /* 词元兜底：AI 会自己造名字（hpMax 而我们有 maxHp）→ 拆词元后等价就当命中 */
  try {
    const want = tokenSetOf(ref);
    if (want.size) {
      const t = getTable(no);
      const cols = (t?.columns ?? []).map((c) => String(c));
      for (let ci = 0; ci < cols.length; ci++) {
        const colName = cols[ci];
        const cand = new Set();
        for (const kk of tokenSetOf(colName)) cand.add(kk);
        for (const a of listAttrs(no)) {
          if (String(a.name) !== colName) continue;
          for (const al of (a.aliases || [])) for (const kk of tokenSetOf(al)) cand.add(kk);
        }
        if (tokensMatch(want, cand)) return { index: ci, name: colName, via: "token" };
      }
    }
  } catch (e) { /* ignore */ }
}

/** 该表可用的全部属性名（列名 + 别名），供提示词与 UI 展示 */
export function listAttrs(no) {
  const cols = getTable(no)?.columns ?? [];
  const t = aliasTableOf(no);
  return cols.map((name, i) => {
    const aliases = Object.entries(t?.aliasToIndex ?? {})
      .filter(([, idx]) => idx === i)
      .map(([a]) => a);
    return { index: i, name, aliases };
  });
}
