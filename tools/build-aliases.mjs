/**
 * build-aliases.mjs —— 从用户现有 rbq.js（1.txt）里提取 TABLE_COL / TABLE_NAME_TO_NUM，
 * 生成 data/aliases.js。
 *
 * 为什么这么做：
 *   现有预设已经把 AI 教会用 `race` / `job` / `level` / `meiki` … 这套英文属性名写 <data>。
 *   重构后我们**不改这套词汇**，只是把"定位与计算"从 AI 手里收回来 ——
 *   所以别名表必须与 rbq.js 完全同源，而不是我另编一套。
 *
 * 用法：node tools/build-aliases.mjs <1.txt> <输出.js>
 */
import fs from 'node:fs';
import path from 'node:path';

const [, , srcPath, outPath] = process.argv;
if (!srcPath || !outPath) {
  console.error('用法: node tools/build-aliases.mjs <rbq.js 或 1.txt> <输出.js>');
  process.exit(2);
}

const text = fs.readFileSync(srcPath, 'utf8');

/** 从 `const NAME = {` 起截取配平的花括号块 */
function extractObjectLiteral(source, constName) {
  const anchor = new RegExp(`const\\s+${constName}\\s*=\\s*\\{`);
  const m = anchor.exec(source);
  if (!m) throw new Error(`找不到 ${constName}`);
  let i = source.indexOf('{', m.index + m[0].length - 1);
  let depth = 0;
  let inStr = null;
  for (let j = i; j < source.length; j++) {
    const c = source[j];
    if (inStr) {
      if (c === '\\') { j++; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return source.slice(i, j + 1);
    }
  }
  throw new Error(`${constName} 花括号未配平`);
}

/* ------------------------------------------------- 1) TABLE_NAME_TO_NUM */

const nameToNumLiteral = extractObjectLiteral(text, 'TABLE_NAME_TO_NUM');
// eslint-disable-next-line no-eval
const TABLE_NAME_TO_NUM = eval(`(${nameToNumLiteral})`);

/* ------------------------------------------------------- 2) TABLE_COL */

const colLiteral = extractObjectLiteral(text, 'TABLE_COL');
// eslint-disable-next-line no-eval
const TABLE_COL = eval(`(${colLiteral})`);

/* ------------------------- 3) 表号 → 语义名 → 列下标（相对去掉行标签列后） */

const tableAliases = {};
for (const [noStr, map] of Object.entries(TABLE_COL)) {
  const no = Number(noStr);
  // 反查：列下标 → [语义名...]（同一列可能有多个别名，取全部）
  const byIndex = new Map();
  for (const [alias, idx] of Object.entries(map)) {
    if (!byIndex.has(idx)) byIndex.set(idx, []);
    byIndex.get(idx).push(alias);
  }
  tableAliases[no] = {
    /** 语义名 → 列下标 */
    aliasToIndex: { ...map },
    /** 列下标 → 语义名数组 */
    indexToAliases: Object.fromEntries([...byIndex.entries()].map(([i, arr]) => [i, arr])),
    /** 该表所有可用的英文别名 */
    aliases: Object.keys(map),
  };
}

/* -------------------------------------------------------------- 4) 输出 */

/* 单例表（与 schema 一致） */
const SINGLETON = [0, 6];

const out = {
  generatedFrom: path.basename(srcPath),
  generatedAt: new Date().toISOString(),
  nameToNo: TABLE_NAME_TO_NUM,
  singletonTables: SINGLETON,
  tableAliases,
};

const banner = `/**\n * 本文件由 tools/build-aliases.mjs 自动生成，请勿手改。\n * 来源：${out.generatedFrom}  @ ${out.generatedAt}\n * 语义：把 AI 惯用的英文属性名（race/job/level/meiki…）映射到表格列下标。\n * 之所以从 rbq.js 反推而不是另编一套，是为了让现有预设产出的 <data> 语义零损失。\n */\n`;

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(path.join(path.dirname(outPath), 'aliases.json'), JSON.stringify(out, null, 2), 'utf8');
fs.writeFileSync(outPath, `${banner}export default ${JSON.stringify(out, null, 2)};\n`, 'utf8');

console.log(`已生成 ${outPath}`);
console.log(`  表名映射: ${Object.keys(out.nameToNo).length}`);
console.log(`  别名表:   ${Object.values(tableAliases).reduce((n, t) => n + t.aliases.length, 0)} 条`);
for (const [no, t] of Object.entries(tableAliases)) {
  console.log(`  [${String(no).padStart(2)}] ${t.aliases.length} 个别名 → 列下标 ${Object.values(t.aliasToIndex).join(',')}`);
}
