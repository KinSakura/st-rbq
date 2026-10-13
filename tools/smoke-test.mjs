/**
 * smoke-test.mjs —— 在 Node 里用假 SillyTavern 上下文验证核心层
 *
 * 本机没有装酒馆，所以这是唯一能在交付前验证逻辑的手段。
 * 覆盖：schema / 列解析 / 两种协议解析 / JSON 容错 / 事务 / 模糊匹配 / 单例表 /
 *       数值增减 / 部分失败 / 导出导入往返 / 撤销回滚 / 锚点。
 *
 * 用法：node tools/smoke-test.mjs
 */

/* --------------------------------------------------- 假 SillyTavern 上下文 */

function makeFakeST() {
  const chat = [
    { is_user: true, mes: '我推开门。', name: '玩家', message_id: 0 },
    { is_user: false, mes: '（开头）\n\n<data>\n</data>', name: '零', message_id: 1 },
  ];
  const ctx = {
    chat,
    chatMetadata: {},
    extensionSettings: {},
    eventSource: { on() {}, off() {} },
    eventTypes: { MESSAGE_RECEIVED: 'message_received', GENERATION_ENDED: 'generation_ended' },
    getCurrentChatId: () => 'smoke-chat',
    saveChat: async () => {},
    saveSettingsDebounced: () => {},
    registerMacro: () => {},
    getContext() { return this; },
  };
  return ctx;
}

const fakeCtx = makeFakeST();
globalThis.window = {
  SillyTavern: { getContext: () => fakeCtx },
  toastr: { info() {}, success() {}, warning() {}, error() {} },
};
globalThis.document = undefined;   // 明确：Node 环境无 DOM

/* --------------------------------------------------------------- 断言工具 */

let pass = 0;
const failures = [];
const QUIET = process.argv.includes('--quiet');
function check(name, fn) {
  try {
    const r = fn();
    if (r === false) throw new Error('断言返回 false');
    pass++;
    if (!QUIET) console.log(`  ✓ ${name}`);
  } catch (e) {
    failures.push({ name, error: e?.message ?? String(e) });
    console.log(`  ✗ ${name}\n      ${e?.message ?? e}`);
  }
}
function eq(a, b, msg = '') {
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(`${msg} 期望 ${sb}，实际 ${sa}`);
}
function ok(v, msg = '') {
  if (!v) throw new Error(msg || '期望为真');
}

/* ------------------------------------------------------------------ 主流程 */

const { default: schema } = await import('../data/default-schema.js');
const S = await import('../core/schema.js');
const P = await import('../core/protocol.js');
const T = await import('../core/txn.js');
const St = await import('../core/store.js');
const M = await import('../core/match.js');

console.log('\n=== 1. schema ===');
/** 用列名取下标，避免测试里写死数字（写死过一次，反而误判了正确代码） */
const col = (no, name) => {
  const r = S.resolveColumn(no, name);
  if (!r) throw new Error(`列「${name}」不存在于表${no}`);
  return r.index;
};
check('15 张表 / 206 列', () => {
  eq(S.getTables().length, 15);
  eq(S.getTables().reduce((n, t) => n + t.columns.length, 0), 206);   // 表3 新增「容貌描述」→ 205 + 1
});
check('单例表 = 表0 与表6', () => {
  ok(S.isSingleton(0) && S.isSingleton(6) && !S.isSingleton(2));
});
check('表名反查表号', () => {
  eq(S.getTable('角色静态档案表').no, 2);
  eq(S.getTableNo('怪物与临时实体属性表'), 14);
});
check('列名解析：精确 / 归一化 / 下标', () => {
  eq(S.resolveColumn(2, '种族').index, 2);
  eq(S.resolveColumn(2, '种族 ').index, 2);
  eq(S.resolveColumn(2, 2).index, 2);
  eq(S.resolveColumn(2, '不存在的列'), null);
});
check('rbq.js 的别名与 schema 列一一对应', () => {
  // race/job/level 在 TABLE_COL 里分别是 2/3/4
  eq(P.resolveAttr(2, 'race').index, 2);
  eq(P.resolveAttr(2, 'job').index, 3);
  eq(P.resolveAttr(2, 'level').index, 4);
  /* 表3 在「三围」后插了「容貌描述」→ 之后的列下标全部 +1 ✓
     （名器：18 → 19 ✓ 这一课就叫"插列必须同步别名表" ✓） */
  eq(P.resolveAttr(3, 'meiki').index, 19);
  eq(P.resolveAttr(3, 'looks').index, 5, '容貌别名应指向新列：');
  eq(P.resolveAttr(3, '容貌').index, 5, '中文「容貌」也要认：');
  eq(P.resolveAttr(13, 'hp').index, 1);
});

console.log('\n=== 2. 别名表（自 rbq.js 提取，205 条）===');
check('中文列名也认', () => {
  eq(P.resolveAttr(2, '种族').index, 2);
});
check('拼错也能兜住（race → raec）', () => {
  const r = P.resolveAttr(2, 'raec');
  ok(r && r.index === 2, `实际 ${JSON.stringify(r)}`);
});

console.log('\n=== 3. JSON 容错（痛点②的解析基础）===');
check('严格 JSON', () => {
  eq(P.parseLooseObject('{"a":1}').value, { a: 1 });
});
check('单引号 + 尾逗号 + 裸键', () => {
  const r = P.parseLooseObject("{'种族':'人类', 年龄:28,}");
  eq(r.value['种族'], '人类');
  eq(r.value['年龄'], 28);
});
check('智能引号', () => {
  const r = P.parseLooseObject('{“种族”:“精灵”}');
  eq(r.value['种族'], '精灵');
});
check('中文裸键', () => {
  const r = P.parseLooseObject('{种族:"矮人", 性别:"女"}');
  eq(r.value['种族'], '矮人');
});
check('无键值对（只给值）自动分配数字键', () => {
  const r = P.parseLooseObject('{"甲","乙"}');
  eq(r.value, { 0: '甲', 1: '乙' });
});

console.log('\n=== 5. 新协议 <data> 事实申报 ===');
const FACT_SAMPLE = `<data>
  <world time="星历182年05月21日-周三-09:30" weather="暴风雪/零下25℃" location="深渊边界旧哨所" atmosphere="高危区"/>
  <present chars="左玄" />
  <character name="左玄" mode="new" race="人类" job="银月骑士团先锋" level="Lv.45" age="28"/>
  <physique name="左玄" gender="男" height="182" weight="78"/>
  <state name="左玄" coord="门边" head="无" outerUpper="深蓝斗篷"/>
  <status name="左玄" hp="120" maxHp="180" sp="80" maxSp="100"/>
  <monster name="暗影狼" mode="new" level="Lv.12" status="active"/>
</data>`;
check('解析出事实', () => {
  const r = P.parseDataFacts(FACT_SAMPLE);
  eq(r.facts.length, 7);
  eq(r.unknownTags.length, 0);
});
check('事实 → ops', () => {
  const r = P.parseDataFacts(FACT_SAMPLE);
  const m = P.factsToOps(r.facts);
  ok(m.ops.length >= 6, `ops=${m.ops.length}`);
  eq(m.warnings.length, 0, '不应有列解析警告：');
});
check('未知标签被记录而不是崩掉', () => {
  const r = P.parseDataFacts('<data><怪东西 name="x"/></data>');
  eq(r.unknownTags, ['怪东西']);
});

console.log('\n=== 6. 事务：写入 / 幂等 / 模糊匹配 ===');
await St.getData();   // 初始化

{
  const r = P.parseDataFacts(FACT_SAMPLE);
  const m = P.factsToOps(r.facts);
  const res = await T.applyOps(m.ops, { persist: false, messageIndex: 1 });
  check('写入成功且无失败项', () => {
    eq(res.failed, []);
    ok(res.applied > 0);
  });
  check('角色落进表2 且列位置正确', () => {
    const rows = St.getRows(2, { create: false });
    eq(rows.length, 1);
    eq(rows[0][col(2, '角色名称')], '左玄');
    eq(rows[0][col(2, '种族')], '人类');
    eq(rows[0][col(2, '公开身份/职业')], '银月骑士团先锋');
    eq(rows[0][col(2, '等级')], 'Lv.45');
  });
  check('数值表落进表13，hp 在第 1 列', () => {
    const rows = St.getRows(13, { create: false });
    eq(rows.length, 1);
    eq(rows[0][col(13, 'HP(当前)')], '120');
    eq(rows[0][col(13, 'HP(上限)')], '180');
  });
  check('单例表（表0）只有一行，多个元素并入', () => {
    const rows = St.getRows(0, { create: false });
    eq(rows.length, 1);
    eq(rows[0][col(0, '时空坐标')], '星历182年05月21日-周三-09:30');
    eq(rows[0][col(0, '在场实体名单')], '左玄');
  });
  check('怪物落进表14', () => {
    eq(St.getRows(14, { create: false }).length, 1);
  });
}

{
  // 幂等：同样的事实再来一遍，行数不应增加
  const r = P.parseDataFacts(FACT_SAMPLE);
  const m = P.factsToOps(r.facts);
  await T.applyOps(m.ops, { persist: false, messageIndex: 1 });
  check('重复应用不产生重复行（upsert 幂等）', () => {
    eq(St.getRows(2, { create: false }).length, 1);
    eq(St.getRows(13, { create: false }).length, 1);
    eq(St.getRows(0, { create: false }).length, 1);
  });
}

{
  // 模糊匹配：名字写错一个字
  const res = await T.applyOps([{ op: 'update', table: '角色静态档案表', row: '左炫', values: { 等级: 'Lv.46' } }], { persist: false, messageIndex: 1 });
  check('名字错一个字也能定位到（模糊匹配）', () => {
    eq(res.failed, []);
    eq(St.getRows(2, { create: false })[0][col(2, '等级')], 'Lv.46');
  });
}

console.log('\n=== 7. 事务：数值增减 / 部分失败 / 撤销 ===');
{
  const before = St.getRows(13, { create: false })[0][col(13, 'HP(当前)')];
  const res = await T.applyOps([{ op: 'delta', table: 13, row: '左玄', col: 'hp', by: -30 }], { persist: false, messageIndex: 1 });
  check('delta 正确扣血', () => {
    eq(res.failed, []);
    eq(St.getRows(13, { create: false })[0][col(13, 'HP(当前)')], String(Number(before) - 30));
  });
}
{
  // 事实申报里的数值增减形式
  const before = Number(St.getRows(13, { create: false })[0][col(13, 'HP(当前)')]);
  const facts = P.parseDataFacts('<data><status name="左玄" field="hp" change="-15" reason="左肩中刃"/></data>').facts;
  const res = await T.applyOps(P.factsToOps(facts).ops, { persist: false, messageIndex: 1 });
  check('<status field="hp" change="-15"> 走 delta', () => {
    eq(res.failed, []);
    eq(St.getRows(13, { create: false })[0][col(13, 'HP(当前)')], String(before - 15));
  });
}
{
  const revBefore = St.getRev();
  const res = await T.applyOps([
    { op: 'update', table: 2, row: '左玄', values: { 核心性格: '冷静' } },
    { op: 'update', table: 2, row: '左玄', values: { 不存在的列: 'x' } },
  ], { persist: false, messageIndex: 1 });
  check('部分失败：好的写进去、坏的报出来', () => {
    ok(res.applied === 1, `applied=${res.applied}`);
    eq(res.failed.length, 1);
    eq(res.failed[0].reason, 'unknown-column');
    eq(St.getRows(2, { create: false })[0][col(2, '核心性格')], '冷静');
    ok(St.getRev() > revBefore);
  });
  check('回滚到上一版', async () => {
    const rb = await T.rollbackTo(revBefore);
    ok(rb.ok, JSON.stringify(rb));
    eq(St.getRows(2, { create: false })[0][col(2, '核心性格')], '');
  });
}

check('更新判定：版本比较正确 + status 暴露入口/缓存字段 + 有强制清缓存', async () => {
  const u = await import('../core/updater.js');
  eq(u.isNewer('2.11.0', '2.10.9'), true, '2.11.0 应比 2.10.9 新：');
  eq(u.isNewer('2.9.7', '2.11.0'), false, '2.9.7 不该被认为比 2.11.0 新：');
  eq(u.isNewer('2.11.0', '2.11.0'), false, '同版本不算新：');
  eq(u.parseVersion('v2.11.0').join('.'), '2.11.0', 'parseVersion 要能去掉 v：');
  ok(typeof u.forceRefresh === 'function', '应有 forceRefresh（清 CDN 缓存后重查）');
  ok(typeof u.purgeCache === 'function', '应有 purgeCache');
  const st = u.status();
  for (const k of ['entryDiff', 'remoteOlder', 'remoteEntry', 'localEntry', 'purged']) ok(k in st, 'status 应暴露 ' + k);
  ok(Array.isArray(u.fallbackSources()) && u.fallbackSources().length >= 3, '多源兜底至少 3 个源');
});

check('别名下标绝不错位（插列后必须同步别名表）', async () => {
  const A = (await import('../data/aliases.js')).default;
  const S = await import('../core/schema.js');
  let over = 0;
  for (const [no, block] of Object.entries(A.tableAliases || {})) {
    const n = S.getColumns(Number(no)).length;
    for (const [k, i] of Object.entries(block.aliasToIndex || {})) { if (Number(i) >= n) { over++; if (over < 4) console.log('      越界：表' + no + ' ' + k + ' → ' + i + '（共 ' + n + ' 列）'); } }
  }
  eq(over, 0, '所有别名下标都必须在列数范围内：');
  /* 哨兵：容易因为插列而错位的几个 ✓ */
  const m3 = A.tableAliases['3'].aliasToIndex;
  const c3 = S.getColumns(3);
  for (const [k, want] of [['meiki', '名器类型'], ['looks', '容貌描述'], ['measures', '三围'], ['overallFigure', '整体体型'], ['chest', '胸部']]) {
    eq(c3[m3[k]], want, '表3 别名 ' + k + ' 应指向：');
  }
});

check('写库计数器：applyOps 会让它涨，重试靠它避免重复写入', async () => {
  const fz = await import('../core/freeze.js');
  const T = await import('../core/txn.js');
  const St = await import('../core/store.js');
  ok(typeof fz.getWriteCount === 'function' && typeof fz.bumpWriteCount === 'function', 'freeze.js 应导出写库计数器');
  const n0 = fz.getWriteCount();
  await T.applyOps([{ op: 'upsert', table: 2, values: { 角色名称: '计数器测试' } }], { source: 'test' });
  ok(fz.getWriteCount() > n0, 'applyOps 之后计数应增加：' + n0 + ' → ' + fz.getWriteCount());
  await St.clearAllTables();
});

console.log('\n=== 8. 导出格式（必须与记忆增强表格插件逐字节兼容）===');
check('导出结构 = {sheet_N:{uid,name,content}}', () => {
  const j = St.exportPluginJson();
  const s2 = j.sheet_2;
  ok(s2, '缺少 sheet_2');
  eq(s2.name, '角色静态档案表');
  ok(Array.isArray(s2.content));
  eq(s2.content[0].length, 16, 'content[0] 应有前导标签列 + 15 列');
  eq(s2.content[0][0], '');
  eq(s2.content[0][1], '角色名称');
  eq(s2.content[1][0], '');
  eq(s2.content[1][1], '左玄');
  eq(s2.uid, 'sheet_2');
});
check('15 张表全部导出', () => {
  eq(Object.keys(St.exportPluginJson()).length, 15);
});
check('导出→导入→再导出 完全一致', () => {
  const r = St.roundTripCheck();
  ok(r.ok, '往返不一致');
});

console.log('\n=== 9. 锚点与统计 ===');
// 先做一次真实写入 —— 前面的回滚测试会把锚点清掉，这是正确行为
{
  const facts = P.parseDataFacts('<data><character name="慕容雪" race="精灵" level="Lv.40"/></data>').facts;
  await T.applyOps(P.factsToOps(facts).ops, { persist: false, messageIndex: 1 });
}
check('锚点写在 AI 消息上', () => {
  const latest = St.findLatestAnchor();
  ok(latest.index >= 0, '没有找到锚点');
  ok(latest.anchor.rev > 0);
  ok(latest.anchor.hash);
  eq(fakeCtx.chat[1].rbqdb_anchor.rev, latest.anchor.rev);
});
check('锚点带撤销数据（可回滚）', () => {
  const latest = St.findLatestAnchor();
  ok(latest.anchor.undo && Object.keys(latest.anchor.undo).length > 0);
});
check('统计信息可用', () => {
  const s = St.stats();
  ok(s.tableCount === 15);
  ok(s.rev > 0);
  ok(s.rowTotal > 0, 'rowTotal 应大于 0');
});

console.log('\n=== 10. 边界与防御 ===');
check('表不存在 → unknown-table', () => {
  const r = T.resolveOp({ op: 'update', table: '不存在的表', row: 'x', values: { a: 1 } });
  eq(r.reason, 'unknown-table');
});
check('行找不到 → row-not-found', () => {
  const r = T.resolveOp({ op: 'update', table: 2, row: '查无此人', values: { 种族: '人类' } });
  eq(r.reason, 'row-not-found');
});
check('缺 values → missing-values', () => {
  const r = T.resolveOp({ op: 'update', table: 2, row: '左玄' });
  eq(r.reason, 'missing-values');
});
check('未知操作 → unknown-op', () => {
  const r = T.resolveOp({ op: 'destroy', table: 2 });
  eq(r.reason, 'unknown-op');
});
check('空/垃圾输入不抛异常', () => {
  P.parseAll('');
  P.parseAll(null);
  P.parseAll('<data>完全不是 XML');
  eq(P.parseAll('<data></data>').ops.length, 0);
});
check('dry-run 不写数据', async () => {
  const rev = St.getRev();
  const res = await T.applyOps([{ op: 'update', table: 2, row: '左玄', values: { 种族: '恶魔' } }], { dryRun: true });
  eq(St.getRev(), rev);
  ok(res.applied === 1);
  eq(St.getRows(2, { create: false })[0][col(2, '种族')], '人类');
});

/* ------------------------------------------------------------------ 正文清洗
   用户实测：发给侧路 API 的"正文"里混着思考块/小总结（预设产出的标签 ✗）
   要求：只留真正的剧情，其余整块丢掉（含**未闭合**的思考块 ✗） */
await check('正文清洗：思考块 / 小总结 / <data> / 未闭合块 全部丢掉', async () => {
  const prose = await import('../core/prose.js');
  const sample = [
    '<thinking_matrix>',
    '【协议一】请求解析：玩家想推门。',
    '</thinking_matrix>',
    '',
    '雨丝斜斜地打在酒馆的窗玻璃上。',
    '她把杯子放下，抬眼看向门口。',
    '',
    '<data_reasoning>',
    '她应该偏冷淡，但台词要短。',
    '</data_reasoning>',
    '',
    '<data>',
    '<world 时空坐标="雨夜" 绝对位置名称="歪脖渡鸦酒馆"/>',
    '</data>',
    '',
    '<This_round_events>',
    '- 玩家推门进入酒馆。',
    '</This_round_events>',
    '',
    '<thinking_matrix>',
    '这段没闭合的思考以前会整段混进正文 ✗',
  ].join('\n');
  const out = prose.extractProse(sample);
  ok(out.includes('雨丝斜斜地') && out.includes('她把杯子放下'), '剧情正文被误删了：' + out.slice(0, 80));
  for (const bad of ['thinking_matrix', 'data_reasoning', 'This_round_events', '协议一', '小总结', '歪脖渡鸦酒馆', '没闭合的思考']) {
    ok(!out.includes(bad), '正文里还残留「' + bad + '」：' + out.slice(0, 120));
  }
});


/* ------------------------------------------------- 预设位置标记（🔒↓ / 🔒↑）
   规则：预设提示词**名字**含 🔒↓ → 拼到侧路提示词【上面】；含 🔒↑ → 拼到【下面】✓
   用户明确了语义（位置标记，不是包一层 ✓），所以用纯逻辑单测锁住 ✓ */
await check('预设位置标记：🔒↓ 放上面 / 🔒↑ 放下面', async () => {
  const sp = await import('../core/sidePipeline.js');
  const fake = [
    { name: '🔒↓口径', content: '只写真实发生的事实。', enabled: true },
    { name: '🔒↓用词', content: '用词克制。', enabled: true },
    { name: '🔒↑格式', content: '只输出 data 标签。', enabled: true },
    { name: '普通提示词', content: '这条不该被带上', enabled: true },
    { name: '🔒↓被关掉的', content: '这条也不该带上', enabled: false },
  ];
  const b = sp.presetMarkedBlocks(fake);
  eq(b.above, '只写真实发生的事实。\n\n用词克制。', '上面那段不对：');
  eq(b.below, '只输出 data 标签。', '下面那段不对：');
  const out = sp.withPresetBlocks('【本体】', fake);
  ok(out.indexOf('只写真实发生的事实') < out.indexOf('【本体】'), '本体应排在"上面"的内容之后');
  ok(out.indexOf('【本体】') < out.indexOf('只输出 data 标签'), '“下面”的内容应排在本体之后');
  ok(!out.includes('这条不该被带上') && !out.includes('这条也不该带上'), '不该带上"没标记"或"被关掉"的提示词');
});

await check('预设标记的顺序：同名标记按预设顺序，↑/↓ 交错也各归各位', async () => {
  const sp = await import('../core/sidePipeline.js');
  const fake = [
    { name: '🔒↑甲的下面', content: 'B1', enabled: true },
    { name: '🔒↓甲在上面', content: 'A1', enabled: true },
    { name: '🔒↑乙的下面', content: 'B2', enabled: true },
    { name: '🔒↓乙在上面', content: 'A2', enabled: true },
    { name: '🔒↓丙在上面', content: 'A3', enabled: true },
  ];
  const b = sp.presetMarkedBlocks(fake);
  eq(b.above, ['A1', 'A2', 'A3'].join('\n\n'), '上面的顺序应按预设出现顺序：');
  eq(b.below, ['B1', 'B2'].join('\n\n'), '下面的顺序应按预设出现顺序：');
  const out = sp.withPresetBlocks('【本体】', fake);
  ok(out.indexOf('A3') < out.indexOf('【本体】'), '所有放上面的都在本体之前');
  ok(out.indexOf('【本体】') < out.indexOf('B1'), '所有放下面的都在本体之后');
});

await check('预设标记：order 里有信息但查不到这条 → 按开着（🔒 是明确意愿）', async () => {
  const sp = await import('../core/sidePipeline.js');
  const list = [
    { identifier: 'x', name: '🔒↑ 标了但 order 里没有', content: '进来吧', enabled: false },
  ];
  const order = [{ character_id: '100001', order: [{ identifier: '别的', enabled: true }] }];
  const r = sp.presetMarkedBlocks(list, order);
  eq(r.below, '进来吧', 'order 没提到它时应视为开着：');
});

await check('侧路入口会再清洗一次正文（防调用方塞原始消息）', async () => {
  const sp = await import('../core/sidePipeline.js');
  const dirty = '<thinking_matrix>想</thinking_matrix>她推开窗。<This_round_events>事件</This_round_events><data>x</data>';
  const out = sp.fillPrompt(dirty, { tables: [], round: 1 });
  ok(!/thinking_matrix/i.test(out.split('正文：').pop() || out), '正文里不该再有 thinking_matrix ✗');
  ok(!/This_round_events/i.test(out.split('正文：').pop() || out), '正文里不该再有 This_round_events ✗');
  ok(out.includes('她推开窗'), '正文内容本身要保留 ✓');
});

await check('预设标记：开关以 prompt_order 为准（提示词自带的 enabled 可能过时）', async () => {
  const sp = await import('../core/sidePipeline.js');
  const list = [
    { identifier: 'a', name: '🔒↓ 甲', content: 'A', enabled: false },   // 自己写着关 ✗
    { identifier: 'b', name: '🔒↑ 乙', content: 'B', enabled: false },   // 自己写着关 ✗
    { identifier: 'c', name: '🔒↓ 丙', content: 'C', enabled: true },    // 自己写着开 ✓
  ];
  /* 真实开关：a 开着 ✓ b 关着 ✗ c 关着 ✗ —— 以这里为准 */
  const order = [{ character_id: '100001', order: [
    { identifier: 'a', enabled: true },
    { identifier: 'b', enabled: false },
    { identifier: 'c', enabled: false },
  ] }];
  const r = sp.presetMarkedBlocks(list, order);
  eq(r.above, 'A', '开着的那条要进来、关着的不要（以 prompt_order 为准）：');
  eq(r.below, '', '被 prompt_order 判为关的不该进来：');
  /* 没有任何 order 信息时 → 退回提示词自带的 enabled ✓ */
  const r2 = sp.presetMarkedBlocks(list, []);
  eq(r2.above, 'C', '没有 order 信息时退回自带的 enabled：');
});

await check('预设标记：不管预设写什么归属，一律当系统并进正文', async () => {
  const sp = await import('../core/sidePipeline.js');
  const fake = [
    { name: '没标记的', role: 'system', content: 'X', enabled: true },
    { name: '🔒↓ 填表口径', role: 'system', content: '【口径】只写事实。', enabled: true },
    { name: '🔒↓ 你是填表助手', role: 'assistant', content: '我只输出结构化数据。', enabled: true },
    { name: '🔒↑ 用户习惯', role: 'user', content: '（备注）我喜欢第三人称。', enabled: true },
    { name: '🔒↑ 收尾提醒', role: 'system', content: '【收尾】闭合标签。', enabled: true },
  ];
  const b = sp.presetMarkedBlocks(fake);
  /* 全部（含 AI 助手 / 用户 身份）都并进正文 ✓ */
  eq(b.above, '【口径】只写事实。\n\n我只输出结构化数据。', '上面那段应包含所有 ↓ 标记的（不分身份）：');
  eq(b.below, '（备注）我喜欢第三人称。\n\n【收尾】闭合标签。', '下面那段应包含所有 ↑ 标记的（不分身份）：');
  eq(sp.presetExtras(fake).length, 0, '不该再按身份拆出单独消息：');
  ok(!b.above.includes('X'), '没标记的不该被带上：');
});
await check('记忆注入的格式：带字段名 + 时间框 + 角色 + 轮次', async () => {
  const m = await import('../core/memory.js');
  const e = { round: 3, t: '『溟历纪314年10月17日 22:45 - 旧溟港 - 小雨 - 港区』', fields: { 感知: '闻到铁锈味', 情绪: '警惕', 意图: '先验封条', 记忆锚点: '灰色铅封箱' }, raw: '原始整段' };
  const s = m.line('苏越', e);
  ok(s.includes('【苏越｜第3轮｜『'), '开头应带角色名 + 轮次 + 时间框：' + s.slice(0, 40));
  ok(s.includes('【感知】闻到铁锈味'), '缺【感知】字段名：' + s);
  ok(s.includes('【情绪】警惕'), '缺【情绪】字段名');
  ok(s.includes('【意图】先验封条'), '缺【意图】字段名');
  ok(s.includes('【记忆锚点】灰色铅封箱'), '缺【记忆锚点】字段名');
  /* 没有字段的老数据 → 退回原始整段（不丢内容 ✓） */
  const old = m.line('甲', { round: 1, fields: {}, raw: '老格式的记忆' });
  ok(old.includes('老格式的记忆'), '没有字段时应退回原始文本');
});

await check('小总结落库：按轮次存一条 + 记录楼层 + 能按楼清掉', async () => {
  const s = await import('../core/summary.js');
  const NL = String.fromCharCode(10);
  s.clearAll();
  const msg = '<This_round_events>' + NL + '<history id="1" t="溟历纪314年" loc="旧溟港">' + NL + '【剧情压缩】：她推开门。' + NL + '</history>' + NL + '</This_round_events>';
  const r = s.maintain(msg, 5, 88);
  ok(r.small && r.small.found, '应该解析到小总结');
  const list = s.listEvents({ limit: 5 });
  eq(list.length, 1, '应存下 1 条：');
  eq(list[0].round, 5, '轮次应记对：');
  eq(String(list[0].msgId), '88', '应记下是哪一楼：');
  ok(String(list[0].text).includes('剧情压缩'), '应保存整段文本（含时间地点）：');
  /* 同一轮再写一次 → 覆盖，不新增 ✓ */
  s.maintain(msg, 5, 88);
  eq(s.listEvents({ limit: 5 }).length, 1, '同一轮应覆盖不新增：');
  /* 按楼清掉 ✓（回滚 / 删楼用 ✓） */
  eq(s.removeByMsgId(88), 1, '按楼应能删掉 1 条：');
  eq(s.listEvents({ limit: 5 }).length, 0, '删后应为空：');
  /* 注入文本 ✓ */
  s.maintain(msg, 6, 89);
  ok(s.recentText({ limit: 5 }).includes('最近几轮事件'), '应生成最近几轮事件文本');
  s.clearAll();
});

await check('侧路所有任务都要清洗正文（不只记忆）', async () => {
  const sp = await import('../core/sidePipeline.js');
  const NL = String.fromCharCode(10);
  const dirty = '<thinking_matrix>想</thinking_matrix>' + NL + '她推开窗。' + NL + '<This_round_events>事件</This_round_events>';
  /* 走进正文的提示词都要干净 ✓（extras 用公开的 preview() 取 ✓ 内部 builder 没导出 ✓） */
  for (const [name, fn] of [['fill', (t) => sp.fillPrompt(t, { round: 1 })], ['extras', (t) => sp.preview('extras', t, 1)]]) {
    const out = fn(dirty);
    ok(!/thinking_matrix/i.test(out), name + ' 的正文不该带 thinking_matrix ✗');
    ok(!/This_round_events/i.test(out), name + ' 的正文不该带 This_round_events ✗');
    ok(out.includes('她推开窗'), name + ' 应保留正文本身 ✓');
  }
});

await check('删中间楼层：只撤销那一层（含增行 / 删行 / 改格）', async () => {
  const dl = await import('../core/delta.js');
  const st = await import('../core/store.js');
  const snap = (rows) => JSON.stringify({ 2: { rows } });
  const R = (name, hp) => [name, hp, '备'];
  const cases = [
    ['纯删一行', [R('A', '10'), R('B', '20'), R('C', '30')], [R('A', '10'), R('C', '30')]],
    ['删一行 + 改两格', [R('A', '10'), R('B', '20'), R('C', '30')], [R('A', '15'), R('C', '35')]],
    ['最前插一行 + 改一格', [R('A', '10'), R('B', '20')], [R('Z', '99'), R('A', '15'), R('B', '20')]],
    ['删尾一行 + 改一格', [R('A', '10'), R('B', '20'), R('C', '30')], [R('A', '15'), R('B', '20')]],
  ];
  for (const [name, before, after] of cases) {
    /* 把库置为"这一层写完之后"的状态 → 再撤销这一层 → 应与 before 一致 ✓ */
    st.setRows(2, JSON.parse(JSON.stringify(after)));
    /* 前置断言：写进去了才算测到东西 ✓（以前没有这条 → 假 store 不支持时用例会"假过" ✗） */
    eq((st.getRows(2, { create: false }) ?? []).length, after.length, name + ' 前置：应能把 after 写进表2：');
    await dl.revertFloorDelta(snap(before), snap(after));
    const now = (st.getRows(2, { create: false }) ?? []).map((r) => [String(r?.[0] ?? ''), String(r?.[1] ?? '')]);
    const want = before.map((r) => [r[0], r[1]]);
    eq(JSON.stringify(now), JSON.stringify(want), name + ' 撤销后应与这一层之前一致：');
  }
});

await check('版本号一致性：manifest / 入口 / 面板角标 / 罗盘菜单 / 全仓无残留', async () => {
  const fs2 = await import('node:fs');
  const path2 = await import('node:path');
  const root = path2.resolve(path2.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
  const m = JSON.parse(fs2.readFileSync(path2.join(root, 'manifest.json'), 'utf8'));
  ok(Array.isArray(m.js) && m.js.length === 1, 'manifest.js 应只有一个入口：' + JSON.stringify(m.js));
  ok(fs2.existsSync(path2.join(root, m.js[0])), '入口文件必须存在：' + m.js[0]);
  const boot = fs2.readFileSync(path2.join(root, m.js[0]), 'utf8');
  const q = String(m.version || '').replace(/\./g, '').replace(/(\d)(\d{3})$/, '$1$2');
  ok(boot.includes('?v=' + q.slice(0, 4) + '0') || /\?v=\d+/.test(boot), '入口里应有 ?v= 版本戳：' + boot.trim());
  const badge = /rbq-ver-badge[^)]*text: '([^']+)'/.exec(fs2.readFileSync(path2.join(root, 'ui/panel.js'), 'utf8'));
  eq(badge && badge[1], 'v' + m.version, '面板角标应与 manifest 一致：');
  const dash = /RBQ v(\d+\.\d+\.\d+)/.exec(fs2.readFileSync(path2.join(root, 'ui/views/dashboard.js'), 'utf8'));
  eq(dash && ('v' + dash[1]), 'v' + m.version, '罗盘菜单里的版本号应与 manifest 一致：');
  /* 全仓不应再出现别的版本号（防止发版时漏改 ✗ —— 罗盘那个就是漏改过 ✓） */
  const stale = [];
  const walk = (d) => {
    for (const e of fs2.readdirSync(d, { withFileTypes: true })) {
      const p2 = path2.join(d, e.name);
      if (e.isDirectory()) { walk(p2); continue; }
      if (!/\.(js|json)$/.test(e.name)) continue;
      const s = fs2.readFileSync(p2, 'utf8');
      for (const v of new Set(s.match(/v2\.\d+\.\d+/g) || [])) if (v !== 'v' + m.version) stale.push(path2.relative(root, p2) + ' → ' + v);
    }
  };
  walk(root);
  eq(stale.length, 0, '还有别的版本号没同步：' + stale.slice(0, 6).join('、'));
});

await check('内置预设清单：版本齐全 + 条目形状正确 + 文件真的在', async () => {
  const fs2 = await import('node:fs');
  const path2 = await import('node:path');
  const root = path2.resolve(path2.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
  const idx = JSON.parse(fs2.readFileSync(path2.join(root, 'presets/index.json'), 'utf8'));
  const items = Array.isArray(idx.items) ? idx.items : [];
  ok(items.length > 0, '内置清单不能为空');
  for (const e of items) {
    ok(!!e.key && !!e.file && !!e.version, '每条都要有 key/file/version：' + JSON.stringify(e));
    ok(fs2.existsSync(path2.join(root, 'presets', e.file)), '清单里的文件必须存在：' + e.file);
    ok(['preset', 'worldinfo'].includes(e.kind || 'preset'), 'kind 只能是 preset/worldinfo：' + e.kind);
  }
});

/* ------------------------------------------------------------------ 收尾 */

console.log(`\n──────────────────────────────────────────`);
console.log(`通过 ${pass} 项，失败 ${failures.length} 项`);
if (failures.length) {
  console.log('\n失败明细：');
  for (const f of failures) console.log(`  · ${f.name}\n    ${f.error}`);
  process.exitCode = 1;
} else {
  console.log('全部通过 ✅');
}
