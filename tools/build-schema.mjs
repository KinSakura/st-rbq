/**
 * 从用户现有的 tableCustomConfig（记忆增强表格插件的导出配置）生成
 * st-rbq 的内置 schema：data/default-schema.json
 *
 * 用法：node tools/build-schema.mjs <tableCustomConfig.json 路径> <输出路径>
 */
import fs from 'node:fs';
import path from 'node:path';

const [, , srcPath, outPath] = process.argv;
if (!srcPath || !outPath) {
  console.error('用法: node tools/build-schema.mjs <输入.json> <输出.json>');
  process.exit(2);
}

const raw = JSON.parse(fs.readFileSync(srcPath, 'utf8'));
const structure = raw.tableStructure ?? [];

/** 已知的单例表（永远只有一行） */
const SINGLETON_TABLES = new Set([0, 6]);

/** 主键列（相对“去掉行标签列”后的列下标） */
const KEY_COLUMNS = {
  5: [0, 1], // 社交网络表：发起方 A + 承受方 B 复合主键
};

/** 每张表的语义分组，用于 UI 归类 */
const GROUP = {
  0: 'world', 1: 'world', 11: 'world', 12: 'world',
  2: 'character', 3: 'character', 4: 'character', 5: 'character', 13: 'character',
  6: 'plot', 7: 'plot',
  8: 'misc', 9: 'misc', 10: 'misc', 14: 'misc',
};

const tables = structure
  .map((t) => {
    const no = Number(t.tableIndex);
    const columns = Array.isArray(t.columns) ? t.columns.map((c) => String(c)) : [];
    return {
      no,
      name: String(t.tableName ?? `表${no}`),
      columns,
      note: String(t.note ?? ''),
      group: GROUP[no] ?? 'misc',
      singleton: SINGLETON_TABLES.has(no),
      required: t.Required !== false,
      keyColumns: KEY_COLUMNS[no] ?? [0],
      // 从 note 里抽“主键”提示，供匹配器/Fuzzy 兜底参考
      enabled: t.enable !== false,
    };
  })
  .sort((a, b) => a.no - b.no);

// ── 每张表补齐 shukuju 式字段（移植自 naiv1.2 的指导表结构）──
// sourceData：这张表自己的四段给 AI 的指令（初始化/插入/更新/删除各说什么）
// updateConfig：这张表的注入参数（深度/频率/批量/跳楼层/只发最近 N 行）
const SOURCE_DATA_DEFAULTS = {
  initNode: '首次建表时：把这一轮出现的相关事实写成一行，缺的列留空。',
  insertNode: '出现新条目时：申报新条目，插件会自动补主键。',
  updateNode: '已有条目变化时：只申报变化的列，不要重写整行。',
  deleteNode: '条目失效或离场时：申报状态变化，不要抹掉历史。',
};
const UPDATE_CONFIG_DEFAULTS = {
  contextDepth: 0,
  updateFrequency: 1,
  batchSize: 0,
  skipFloors: 0,
  sendLatestRows: 0,
};
for (const t of tables) {
  const old = t.sourceData && typeof t.sourceData === 'object' ? t.sourceData : {};
  t.sourceData = { note: old.note ?? t.note ?? '', ...SOURCE_DATA_DEFAULTS, ...old };
  const oldU = t.updateConfig && typeof t.updateConfig === 'object' ? t.updateConfig : {};
  t.updateConfig = { ...UPDATE_CONFIG_DEFAULTS, ...oldU };
}

const out = {
  schemaVersion: 1,
  generatedFrom: path.basename(srcPath),
  generatedAt: new Date().toISOString(),
  // 表名 → 表号（与 statusbar.js / rbq.js 的 TABLE_NAME_TO_NUM 完全一致）
  nameToNo: Object.fromEntries(tables.map((t) => [t.name, String(t.no)])),
  tables,
  // 直接沿用用户调好的那段总说明；运行时会被 prompts/tablePrompt.js 拼接
  messageTemplate: String(raw.message_template ?? ''),
  // 注入相关设置（迁移过来，供配置中心显示/切换）
  legacy: {
    injectionMode: raw.injection_mode ?? 'injection_off',
    deep: raw.deep ?? 1,
  },
};

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8');

// 同时产出一个 ES module 版本：扩展里静态 import，避免 fetch/JSON 导入属性的兼容问题
const jsPath = outPath.replace(/\.json$/i, '.js');
const banner = `/**\n * 本文件由 tools/build-schema.mjs 自动生成，请勿手改。\n * 来源：${out.generatedFrom}  @ ${out.generatedAt}\n * 如需修改表格结构，请改配置后重新运行生成脚本。\n */\n`;
fs.writeFileSync(jsPath, `${banner}export default ${JSON.stringify(out, null, 2)};\n`, 'utf8');

console.log(`已生成 ${outPath}`);
console.log(`已生成 ${jsPath}`);
console.log(`  表数量: ${tables.length}`);
console.log(`  单例表: ${[...SINGLETON_TABLES].join(', ')}`);
console.log(`  列总数: ${tables.reduce((n, t) => n + t.columns.length, 0)}`);
console.log(`  messageTemplate: ${out.messageTemplate.length} 字`);
for (const t of tables) {
  console.log(`  [${String(t.no).padStart(2)}] ${t.name.padEnd(20)} ${String(t.columns.length).padStart(2)} 列  ${t.group}${t.singleton ? '  (单例)' : ''}`);
}
