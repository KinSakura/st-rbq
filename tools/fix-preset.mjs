/**
 * fix-preset.mjs —— 预设重构工具（可复现，不手抄提示词）
 *
 * 做这些事：
 *   1. 修 正则5「转述输入」的 $2（原 findRegex 没有捕获组，$2 永远解析不出来）
 *   2. 拆分「markdownOnly 与 promptOnly 同时为 true」的冲突正则（ST 里语义矛盾）
 *   3. 处理孤儿 prompt（不在 prompt_order 里 = 永远不会发送）
 *   4. 统一 prompts 与 prompt_order 的 enabled 双标
 *   5. 清掉首条乱码 prompt
 *   6. 把 100 条内嵌世界书抽成独立世界书文件（预设体积大幅下降）
 *   7. 按语义把 prompt_order 重排成 8 个区块
 *   8. 输出：优化后的预设 + 独立世界书 + 报告
 *
 * 用法：
 *   node tools/fix-preset.mjs <原预设.json> <输出目录>
 */
import fs from 'node:fs';
import path from 'node:path';

const [, , srcPath, outDir] = process.argv;
if (!srcPath || !outDir) {
  console.error('用法: node tools/fix-preset.mjs <原预设.json> <输出目录>');
  process.exit(2);
}

const preset = JSON.parse(fs.readFileSync(srcPath, 'utf8'));
const report = [];
const log = (s) => { report.push(s); console.log(s); };

/* ------------------------------------------------------------------ 工具 */

const clone = (v) => JSON.parse(JSON.stringify(v));
const prompts = preset.prompts ?? [];
const order0 = preset.prompt_order ?? [];
const orderEntries = order0[0]?.order ?? [];
const byId = new Map(prompts.map((p) => [p.identifier, p]));

const nameOf = (id) => byId.get(id)?.name ?? id;

/* ------------------------------------------------- 1) 正则修复 */

const regexes = preset.extensions?.regex_scripts ?? [];
let regexFixed = 0;
const newRegexes = [];

for (const r of regexes) {
  const copy = clone(r);

  // 1a. 转述输入：findRegex 无捕获组却引用 $2 → 补捕获组并把 $2 改成 $1
  if (String(copy.scriptName).includes('转述输入')) {
    if (copy.findRegex === '[\\s\\S]*' || copy.findRegex === '[\\s\\S]*') {
      copy.findRegex = '([\\s\\S]*)';
      regexFixed++;
      log(`  · 正则「${r.scriptName}」：findRegex 补上捕获组 [\\s\\S]* → ([\\s\\S]*)`);
    }
    if (typeof copy.replaceString === 'string' && copy.replaceString.includes('[$2]')) {
      copy.replaceString = copy.replaceString.replace(/\[\$2\]/g, '[$1]');
      regexFixed++;
      log('  · 正则「转述输入」：replaceString 里的 [$2] → [$1]（原来永远解析不出内容）');
    }
    // 把"只申报事实"的要求写进每轮指令 —— 与扩展生成的 {{tablePrompt}} 同向
    if (typeof copy.replaceString === 'string' && !copy.replaceString.includes('只申报')) {
      copy.replaceString = copy.replaceString.replace(
        '</Request>',
        '【表格数据写法】：输出 <data> 时**只申报「谁对谁做了什么、值变成多少」**，不要自己算行号列号 —— 插件会自动定位到正确的行与列，名字写错一两个字也能兜住。具体标签与字段见表格操作指南。\n</Request>',
      );
      regexFixed++;
      log('  · 正则「转述输入」：补上「只申报事实」的要求（不再让 AI 自己算行号列号）');
    }
  }

  // 1b. markdownOnly 与 promptOnly 同时为 true —— ST 里是矛盾语义，拆成两条
  if (copy.markdownOnly === true && copy.promptOnly === true) {
    const hideOnly = { ...clone(copy), scriptName: `${copy.scriptName}（仅隐藏显示）`, markdownOnly: true, promptOnly: false };
    const stripOnly = { ...clone(copy), scriptName: `${copy.scriptName}（仅从提示词剔除）`, markdownOnly: false, promptOnly: true };
    newRegexes.push(hideOnly, stripOnly);
    regexFixed++;
    log(`  · 正则「${r.scriptName}」：markdownOnly 与 promptOnly 同时为 true（语义冲突）→ 拆成「仅隐藏显示」+「仅从提示词剔除」两条`);
    continue;
  }
  newRegexes.push(copy);
}
if (preset.extensions) preset.extensions.regex_scripts = newRegexes;

/* ------------------------------------------------- 2) 孤儿 prompt */

const inOrder = new Set(orderEntries.map((e) => e.identifier));
const orphans = prompts.filter((p) => !inOrder.has(p.identifier));
const droppedOrphans = [];

for (const o of orphans) {
  const len = (o.content ?? '').length;
  if (o.identifier === '89cdee4c-2546-439f-9c53-1393726139e0' || len > 4000) {
    droppedOrphans.push(`${o.name}（${len} 字，与本体无关）`);
    log(`  · 删除孤儿 prompt「${o.name}」（${len} 字：与世界观无关的残留文本）`);
  } else if (String(o.name).includes('文风')) {
    log(`  · 孤儿 prompt「${o.name}」（${len} 字）：内容已并入「🎬 叙事与输出排版」，原条目删除`);
    const target = byId.get('a7477399-86cb-4ce5-9004-bfe6a39d5fc9');
    if (target && !String(target.content).includes('【文风】')) {
      target.content = `${String(target.content).trim()}\n\n【文风】\n${String(o.content).trim()}`;
    }
    droppedOrphans.push(`${o.name}（并入叙事排版）`);
  } else {
    log(`  · 孤儿 prompt「${o.name}」（${len} 字）未处理 —— 请人工确认是否要挂进顺序`);
  }
}

const keptOrphanIds = new Set();
for (const o of orphans) {
  if (droppedOrphans.some((d) => d.startsWith(o.name))) keptOrphanIds.add(o.identifier);
}
preset.prompts = prompts.filter((p) => !keptOrphanIds.has(p.identifier));
if (droppedOrphans.length) {
  log(`  · 共删除 ${keptOrphanIds.size} 条无效 prompt`);
}

/* ------------------------------------------------- 3) enabled 双标 */

let enabledFixed = 0;
for (const e of orderEntries) {
  const p = byId.get(e.identifier);
  if (!p) continue;
  // prompt_order 才是实际生效的；把 prompts 数组里的值对齐过去，消除"界面显示关、实际在发"
  if (p.enabled !== undefined && p.enabled !== e.enabled) {
    log(`  · enabled 双标修正：「${p.name}」数组里 ${p.enabled} / 顺序里 ${e.enabled} → 统一为 ${e.enabled}`);
    p.enabled = e.enabled;
    enabledFixed++;
  }
}

/* ------------------------------------------------- 4) 首条乱码 prompt */

const GARBLED = '6e8f29a5-08a6-48e9-9fdf-ebaf91b3cadf';
const garbled = byId.get(GARBLED);
if (garbled) {
  const content = String(garbled.content ?? '');
  const susp = (content.match(/\{\{roll/g) ?? []).length;
  if (susp >= 2) {
    log(`  · 删除首条乱码 prompt「${garbled.name}」（含 ${susp} 个 roll 宏，内容是噪声）`);
    preset.prompts = preset.prompts.filter((p) => p.identifier !== GARBLED);
    // 从顺序里也去掉
    for (let i = orderEntries.length - 1; i >= 0; i--) {
      if (orderEntries[i].identifier === GARBLED) orderEntries.splice(i, 1);
    }
  }
}

/* ------------------------------------------------- 5) 抽出世界书 */

const lb = preset.extensions?.preset_lorebook;
let worldbookFile = null;
if (lb?.data?.entries && Object.keys(lb.data.entries).length > 0) {
  const count = Object.keys(lb.data.entries).length;
  worldbookFile = {
    name: lb.name ?? 'RBQ世界书',
    // 用 ST 世界书导出的标准结构
    entries: clone(lb.data.entries),
  };
  delete preset.extensions.preset_lorebook;
  log(`  · 内嵌世界书「${lb.name}」共 ${count} 条 → 抽出为独立文件 ${path.basename(outDir)}/RBQ世界书.json（预设体积大幅下降）`);
}

/* ------------------------------------------------- 6) 重排为 8 个区块 */

const BLOCKS = [
  ['① 系统身份与铁律', ['de8dc549-77c2-4607-8ac9-6f6ad2d11b8e', 'main']],
  ['② 世界与角色（占位区）', ['worldInfoBefore', 'personaDescription', 'charDescription', 'charPersonality', 'scenario', 'worldInfoAfter', 'dialogueExamples']],
  ['③ 扮演与叙事规则', ['b40bb2b8-69ef-46fb-ac61-583f552a3fd5', '1fbccdd2-e23d-4d56-9043-6a475b495d12', 'c4320250-ef14-4a63-ad7f-4a36043329ef', 'a7477399-86cb-4ce5-9004-bfe6a39d5fc9']],
  ['④ 内容分级与渲染', ['a3b33548-8d3b-4bb6-ad17-cfbda6414304']],
  ['⑤ 运行时数据（表格）', ['d92cf46f-491d-47c1-afff-9de19f3e9465', 'nsfw']],
  ['⑥ 输出协议与思维链', ['9e004602-06c7-4cc5-872f-53b69d541ebb', '4f4f09c8-b9de-47de-99af-fe06d9b8f43f', '3271160a-0c4a-49de-9c4c-12507d50f78d', 'a9bf0863-799a-4ba0-949c-0965576e8cb5', '4778ce2c-82d0-4986-b61c-9d85ff9a52d9']],
  ['⑦ 记忆与历史', ['enhanceDefinitions', '710ced61-9043-457a-aba0-283130d47f51', 'chatHistory', '344e3ce8-beda-4490-b52a-4b1e795b99b4', '9a849c38-2dcc-49b7-ba8c-deae7b079a79', '8ba68e1d-a4ab-4eca-b1de-81e43b7e1632']],
  ['⑧ 越狱与收尾', ['jailbreak', '4617e014-e131-47d0-9c7a-c654af61e39c', '3b14c0f4-8016-4d4f-9f7f-1f1baa23c5c8', '0f35c03b-26fd-43f1-bed6-87948ee412ff', '84046c9f-0c03-46b8-86c8-c067ff3086fb', '4b8389e6-a502-494e-a763-96451c0b997e']],
];

const enabledMap = new Map(orderEntries.map((e) => [e.identifier, e.enabled]));
const inOrderNow = new Set(orderEntries.map((e) => e.identifier));
const validIds = new Set(preset.prompts.map((p) => p.identifier));

const newOrder = [];
const placed = new Set();
for (const [blockName, ids] of BLOCKS) {
  let n = 0;
  for (const id of ids) {
    if (!validIds.has(id) || !inOrderNow.has(id) || placed.has(id)) continue;
    newOrder.push({ identifier: id, enabled: enabledMap.get(id) ?? true });
    placed.add(id);
    n++;
  }
  report.push(`  · 区块${blockName}：${n} 条`);
}
// 没被区块收进去的，按原顺序追加（避免丢东西）
for (const e of orderEntries) {
  if (placed.has(e.identifier) || !validIds.has(e.identifier)) continue;
  newOrder.push({ identifier: e.identifier, enabled: e.enabled ?? true });
  placed.add(e.identifier);
}
const dropped = orderEntries.filter((e) => !validIds.has(e.identifier));
if (dropped.length) report.push(`  · 顺序里有 ${dropped.length} 条悬空引用（对应 prompt 已删除），已清理`);

preset.prompt_order = [{ character_id: order0[0]?.character_id ?? 100001, order: newOrder }];

/* --------------------------------------------------------- 7) 顺带清理 */

// 7a. 从预设里移除远程 eval 的两个 loader（安全 + 行为一致性）
const th = preset.extensions?.tavern_helper;
if (th?.scripts?.length) {
  const loaders = th.scripts.filter((s) => /fetch\s*\(|eval\s*\(/.test(String(s.content ?? '')));
  if (loaders.length) {
    th.scripts = th.scripts.filter((s) => !loaders.includes(s));
    log(`  · 从预设里移除 ${loaders.length} 个远程加载脚本（fetch+eval，存在安全隐患）：${loaders.map((s) => s.name).join('、')}`);
    log('    → 请改在酒馆助手的全局脚本库里管理它们');
  }
}

/* ---------------------------------------------------------------- 输出 */

fs.mkdirSync(outDir, { recursive: true });
const outPreset = path.join(outDir, 'rbq-preset-optimized.json');
fs.writeFileSync(outPreset, JSON.stringify(preset, null, 2), 'utf8');

if (worldbookFile) {
  const outWb = path.join(outDir, 'RBQ世界书.json');
  fs.writeFileSync(outWb, JSON.stringify(worldbookFile, null, 2), 'utf8');
}

const srcSize = fs.statSync(srcPath).size;
const outSize = fs.statSync(outPreset).size;
const summary = [
  '# 预设重构报告',
  '',
  `原文件：${path.basename(srcPath)}（${(srcSize / 1024).toFixed(0)} KB）`,
  `新文件：${path.basename(outPreset)}（${(outSize / 1024).toFixed(0)} KB，${(((srcSize - outSize) / srcSize) * 100).toFixed(0)}% 减小）`,
  '',
  `- prompt 条数：${prompts.length} → ${preset.prompts.length}`,
  `- 顺序条数：${orderEntries.length} → ${newOrder.length}`,
  `- 正则条数：${regexes.length} → ${newRegexes.length}（修/拆 ${regexFixed} 处）`,
  `- enabled 双标修正：${enabledFixed} 处`,
  `- 删除孤儿 prompt：${keptOrphanIds.size} 条`,
  `- 世界书：${worldbookFile ? `已抽出 ${Object.keys(worldbookFile.entries).length} 条` : '无'}`,
  '',
  '## 改动明细',
  ...report,
  '',
  '## 重排后的区块',
  ...BLOCKS.map(([n, ids]) => `- ${n}：${ids.filter((i) => newOrder.some((o) => o.identifier === i)).map(nameOf).join('、') || '（空）'}`),
  '',
  '## 安装',
  '1. 用 `rbq-preset-optimized.json` 替换你在酒馆里的预设（先在预设界面导出备份）。',
  '2. 把 `RBQ世界书.json` 导入成一本独立世界书，并在角色卡/聊天里绑定它。',
  '3. 确认 RBQ 数据库扩展已启用（它提供 `{{tablePrompt}}` / `{{tableData}}` / `{{GET_ALL_TABLES_JSON}}` 三个宏）。',
].join('\n');

fs.writeFileSync(path.join(outDir, '预设重构报告.md'), summary, 'utf8');

/* --------------------------------------------------------- 8) 自校验 */

const check = JSON.parse(fs.readFileSync(outPreset, 'utf8'));
const problems = [];
const ids = new Set((check.prompts ?? []).map((p) => p.identifier));
for (const ord of check.prompt_order ?? []) {
  for (const e of ord.order ?? []) {
    if (!ids.has(e.identifier)) problems.push(`顺序里的 ${e.identifier} 找不到对应 prompt`);
  }
}
const toolUsed = JSON.stringify(check).match(/\{\{(tablePrompt|tableData|GET_ALL_TABLES_JSON)\}\}/g) ?? [];
if (!toolUsed.length) problems.push('预设里再也找不到表格宏引用 —— 表格数据将不会注入');
const tr = (check.extensions?.regex_scripts ?? []).find((r) => String(r.scriptName).includes('转述输入'));
if (!tr) problems.push('找不到「转述输入」正则');
else {
  if (!/\(\[\\s\\S\]\*\)/.test(tr.findRegex) && tr.findRegex !== '([\\s\\S]*)') problems.push(`转述输入 findRegex 仍无捕获组：${tr.findRegex}`);
  if (tr.replaceString.includes('$2')) problems.push('转述输入仍在引用 $2');
}
if (check.extensions?.preset_lorebook) problems.push('内嵌世界书仍然存在（应已抽出）');

console.log('\n自校验：' + (problems.length ? `${problems.length} 个问题` : '全部通过 ✅'));
for (const p of problems) console.log(`  ✗ ${p}`);
console.log(`  · 预设内表格宏引用：${[...new Set(toolUsed)].join(' ')}`);
console.log(`  · 世界书条数：${worldbookFile ? Object.keys(worldbookFile.entries).length : 0}`);
if (problems.length) process.exitCode = 1;
console.log(`\n已输出：\n  ${outPreset}\n${worldbookFile ? `  ${path.join(outDir, 'RBQ世界书.json')}\n` : ''}  ${path.join(outDir, '预设重构报告.md')}`);
