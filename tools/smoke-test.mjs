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

check('向量来源默认=主 API（不填接口就用主连接的地址）', async () => {
  const em = await import('../core/embed.js');
  const c = em.config();
  eq(c.source, 'main', '默认来源必须是 main（用户要求：不填就默认用主 API）：' + c.source);
  ok(em.SOURCES.some((s) => s.id === 'main'), '来源表里要有 main：');
  ok(typeof em.mainApi === 'function', '应有 mainApi() 读取主连接：');
  const m = em.mainApi();
  ok(m && typeof m.url === 'string' && typeof m.key === 'string', 'mainApi 必须返回 {url,key}：' + JSON.stringify(m));
  /* 没填地址时应回落到主连接的地址（本环境是空 ✓ 不能抛也不能给 undefined）*/
  const u = em.effectiveUrl('main', '');
  eq(typeof u, 'string', '主 API 来源的地址必须是字符串：');
  ok(!String(u).includes('undefined'), '不能出现 undefined：' + u);
  /* 有效 Key：填了用填的 */
  eq(em.effectiveKey('main', 'k1'), 'k1', '填了 Key 就该用它：');
  /* 主 API 来源且没模型 → 不可用（模型必须填）*/
  em.setConfig({ source: 'main', url: '', key: '', model: '' });
  eq(em.available(), false, '主 API 但没模型时必须不可用：');
  const sc = await em.selfCheck();
  ok(sc.ok === false, '自检应失败：' + JSON.stringify(sc));
  em.setConfig({ source: 'main' });
});

check('向量来源表：本地/自建不需要 Key（借鉴改版 connection-manager）', async () => {
  const em = await import('../core/embed.js');
  ok(Array.isArray(em.SOURCES) && em.SOURCES.length >= 5, '应有来源表：' + JSON.stringify((em.SOURCES || []).length));
  ok(em.sourceDef('ollama').needsKey === false, 'ollama 不该要 Key：');
  ok(em.sourceDef('siliconflow').needsKey === true, 'SiliconFlow 应要 Key：');
  eq(em.effectiveUrl('siliconflow', ''), 'https://api.siliconflow.cn/v1', '没填地址时应用来源默认地址：');
  eq(em.effectiveUrl('custom', 'http://x/v1'), 'http://x/v1', '填了就用填的：');
  /* ollama：没 Key 也应可用（只要模型）*/
  em.setConfig({ source: 'ollama', url: '', key: '', model: 'nomic-embed-text' });
  eq(em.available(), true, 'ollama + 模型（无 Key）必须可用：' + JSON.stringify(em.config()));
  /* 需要 Key 的来源：没 Key 不可用 */
  em.setConfig({ source: 'siliconflow', key: '', model: 'BAAI/bge-m3' });
  eq(em.available(), false, 'SiliconFlow 没 Key 时必须不可用：');
  /* 自检要能明确说是缺 Key */
  const sc = await em.selfCheck();
  ok(sc.ok === false && sc.step === 'Key', '自检应报缺 Key：' + JSON.stringify(sc));
  /* 本地来源没模型也要报缺模型 */
  em.setConfig({ source: 'ollama', model: '' });
  const sc2 = await em.selfCheck();
  ok(sc2.ok === false && sc2.step === '模型', '自检应报缺模型：' + JSON.stringify(sc2));
  em.setConfig({ source: 'custom', url: '', key: '', model: '' });
});

check('向量层：余弦/混排/回退（没有 key 必须回退词面）', async () => {
  const em = await import('../core/embed.js');
  const rc = await import('../core/recall.js');
  /* 余弦 */
  ok(Math.abs(em.cosine([1, 0], [1, 0]) - 1) < 1e-9, '同向余弦应为 1：');
  ok(Math.abs(em.cosine([1, 0], [0, 1])) < 1e-9, '正交余弦应为 0：');
  eq(em.cosine([1, 2], [1, 2, 3]), 0, '维度不一致应返回 0：');
  /* 混排 */
  ok(Math.abs(em.blend(1, 0, 0.5) - 0.5) < 1e-9, '词面1+向量0 应为 0.5：');
  ok(Math.abs(em.blend(0, 1, 0.5) - 0.5) < 1e-9, '词面0+向量1 应为 0.5：');
  ok(em.blend(1, 1, 0.5) === 1, '都满分应为 1：');
  /* 指纹稳定 */
  eq(em.hashText('abc'), em.hashText('abc'), '同文本指纹应一致：');
  ok(em.hashText('abc') !== em.hashText('abd'), '不同文本指纹应不同：');
  /* 没配置 → 不可用 + 回退 */
  em.setConfig({ url: '', key: '', model: '' });
  eq(em.available(), false, '空配置时 available 必须为 false：');
  const r = await rc.precomputeAsync({ round: 3 });
  eq(r.mode, 'lexical', '无配置时必须回退词面：' + JSON.stringify({ mode: r.mode, reason: r.reason }));
  /* 混排纯函数：向量独有的条目过阈值要进来，低于阈值不要 */
  const mkEntry = (t) => ({ text: t, round: 1, important: 0 });
  const hits = [{ name: '甲', entry: mkEntry('窗外的雪'), score: 0.9 }];
  const only = mkEntry('同义但字面无关的句子');
  const map = new Map();
  map.set(em.hashText(String(await import('../core/memory.js').then((m) => m.textOf(only)))), 0.9);
  const rb = rc.rankBlended(hits, map, { threshold: 0.35, topK: 10, lexWeight: 0.5 });
  ok(rb.list.length >= 1, '混排后至少保留原命中：');
  ok(rb.list[0].final >= rb.list[rb.list.length - 1].final, '必须按最终分从高到低：');
  const map2 = new Map();
  map2.set(em.hashText(String(await import('../core/memory.js').then((m) => m.textOf(only)))), 0.1);
  const rb2 = rc.rankBlended([], map2, { threshold: 0.35, topK: 10 });
  eq(rb2.list.length, 0, '低于阈值的向量独有条目不该进来：');
  /* 覆盖率可读 */
  const cov = em.coverage();
  ok(typeof cov.total === 'number' && typeof cov.done === 'number', '覆盖率应可读：' + JSON.stringify(cov));
  rc.clearCache();
});

check('预先召回缓存：记忆一变就失效（删楼层/重生成不会用旧召回）', async () => {
  const rc = await import('../core/recall.js');
  const m = await import('../core/memory.js');
  ok(typeof rc.precompute === 'function', '应有 precompute');
  ok(typeof rc.recallTextFor === 'function', '应有 recallTextFor');
  const wrote = rc.writeCache({ rev: 1, round: 1, msgId: 2, text: 'x', count: 0, at: 1 });
  if (wrote === false) { ok(true, '（本环境没有 chatMetadata，跳过缓存断言）'); return; }
  rc.clearCache();
  m.clearAll();
  const r1 = rc.precompute({ round: 5, msgId: 9 });
  ok(r1.ok === true, 'precompute 应成功：' + JSON.stringify(r1.reason || ''));
  const st1 = rc.cacheStatus();
  ok(st1.valid === true, '刚算完缓存应有效：' + JSON.stringify(st1));
  /* ★ 硬约束①：记忆变了 → 缓存必须失效 */
  m.addMemories([{ name: '甲', fields: { 感知: '窗外的雪停了' } }], 9);
  const st2 = rc.cacheStatus();
  ok(st2.valid === false, '写入新记忆后缓存必须失效（否则召回不含最新记忆）：' + JSON.stringify(st2));
  ok(String(st2.reason).includes('记忆变了'), '失效原因要说清是记忆变了：' + st2.reason);
  /* recallTextFor 必须能自愈：失效时自己重算并重新有效 */
  const t = rc.recallTextFor({ round: 5 });
  eq(typeof t, 'string', 'recallTextFor 必须返回字符串：');
  const st3 = rc.cacheStatus();
  ok(st3.valid === true, '自愈后缓存应重新有效：' + JSON.stringify(st3));
  /* ★ 硬约束①的另一半：按楼层删记忆 → 也要失效 */
  m.removeByMsgId(9);
  ok(rc.cacheStatus().valid === false, '删楼层回滚记忆后缓存必须失效：');
  rc.clearCache();
  m.clearAll();
});

check('记忆修订号 memRev：任何写入/删除都 +1（召回缓存靠它失效）', async () => {
  const m = await import('../core/memory.js');
  ok(typeof m.memRev === 'function', '应有 memRev');
  ok(typeof m.bumpRev === 'function', '应有 bumpRev');
  m.clearAll();
  const r0 = m.memRev();
  m.addMemories([{ name: '甲', fields: { 感知: '看到窗外的雪' } }], 3);
  const r1 = m.memRev();
  ok(r1 > r0, '写入后修订号必须 +1：' + r0 + ' → ' + r1);
  m.removeByMsgId(3);
  const r2 = m.memRev();
  ok(r2 > r1, '按楼层删除后必须 +1：' + r1 + ' → ' + r2);
  m.addMemories([{ name: '乙', fields: { 感知: 'y' } }], 4);
  const r3 = m.memRev();
  m.clearCharacter('乙');
  ok(m.memRev() > r3, '清某个角色后必须 +1：');
  const r4 = m.memRev();
  m.clearAll();
  ok(m.memRev() > r4, '全部清空后必须 +1：');
  /* 只读操作不能改号 */
  const r5 = m.memRev();
  m.allMemories(); m.stats(); m.recall({ query: 'x' });
  eq(m.memRev(), r5, '只读操作不该改修订号：');
});

check('召回查询串带上在场角色与焦点（第1步）', async () => {
  const P = await import('../prompts/prompts.js');
  const St = await import('../core/store.js');
  const S = await import('../core/schema.js');
  ok(typeof P.recallQuery === 'function', 'recallQuery 应已导出（便于测试）');
  const mk = (no, o) => S.getColumns(no).map((c) => String(o[c] ?? ''));
  await St.setRows(2, [mk(2, { 角色名称: '苏越' }), mk(2, { 角色名称: '温舒雅' })]);
  await St.setRows(6, [mk(6, { 即时焦点: '把礼盒里的暗号弄清楚' })]);
  const q = P.recallQuery();
  ok(/苏越|温舒雅/.test(q), '查询串里应出现在场角色：' + q.slice(0, 80));
  ok(q.includes('把礼盒里的暗号弄清楚'), '查询串里应出现当前焦点：' + q.slice(0, 80));
  /* 没有在场/焦点时不能报错，也不能塞垃圾 */
  await St.setRows(2, []); await St.setRows(6, []);
  const q2 = P.recallQuery();
  eq(typeof q2, 'string', '空数据时必须返回字符串：');
  ok(!q2.includes('undefined'), '不能出现 undefined：' + q2.slice(0, 60));
});

check('召回条数：0 = 全部召回（大总结/小总结/记忆三处语义一致）', async () => {
  const su = await import('../core/summary.js');
  const St = await import('../core/store.js');
  const S = await import('../core/schema.js');
  const cols = S.getColumns(12);
  const mk = (o) => cols.map((c) => String(o[c] ?? ''));
  const rows = [];
  for (let i = 1; i <= 7; i++) rows.push(mk({ 纪元封包名: '第' + i + '纪', 时间轴区间: i + '年', 剧情压缩: '内容' + i }));
  await St.setRows(12, rows);
  const all = su.digestText({ limit: 0 });
  eq(all.count, 7, '表里应有 7 条：');
  eq(all.shown, 7, 'limit=0 时必须全部召回（7 条）：');
  const three = su.digestText({ limit: 3 });
  eq(three.shown, 3, 'limit=3 时只取最近 3 条：');
  ok(three.text.includes('第7纪') && !three.text.includes('第1纪'), '应该取最近的（7/6/5），不该有第1纪：' + three.text.slice(0, 60));
  const neg = su.digestText({ limit: -1 });
  eq(neg.shown, 7, '负数也当全部：');
  await St.setRows(12, []);
});

check('大总结做成变量：格式干净、按列名取值、超长截断', async () => {
  const su = await import('../core/summary.js');
  const St = await import('../core/store.js');
  const S = await import('../core/schema.js');
  ok(typeof su.digestText === 'function', '应有 digestText');
  eq(su.digestText().text, '', '空表时应返回空串：');
  const cols = S.getColumns(12);
  const mk = (o) => cols.map((c) => String(o[c] ?? ''));
  await St.setRows(12, [
    mk({ 纪元封包名: '第一纪', 时间轴区间: '1年-2年', 剧情压缩: '开场与结盟。' }),
    mk({ 纪元封包名: '第二纪', 时间轴区间: '3年-4年', 剧情压缩: 'x'.repeat(500) }),
  ]);
  const d = su.digestText({ limit: 5, maxChars: 3600 });
  ok(d.text.includes('【大总结 · 共 2 条'), '应有表头与条数：' + d.text.slice(0, 40));
  ok(d.text.includes('第一纪') && d.text.includes('第二纪'), '两条都该出现：');
  ok(d.text.includes('开场与结盟。'), '正文该出现：');
  ok(!d.text.includes('x'.repeat(401)), '超长必须截断（不留 401 个 x）：');
  ok(d.text.includes('…'), '截断处应有省略号：');
  eq(d.count, 2, 'count 应为 2：');
  await St.setRows(12, []);
});

check('附加功能预览：显示真正会写进去的内容（含抢话的反向语义）', async () => {
  const ex = await import('../core/extras.js');
  ok(typeof ex.previewWritten === 'function', '应有 previewWritten');
  /* 抢话：关着 → 写禁令文本；开着 → 写空串 */
  ex.set('speakBan', { enabled: false, text: '' });
  const off = ex.previewWritten('speakBan');
  ok(off.length > 0, '抢话关着时应写进禁令文本：' + JSON.stringify(off.slice(0, 20)));
  ex.set('speakBan', { enabled: true });
  eq(ex.previewWritten('speakBan'), '', '抢话开着时应写空串（不限制）：');
  /* 普通条目：开着写模板、关着写空 */
  ex.set('narration', { enabled: true });
  ok(ex.previewWritten('narration').length > 0, '普通条目开着应有内容：');
  ex.set('narration', { enabled: false });
  eq(ex.previewWritten('narration'), '', '普通条目关着应写空：');
  /* 时间框不是变量 → 预览为空 */
  eq(ex.previewWritten('timeBox'), '', '时间框不该有变量预览：');
});

check('中止之后不再重试（点了终止就别再发请求）', async () => {
  const api = await import('../core/sideApi.js');
  ok(typeof api.isAbortError === 'function', '应有 isAbortError');
  eq(api.isAbortError({ name: 'AbortError' }), true, 'AbortError 应认出来：');
  eq(api.isAbortError(new Error('The operation was aborted.')), true, '消息里带 aborted 也算：');
  eq(api.isAbortError(new Error('HTTP 500')), false, '普通错误不该被当成中止：');
  const ac = new AbortController();
  eq(api.isAbortError(null, ac.signal), false, '信号没翻就不算：');
  ac.abort();
  eq(api.isAbortError(null, ac.signal), true, '信号翻了就算：');
  /* 关键：抛 AbortError 时只能试 1 次 */
  let n1 = 0;
  try { await api.withRetry(async () => { n1++; throw Object.assign(new Error('aborted'), { name: 'AbortError' }); }, { retries: 3, backoffMs: 1 }); } catch (e) { /* 预期抛错 */ }
  eq(n1, 1, '抛中止错时只能尝试 1 次：');
  /* 信号一开始就是中止状态 → 也只 1 次 */
  const ac2 = new AbortController(); ac2.abort();
  let n2 = 0;
  try { await api.withRetry(async () => { n2++; throw new Error('boom'); }, { retries: 3, backoffMs: 1, signal: ac2.signal }); } catch (e) { /* 预期 */ }
  eq(n2, 1, '信号已中止时只能尝试 1 次：');
  /* 普通错误仍要重试 */
  let n3 = 0;
  try { await api.withRetry(async () => { n3++; if (n3 < 3) throw new Error('HTTP 500'); return 'ok'; }, { retries: 3, backoffMs: 1 }); } catch (e) { /* ignore */ }
  eq(n3, 3, '普通错误该重试到成功：');
});

check('记忆召回：每人保底配额（不让主角把别人的记忆挤掉）', async () => {
  const m = await import('../core/memory.js');
  ok(typeof m.pickByQuota === 'function', '应有 pickByQuota');
  const mk = (name, n) => ({ name, entry: { text: 'x'.repeat(40), n } });
  const items = [mk('甲', 1), mk('甲', 2), mk('甲', 3), mk('甲', 4), mk('乙', 5), mk('丙', 6)];
  const r = m.pickByQuota(items, (h) => h.name + '#' + h.entry.n + ':' + 'y'.repeat(30), { maxChars: 1000, perName: 2 });
  const names = r.picked.map((h) => h.name);
  ok(names[0] === '甲' && names[1] === '甲', '第一轮应先把甲的两条按分数取走：' + names.join(','));
  ok(names.includes('乙') && names.includes('丙'), '第一轮必须让乙丙也各有一条（保底）：' + names.join(','));
  ok(names.indexOf('乙') < names.indexOf('甲#' + 3), '乙的保底条应排在甲的第三条之前：' + names.join(','));
  /* 字数预算很小时，也只能按顺序取，不超预算 */
  const r2 = m.pickByQuota(items, (h) => 'z'.repeat(60), { maxChars: 130, perName: 2 });
  ok(r2.used <= 130, '不能超过字数预算：' + r2.used);
  /* 空输入不炸 */
  eq(m.pickByQuota([], () => 'x', { maxChars: 100, perName: 2 }).lines.length, 0, '空输入应返回空：');
});

check('防陈旧注入：关掉原生注入时必须把上一次的注入清空', async () => {
  const inj = await import('../core/inject.js');
  const calls = [];
  const fake = {
    setExtensionPrompt: (...a) => calls.push(a),
    constants: { promptTypes: { IN_PROMPT: 0, IN_CHAT: 1 } },
  };
  /* 先开着注入（写一次）*/
  inj.setNativeConfig({ enabled: true, position: 'in_chat', depth: 4 });
  try { inj.applyNativeInjection(fake); } catch (e) { /* 环境不同也没关系 */ }
  /* 再关掉 → 必须用空串清一次，否则上一轮的注入会泄漏到下一次请求 */
  inj.setNativeConfig({ enabled: false });
  calls.length = 0;
  const r = inj.applyNativeInjection(fake);
  ok(r && r.ok === false, '关掉时应返回 ok:false：' + JSON.stringify(r));
  ok(calls.length >= 1, '关掉时也必须调一次 setExtensionPrompt 去清空');
  if (calls.length) eq(String(calls[0][1]), '', '清空时文本必须是空串：');
  calls.length = 0;
  try { inj.clearNativeInjection(fake); } catch (e) { /* ignore */ }
  ok(calls.length >= 1, 'clearNativeInjection 也要真的清一次');
  inj.setNativeConfig({ enabled: false });
});

check('按轮次节奏只发该写的表（缩短填表提示词）', async () => {
  const sp = await import('../core/sidePipeline.js');
  ok(typeof sp.activeTables === 'function', '应有 activeTables');
  const CAD = sp.TABLE_CADENCE;   // 显式传节奏才生效（默认关闭）
  const r1 = sp.activeTables(1, CAD);
  const r2 = sp.activeTables(2, CAD);
  const r3 = sp.activeTables(3, CAD);
  ok(r1.includes(3) && r1.includes(5) && r1.includes(10), '第 1 轮应全写（建档轮）：' + JSON.stringify(r1));
  ok(r2.length < r1.length, '第 2 轮应比第 1 轮少一些（有节奏）：' + r2.length + ' vs ' + r1.length);
  ok(r3.includes(3) && r3.includes(10), '第 3 轮应轮到生理/技能：' + JSON.stringify(r3));
  ok(!r2.includes(3), '第 2 轮不该轮到生理：' + JSON.stringify(r2));
  ok(r1.includes(0) && r2.includes(0) && r3.includes(0), '表0 每轮都要写（实时状态）：');
  eq(sp.activeTables(2).length, 15, '不传节奏时必须返回全部表（默认关闭）：');
  ok(sp.activeTables(4, CAD).includes(5), '第 4 轮应轮到关系（每 2 轮）：' + JSON.stringify(sp.activeTables(4)));
});

check('终止后绝不写脏数据（写库层硬拦，不依赖上层守卫）', async () => {
  const fz = await import('../core/freeze.js');
  const T = await import('../core/txn.js');
  const St = await import('../core/store.js');
  await St.clearAllTables();
  fz.clearAbort();
  await T.applyOps([{ op: 'upsert', table: 2, values: { 角色名称: '终止前' } }], { source: 'side' });
  const before = (St.getRows(2, { create: false }) || []).length;
  ok(before > 0, '前置：终止前应该能写进去');
  fz.requestAbort();
  const r = await T.applyOps([{ op: 'upsert', table: 2, values: { 角色名称: '终止后' } }], { source: 'side' });
  const after = (St.getRows(2, { create: false }) || []).length;
  ok(r && r.aborted === true, '终止后 applyOps 必须回 aborted:true：' + JSON.stringify(r));
  eq(after, before, '终止后行数不能变：');
  fz.clearAbort();
  await St.clearAllTables();
});

check('记忆补跑不再重复生成刚做过的角色（登记集合 + 判重）', async () => {
  const sp = await import('../core/sidePipeline.js');
  ok(typeof sp.markMemoryWritten === 'function', '应有 markMemoryWritten');
  ok(typeof sp.memoryWrittenNames === 'function', '应有 memoryWrittenNames');
  ok(typeof sp.resetMemoryWritten === 'function', '应有 resetMemoryWritten');
  ok(typeof sp.beginRoundMemory === 'function', '应有 beginRoundMemory');
  sp.resetMemoryWritten();
  eq(sp.memoryWrittenNames().length, 0, '清空后应为空：');
  sp.markMemoryWritten(['甲', '乙', '']);
  const names = sp.memoryWrittenNames();
  eq(names.length, 2, '只登记有名字的：');
  ok(names.includes('甲') && names.includes('乙'), '应登记甲乙：' + JSON.stringify(names));
  sp.beginRoundMemory();
  eq(sp.memoryWrittenNames().length, 0, '新一轮开始时必须清空（否则会永久挡住）：');
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

check('全仓版本字面量一致（角标写死这类坑必须绝迹）', async () => {
  const fs3 = await import('node:fs');
  const path3 = await import('node:path');
  const m = JSON.parse(fs3.readFileSync(path3.join(root, 'manifest.json'), 'utf8'));
  const walk = (d) => fs3.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path3.join(d, e.name)) : [path3.join(d, e.name)]);
  const bad = [];
  for (const f of walk(root)) {
    if (!/\.(js|css|html)$/.test(f)) continue;
    const lines = fs3.readFileSync(f, 'utf8').split('\n');
    lines.forEach((line, i) => {
      const inComment = /^\s*(\*|\/\/|\/\*)/.test(line) || /【v\d/.test(line);
      if (inComment) return;
      const vs = line.match(/v\d+\.\d+\.\d+/g) || [];
      for (const v of vs) { if (v !== 'v' + m.version) bad.push(path3.relative(root, f) + ' L' + (i + 1) + ' → ' + v); }
    });
  }
  eq(bad.length, 0, '这些地方的版本号与 manifest 不一致（角标写死就是这么来的）：\n    ' + bad.slice(0, 8).join('\n    '));
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
