/**
 * rules.js —— 属性计算与"派生展开"
 *
 * 这是痛点 ② 的落地：AI 只申报事实（谁、对谁、用什么、多用力），
 * 数值与连锁反应由这里算。模型每少做一次算术，就少一个错。
 *
 * 三块内容：
 *   1. 属性公式（与 tableCustomConfig 里写明的公式一致）
 *   2. 战斗展开：<skill used="霜刃" power="7" actor="A" target="B"/> → 伤害/消耗/HP 变化
 *   3. 离场展开：<departure name="X"/> → 表4 离场列 + 表0 在场名单同步
 */

import { getTable } from './schema.js';
import { matchRow } from './match.js';
import { resolveAttr } from './alias.js';
import { cellStr } from './util.js';
import * as store from './store.js';

/* ------------------------------------------------------------ 属性公式 */

/**
 * 默认战斗系数（按 power 语义：1-2 试探 / 3-4 轻击 / 5-6 标准 / 7-8 重击 / 9-10 终结）
 * 可在设置里覆盖；这里给的是"叙事语义"的直觉映射，具体数值你可以随时调。
 */
export const DEFAULT_POWER_FACTOR = {
  1: 0.25, 2: 0.35,
  3: 0.55, 4: 0.7,
  5: 0.9, 6: 1.1,
  7: 1.35, 8: 1.6,
  9: 1.9, 10: 2.3,
};

/** 从 "Lv.45" / "45" / "Lv45" 里取等级数字 */
export function parseLevel(v) {
  const m = String(v ?? '').match(/(\d+)/);
  return m ? Number(m[1]) : 0;
}

/** 从 "1.5|1.2|0.8|0.6" 里取四维系数 */
/** 四维系数为空时，按基准 1.0 计算（只用于算派生值，不写回这一列） */
export function parseCoefOrBase(v) {
  const c = parseCoef(v);
  if (c && c.some((x) => x)) return c;
  return [1, 1, 1, 1];
}

export function parseCoef(v) {
  const parts = String(v ?? '').split(/[|｜/,\s]+/).map((x) => Number(x)).filter((n) => Number.isFinite(n));
  return [parts[0] ?? 1, parts[1] ?? 1, parts[2] ?? 1, parts[3] ?? 1];
}

/** 属性值 = 5 + (等级-1) × 系数（与你的表格说明完全一致） */
export function baseAttr(level, coef) {
  return Math.round(5 + Math.max(0, level - 1) * coef);
}

/**
 * 由「等级 + 四维系数」推出全部派生属性。
 * @returns {{level:number, STR:number, CON:number, DEX:number, INT:number, maxHp:number, maxMp:number, maxSp:number, ATK:number, DEF:number, MATK:number, MDEF:number, AGI:number, maxLoad:number}}
 */
export function deriveStats(level, coef) {
  const [cStr, cCon, cDex, cInt] = coef;
  const STR = baseAttr(level, cStr);
  const CON = baseAttr(level, cCon);
  const DEX = baseAttr(level, cDex);
  const INT = baseAttr(level, cInt);
  return {
    level, STR, CON, DEX, INT,
    maxHp: Math.round(100 + CON * 20),
    maxMp: Math.round(50 + INT * 10),
    maxSp: 100,
    ATK: Math.round(STR * 2),
    DEF: Math.round(CON * 1.5),
    MATK: Math.round(INT * 2),
    MDEF: Math.round(INT * 1),
    AGI: Math.round(DEX * 1.5),
    maxLoad: Math.round(CON * 10),
  };
}

/** 读一个数值单元格 */
function num(row, idx) {
  const raw = String(row?.[idx] ?? '').replace(/[^\d.+-]/g, '');
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

/* ---------------------------------------------------------- 角色重算 */

/**
 * 依据表2（静态档案：等级 + 四维系数）重算表13 的派生属性。
 * 只覆盖"派生列"，不动 HP/MP/SP 的当前值（那是战斗与状态管的）。
 * @returns {Array<op>}
 */
export function recalcCharacters({ fillMax = true } = {}) {
  const ops = [];
  const t2 = getTable(2);
  const t13 = getTable(13);
  if (!t2 || !t13) return ops;

  const rows13 = store.getRows(13, { create: false });
  const c13 = t13.columns;
  const idx = (name) => c13.indexOf(name);

  for (const r2 of store.getRows(2, { create: false })) {
    const name = String(r2?.[t2.columns.indexOf('角色名称')] ?? '').trim();
    if (!name) continue;
    const level = parseLevel(r2[t2.columns.indexOf('等级')]) || 1;   // 等级还没写出来时按 1 级算，先把派生列填上（后续轮次会覆盖）
    const coef = parseCoefOrBase(r2[t2.columns.indexOf('四维系数(STR|CON|DEX|INT)')]);
    const s = deriveStats(level, coef);

    const hit = matchRow(13, rows13, name, { maxDistance: 1 });
    if (!hit) continue;
    const row = rows13[hit.index];

    const values = {
      '力量(STR)': String(s.STR),
      '体质(CON)': String(s.CON),
      '敏捷(DEX)': String(s.DEX),
      '智力(INT)': String(s.INT),
      '物理攻击(ATK)': String(s.ATK),
      '物理防御(DEF)': String(s.DEF),
      '魔法攻击(MATK)': String(s.MATK),
      '魔法防御(MDEF)': String(s.MDEF),
      '速度(AGI)': String(s.AGI),
      '负重上限': String(s.maxLoad),      // 真实列名（实测 schema 就是「负重上限」）
      '临时修正': '无',                       // 机械列：脚本写默认值，不让 AI 操心
      '更新时间戳': String(store.getRev ? (store.getRev() || 0) : 0),
      '负重(LOAD)': String(s.maxLoad),    // 兼容另一种命名的 schema
    };
    if (fillMax) {
      if (!num(row, idx('HP(上限)'))) values['HP(上限)'] = String(s.maxHp);
      if (!num(row, idx('MP(上限)'))) values['MP(上限)'] = String(s.maxMp);
      if (!num(row, idx('SP(上限)'))) values['SP(上限)'] = String(s.maxSp);
    }
    ops.push({ op: 'update', table: 13, row: name, values, __tag: 'recalc' });
  }
  return ops;
}

/* ------------------------------------------------------------ 战斗展开 */

/**
 * 把一条 <skill> 事实展开成具体操作。
 *
 * 支持的写法：
 *   <skill used="霜刃" actor="左玄" target="慕容雪" power="7"/>
 *   <skill name="霜刃" from="左玄" to="慕容雪" power="7" heal="true"/>   （治疗）
 *   <skill actor="左玄" target="慕容雪" power="7" damage="120"/>        （直接给伤害，跳过查技能）
 */
export function expandSkill(fact, { powerFactor = DEFAULT_POWER_FACTOR } = {}) {
  const ops = [];
  const notes = [];
  const merged = { ...(store.getConfigValue('dataProtocol.powerFactor', {}) ?? {}), ...powerFactor };

  const a = fact.attrs ?? {};
  const actor = String(a.actor ?? a.from ?? a.by ?? '').trim();
  const target = String(a.target ?? a.to ?? a.on ?? '').trim();
  const skillName = String(a.used ?? a.name ?? a.skill ?? '').trim();
  const power = Math.max(1, Math.min(10, Number(a.power ?? a.force ?? 5) || 5));
  const factor = merged[power] ?? DEFAULT_POWER_FACTOR[5];
  const isHeal = String(a.heal ?? '').toLowerCase() === 'true' || /治疗|回复/.test(String(a.type ?? ''));

  if (!target) { notes.push('<skill> 缺少 target，已忽略。'); return { ops, notes }; }

  /* ---- 1) 找目标的属性行（表13 优先，找不到找表14 怪物） ---- */
  let dmgTableNo = 13;
  let targetRows = store.getRows(13, { create: false });
  let targetHit = target ? matchRow(13, targetRows, target, { maxDistance: 2 }) : null;
  if (!targetHit) {
    dmgTableNo = 14;
    targetRows = store.getRows(14, { create: false });
    targetHit = matchRow(14, targetRows, target, { maxDistance: 2 });
  }
  if (!targetHit) { notes.push(`<skill> 找不到目标「${target}」的属性行，未结算。`); return { ops, notes }; }

  const tTarget = getTable(dmgTableNo);
  const row = targetRows[targetHit.index];
  const col = (name) => tTarget.columns.indexOf(name);

  /* ---- 2) 算基础量 ---- */
  let base = Number(a.damage ?? a.value ?? a.amount);
  let mp = 0; let sp = 0;

  const t10 = getTable(10);
  const skillRows = store.getRows(10, { create: false });
  const skillHit = skillName ? matchRow(10, skillRows, skillName, { maxDistance: 2 }) : null;
  if (skillHit) {
    const srow = skillRows[skillHit.index];
    if (!Number.isFinite(base)) {
      base = num(srow, t10.columns.indexOf('基础伤害/治疗量'));
      if (!base) base = 10;                       // 技能没写伤害时的兜底
    }
    mp = num(srow, t10.columns.indexOf('MP消耗'));
    sp = num(srow, t10.columns.indexOf('SP消耗'));
  } else {
    if (!Number.isFinite(base)) base = 10;
    if (skillName) notes.push(`技能「${skillName}」不在表10，按基础 ${base} 结算（建议补建 <skill_def>）。`);
  }

  /* ---- 3) 攻防修正 ---- */
  let atk = 0; let def = 0;
  if (actor) {
    let actorTableNo = 13;
    let actorHit = matchRow(13, store.getRows(13, { create: false }), actor, { maxDistance: 2 });
    if (!actorHit) {
      actorHit = matchRow(14, store.getRows(14, { create: false }), actor, { maxDistance: 2 });
      actorTableNo = 14;
    }
    if (actorHit) {
      const aRow = store.getRows(actorTableNo, { create: false })[actorHit.index] ?? [];
      atk = num(aRow, getTable(13).columns.indexOf('物理攻击(ATK)'));
    }
  }
  def = num(row, col('物理防御(DEF)'));

  const ratio = 1 + Math.max(-0.6, Math.min(0.8, (atk - def) / 400));
  let amount = Math.max(1, Math.round(base * factor * ratio));
  if (isHeal) amount = -amount;                    // 治疗用负数走 delta

  /* ---- 4) 目标 HP 变化 ---- */
  const hpCol = col('HP(当前)');
  if (hpCol >= 0) {
    ops.push({
      op: 'delta', table: dmgTableNo, row: target, col: 'HP(当前)', by: -amount,
      __tag: 'skill', __reason: `${actor || '?'} → ${target}（${skillName || '攻击'} power=${power}）`,
    });
  }

  /* ---- 5) 施法者消耗 ---- */
  if (actor && (mp || sp)) {
    if (mp) ops.push({ op: 'delta', table: 13, row: actor, col: 'MP(当前)', by: -mp, __tag: 'skill-cost' });
    if (sp) ops.push({ op: 'delta', table: 13, row: actor, col: 'SP(当前)', by: -sp, __tag: 'skill-cost' });
  }

  /* ---- 6) 把技能标记为冷却中（有 CD 且非瞬发时） ---- */
  if (skillHit) {
    const cd = String(skillRows[skillHit.index]?.[t10.columns.indexOf('CD冷却')] ?? '');
    if (cd && !/瞬发|无/.test(cd)) {
      ops.push({ op: 'update', table: 10, row: skillName, values: { 封印状态: `冷却中（${cd}）` }, __tag: 'skill-cd' });
    }
  }

  notes.push(`结算：${actor || '?'} 用「${skillName || '攻击'}」(power ${power} × ${factor}) 对 ${target} 造成 ${amount} 点${isHeal ? '治疗' : '伤害'}`
    + (mp || sp ? `；消耗 MP${mp} SP${sp}` : ''));
  return { ops, notes };
}

/* ------------------------------------------------------------ 离场展开 */

/**
 * <departure name="X" silent="true"/> →
 *   ① 表4 该角色离场列写"已离场(隐匿)丨退场锚点：N"
 *   ② 表0 在场名单里移除该角色
 */
export function expandDeparture(fact, { round = null } = {}) {
  const ops = [];
  const notes = [];
  const name = String(fact.attrs?.name ?? fact.attrs?.who ?? '').trim();
  if (!name) { notes.push('<departure> 缺少 name，已忽略。'); return { ops, notes }; }

  const silent = String(fact.attrs?.silent ?? '').toLowerCase() === 'true';
  const anchor = round ?? (store.getRev() + 1);

  const t4 = getTable(4);
  const hit4 = matchRow(4, store.getRows(4, { create: false }), name, { maxDistance: 2 });
  if (hit4) {
    ops.push({
      op: 'update', table: 4, row: name,
      values: { 离场状态: `已离场${silent ? '（隐匿）' : ''}丨退场锚点：${anchor}` },
      __tag: 'departure',
    });
  } else {
    notes.push(`<departure> 表4 里没有「${name}」，只同步了在场名单。`);
  }
  void t4;

  // 同步表0 在场名单
  const t0 = getTable(0);
  const presentIdx = t0?.columns.indexOf('在场实体名单') ?? -1;
  const rows0 = store.getRows(0, { create: false });
  if (presentIdx >= 0 && rows0.length) {
    const cur = String(rows0[0]?.[presentIdx] ?? '');
    const list = cur.split(/[/,，、]/).map((s) => s.trim()).filter(Boolean);
    const next = list.filter((n) => n !== name);
    if (next.length !== list.length) {
      ops.push({ op: 'set', table: 0, rowIndex: 0, col: '在场实体名单', value: next.join('/'), __tag: 'departure-sync' });
      notes.push(`在场名单已移除「${name}」（剩余 ${next.length} 人）。`);
    }
  }
  return { ops, notes };
}

/* ------------------------------------------------------------ 统一入口 */

/**
 * 把 protocol 层标为"需要派生"的事实展开成 ops。
 * @returns {{ops:Array, notes:Array<string>}}
 */
export function expandFacts(unparsed, opts = {}) {
  const ops = [];
  const notes = [];
  for (const fact of unparsed ?? []) {
    try {
      if (['skill', 'skill_use', 'attack', 'combat'].includes(fact.tag)) {
        const r = expandSkill(fact, opts);
        ops.push(...r.ops); notes.push(...r.notes);
      } else if (['departure', 'leave'].includes(fact.tag)) {
        const r = expandDeparture(fact, opts);
        ops.push(...r.ops); notes.push(...r.notes);
      } else if (['memory', 'character_memory'].includes(fact.tag)) {
        notes.push(`<${fact.tag}>（角色视角记忆）已识别；记忆模块尚未接入，本轮未处理。`);
      } else {
        notes.push(`<${fact.tag}> 暂不支持派生展开。`);
      }
    } catch (e) {
      notes.push(`展开 <${fact.tag}> 时出错：${e?.message ?? e}`);
    }
  }
  return { ops, notes };
}

export { cellStr, resolveAttr };

/* ------------------------------------------------------------ 表14 派生数值 */

/**
 * 表14（怪物与临时实体）也按「等级 + 四维系数」算派生数值 —— 与表13 同一套公式。
 * 覆盖率实测发现：表14 的力量/体质/敏捷/智力/前后缀攻防一直是空的（只有表13 被重算）。
 */
export function recalcMonsters({ fillMax = true } = {}) {
  const ops = [];
  try {
    const t14 = getTable(14);
    if (!t14) return ops;
    const cols = (t14.columns || []).map((c) => String(c));
    const find = (re) => cols.findIndex((c) => re.test(c));
    const iName = find(/名称|名字/);
    const iLv = find(/等级/);
    const iCoef = find(/四维系数/);
    if (iName < 0 || iLv < 0 || iCoef < 0) return ops;
    const rows = store.getRows(14, { create: false });
    for (const r of rows) {
      const name = String(r?.[iName] ?? "").trim();
      if (!name) continue;
      const lv = Number(String(r?.[iLv] ?? "").replace(/[^\d.]/g, ""));
      const coef = parseCoefOrBase ? parseCoefOrBase(r?.[iCoef]) : parseCoef(r?.[iCoef]);
      if (!lv || !coef) continue;
      const s = deriveStats(lv, coef);
      const values = {};
      const put = (colName, v) => { if (colName && cols.includes(colName)) values[colName] = String(v); };
      put(cols[find(/力量|STR/i)], s.STR);
      put(cols[find(/体质|CON/i)], s.CON);
      put(cols[find(/敏捷|DEX/i)], s.DEX);
      put(cols[find(/智力|INT/i)], s.INT);
      put(cols[find(/物理攻击|ATK/i)], s.ATK);
      put(cols[find(/物理防御|DEF/i)], s.DEF);
      put(cols[find(/魔法攻击|MATK/i)], s.MATK);
      put(cols[find(/魔法防御|MDEF/i)], s.MDEF);
      put(cols[find(/速度|AGI/i)], s.AGI);
      put(cols[find(/负重/i)], s.maxLoad);
      if (fillMax) {
        if (!Number(String(r?.[find(/HP\(上限\)/)] ?? "").replace(/[^\d.]/g, ""))) put(cols[find(/HP\(上限\)/)], s.maxHp);
        if (!Number(String(r?.[find(/MP\(上限\)/)] ?? "").replace(/[^\d.]/g, ""))) put(cols[find(/MP\(上限\)/)], s.maxMp);
      }
      if (Object.keys(values).length) ops.push({ op: "update", table: 14, row: name, values, __tag: "recalc" });
    }
  } catch (e) { console.warn("[RBQ] 表14 重算失败", e); }
  return ops;
}
