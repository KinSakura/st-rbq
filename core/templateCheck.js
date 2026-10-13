/**
 * templateCheck.js —— 模板检验 + 兼容说明导出 + 版本门控同步
 *
 * 借鉴：
 *   ① jerryzmtz 骰子系统的"模板检验预设"——把"哪些视图需要哪些表/列"写成文档并逐项检验；
 *   ② DND TemplateSync——版本门控：版本变了就提醒导入配套模板，导入前先做结构校验。
 *
 * 分级：error 会让视图坏掉；warning 可能让某个视图降级；info 只是统计。
 */
import * as store from './store.js';
import { getTables, getSchema, isSingleton, keyColumns } from './schema.js';

/** 当前配套模板版本；改了表结构就要 +1（用于提示用户导入新模板） */
export const TEMPLATE_SYNC_VERSION = '1.0';

/**
 * 每个视图/领域查询对表与列的要求（唯一清单；兼容说明也从这里生成）
 * cols 里写的是**语义名**，与 domain.js 的 COL_ALIAS 同一套叫法。
 */
export const VIEW_REQUIREMENTS = [
  { view: '总览', table: 0, cols: ['系统轮次', '时空坐标', '绝对位置名称', '环境气象', '在场实体名单', '世界法则'], level: 'error' },
  { view: '地图', table: 1, cols: ['地点名称', '所属大区'], level: 'error' },
  { view: '角色卡', table: 2, cols: ['角色名称', '存活状态', '种族', '职业', '等级'], level: 'error' },
  { view: '角色卡·生理', table: 3, cols: ['角色名称', '性别', '身高'], level: 'warning' },
  { view: '角色卡·即时', table: 4, cols: ['角色名称', '离场状态'], level: 'warning' },
  { view: '人物关系图', table: 5, cols: ['发起方A', '承受方B', '表面关系', '好感底色'], level: 'error' },
  { view: '任务看板', table: 7, cols: ['任务名称', '推进状态', '挂载角色', '过期死线'], level: 'error' },
  { view: '异常状态', table: 8, cols: ['异常状态名称', '宿主对象', '严重度'], level: 'warning' },
  { view: '背包/装备', table: 9, cols: ['物品名称', '当前归属', '物理类别', '稀有度'], level: 'error' },
  { view: '技能轮盘', table: 10, cols: ['技能名称', '检定类型', '熟练阶层'], level: 'error' },
  { view: '势力/阵营', table: 11, cols: ['名称', '数据分类', '敌对关联'], level: 'warning' },
  { view: '纪事年代带', table: 12, cols: ['纪元封包名', '时间轴区间', '剧情压缩'], level: 'warning' },
  { view: '角色卡·属性', table: 13, cols: ['角色名称', 'HP(当前)', 'HP(上限)', 'MP(当前)', 'MP(上限)'], level: 'error' },
  { view: '敌人/实体', table: 14, cols: ['实体名称', '等级', 'HP(当前)'], level: 'error' },
];

function hasCol(table, colName) {
  if (!table || !Array.isArray(table.columns)) return false;
  const target = String(colName);
  return table.columns.some((c) => {
    const s = String(c);
    return s === target || s.includes(target) || target.includes(s);
  });
}

/**
 * 检验一份 schema。返回 { ok, errors, warnings, infos }
 * 不传就检验当前生效的 schema。
 */
export function checkTemplate(schema = null) {
  const errors = [];
  const warnings = [];
  const infos = [];
  const sc = schema ?? getSchema();
  if (!sc || typeof sc !== 'object') {
    errors.push({ code: 'schema-missing', text: '模板不是一个对象。' });
    return { ok: false, errors, warnings, infos };
  }
  const tables = Array.isArray(sc.tables) ? sc.tables : [];
  if (!tables.length) {
    errors.push({ code: 'no-tables', text: '模板里一张表都没有。' });
    return { ok: false, errors, warnings, infos };
  }
  const seenNo = new Map();
  for (const t of tables) {
    const label = t?.name ? String(t.name) : `第 ${t?.no ?? '?'} 张表`;
    if (t?.no === undefined || t?.no === null) { errors.push({ code: 'table-no-missing', table: label, text: `${label}：缺表号。` }); continue; }
    if (!t?.name) errors.push({ code: 'table-name-missing', table: t.no, text: `表 ${t.no}：缺表名。` });
    if (!Array.isArray(t?.columns) || !t.columns.length) errors.push({ code: 'table-columns-missing', table: label, text: `${label}：一列都没有。` });
    if (seenNo.has(t.no)) errors.push({ code: 'table-no-dup', table: t.no, text: `表号 ${t.no} 重复（${seenNo.get(t.no)} 与 ${label}）。` });
    else seenNo.set(t.no, label);
    const cols = Array.isArray(t?.columns) ? t.columns.map(String) : [];
    const dup = cols.filter((c, i) => cols.indexOf(c) !== i);
    if (dup.length) warnings.push({ code: 'column-dup', table: label, text: `${label}：列名重复（${[...new Set(dup)].join('、')}）。` });
    if (!t?.sourceData || !t.sourceData.initNode || !t.sourceData.updateNode) {

    }

    if (isSingleton(t.no) && cols.length === 0) warnings.push({ code: 'singleton-empty', table: label, text: `${label}：单例表没有列。` });
    const keys = keyColumns(t.no);
    if (!keys || !keys.length) infos.push({ code: 'no-key', table: label, text: `${label}：没声明主键列，靠第一列当主键。` });
  }
  // 视图要求逐项核对
  const byNo = new Map(tables.map((t) => [Number(t.no), t]));
  for (const req of VIEW_REQUIREMENTS) {
    const t = byNo.get(Number(req.table));
    if (!t) {
      const item = { code: 'view-table-missing', view: req.view, table: req.table, text: `${req.view}：缺表 ${req.table}，这个视图会是空的。` };
      if (req.level === 'error') errors.push(item); else warnings.push(item);
      continue;
    }
    const missing = req.cols.filter((c) => !hasCol(t, c));
    if (missing.length) {
      const item = { code: 'view-col-missing', view: req.view, table: req.table, text: `${req.view}：表「${t.name}」里找不到 ${missing.join('、')}，对应区块会降级或空着。` };
      if (req.level === 'error') errors.push(item); else warnings.push(item);
    }
  }
  infos.push({ code: 'summary', text: `共 ${tables.length} 张表、${tables.reduce((n, t) => n + (t.columns?.length ?? 0), 0)} 列。` });
  return { ok: errors.length === 0, errors, warnings, infos };
}

/** 导出《视图 ↔ 表名列名要求》兼容说明（Markdown） */
export function exportCompatibilityDoc() {
  const tables = getTables();
  const byNo = new Map(tables.map((t) => [Number(t.no), t]));
  const lines = [];
  lines.push('# RBQ 视图 ↔ 表名列名要求', '');
  lines.push('改表名/列名后，用这份清单对照：缺哪一项，哪个视图会降级或空着。', '');
  lines.push('| 视图 | 需要表 | 需要的列（语义名） | 缺了会怎样 | 当前状态 |');
  lines.push('|---|---|---|---|---|');
  for (const req of VIEW_REQUIREMENTS) {
    const t = byNo.get(Number(req.table));
    const missing = t ? req.cols.filter((c) => !hasCol(t, c)) : req.cols;
    const status = !t ? '❌ 缺整张表' : (missing.length ? `⚠ 缺 ${missing.join('、')}` : '✅ 齐');
    const impact = req.level === 'error' ? '视图坏掉' : '区块降级';
    lines.push(`| ${req.view} | ${req.table}${t ? ' ' + t.name : ''} | ${req.cols.join('、')} | ${impact} | ${status} |`);
  }
  lines.push('', '## 当前模板', '');
  for (const t of tables) {
    lines.push(`- 表 ${t.no}「${t.name}」 ${t.columns.length} 列：${t.columns.join('、')}`);
  }
  return lines.join('\n');
}

/* ---------------------------------------------------------------- 版本门控 */

/** 已同步的模板版本（存在扩展设置里） */
export function getSyncedTemplateVersion() {
  return store.getConfigValue('templateSyncVersion', null);
}

export function setSyncedTemplateVersion(v = TEMPLATE_SYNC_VERSION) {
  store.updateConfig({ templateSyncVersion: String(v) });
  return String(v);
}

/** 是否需要同步（照 DND TemplateSync 的版本比对） */
export function templateSyncState() {
  const synced = getSyncedTemplateVersion();
  const current = TEMPLATE_SYNC_VERSION;
  return {
    current,
    synced,
    isFirstTime: !synced,
    needsSync: synced !== current,
  };
}

/** 把当前 schema 存成一份模板（供导出/分享），同时记录版本 */
export function snapshotCurrentTemplate() {
  const sc = getSchema();
  const check = checkTemplate(sc);
  return { mate: { type: 'rbqTemplate', version: TEMPLATE_SYNC_VERSION, checkedAt: new Date().toISOString(), ok: check.ok }, schema: sc, check };
}
