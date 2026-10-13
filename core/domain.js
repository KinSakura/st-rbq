/**
 * domain.js —— 领域查询层（照 DND 仪表盘的 DataManager 做法）
 *
 * 为什么要有这一层：
 *   视图不该自己拼表。视图想要的是"角色""技能""关系"这种**领域对象**，
 *   而不是"表2 第 3 行的第 7 列"。这一层负责：
 *     ① 按语义列名取数（改表名列名不崩）
 *     ② 把跨表的东西联起来（角色 = 表2+表3+表4+表13；技能 = 表2 技能池 × 表10）
 *     ③ 双向关系（他眼中的别人 / 别人眼中的他）
 *   AI 那边照旧拿表格；人这边拿到的是领域对象。
 */
import * as store from './store.js';
import { getTable } from './schema.js';
import { resolveAttr } from './alias.js';

/** 语义名 → 真实列名（唯一真相源；视图与领域层都用它，改表名只动这里） */
export const COL_ALIAS = {
  7: { 任务状态: '推进状态', 状态: '推进状态', 进度: '推进状态', 完成度: '推进状态', 截止期限: '过期死线', 死线: '过期死线', 达成目标: '物理目标', 目标: '物理目标', 参与成员: '挂载角色', 成员: '挂载角色', 报酬与资产: '关键资产', 报酬: '关键资产', 约束与违约条款: '结算规则', 约束: '结算规则', 发布者: '发放方', 委托人: '发放方', 任务地点: '执行坐标', 任务类别: '行动类别', 类别: '行动类别' },
  9: { 当前持有者: '当前归属', 类别: '物理类别', 持有者: '当前归属', 数量: '耐久/数量', 耐久度: '耐久/数量', 备注与属性加成: '属性加成', 实时状态: '外显状态', 部位: '物理类别' },
  10: { '来源/流派': '觉醒溯源', 来源: '觉醒溯源', 掌握度: '熟练阶层', 覆盖范围: '波及范围', 效果描述: '物理描述', 描述: '物理描述' },
  11: { '势力/法则名称': '名称', 类型: '数据分类', 核心领袖: '权力终端/制定者', 势力范围: '辐射辖区', 声望评级: '主角声望/参与度', 对玩家敌对度: '敌对关联', 成员福利: '内部福利/优势', 组织红线: '红线/禁忌', 违规惩罚: '处罚/后果' },
  12: { 时间跨度: '时间轴区间', 阶段索引: '纪元封包名', 路线标记: '地理迁徙路线', 纪事概要: '剧情压缩', 死亡与伤亡: '死亡名单', 势力与格局变动: '派系崩塌与格局重构', 情感与关系沉淀: '情感质变', 遗留伏笔与悬念: '继承悬念' },
};

/* ------------------------------------------------------------------ 底层 */

function rowsOf(no) {
  try { return store.getRows(no, { create: false }) ?? []; } catch { return []; }
}

function colsOf(no) {
  const t = getTable(no);
  return t?.columns ?? [];
}

/** 按语义名取一行的某列（先走本表的别名表，再走全局别名，最后包含匹配） */
export function cell(no, row, semantic) {
  if (!Array.isArray(row)) return undefined;
  const tableAlias = COL_ALIAS[no] ?? {};
  const mapped = tableAlias[semantic] ?? semantic;
  // 注意：resolveAttr(表号, 语义名) 第一个参数是**表号**，返回 {index, name}
  const hit = resolveAttr(no, mapped);
  if (!hit) return undefined;
  return row[hit.index];
}

/** 把一行的所有列变成对象（键是真实列名） */
export function rowObj(no, row) {
  const cols = colsOf(no);
  const out = {};
  if (!Array.isArray(row)) return out;
  cols.forEach((c, i) => { if (row[i] !== undefined && row[i] !== '') out[c] = row[i]; });
  return out;
}

/** 整表 → 对象数组 */
export function listOf(no) {
  return rowsOf(no).filter((r) => Array.isArray(r)).map((r) => rowObj(no, r));
}

function nameOfRow(no, row, candidates) {
  for (const c of candidates) {
    const v = cell(no, row, c);
    if (v !== undefined && v !== '' && v !== null) return String(v).trim();
  }
  return '';
}

/** 主角名字：表0 在场名单第一个，或表2 第一行 */
export function mainName() {
  const present = presentNames();
  if (present.length) return present[0];
  const r2 = rowsOf(2)[0];
  return r2 ? nameOfRow(2, r2, ['角色名称', '姓名', '名字']) : '';
}

/* ------------------------------------------------------------------ 世界 */

/** 表0：宏观时空（单例） */
export function worldState() {
  const r = rowsOf(0)[0];
  if (!r) return {};
  const o = rowObj(0, r);
  return {
    round: cell(0, r, '系统轮次') ?? o['系统轮次'] ?? '',
    time: cell(0, r, '时空坐标') ?? '',
    place: cell(0, r, '绝对位置名称') ?? '',
    weather: cell(0, r, '环境气象') ?? '',
    law: cell(0, r, '世界法则') ?? '',
    mood: cell(0, r, '安全氛围') ?? '',
    raw: o,
  };
}

/** 表0 在场名单（逗号/顿号/分号/斜杠分隔都认） */
export function presentNames() {
  const r = rowsOf(0)[0];
  if (!r) return [];
  const v = cell(0, r, '在场实体名单') ?? cell(0, r, '在场名单') ?? '';
  return String(v).split(/[、,，;；/|]/).map((s) => s.trim()).filter(Boolean);
}

/* ------------------------------------------------------------------ 角色 */

const NAME_COLS = { 2: ['角色名称', '姓名', '名字'], 3: ['角色名称', '姓名'], 4: ['角色名称', '姓名'], 13: ['角色名称', '姓名'], 14: ['实体名称', '名称'] };

function indexByName(no) {
  const m = new Map();
  for (const r of rowsOf(no)) {
    if (!Array.isArray(r)) continue;
    const n = nameOfRow(no, r, NAME_COLS[no] ?? ['名称', '姓名']);
    if (n && !m.has(n)) m.set(n, r);
  }
  return m;
}

/** 所有角色（表2 静态档案 × 表3 生理 × 表4 即时状态 × 表13 动态属性） */
export function listCharacters() {
  const m3 = indexByName(3);
  const m4 = indexByName(4);
  const m13 = indexByName(13);
  const present = new Set(presentNames());
  const out = [];
  for (const r of rowsOf(2)) {
    if (!Array.isArray(r)) continue;
    const name = nameOfRow(2, r, NAME_COLS[2]);
    if (!name) continue;
    const a13 = m13.get(name);
    const num = (v) => (v === undefined || v === '' || v === null ? null : Number(v));
    out.push({
      name,
      sheet: rowObj(2, r),
      body: m3.has(name) ? rowObj(3, m3.get(name)) : {},
      now: m4.has(name) ? rowObj(4, m4.get(name)) : {},
      stats: a13 ? rowObj(13, a13) : {},
      hp: a13 ? num(cell(13, a13, 'HP(当前)')) : null,
      hpMax: a13 ? num(cell(13, a13, 'HP(上限)')) : null,
      mp: a13 ? num(cell(13, a13, 'MP(当前)')) : null,
      mpMax: a13 ? num(cell(13, a13, 'MP(上限)')) : null,
      sp: a13 ? num(cell(13, a13, 'SP(当前)')) : null,
      spMax: a13 ? num(cell(13, a13, 'SP(上限)')) : null,
      level: (() => { const v = cell(2, r, '等级'); return v === undefined || v === '' ? null : Number(v); })(),
      race: cell(2, r, '种族') ?? '',
      job: cell(2, r, '职业') ?? '',
      alive: cell(2, r, '存活状态') ?? '',
      present: present.has(name),
      left: String(cell(4, m4.get(name) ?? [], '离场状态') ?? '') !== '',
    });
  }
  return out;
}

/** 单个角色（含技能/装备/关系/异常），一张卡里的东西一次拿全 */
export function getCharacter(name) {
  const target = String(name ?? '').trim();
  if (!target) return null;
  const c = listCharacters().find((x) => x.name === target) ?? null;
  if (!c) return null;
  return {
    ...c,
    skills: getCharacterSkills(target),
    equipment: getCharacterEquipment(target),
    relations: getRelationsOf(target),
    anomalies: listAnomalies(target),
    items: listItemsOwnedBy(target),
  };
}

/** 角色的技能：表2「技能池」里写的名字 × 表10 能力法则表 */
export function getCharacterSkills(name) {
  const target = String(name ?? '').trim();
  const m2 = indexByName(2);
  const r2 = m2.get(target);
  const poolRaw = r2 ? (cell(2, r2, '技能池') ?? cell(2, r2, '技能') ?? '') : '';
  const pool = String(poolRaw).split(/[、,，;；/|]/).map((s) => s.trim()).filter(Boolean);
  const lib = listOf(10);
  const out = [];
  for (const p of pool) {
    const hit = lib.find((s) => String(s['技能名称'] ?? '').trim() === p)
      ?? lib.find((s) => String(s['技能名称'] ?? '').includes(p));
    if (hit) out.push({ name: p, ...hit });
    else out.push({ name: p, missing: true });
  }
  return out;
}

/** 角色的装备：表9 里「当前归属」是他的物品；部位由「物理类别」推断 */
export function getCharacterEquipment(name) {
  const target = String(name ?? '').trim();
  return listItemsOwnedBy(target).map((it) => ({ ...it, slot: slotOfItem(it) }));
}

export function listItemsOwnedBy(name) {
  const target = String(name ?? '').trim();
  const out = [];
  for (const r of rowsOf(9)) {
    if (!Array.isArray(r)) continue;
    const owner = String(cell(9, r, '当前归属') ?? '').trim();
    if (owner !== target) continue;
    out.push({
      name: String(cell(9, r, '物品名称') ?? ''),
      category: String(cell(9, r, '物理类别') ?? ''),
      rarity: String(cell(9, r, '稀有度') ?? ''),
      dmg: cell(9, r, '基础伤害') ?? '',
      armor: cell(9, r, '护甲值') ?? '',
      bonus: String(cell(9, r, '属性加成') ?? ''),
      raw: rowObj(9, r),
    });
  }
  return out;
}

/** 由物品类别推断装备位（表9 没有"部位"列，靠类别词猜） */
export function slotOfItem(it) {
  const s = String(it?.category ?? '') + String(it?.name ?? '') + String(it?.bonus ?? '');
  if (/主手|武器|剑|刀|枪|弓|杖|镰/.test(s)) return '主手';
  if (/副手|盾|副武器/.test(s)) return '副手';
  if (/头|盔|帽/.test(s)) return '头部';
  if (/上装|衣|甲|外套/.test(s)) return '上装';
  if (/下装|裤|裙/.test(s)) return '下装';
  if (/鞋|靴|足/.test(s)) return '足部';
  if (/饰品|戒指|项链|护符/.test(s)) return '饰品';
  if (/披风|斗篷|披/.test(s)) return '披风';
  return '其他';
}

/** 关系：outgoing = 他眼中的别人；incoming = 别人眼中的他 */
export function getRelationsOf(name) {
  const target = String(name ?? '').trim();
  const outgoing = [];
  const incoming = [];
  for (const r of rowsOf(5)) {
    if (!Array.isArray(r)) continue;
    const a = String(cell(5, r, '发起方A') ?? cell(5, r, '发起方') ?? '').trim();
    const b = String(cell(5, r, '承受方B') ?? cell(5, r, '承受方') ?? '').trim();
    const obj = {
      a, b,
      surface: String(cell(5, r, '表面关系') ?? ''),
      call: String(cell(5, r, '表面称呼') ?? ''),
      secret: String(cell(5, r, '私密关系') ?? ''),
      secretCall: String(cell(5, r, '私密称呼') ?? ''),
      favor: cell(5, r, '好感底色') ?? '',
      raw: rowObj(5, r),
    };
    if (a === target) outgoing.push({ other: b, ...obj });
    if (b === target) incoming.push({ other: a, ...obj });
  }
  return { outgoing, incoming };
}

/** 表8：特殊面板覆写与异变（可按宿主过滤） */
export function listAnomalies(host) {
  const all = listOf(8);
  if (!host) return all;
  const target = String(host).trim();
  return all.filter((a) => String(a['宿主对象'] ?? '').trim() === target);
}

/* ------------------------------------------------------------------ 其它域 */

export function listQuests() { return listOf(7); }
export function listLocations() { return listOf(1); }
export function listFactions() { return listOf(11); }
export function listChronicle() { return listOf(12); }
export function listEntities() { return listOf(14); }
export function listSkills() { return listOf(10); }
export function listItems() { return listOf(9); }

/** 总览用：一句话统计 */
export function overview() {
  const chars = listCharacters();
  const w = worldState();
  return {
    world: w,
    present: presentNames(),
    characters: chars.length,
    alive: chars.filter((c) => !/死|亡/.test(String(c.alive))).length,
    quests: listQuests().length,
    locations: listLocations().length,
    entities: listEntities().length,
    factions: listFactions().length,
    chronicle: listChronicle().length,
  };
}
