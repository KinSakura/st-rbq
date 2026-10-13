/**
 * index.js —— RBQ 数据库扩展入口
 *
 * 职责：
 *   1. 注册三个宏（与旧插件同名同构 → 你的预设与状态栏都不用改）
 *   2. 挂 UI：输入框旁的小按钮 + 主面板
 *   3. 监听生成结束，解析 AI 输出里的 <data> 并走事务写入
 *   4. 暴露 window.RBQ 供控制台/其它脚本调用
 *
 * 所有对外部 API 的依赖都在 core/ctx.js，这里只做编排。
 */

import { ctx, on, onType, invalidate, notify, doc, chat, chatMetadata } from './core/ctx.js';
import { registerMacro } from './core/ctx.js';
import { useSchema, getTables, getTable } from './core/schema.js';
import * as store from './core/store.js';
import * as txn from './core/txn.js';
import * as protocol from './core/protocol.js';
import * as rules from './core/rules.js';
import * as review from './core/review.js';
import * as repair from './core/repair.js';
import * as options from './core/options.js';
import * as memory from './core/memory.js';
import * as addons from './core/addons.js';
import * as extras from './core/extras.js';
import * as inject from './core/inject.js';
import * as vars from './core/vars.js';
import * as legacyVars from './core/legacyVars.js';
import * as inspiration from './core/inspiration.js';
import * as sideApi from './core/sideApi.js';
import { extractProse, extractProseStrict } from './core/prose.js';
import * as sidePipeline from './core/sidePipeline.js';
import { expandUnparsed } from './core/expand.js';
import * as persona from './core/persona.js';
import * as progress from './ui/progress.js?v=21110';
import { closeNotify } from './core/ctx.js';
import * as updater from './core/updater.js';
import * as presetImport from './core/presetImport.js';
import * as summary from './core/summary.js';
import { macroTableData, macroTablePrompt, macroAllTablesJson, buildTableData } from './prompts/prompts.js';
import { mountPanel, showPanel, togglePanel, refreshPanel } from './ui/panel.js?v=21110';
import { startInputButtonInjection, setPanelOpener, refreshBadge, stopInputButton } from './ui/inputButton.js?v=21110';

const VERSION = '0.1.0';
let initialized = false;
const runtime = {
  lastProcessedMessageId: null,
  lastError: null,
};

/* ------------------------------------------------------------------ 宏 */

function registerMacros() {
  if (store.getConfigValue('macros.enabled', true) === false) {
    console.log('[RBQ] 宏注册已在设置里关闭，跳过。');
    return;
  }
  const ok1 = registerMacro('tablePrompt', macroTablePrompt, 'Returns table prompt');
  const ok2 = registerMacro('tableData', macroTableData, 'Returns table data');
  const ok3 = registerMacro('GET_ALL_TABLES_JSON', macroAllTablesJson, 'Returns table data as json');


  console.log(`[RBQ] 宏注册：tablePrompt=${ok1} tableData=${ok2} GET_ALL_TABLES_JSON=${ok3}`);
  if (!ok1 && !ok2 && !ok3) {
    console.warn('[RBQ] 三种宏注册方式都失败了 —— 表格数据将无法注入到提示词，请检查酒馆版本。');
  }
}

/* ------------------------------------------------------- 从 AI 输出写表 */

/**
 * 处理一条 AI 消息里的表格指令/事实。
 * @param {number} messageIndex
 * @param {{force?:boolean, source?:string}} [opts]
 */
async function processMessage(messageIndex, opts = {}) {
  const c = chat();
  const msg = c[messageIndex];
  if (!msg || msg.is_user === true) return { skipped: 'not-ai-message' };

  /* ============================================================
     【不再解析正文里的 <data>】✓ —— 用户明确要求：这套是重做的，
     不需要兼容老预设/老写法 ✓ 填表**只走侧路 API** 一条路 ✓
     （以前主 AI 在正文里写 <data> 也会被直接入库 ✗ 造成"数据凭空出现"的困惑 ✓）
     这里直接返回，后面那些维护动作（注入/附加变量/小总结）在别处照常跑 ✓
     ============================================================ */
  console.log('[RBQ] 只走侧路填表：忽略正文里的表格指令（不再解析 <data>/<tableEdit>）');
  return { skipped: 'legacy-body-data-disabled', applied: 0, failed: [], warnings: [], notes: [] };
}


/** 行动选项：把 <RP_OPTIONS> 变成消息里的按钮（延后一点，等酒馆把消息渲染完） */
/** 到了大总结轮次就提醒一次（不打断，只提示） */
function checkRoundReminder() {
  try {
    const r = addons.roundInfo();
    if (r.needSummary) notify('info', `已经第 ${r.round} 轮了，距上次大总结 ${r.since} 轮 —— 可以考虑让 AI 做一次 <epoch> 总结。`);
  } catch { /* ignore */ }
}

function refreshOptionsSoon(delay = 350) {
  if (store.getConfigValue('features.options', true) === false) return;
  setTimeout(async () => {
    try {
      const n = options.injectButtons();
      if (n) console.log(`[RBQ] 已在 ${n} 条消息里注入行动选项按钮`);
    } catch (e) { console.warn('[RBQ] 注入行动选项失败', e); }
    try {
      await options.maybeAutoRp();
    } catch (e) { console.warn('[RBQ] 全自动 RP 失败', e); }
  }, delay);
}

/**
 * 展开需要计算的标签：战斗(<skill>)、离场(<departure>)、记忆(<character_memory>)。
 * 交给 core/rules.js 与 core/memory.js —— AI 只申报事实，数值与连锁反应由脚本算。
 */
/* expandUnparsed 已搬到 core/expand.js（侧路也要用它 ✓） */

/**
 * 把一段“表格写入文本”直接落库（解析 → 展开技能/战斗/离场/记忆 → 应用）
 * 用途：① 手动重跑某一层 ② 端到端测试
 * 注意：**正文里的 <data> 不再自动走这里**（填表只走侧路 API ✓）
 */
export async function processFactsText(text, messageIndex = null) {
  const p = protocol.parseAll(String(text ?? ''));
  const ops = [...(p.ops ?? [])];
  let notes = [];
  try {
    const ex = await expandUnparsed(p.unparsed ?? []);
    ops.push(...(ex?.ops ?? []));
    notes = ex?.notes ?? [];
  } catch (e) { console.warn('[RBQ] 展开失败', e); }
  if (!ops.length) return { applied: 0, failed: [], notes, warnings: p.warnings ?? [] };
  const r = await txn.applyOps(ops, { source: 'facts-text', messageIndex: messageIndex ?? undefined });
  return { applied: r?.applied ?? 0, failed: r?.failed ?? [], notes, warnings: p.warnings ?? [] };
}

/* ------------------------------------------------------------- 事件绑定 */

/**
 * 【快照回填】给"缺快照"的旧楼层补上 before/after 快照 ✓
 *   依据：第 N 层写入之前 = 第 N-1 层写入之后 ✓（精确 ✓）
 *   为什么要它：v1.83 之前记的楼层没有快照 ✗，
 *     用户现在的聊天里大量楼层是那时候记的 → 删楼层/重生成时只能退回版本链 ✗（不可靠 ✓）
 *   回填之后【每一层都能按快照回滚】✓（删中间某层、删最后一层都准 ✓）
 */
function backfillAnchors() {
  try {
    const list = chat();
    /* 【删楼层定位用】顺手记住"当前这一串消息引用"✓（启动 / 换聊天 / 删楼前都会走到这里 ✓） */
    try { runtime.lastChatRefs = [...list]; } catch (e) { /* ignore */ }
    const idx = [];
    list.forEach((m, i) => { if (m && m.is_user !== true && m.rbqdb_anchor) idx.push(i); });
    if (!idx.length) return 0;
    let n = 0;
    // 正向：before 缺失 → 用上一层的 after（第一层用空表 ✓）
    for (let k = 0; k < idx.length; k++) {
      const a = list[idx[k]].rbqdb_anchor;
      if (a.beforeSnapshot) continue;
      const prev = k > 0 ? list[idx[k - 1]].rbqdb_anchor.afterSnapshot : null;
      a.beforeSnapshot = prev || '{}';
      n++;
    }
    // 反向：after 缺失 → 用下一层的 before
    for (let k = idx.length - 1; k >= 0; k--) {
      const a = list[idx[k]].rbqdb_anchor;
      if (a.afterSnapshot) continue;
      const next = k < idx.length - 1 ? list[idx[k + 1]].rbqdb_anchor.beforeSnapshot : null;
      a.afterSnapshot = next || store.snapshotTables();
      n++;
    }
    if (n) console.log('[RBQ] 已给 ' + n + ' 处缺失的楼层快照做回填（每层现在都能按快照回滚 ✓）');
    return n;
  } catch (e) { console.warn('[RBQ] 快照回填失败', e); return 0; }
}

/* 【用户要求】鼠标滚轮也能左右滚动 ✓
   在 RBQ 面板里，凡是可以横向滚动的容器（数据页表格 / 各种横向列表 ✓），
   滚轮的上下滚动直接转成左右滚动（按住 Shift 保留原生行为 ✓） */
function installWheelScroll() {
  try {
    if (window.__rbqWheelInstalled) return;
    window.__rbqWheelInstalled = true;
    document.addEventListener('wheel', (ev) => {
      try {
        if (!ev.target || !ev.target.closest || !ev.target.closest('#rbq-panel')) return;
        if (ev.shiftKey) return;
        let el = ev.target;
        while (el && el !== document.body) {
          const canX = el.scrollWidth > el.clientWidth + 4;
          const canY = el.scrollHeight > el.clientHeight + 4;
          if (canX && !canY) { el.scrollLeft += (ev.deltaY || 0); ev.preventDefault(); return; }
          el = el.parentElement;
        }
      } catch (e) { /* ignore */ }
    }, { passive: false });
    console.log('[RBQ] 已启用「滚轮横向滚动」');
  } catch (e) { /* ignore */ }
}
function bindEvents() {
  try { installWheelScroll(); } catch (e) { /* ignore */ }
  // 生成结束：这是唯一权威的"这一轮结束了"信号
  onType('GENERATION_ENDED', async (messageId) => {
    /* 侧路自己那次调用如果也触发了 GENERATION_ENDED，就忽略 ✓
       【修 bug】以前用"计数器"记账 ✗：如果某次侧路调用**没有**触发 GENERATION_ENDED，
       计数就会留到下一次真正的生成结束 → 把用户的正常轮次/第二次重新生成吞掉 ✗✓
       （用户实测："同一楼层第二次重新生成时侧路 API 没触发" ✓）
       现在改成：只在**侧路任务正在跑**的时候忽略 ✓ 精确得多 */
    try {
      if (runtime.sideBusy) {
        /* 酒馆刚把发送键放回来 → 侧路还在跑就再按回"生成中" ✓
           （busyOn 定义在侧路函数里 ✗ 这里调不到 ✓ 所以直接操作按钮 ✓） */
        try {
          if (Number(runtime.stopRefs ?? 0) > 0) {
            const st2 = document.getElementById('mes_stop');
            if (st2) st2.style.display = '';
            const sb2 = document.getElementById('send_but');
            if (sb2) sb2.style.display = 'none';
          }
        } catch (e) { /* ignore */ }
        console.log('[RBQ] 忽略一次 GENERATION_ENDED（侧路任务正在运行中）');
        return;
      }
    } catch (e) { /* ignore */ }
    try {
      await handleGenerationEnded(messageId);
    } catch (e) {
      console.error('[RBQ] GENERATION_ENDED 处理失败', e);
      runtime.lastError = e;
    }
  });

  // 消息被编辑/滑动：重新解析那条消息（不重生成）
  const reparse = (messageId) => {
    // __reparseRollback：重新生成/编辑消息时，先滚回该消息上次记录前的版本，避免表格叠加
    try {
      const list = chat();
      const msg = list[index];
      const a = msg && msg.rbqdb_anchor;
      if (a && Number.isFinite(Number(a.beforeRev))) txn.rollbackTo(Number(a.beforeRev));
    } catch (e) { console.warn("[RBQ] 重新生成回退失败", e); }
    /* 编辑/滑动后重跑侧路填表（v1.95：填表只走侧路 ✓ 以前这里只重解析正文 ✗） */
    setTimeout(() => { handleGenerationEnded(messageId).catch((e) => console.warn('[RBQ] 重跑侧路失败', e)); }, 200);
  };
  onType('MESSAGE_EDITED', reparse);
  onType('MESSAGE_SWIPED', reparse);
  onType('MESSAGE_UPDATED', (messageId) => { refreshPanel(); void messageId; });

  // 换聊天：清缓存 + 重载
  onType('CHAT_CHANGED', () => {
    /* 【删楼层定位用】换聊天了 → 重新记住"当前这一串消息引用"✓ */
    try { runtime.lastChatRefs = [...chat()]; } catch (e) { /* ignore */ }
    setTimeout(() => { try { if (store.getConfigValue('persona.wrap', true) !== false) persona.applyPersona({ onlyCurrent: false }); } catch (e) { /* ignore */ } }, 800);
    try { backfillAnchors(); } catch (e) { /* ignore */ }
    invalidate();
    runtime.lastProcessedMessageId = null;

    setTimeout(() => { refreshPanel(); startInputButtonInjection(); }, 200);
  // —— 诊断钩子：只在 ?rbqtest=1 时启用，用来在真实浏览器里核对"面板到底有没有显示"
  try {
    if (new URLSearchParams(location.search).get("rbqtest") === "1") {
      const dump = (tag) => {
        const el = document.getElementById("rbq-panel");
        const cs = el ? getComputedStyle(el) : null;
        const r = el ? el.getBoundingClientRect() : null;
        const info = {
          tag,
          exists: !!el,
          connected: !!el?.isConnected,
          cls: el?.className ?? null,
          inline: el ? (el.getAttribute("style") ?? "") : null,
          display: cs?.display ?? null,
          visibility: cs?.visibility ?? null,
          opacity: cs?.opacity ?? null,
          position: cs?.position ?? null,
          zIndex: cs?.zIndex ?? null,
          width: r ? Math.round(r.width) : null,
          height: r ? Math.round(r.height) : null,
          top: r ? Math.round(r.top) : null,
          left: r ? Math.round(r.left) : null,
          vw: innerWidth, vh: innerHeight,
          entry: (() => { try { return window.RBQ?.entryStatus?.() ?? null; } catch { return "err"; } })(),
        };
        let pre = document.getElementById("rbq-diag");
        if (!pre) { pre = document.createElement("pre"); pre.id = "rbq-diag"; document.body.appendChild(pre); }
        pre.textContent += "\nRBQDIAG " + JSON.stringify(info);
        return info;
      };
      setTimeout(() => {
        try {
          const btn = document.getElementById("rbq-input-btn");
          const fab = document.getElementById("rbq-fab-btn");
          console.log("[RBQ-TEST] 入口存在：工具栏=" + !!btn + " 浮动=" + !!fab);
          // 真实路径 1：点工具栏按钮
          if (btn) { btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); }
          else if (fab) { fab.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); }
          else { window.RBQ?.openPanel?.(); }
        } catch (e) { console.error("[RBQ-TEST] 点击失败", e); }
        setTimeout(() => dump("after-click"), 700);
      }, 3000);
      setTimeout(() => dump("late"), 7000);
    }
  } catch { /* ignore */ }
  });

  /* 【最重要的一处】GENERATION_AFTER_COMMANDS 在**酒馆组装提示词之前**触发 ✓
     （酒馆的流程：GENERATION_AFTER_COMMANDS → 宏替换/拼提示词 → 发请求）
     所以重新生成/滑动时的回滚必须挂在这里 ✗→✓ ——
     否则酒馆会把**上一轮的旧表格数据**一起发给 AI，剧情就永远对不上（用户明确指出的问题 ✓） */
  /* ============ 重新生成 / 滑动 的回滚（三重保险，照记忆增强插件的思路）============
     酒馆源码：GENERATION_STARTED(L4299) 与 GENERATION_AFTER_COMMANDS(L4321)**都带 type 且都 await** ✓
     ① STARTED 先记下 type；② AFTER_COMMANDS 回滚（拼提示词前最后窗口）；③ MESSAGE_SWIPED 兜底 ✓
     回滚必须 await（rollbackTo 内部要 saveChat ✓），否则提示词先组装完 ✗ 旧表格照样发给 AI ✓ */
  const __isRegen = (a, b) => {
    const s = (String(a ?? '') + '|' + String(b ?? '')).toLowerCase();
    return s.includes('regenerate') || s.includes('swipe');
  };
  const __rollbackLastAiFloor = async (why) => {
    try {
      const list = chat();
      for (let i = list.length - 1; i >= 0; i--) {
        const m = list[i];
        if (!m || m.is_user) continue;
        const a = m.rbqdb_anchor;
        if (!a) { console.log('[RBQ] ' + why + '：第 ' + i + ' 层没有锚点（从未记录过 beforeRev ✗ → 无从回滚）'); break; }
        const target2 = Number.isFinite(Number(a.beforeRev)) ? Number(a.beforeRev) : Number(a.rev);
        /* 【诊断】把"为什么可能回不动"一次说清：目标版本、当前版本、各锚点的 rev 与有没有 undo */
        try {
          const anchors = (store.listAnchors ? store.listAnchors() : []) || [];
          const brief = anchors.map((x) => '#' + x.index + ':rev=' + (x.anchor?.rev ?? '?') + (x.anchor?.undo && Object.keys(x.anchor.undo).length ? '+undo' : '✗noUndo') + (Number.isFinite(Number(x.anchor?.beforeRev)) ? '(beforeRev=' + x.anchor.beforeRev + ')' : ''));
          const plan = store.planRollback ? store.planRollback(target2).length : '?';
          console.log('[RBQ] 回滚诊断：目标=' + target2 + ' 当前rev=' + store.getRev() + ' 可执行步骤=' + plan + ' 锚点=[' + brief.join(', ') + ']');
        } catch (e) { /* ignore */ }
        if (Number.isFinite(target2)) {
          /* 【最优先】有"写入之前的快照"就直接还原 ✓ 一字不差、不受 rev/undo 影响 ✓
             （这是记忆增强插件的做法：每条消息自带快照 ✓ 比版本号链可靠得多 ✓） */
          if (a.beforeSnapshot) {
            const okSnap = await store.restoreTablesSnapshot(a.beforeSnapshot);
            console.log('[RBQ] ' + why + '：已用【快照】还原表格 ✓（' + (okSnap ? '成功' : '失败') + '，AI 将看到回滚后的数据）');
            // 【关键】冻结写入 15 秒：上一轮侧路的收口定时器/补写批次还在跑，
            // 不冻结它们会把刚清空的表又写回数据 ✗（我自己在测试环境复现过：剩 4 行残留 ✓）
            try { sidePipeline.freezeFor?.(15000); } catch (e) { /* ignore */ }
            try { memory.removeByMsgId?.(i); } catch (e) { /* ignore */ }
    try { summary.removeByMsgId?.(i); } catch (e) { /* ignore */ }
            try { extras.applyAll({ quiet: true }); } catch (e) { /* ignore */ }
            try { inject.applyNativeInjection(); } catch (e) { /* ignore */ }
            try { refreshPanel(); } catch (e) { /* ignore */ }
            break;
          }
          console.log('[RBQ] ' + why + '：这一层是旧版本记录的（没有快照 ✗），退回用版本号回滚 —— 建议发一条新消息后，再重新生成它 ✓');
          const r = await txn.rollbackTo(target2);
          try { sidePipeline.freezeFor?.(15000); } catch (e) { /* ignore */ }
          console.log('[RBQ] ' + why + '：已回滚表格到第 ' + target2 + ' 版 ✓（恢复 ' + (r?.restored ?? 0) + ' 张表，AI 将看到回滚后的数据）');
        } else {
          console.log('[RBQ] ' + why + '：第 ' + i + ' 层的锚点没有可用版本号 ✗');
        }
        try { memory.removeByMsgId?.(i); } catch (e) { /* ignore */ }
    try { summary.removeByMsgId?.(i); } catch (e) { /* ignore */ }
        /* 【关键】回滚完必须**重新推送**给酒馆 ✓✓
           对比记忆增强插件：它是在拼提示词那一刻用【宏现算】表格文本（拉取式 ✓ 永远最新）；
           我们的"原生注入"是 setExtensionPrompt **推送式** ✗ ——
           表格回滚了却不重推的话，酒馆手里还是**回滚前的旧文本** → AI 照样看到旧数据 ✗✓
           （我上一版重写这个处理器时把这三行删掉了 ✗ 现在补回来 + 放在回滚之后 ✓） */
        try { extras.applyAll({ quiet: true }); } catch (e) { /* ignore */ }
        try { inject.applyNativeInjection(); } catch (e) { /* ignore */ }
        try { refreshPanel(); } catch (e) { /* ignore */ }
        break;
      }
    } catch (e) { console.warn('[RBQ] ' + why + ' 回滚失败', e); }
  };

  console.log('[RBQ] 已监听 GENERATION_STARTED / AFTER_COMMANDS / MESSAGE_SWIPED（重生与滑动会在拼提示词前回滚）');
  onType('GENERATION_STARTED', async (type) => {
    runtime.pendingGenType = String(type ?? '');
    console.log('[RBQ] GENERATION_STARTED type=' + runtime.pendingGenType);
    repair.clearUserStop();   // 恢复自动修复（这三行以前就在这个处理器里，重写时被我误删 ✗ 现在补回 ✓）
    try { extras.applyAll({ quiet: true }); } catch (e) { console.warn('[RBQ] 写附加变量失败', e); }
    if (__isRegen(runtime.pendingGenType, '')) await __rollbackLastAiFloor('GENERATION_STARTED(' + runtime.pendingGenType + ')');
    try { inject.applyNativeInjection(); } catch (e) { console.warn('[RBQ] 原生注入失败', e); }
  });
  onType('GENERATION_AFTER_COMMANDS', async (type) => {
    console.log('[RBQ] GENERATION_AFTER_COMMANDS 触发了，type=' + String(type) + '（STARTED 记的是 ' + String(runtime.pendingGenType) + '）');
    if (__isRegen(type, runtime.pendingGenType)) await __rollbackLastAiFloor('GENERATION_AFTER_COMMANDS');
    runtime.pendingGenType = '';
  });
  onType('MESSAGE_SWIPED', async (messageId) => {
    console.log('[RBQ] MESSAGE_SWIPED 兜底回滚（第 ' + messageId + ' 层）');
    await __rollbackLastAiFloor('MESSAGE_SWIPED');
  });

  /* 删除楼层 → 回滚到【被删那一层写入之前】的状态 ✓
     【关键一】MESSAGE_DELETED 触发时，那条消息**通常还在数组里** ✗✓ ——
       所以必须**在这一刻就把它自己的快照抓下来**（beforeSnapshot = 那一层写入之前 ✓）
       等酒馆真删掉之后再去找，就已经找不到它了 ✗（这就是"删了不回滚"的根因 ✓）
     【关键二】按**对象身份**对比新旧数组找出被删的那条 ✓
       比"猜 id / 取最后一条"可靠得多（删中间某层也准 ✓）
     【兜底】万一抓不到（比如程序化清空聊天 ✓）→ 退回"剩下最后一条带锚点的层"的 afterSnapshot ✓ */
  onType('MESSAGE_DELETED', async (deletedId) => {
    try {
      /* ⚠️ 顺序很重要：必须在 backfillAnchors() 之前把"上一次的引用"读出来 ✓
         （backfillAnchors 会顺手把 lastChatRefs 更新成【现在】的数组 ✗ 那就白记了 ✓） */
      const prev = Array.isArray(runtime.lastChatRefs) ? runtime.lastChatRefs : null;
      backfillAnchors();   // 再给缺快照的旧楼层补上 ✓
      /* 【有效性别断】只有"上一次记下来的那串引用几乎全都还在"时，它才算可信的"删前状态" ✓
         否则（比如扩展刚加载、harness 里刚造的消息 ✓）它已经过时了 ✗
         → 过时就退回老办法（拿事件时的数组当删前 + 等它变短 ✓）✓ */
      const nowAll = [...chat()];
      const aliveCount = prev ? prev.filter((m) => m && nowAll.includes(m)).length : 0;
      /* 判据收紧 ✓：必须"正好只少了一条、其余全在"才算可信 ✓
         （以前只要求"大部分还在"✗ → 引用过时了也会被当成删前 → 挑错被删的那层 ✗） */
      const prevValid = !!(prev && prev.length === nowAll.length + 1 && aliveCount === nowAll.length);
      if (!prevValid) {
        /* 数组可能还在"删之前"（有的环境先发事件再删 ✓）→ 短等一下 ✓ 但别久等 ✗（拖慢删楼体验 ✓） */
        try {
          if (chat().length >= nowAll.length) {
            const { waitFor } = await import('./core/util.js');
            await waitFor(() => chat().length < nowAll.length, { timeout: 400, interval: 40 });
          }
        } catch (e) { /* ignore */ }
      }
      const before = prevValid ? prev.slice() : nowAll.slice();
      const gone = prevValid ? prev.filter((m) => m && !nowAll.includes(m)) : [];
      const deletedRef = gone.length ? gone[gone.length - 1] : null;
      const afterNow = [...chat()];
      runtime.lastChatRefs = afterNow;
      const lenAtEvent = before.length;
      const snapshotOf = new Map();
      let picked = null;
      for (const m of before) {
        if (!m || !m.rbqdb_anchor) continue;
        snapshotOf.set(m, { a: { ...m.rbqdb_anchor }, msg: m, mes: String(m.mes ?? '').slice(0, 60) });
      }
      /* ① 首选：我们记住的"被删引用"✓（真实酒馆走这条：先删数组再 emit ✓） */
      try {
        if (deletedRef && deletedRef.rbqdb_anchor) picked = snapshotOf.get(deletedRef) ?? { a: { ...deletedRef.rbqdb_anchor }, msg: deletedRef };
      } catch (e) { /* ignore */ }
      /* ② 其次：万一酒馆把被删消息/下标当载荷传过来 ✓ */
      try {
        if (!picked && deletedId && typeof deletedId === 'object' && deletedId.rbqdb_anchor) picked = snapshotOf.get(deletedId) ?? { a: { ...deletedId.rbqdb_anchor }, msg: deletedId };
        const idx = Number(deletedId);
        if (!picked && Number.isInteger(idx) && before[idx] && before[idx].rbqdb_anchor) picked = snapshotOf.get(before[idx]) ?? { a: { ...before[idx].rbqdb_anchor }, msg: before[idx] };
      } catch (e) { /* ignore */ }

      const after = afterNow;
      console.log('[RBQ] 删楼层：上一次 ' + lenAtEvent + ' 条 → 现在 ' + after.length + ' 条（按身份定位=' + (deletedRef ? '命中' : '未命中') + '，引用可信=' + prevValid + '，载荷=' + String(deletedId) + '）');

      /* ③ 没按 id 取到时，用"对象身份差集"找出被删的那条 ✓ */
      if (!picked) {
        const alive = new Set(after);
        for (const m of before) {
          if (!alive.has(m)) { picked = snapshotOf.get(m) ?? null; if (picked) { console.log('[RBQ] 删楼层：按身份定位到被删的那一层（含锚点=' + !!(picked.a) + '）'); break; } }
        }
      }

      /* ④ 决定还原目标：优先【被删那条的 beforeSnapshot】✓
            （= 它写入之前的表格状态 ✓ 正是"删掉它之后应该回到的阶段"✓）
            没有就退到"剩下最后一条带锚点的层"的 afterSnapshot ✓ 再没有才用版本链 ✓ */
      /* 【诊断】聊天里根本没有锚点（例如刚清空过数据 ✓ / 这些楼是旧版本记的但锚点被清了 ✗）
         → 明确告诉用户"为什么没回滚" ✓ 不然他只会看到"删了没反应" ✗ */
      const anyAnchor = after.some((m) => m && m.rbqdb_anchor);
      if (!anyAnchor) {
        console.warn('[RBQ] 删楼层：这个聊天里没有任何楼层快照（锚点）→ 无法回滚。');
        notify('warning', '删楼层：这个聊天里没有可回滚的楼层快照，所以表格保持不动。正常跑一轮后就有了。');
      }
      let restored = false;
      /* 【删的是不是最后一层？】**是** → 直接还原它的 before 快照 ✓（最干净 ✓）
         **不是**（删中间某层 ✓）→ 用它的 before/after 差【只撤销那一层】✓
           后面的层必须保留 ✓（例：甲/乙/丙 删掉中间的乙 → 应得 甲+丙 ✓） */
      const delIdxInOld = picked && picked.msg ? before.indexOf(picked.msg) : -1;
      const isLastFloor = delIdxInOld < 0 ? false : !before.slice(delIdxInOld + 1).some((m) => m && m.rbqdb_anchor);
      const deletedHadAnchor = !!(picked && picked.a && (picked.a.beforeSnapshot || picked.a.afterSnapshot));
      console.log('[RBQ] 删楼层诊断：旧下标=' + delIdxInOld + ' 旧长度=' + before.length + ' 是最后一层=' + isLastFloor + ' 有锚点=' + deletedHadAnchor + ' 旧数组尾部带锚点层数=' + before.slice(delIdxInOld + 1).filter((m) => m && m.rbqdb_anchor).length);
      if (deletedHadAnchor && !isLastFloor && picked.a.beforeSnapshot && picked.a.afterSnapshot) {
        try {
          const dl = await import('./core/delta.js');
          const r = await dl.revertFloorDelta(picked.a.beforeSnapshot, picked.a.afterSnapshot);
          console.log('[RBQ] 删楼层（中间层）：只撤销了这一层的改动 ✓（单元格 ' + r.reverted + ' / 行 ' + r.deletedRows + '）');
          restored = true;
        } catch (e) { console.warn("[RBQ] 撤销该层改动失败，退回快照还原", e); }
      }
      /* 【最关键的一条】删完之后，聊天里**一条 AI 剧情楼层都不剩** → 数据库必须是空的 ✓✓
         用户实测（他在 1 楼测试 ✓）：删掉唯一那层剧情后表格里还留着之前的数据 ✗
         因为旧代码在"没有可用快照"时什么都不做 ✗ → 数据就留着了 ✗
         而正确语义是：剩下的聊天里没有剧情 → 没有实体、没有关系、没有时间地点 ✓ → 清空 ✓ */
      const remainAiFloors = after.filter((m) => m && m.is_user !== true).length;
      /* 兜底：有些聊天/旧数据里消息没带 is_user 标记 ✗ → 再用"总条数"判一次 ✓
         （删掉唯一那层剧情后，聊天里只剩开场那一条 ✓ → 同样该清空 ✓） */
      const remainTotal = after.filter((m) => m && String(m.mes ?? '').trim()).length;
      console.log('[RBQ] 删楼层·判定：剩下的 AI 层=' + remainAiFloors + '，有内容的条数=' + remainTotal + '，数组长度=' + after.length);
      if (remainAiFloors === 0 || remainTotal <= 1) {
        await store.clearAllTables();
        try { memory.clearAll?.(); } catch (e) { /* ignore */ }
    try { summary.clearAll?.(); } catch (e) { /* ignore */ }
        console.log('[RBQ] 删楼层：聊天里已经没有剧情楼层了 → 已清空全部表格与记忆 ✓（AI 下次只会收到"数据库为空"提示 ✓）');
        restored = true;
      }

      const beforeSnap = picked?.a?.beforeSnapshot;
      if (!restored && beforeSnap) {
        const okk = await store.restoreTablesSnapshot(beforeSnap);
        console.log('[RBQ] 删楼层：已用【被删层的 before 快照】还原 ✓（' + (okk ? '成功' : '失败') + '）');
        restored = !!okk;
      }
      if (!restored) {
        for (let i = after.length - 1; i >= 0; i--) {
          const a = after[i] && after[i].rbqdb_anchor;
          if (!a) continue;
          const target2 = Number.isFinite(Number(a.rev)) ? Number(a.rev) : Number(a.beforeRev);
          if (a.afterSnapshot) {
            const okk = await store.restoreTablesSnapshot(a.afterSnapshot);
            console.log('[RBQ] 删楼层：已用【剩下最后一层的 after 快照】还原到第 ' + i + ' 层 ✓（' + (okk ? '成功' : '失败') + '）');
          } else if (Number.isFinite(target2)) {
            const r = await txn.rollbackTo(target2);
            console.log('[RBQ] 删楼层：已回滚到第 ' + target2 + ' 版（没有快照，用版本链 ✓ 恢复 ' + (r?.restored ?? 0) + ' 张表）');
          }
          break;
        }
      }

      /* ⑤ 被删掉的那些层写的记忆清掉 + 存活楼层的记录重映射到新下标 ✓
         【修 bug】以前这里把"现存带锚点的 AI 层数"当起始下标用 ✗（数量 ≠ 下标）
         → 会把仍然在场的楼层记忆/小总结误删 ✓ 而被删那层反而可能没清 ✓
         现在改成：按 before/after 的对象身份算出【旧下标 → 新下标】映射 ✓
         · 还在的楼层 → 记录里的 msgId 跟着改 ✓（否则删一层之后全体错位 ✓）
         · 已经不在的楼层 → 它的记忆/小总结被删掉 ✓ */
      try {
        const oldOf = new Map();
        for (let oi = 0; oi < before.length; oi++) oldOf.set(before[oi], oi);
        const remap = new Map();
        for (let ni = 0; ni < after.length; ni++) {
          const oi = oldOf.get(after[ni]);
          if (oi !== undefined) remap.set(oi, ni);
        }
        try { memory.remapMsgIds?.(remap); } catch (e) { /* ignore */ }
        try { summary.remapMsgIds?.(remap); } catch (e) { /* ignore */ }
        console.log('[RBQ] 删楼层后已重映射记忆/小总结的下标（存活 ' + remap.size + ' 层 ✓ 被删层的记录已清除 ✓）');
      } catch (e) { /* ignore */ }
      try { extras.applyAll({ quiet: true }); } catch (e) { /* ignore */ }
      try { inject.applyNativeInjection(); } catch (e) { /* ignore */ }
    } catch (e) { console.warn('[RBQ] 删楼层回退失败', e); }
    refreshPanel();
  });

  /* 【已删除】这里原本还有**第二个** GENERATION_STARTED 处理器（v1.75 时代写的），
     它用 `txn.rollbackTo(beforeRev)` 走【版本链】回滚 ✗ ——
     实测后果：上面的【快照】还原（干净 ✓）之后，它又把表用 undo 链**还原回来**了 ✗✓
     （写入审计抓到：setRows 直接写 表2 ← rollbackTo ← EventEmitter ✓）
     现在统一只走上面那一个处理器（快照优先 ✓），别再挂重复的 ✓ */
  onType('GENERATION_STOPPED', () => {
    repair.markUserStopped(store.findLatestAnchor()?.anchor?.roundId ?? null);
    console.log('[RBQ] 生成被手动停止，本轮不再自动重试。');
  });
}

async function handleGenerationEnded(messageId) {
  // 宿主可能还没把消息插进数组 —— 轮询校验而不是"睡固定毫秒"
  const { waitFor } = await import('./core/util.js');
  const c = chat();
  const target = Number.isInteger(messageId) ? messageId : c.length - 1;

  const ok = await waitFor(() => {
    const arr = chat();
    return arr.length > target && arr[target] && arr[target].is_user !== true;
  }, { timeout: 4000, interval: 80 });

  if (!ok) {
    // 等不到指定楼层时，退回到"最后一条 AI 消息"继续处理（宿主有时把事件发在消息落地之前）
    const arr = chat();
    let last = -1;
    for (let i = arr.length - 1; i >= 0; i--) { if (arr[i] && arr[i].is_user !== true) { last = i; break; } }
    if (last < 0) {
      console.warn('[RBQ] 生成结束后没等到 AI 消息落地，且聊天里没有 AI 消息，跳过本轮表格处理。');
      notify('warning', '生成结束后没找到 AI 消息，本次跳过填表。');
      return;
    }
    console.warn('[RBQ] 没等到指定楼层 ' + target + '，改用最后一条 AI 消息（第 ' + last + ' 层）继续处理。');
    return handleGenerationEndedResolved(last);
  }
  return handleGenerationEndedResolved(target);
}

/** 真正处理某一层 AI 消息（handleGenerationEnded 校验完楼层后调用） */
async function handleGenerationEndedResolved(target) {
  /* 守卫：同一条消息 **且正文一模一样** 才跳过。
     以前只看 messageId → 重新生成（同 id 新正文）会被误判成"已处理过"而不跑侧路。 */
  const __bodyOf = (id) => { try { return String(chat()?.[id]?.mes ?? ''); } catch (e) { return ''; } };
  const __hash = (s) => { let h = 0; for (let i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0; } return h + ':' + s.length; };
  const __curHash = __hash(__bodyOf(target));
  if (runtime.lastProcessedMessageId === target && runtime.lastProcessedHash === __curHash) {
    console.log('[RBQ] 该消息内容未变，已处理过，跳过。');
    return;
  }
  runtime.lastProcessedMessageId = target;
  runtime.lastProcessedHash = __curHash;

  /* 【最靠前的一次快照】—— 必须早于**所有**写入 ✗→✓
     之前的快照是在"侧路开跑前"拍的，可那时正文里的 <data>（旧路径 processMessage）已经写进表了 ✗
     → 回滚到那份快照 = 残留旧路径写的数据（实测：表2 剩 2 行 ✓）
     现在改成：刚确定要处理这条消息时就拍，覆盖得住旧路径 + 侧路两条链路 ✓ */
  try {
    const m0 = chat()?.[target];
    if (m0) {
      const a0 = store.getAnchor(m0) ?? { v: 1, roundId: null, rev: store.getRev(), at: Date.now(), hash: {}, undo: [] };
      if (!a0.beforeSnapshot) {
        a0.beforeSnapshot = store.snapshotTables();
        console.log('[RBQ] 已拍快照（第 ' + target + ' 层，本条消息写入之前的表格状态=' + (a0.beforeSnapshot ? a0.beforeSnapshot.length + ' 字节' : '失败') + '）');
      }
      if (!Number.isFinite(Number(a0.beforeRev))) a0.beforeRev = store.getRev();
      store.setAnchor(m0, a0);
    }
  } catch (e) { console.warn('[RBQ] 拍快照失败', e); }

  // AI 这条消息是空的（模型没返回内容 / 流式被打断）——说清楚，别让人以为数据库坏了  __emptyWarn
  try {
    const raw = String(chat()?.[target]?.mes ?? '');
    const body = raw.replace(/<thinking_matrix>[\s\S]*?<\/thinking_matrix>/gi, '').replace(/<[^>]+>/g, '').trim();
    if (body.length < 2) {
      const model = (() => { try { return chat()?.[target]?.extra?.model ?? ''; } catch { return ''; } })();
      notify('warning', '这条 AI 消息是空的（模型 ' + (model || '未知') + ' 没返回内容），本次没有数据可填。');
      runtime.lastEmptyMessageId = target;
    }
  } catch { /* ignore */ }

  /* 重新生成 / 编辑后重跑：先把这个楼层上一轮写进去的东西**回滚干净**，再重新处理 ✓
     （用户反馈：重新生成后上一轮的表格与记忆没回滚，数据叠在一起 ✗） */
  try {
    const hadAnchor = (() => { try { return chat()?.[target]?.rbqdb_anchor ?? null; } catch (e) { return null; } })();
    if (hadAnchor) {
      const br = Number(hadAnchor.beforeRev);
      if (Number.isFinite(br)) {
        /* 【已禁用】处理楼层前的 rev 回滚：与快照回滚重复，且会用 undo 链把表"还原回来" ✗
               （快照路径已经处理过了 ✓） */
        void br;
      }
      try {
        const mem = await import("./core/memory.js");
        mem.removeByMsgId?.(target);
      try { summary.removeByMsgId?.(target); } catch (e) { /* 小总结也要成对清掉 ✓ 以前漏了 ✗ */ }
      } catch (e) { /* ignore */ }
    }
  } catch (e) { console.warn("[RBQ] 重新生成前回滚失败", e); }

  /* 【开关】正文里的 <data>（旧填表路径）——
     默认仍然解析（兼容老预设 ✓），但可以在设置里关掉，做到"填表只走侧路 API" ✓
     （用户实测：主 AI 正文里带 <data> 时，即使侧路没配，表也会被直接写入 ✗ 造成的困惑 ✓） */
  /* 填表只走侧路 API ✓（不再有"是否解析正文 <data>"的分支 ✓） */
  const res = { applied: 0, failed: [], warnings: [], notes: [] };
  if (res?.skipped === 'no-table-tags') {
    console.log('[RBQ] 本轮没有表格标签。');
  }
  // 侧路 API：每条 AI 正文都跑（与「有没有表格标签」无关 —— 侧路接管填表后正文里本来就没有标签）
  try {
    const sideRaw = String(chat()[target]?.mes ?? '');
    /* ⚠️ sideRound 必须【先定义】再往下用（上一轮我把它写在 635 行、617 行就用了 ✗
       → const 的暂时性死区 → 每次抛 ReferenceError 被 catch 吞掉 ✓
       结果：小总结落库其实一次都没成功 ✓ 这个 bug 由代码审计发现 ✓ 现在提到前面 ✓） */
    const sideRound = (() => { try { return addons.roundInfo().round; } catch { return 0; } })();
    /* 【修 bug】以前 summary.maintain 从来没被调用 ✗ → 小总结根本没存进库 ✓
       这里用【原始】正文解析（<This_round_events> 就在原文里 ✓）
       → 落库到本聊天的 summary.events（按轮次一条 ✓）→ 之后会被召回给主 AI ✓ */
    try {
      const sm = summary.maintain(sideRaw, sideRound, target);
      if (sm && sm.small && sm.small.found) console.log('[RBQ] 小总结已存（第 ' + sideRound + ' 轮，库里共 ' + (sm.events || 0) + ' 条）');
      /* 立刻落盘一次 ✓（否则要等这一轮后面某次 commit 才写进聊天 ✓ 中途刷新会丢 ✓） */
      await store.commit({ persist: true });
    } catch (e) { console.warn('[RBQ] 小总结落库失败', e); }
    let body = extractProseStrict(sideRaw);   // 【用户要求】被标签包裹的内容一律剔除（只有正文不带标签 ✓）
    // 正文提空时不要静默跳过：退回"去掉已知元信息块"的原始文本，并告诉用户发生了什么
    if (!body || body.trim().length < 8) {
      try {
        body = sideRaw
          .replace(/<thinking_matrix>[\s\S]*?<\/thinking_matrix>/gi, '')
          .replace(/<data_reasoning>[\s\S]*?<\/data_reasoning>/gi, '')
          .replace(/<[^>]*(?:data|tableEdit|This_round_events|character_memor[^>]*)[^>]*>[\s\S]*?<\/[^>]+>/gi, '')
          .replace(/<!--[\s\S]*?-->/g, '')
          .trim();
      } catch { /* ignore */ }
      if (body && body.trim().length >= 8) notify('info', '正文里可读的文字很少，已退回用整条消息做填表输入。');
    }

    // 启动前把"为什么不跑"说清楚（并且**一定打在控制台** ✓ 方便排查）
    const __gate = { enabled: sideApi.enabled(), usable: sideApi.isUsable(), hasBody: !!body, len: body ? body.length : 0 };
    console.log('[RBQ] 侧路闸门：enabled=' + __gate.enabled + ' usable=' + __gate.usable + ' bodyLen=' + __gate.len);
    if (!__gate.enabled) { console.warn('[RBQ] 侧路没跑：侧路 API 已关闭（设置 → 侧路 API）'); notify('warning', '侧路 API 已关闭（设置 → 侧路 API），本次不填表。'); }
    else if (!__gate.usable) { console.warn('[RBQ] 侧路没跑：没有可用的接口（没填独立地址，酒馆也没提供 generateRaw）'); notify('warning', '侧路没法用：没填独立接口，酒馆也没提供生成函数。'); }
    else if (!__gate.hasBody) { console.warn('[RBQ] 侧路没跑：这条 AI 消息没有可读正文'); notify('warning', '这条 AI 消息没有可读正文，本次跳过填表。'); }

    // isUsable：填了独立接口就用独立接口；留空就用酒馆里配好的那个 API
    if (sideApi.enabled() && sideApi.isUsable() && body) {
      const chan = sideApi.channel() === 'side' ? '独立接口' : '酒馆 API';
      const want = [];
      if (sideApi.config()?.tasks?.fill) want.push('fill');
      if (sideApi.config()?.tasks?.memory) want.push('memory');
      if (sideApi.config()?.tasks?.extras) want.push('extras');
      if (sideApi.config()?.tasks?.summary) want.push('summary');
      runtime.sideBusy = true;   // 侧路跑的时候，忽略期间冒出来的 GENERATION_ENDED ✓
      // 卡片只显示**真正要跑的任务**：不预建行，谁开始跑谁出现 ✓
      // （附加没开 / 大总结没到轮次 → update 不会被调用 → 卡片上就不会有它们 ✓）
      progress.show?.('侧路 API · ' + chan);
      // 每个任务一个独立气泡（一直挂到该任务结束），并带「中止」按钮
      const ac = new AbortController();
      /* 进度气泡上的「终止」按钮：中止本次侧路调用（同时把酒馆的生成也停掉） */
      try {
        progress.setAbort?.(() => {
          try { ac.abort(); } catch (e) { /* ignore */ }
          try { ctx()?.stopGeneration?.(); } catch (e) { /* ignore */ }
          try { progress.update('fill', 'failed', '已请求终止'); } catch (e) { /* ignore */ }
          console.log('[RBQ] 用户点了进度气泡上的「终止」');
        });
      } catch (e) { /* ignore */ }
      /* 用酒馆原生的「生成中」状态：发送键会变成终止圆钮（#mes_stop），点它中止本轮侧路 */
      const ctx0 = (() => { try { return SillyTavern.getContext(); } catch (e) { return null; } })();
      /* 引用计数：可能同时有多个侧路任务（例如重新生成时上一轮还没收尾 ✓）
         只有最后一个结束才把发送键恢复 ✓ 否则会出现"发送 + 停止"同框 ✗（用户实测 ✓） */
      const restoreStop = () => {
        try {
          runtime.stopRefs = Math.max(0, Number(runtime.stopRefs ?? 0) - 1);
          if (runtime.stopRefs > 0) { console.log("[RBQ] 还有 " + runtime.stopRefs + " 个侧路任务在跑，暂不恢复发送键"); return; }
          try { if (runtime.keepBusyTimer) { clearInterval(runtime.keepBusyTimer); runtime.keepBusyTimer = null; } } catch (e) { /* ignore */ }
          const st = document.getElementById('mes_stop');
          if (st) st.style.display = "none";
          const sb = document.getElementById('send_but');
          if (sb) sb.style.display = "flex";
          if (ctx0 && typeof ctx0.activateSendButtons === "function") ctx0.activateSendButtons();
        } catch (e) { /* ignore */ }
      };
      /* 【用户实测】正文一生成完，酒馆**自己**就把发送键放回来了 ✗，
         而侧路还在跑 ✓ → "发送"和"停止"同框 ✓
         这里在侧路期间挂一个轻量守护：时不时把"生成中"状态再按一次 ✓
         （只动显示 ✓ 不拦酒馆自己的行为 ✓ 侧路全部结束后立刻停 ✓） */
      const keepBusyStart = () => {
        try {
          if (runtime.keepBusyTimer) return;
          runtime.keepBusyTimer = setInterval(() => {
            try {
              if (Number(runtime.stopRefs ?? 0) <= 0) { clearInterval(runtime.keepBusyTimer); runtime.keepBusyTimer = null; return; }
              const st2 = document.getElementById('mes_stop');
              if (st2 && st2.style.display === 'none') st2.style.display = '';
              const sb2 = document.getElementById('send_but');
              if (sb2) sb2.style.display = 'none';
            } catch (e) { /* ignore */ }
          }, 400);
        } catch (e) { /* ignore */ }
      };
      const busyOn = () => {
        try {
          runtime.stopRefs = Number(runtime.stopRefs ?? 0) + 1;
          keepBusyStart();
          if (ctx0 && typeof ctx0.deactivateSendButtons === "function") ctx0.deactivateSendButtons();
          const st = document.getElementById('mes_stop');
          if (st) {
            st.style.display = "";
            if (!st.__rbqBound) {
              st.__rbqBound = true;
              st.addEventListener('click', (ev) => {
                try { ev.stopImmediatePropagation(); ev.preventDefault(); } catch (e) { /* ignore */ }
                try { const cur = window.__rbqSideAbort; if (typeof cur === 'function') cur(); } catch (e) { /* ignore */ }
              }, true);
            }
          }
        } catch (e) { /* ignore */ }
      };
      try { window.__rbqSideAbort = () => { try { ac.abort(); } catch (e) { /* ignore */ } }; } catch (e) { /* ignore */ }
      busyOn();
      const nmOf = (k) => ({ fill: '填表', memory: '记忆', summary: '大总结', extras: '附加' })[k] ?? k;
      /* 【用户要求】不再用酒馆的通知气泡做"运行中"提示 ✗ ——
         全部改用右下角那张自绘的进度卡片（卡片标题行右侧就是「终止」按钮 ✓）。
         这里保留一个最小壳，只是为了让后面的 closeNotify/restoreStop 调用不出错。 */
      const toasts = {};
      const addAbortBtn = () => {};
      const onProgress = (task, state, detail) => {
        // 用户要求：卡片只显示【真正在跑的任务】→ 未开启/空闲的不要出现在卡片上 ✓
        if (state === 'off' || state === 'idle') return;
        progress.update(task, state, detail);
        const nm = nmOf(task);
        if (state === 'running') {
          try { progress.show?.('侧路 API · 运行中'); progress.setAbort?.(() => { try { ac.abort(); } catch (e) { /* ignore */ } try { restoreStop(); } catch (e) { /* ignore */ } }); } catch (e) { /* ignore */ }
          return;
        }
        void nm;
        // ok / empty / failed 的细节都留在卡片里，不再弹通知气泡（少打扰 ✓）
      };
      /* 【关键】侧路填表这条路以前**不记录 beforeRev** ✗ → 所以"重新生成/删楼层"时回滚是空转的 ✓
         这里在侧路真正写表**之前**把"应用前的版本"记进这一层的 anchor（幂等，只有第一次才写 ✓） */
      try {
        const m0 = chat()?.[target];
        if (m0) {
          const a0 = store.getAnchor(m0) ?? { v: 1, roundId: null, rev: store.getRev(), at: Date.now(), hash: {}, undo: [] };
          if (!Number.isFinite(Number(a0.beforeRev))) {
            a0.beforeRev = store.getRev();
            console.log('[RBQ] 记录 beforeRev = ' + a0.beforeRev + '（第 ' + target + ' 层，供重新生成/删楼层回滚）');
          }
          /* 【最可靠的一招】给这一层拍一张"写入之前的表格快照" ✓（照记忆增强插件的 hash_sheets 做法 ✓）
             回滚时直接还原这张快照 → 不用管 rev/undo 是否被清理 ✓ 一字不差 ✓ */
          if (!a0.beforeSnapshot) {
            a0.beforeSnapshot = store.snapshotTables();
            console.log('[RBQ] 已拍快照（第 ' + target + ' 层，写入之前的表格状态=' + (a0.beforeSnapshot ? a0.beforeSnapshot.length + ' 字节' : '失败') + '）');
          }
          a0.sideRound = sideRound;
          a0.sideHash = (() => { try { const s = String(chat()?.[target]?.mes ?? ''); let h = 0; for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0; return h + ':' + s.length; } catch (e) { return null; } })();
          store.setAnchor(m0, a0);
        }
      } catch (e) { console.warn('[RBQ] 侧路记录 beforeRev 失败', e); }
      sidePipeline.runForMessage(target, body, { round: sideRound, onProgress, signal: ac.signal }).then((r) => {
        /* 【用户要求】等这一轮「填表 + 所有角色记忆」都写完 → 用最新的表0时间统一回填本轮记忆 ✓
           （记忆是填表之后写的 ✓ 但收尾可能还会补写表0 → 所以最后再统一盖一次最准 ✓） */
        try {
          setTimeout(() => {
            try {
              const tt = extras.timeBoxText();
              const n = memory.stampRoundTime(sideRound, tt);
              if (n) { store.commit({ persist: true }); console.log('[RBQ] 已给 ' + n + ' 条记忆写上时间框：' + tt); }
            } catch (e) { /* ignore */ }
          }, 800);
        } catch (e) { /* ignore */ }
        if (r && r.tasks) {
          let line = sidePipeline.statusLine(r);
          console.log('[RBQ] 侧路完成：' + line);
          // 填表自检：缺什么就再补一次（只补缺口）
          // 先补派生字段（年龄），再自检
          try { sidePipeline.fixDerivedFields?.(); } catch (e) { /* ignore */ }
          const __miss0 = (() => { try { return sidePipeline.auditAfterFill?.() || ''; } catch (e) { return ''; } })();
          if (__miss0) { try { console.warn('[RBQ] 这轮填表缺：' + __miss0); } catch (e) { /* ignore */ } }
          const __finish = (m) => {
            if (m) { try { console.warn('[RBQ] 补写后仍缺：' + m); } catch (e) { /* ignore */ } }
            /* 收尾：把"应用**之后**的版本"也记进这一层的 anchor ✓
               （删楼层要用 rev ✓，重新生成要用 beforeRev ✓ —— 两个都要有才完整） */
            try {
              const m0 = chat()?.[target];
              if (m0) {
                const a0 = store.getAnchor(m0) ?? { v: 1, roundId: null, at: Date.now(), hash: {}, undo: [] };
                a0.rev = store.getRev();
                a0.at = Date.now();
                // 再拍一张"写入之后"的快照（删楼层时还原用 ✓，同样是插件那套做法 ✓）
                try { a0.afterSnapshot = store.snapshotTables(); } catch (e) { /* ignore */ }
                store.setAnchor(m0, a0);
                /* 【删楼层定位用】这一轮写完了 → 记住"当前这一串消息引用"✓
                   下次删楼层时，被删的那条 = 这次有、下次没有的 ✓（不依赖酒馆事件参数 ✓） */
                try { runtime.lastChatRefs = [...chat()]; } catch (e) { /* ignore */ }
                console.log('[RBQ] 第 ' + target + ' 层锚点已更新：beforeRev=' + a0.beforeRev + ' rev=' + a0.rev + ' 快照=' + (a0.beforeSnapshot ? 'before✓' : 'before✗') + '/' + (a0.afterSnapshot ? 'after✓' : 'after✗'));
              }
            } catch (e) { /* ignore */ }
            progress.end('侧路完成 · ' + line + (m ? ' ⚠ 仍缺：' + m : ''), { hideAfter: 8000 });   // 用户要求：完事几秒后自动消失
            runtime.sideBusy = false;
            restoreStop();
            for (const k of Object.keys(toasts)) { try { closeNotify(toasts[k]); } catch (e) { /* ignore */ } delete toasts[k]; }
            // 收尾再算一次派生数值：补写可能新建了 表13 的行，不重算那一行的 ATK/DEF 就是空的
            try { sidePipeline.finalFill?.(); } catch (e) { /* ignore */ }   // 最终收口：补上仍空的格子
            try { sidePipeline.fixDerivedFields?.(); console.log('[RBQ] 收尾再算派生数值'); } catch (e) { /* ignore */ }
            // 延迟再收口 + 重算：补写的写入是异步落盘的，等一会儿再跑一遍才能覆盖"刚新建的行"，
            // 否则收口/重算会在空表上空转（实测：7 格残留就是这么来的）
            try {
              for (const d of [2500, 6000, 12000]) {
                setTimeout(() => {
                  try { sidePipeline.finalFill?.(); } catch (e) { /* ignore */ }          // 先收口（补空 + 初始化空表）
                  try { sidePipeline.fixDerivedFields?.(); } catch (e) { /* ignore */ }  // 再按最新数据重算派生值
                }, d);
              }
              console.log('[RBQ] 已排三次延迟收口 + 重算（2.5s / 6s / 12s）');
            } catch (e) { /* ignore */ }
            try { extras.applyTimeBoxToMessage(target, { force: true }); } catch (e) { /* ignore */ }
          };
          /* 补写：最多两轮，每轮只补"逐格列出的缺口"（仿老 RBQ 的 scan → issueReport → 补全） */
          const __repairLoop = (miss, round) => {
            if (!miss || round > 5 || !sidePipeline.taskRepairFill) { __finish(miss); return; }   // 现在每轮内部还会按表分批
            (sidePipeline.taskRepairFillBatched || sidePipeline.taskRepairFill)(body, sideApi.config(), miss, ac.signal)
              .then((rr) => {
                console.log('[RBQ] 第' + round + '轮补写：应用 ' + ((rr && rr.applied) || 0) + ' 项，剩余：' + ((rr && rr.rest) || '(无)'));
                if (rr && rr.applied) line += ' ＋补写' + rr.applied + '项';
                __repairLoop(rr ? (rr.rest || '') : miss, round + 1);
              })
              .catch((e) => { try { console.warn('[RBQ] 定向补写失败', e); } catch (e2) { /* ignore */ } __finish(miss); });
          };
          if (__miss0) {
            __repairLoop(__miss0, 1);
          } else __finish(__miss0);
        }
      }).catch((e) => { console.warn('[RBQ] 侧路失败（不影响正文）', e); progress.end('侧路失败', { hideAfter: 8000 }); runtime.sideBusy = false; notify('error', '侧路失败：' + String(e?.message ?? e).slice(0, 80)); restoreStop(); });
    }
    try { const ct = SillyTavern.getContext(); if (ct && ct.activateSendButtons) ct.activateSendButtons(); } catch (e2) { /* ignore */ }
    try { const st2 = document.getElementById('mes_stop'); if (st2) st2.style.display = 'none'; const sb2 = document.getElementById('send_but'); if (sb2) sb2.style.display = 'flex'; } catch (e3) { /* ignore */ }
  } catch (e) { console.warn('[RBQ] 侧路启动失败', e); }
  refreshOptionsSoon(300);
  checkRoundReminder();
  try { await extras.applyTimeBoxToMessage(target, { force: true }); } catch (e) { console.warn('[RBQ] 时间框失败', e); }
}

/* ------------------------------------------------------------------ 启动 */

function wirePanelOpener() {
  setPanelOpener(() => {
    mountPanel();
    togglePanel();
  });
}

function exposeApi() {
  const api = {
    version: VERSION,
    // 数据
    getAll: () => store.getAllTables(),
    getTable: (no) => store.getRows(no, { create: false }),
    getRev: () => store.getRev(),
    stats: () => store.stats(),
    // 写入
    applyOps: (ops, opts) => txn.applyOps(ops, opts),
    setCell: (no, row, col, value) => txn.setCell(no, row, col, value),
    updateRow: (no, row, values) => txn.updateRow(no, row, values),
    insertRow: (no, values) => txn.insertRow(no, values),
    deleteRow: (no, row) => txn.deleteRow(no, row),
    rollbackTo: (rev) => txn.rollbackTo(rev),
    // 协议（便于调试：贴一段文本看会解析成什么）
    parse: (text) => protocol.parseAll(text),
    // 审查 / 规则
    review: (opts) => review.review(opts),
    formatIssues: (issues) => review.formatIssues(issues),
    reviewRules: () => review.RULES.map((r) => ({ id: r.id, desc: r.desc, severity: r.severity, strategy: r.strategy })),
    recalc: (opts) => rules.recalcCharacters(opts),
    applyRecalc: async (opts) => {
      const ops = rules.recalcCharacters(opts);
      if (!ops.length) return { applied: 0, failed: [] };
      return txn.applyOps(ops, { source: 'recalc' });
    },
    previewTableData: () => prompts.buildTableData(),
    extras: () => extras.list(),
    applyExtras: () => extras.applyAll({ quiet: false }),
    nativeInject: (patch) => (patch === undefined ? inject.nativeConfig() : inject.setNativeConfig(patch)),
    applyNativeInject: () => inject.applyNativeInjection(),
    expandSkill: (fact) => rules.expandSkill(fact),
    deriveStats: (level, coef) => rules.deriveStats(level, rules.parseCoef(coef)),
    MEIKI_LIST: review.MEIKI_LIST,
    // 修复
    repairState: (messageIndex) => repair.describeState(Number.isInteger(messageIndex) ? messageIndex : chat().length - 1),
    repairNow: (opts) => repair.repairRound({ messageIndex: chat().length - 1, reason: 'manual', ...opts }),
    llmAvailable: () => repair.describeState(0).llmAvailable,
    // 宏内容（便于预览）
    previewTablePrompt: () => macroTablePrompt(),
    previewTableData: () => buildTableData(),
    // 导入导出
    exportJson: () => store.exportJsonString(),
    importJson: (json) => store.importPluginJson(json, { replace: true }),
    // UI
    inspiration: (opts = {}) => inspiration.checkAndGenerate(!!opts.force),
    governance: () => addons.governanceReport(),
    fixGovernance: () => addons.fixGovernance(),
    sideApi: (patch) => (patch === undefined ? sideApi.config() : sideApi.setConfig(patch)),
    sideStatus: () => sidePipeline.status(),
    /* 手动运行也要弹进度卡片（用户反馈：只有自动侧路会弹 → 手动跑时右下角什么都没有 ✗） */
    sideRun: (id, text, opts) => {
      try { progress.begin('侧路 API · 手动运行', ['fill']); } catch (e) { /* ignore */ }
      try { progress.setAbort?.(() => { try { ctx()?.stopGeneration?.(); } catch (e) { /* ignore */ } }); } catch (e) { /* ignore */ }
      return Promise.resolve(sidePipeline.rerun(id, text, opts))
        .then((r) => { try { progress.end('手动运行完成'); } catch (e) { /* ignore */ } return r; })
        .catch((e) => { try { progress.end('手动运行失败', { hideAfter: 12000 }); } catch (e2) { /* ignore */ } throw e; });
    },
    sideTest: () => {
      try { progress.begin('侧路 API · 连接测试', ['test']); progress.update('test', 'running', '正在请求…'); } catch (e) { /* ignore */ }
      return Promise.resolve(sideApi.testConnection())
        .then((r) => {
          try {
            const okk = r && (r.ok ?? r.success ?? r.reachable);
            progress.update('test', okk ? 'ok' : 'failed', String((r && (r.message ?? r.detail ?? r.error)) || (okk ? '连接正常' : '失败')).slice(0, 60));
            progress.end(okk ? '侧路 API · 连接正常' : '侧路 API · 连接失败');
          } catch (e) { /* ignore */ }
          return r;
        })
        .catch((e) => { try { progress.update('test', 'failed', String(e?.message ?? e).slice(0, 60)); progress.end('侧路 API · 连接失败', { hideAfter: 12000 }); } catch (e2) { /* ignore */ } throw e; });
    },
    /* 直接喂一段文本，返回"侧路填表会发出去的完整提示词" ✓（排查预设标记/正文清洗都靠它 ✓） */
    sidePreviewPrompt: (text) => { try { return sidePipeline.fillPrompt(String(text ?? ""), sideApi.config()); } catch (e) { return "ERR " + e.message; } },
    sidePreview: (task, text, round) => sidePipeline.preview(task, text, round),
    updateStatus: () => updater.status(),
    updateBootCheck: () => updater.bootCheck(),
    updateRepo: () => updater.REPO_URL,
    updateDismiss: () => updater.dismiss(),
    updateCheck: (opts) => updater.check(opts),
    updateApply: () => updater.applyUpdate(),
    bundledPresets: () => presetImport.list(),
    presetCheck: () => presetImport.checkUpdates(),
    presetLoadManifest: () => presetImport.loadManifest({ force: true }),
    importPreset: (key) => { const e = presetImport.list().find((x) => x.key === key); return e ? presetImport.importOne(e) : { ok: false, error: '没有这个内置预设' }; },
    inspirationStatus: () => inspiration.status(),
    openPanel: () => { mountPanel(); showPanel(); },
    togglePanel: () => { mountPanel(); togglePanel(); },
    refresh: () => refreshPanel(),
    personaStatus: () => persona.personaStatus(),
    personaApply: (opts) => persona.applyPersona(opts || {}),
    personaUnwrap: () => persona.unwrapPersona(),
    // 运维
    config: {
      get: (key, def) => store.getConfigValue(key, def),
      set: (patch) => { store.updateConfig(patch ?? {}); return true; },
    },
    /* 手动重跑某一层：走新的"文本 → 解析 → 展开 → 落库"入口 ✓
       （v1.95 起填表只走侧路 ✓ 正文里的 <data> 不再被自动解析 ✗
         但手动重跑 / 测试仍需要一个"给我一段文本就落库"的口子 ✓） */
    reprocess: (messageId) => {
      const id = Number.isInteger(messageId) ? messageId : chat().length - 1;
      const txt = (() => { try { return String(chat()?.[id]?.mes ?? ''); } catch (e) { return ''; } })();
      return processFactsText(txt, id);
    },
    reset: () => { runtime.lastProcessedMessageId = null; },
    state: runtime,
  };
  try { window.RBQ = api; } catch { /* ignore */ }
  try { if (window.parent && window.parent !== window) window.parent.RBQ = api; } catch { /* ignore */ }
  return api;
}

function applyUserSchemaIfAny() {
  const schema = store.getUserSchema();
  if (schema) useSchema(schema);
}

/** 启动失败时在页面上显示出来（不然用户只看到"没反应"） */
function showBootError(e) {
  console.error('[RBQ] 启动失败', e);
  try {
    const doc = document;
    let el = doc.getElementById('rbq-boot-error');
    if (!el) {
      el = doc.createElement('div');
      el.id = 'rbq-boot-error';
      el.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:99999;background:#7a2a1f;color:#fff;padding:10px 14px;border-radius:8px;font:13px/1.6 sans-serif;max-width:62vw;white-space:pre-wrap;box-shadow:0 6px 20px rgba(0,0,0,.4)';
      (doc.body ?? doc.documentElement).appendChild(el);
    }
    el.textContent = 'RBQ 启动失败：' + (e?.message ?? e) + String.fromCharCode(10) + '按 F12 打开控制台可看详情。';
  } catch { /* ignore */ }
}

/**
 * 【老 RBQ 的功能】把 {{user}} 角色设定用 <{{user}}角色设定> 标签包起来
 *   + 把插入位置改成「聊天内 · 深度 0」✓
 *
 * 【用户要求】每次打开酒馆**自动**做 ✓ 不用手动点 ✓ 自动路径**不弹气泡**（只写控制台）✓
 * 【用户实测】"打开酒馆没自动" ✗ —— 其实跑过了 ✓ 只是成功/失败都**没说话** ✗ 他无从判断 ✓
 *   → 现在开始/失败/结果都会打日志 ✓
 * 启动时机不一定准（酒馆的 power-user 可能还没就绪 ✗）→ 最多 10 次、每 2 秒一次，成功即停 ✓
 */
let __personaAutoStarted = false;
function personaAutoApply() {
  if (__personaAutoStarted) return;
  __personaAutoStarted = true;
  let tries = 0;
  const MAX = 10;
  const GAP = 2000;
  const run = async () => {
    tries++;
    let why = '';
    try {
      if (store.getConfigValue('persona.wrap', true) === false) {
        console.log('[RBQ] 角色设定自动处理：设置里关掉了，跳过 ✓');
        return;
      }
      const r = await persona.applyPersona({ onlyCurrent: false });
      if (r && r.ok) {
        if (r.wrapped > 0 || r.moved > 0) console.log('[RBQ] 角色设定已在启动时自动处理 ✓（包标签 ' + r.wrapped + ' 条 / 改插入位置 ' + r.moved + ' 处，第 ' + tries + ' 次尝试）');
        else console.log('[RBQ] 角色设定已经符合要求 ✓（无需改动）');
        return;
      }
      why = (r && r.reason) ? r.reason : '返回了失败结果';
    } catch (e) { why = String(e?.message ?? e); }
    if (tries === 1) console.log('[RBQ] 角色设定自动处理：第 1 次没成功（' + why + '），继续重试 ✓');
    else if (tries >= MAX) { console.warn('[RBQ] 角色设定自动处理：重试 ' + MAX + ' 次仍没成功（' + why + '）→ 可在设置页点「立即应用」✓'); __personaAutoStarted = false; }
    if (tries < MAX) setTimeout(run, GAP);
  };
  setTimeout(run, 500);
}

function safeBoot() {
  try {
    console.log('[RBQ] 启动中…');
    boot();
    /* 启动时给缺快照的旧楼层回填一次（聊天这时已经加载好了 ✓） */
    try { backfillAnchors(); } catch (e) { /* ignore */ }
    /* 插件更新：启动后自动查一次（多源兜底 ✓）有新版本提示一次 ✓ 失败静默 ✓ */
    setTimeout(() => { try { updater.bootCheck(); } catch (e) { /* ignore */ } }, 6000);
    /* 【新增内置列 · 迁移】老用户如果存过"本聊天的表结构覆盖" ✓ 新加的列不会自动出现 ✗
       → 启动时补一次 ✓（只补缺的那一列，别的不动 ✓）
       用户需求：表3 缺"容貌描述"→ 剧情里角色难以区分 ✓ 现在补上 ✓ */
    setTimeout(() => { try { store.ensureBuiltinColumns(3, '容貌描述', '三围'); } catch (e) { /* ignore */ } }, 2500);
    /* 先拿到酒馆真实的 oai_settings（ctx 里那份是克隆 ✗ 读不到预设 ✓）*/
    setTimeout(() => { try { sidePipeline.initPresetSource(); } catch (e) { /* ignore */ } }, 1200);
    /* 【用户反馈 · 反复提醒预设更新】启动后自动比一次：
       如果你现在实际在用的预设就是内置那份 → 直接记下版本 ✓ 胶囊就不会一直挂着了 ✓ */
    setTimeout(() => {
      try {
        presetImport.detectAlreadyImported()
          .then(() => { try { refreshPanel(); } catch (e) { /* ignore */ } })
          .catch(() => {});
      } catch (e) { /* ignore */ }
    }, 7000);
    /* 记忆条目要显示「这一轮的表0时间框」✓（格式与时间框完全一致 ✓）*/
    try { memory.setTimeBoxProvider(() => extras.timeBoxText()); } catch (e) { /* ignore */ }
    /* 角色设定自动处理（老 RBQ 的功能 ✓ 自动、不弹气泡 ✓） */
    try { personaAutoApply(); } catch (e) { /* ignore */ }
    console.log('[RBQ] 启动完成。');
  }
  catch (e) { showBootError(e); }
}
function boot() {
  if (initialized) return;
  if (!ctx()) {
    console.warn('[RBQ] 拿不到酒馆上下文，1 秒后重试。');
    setTimeout(safeBoot, 1000);
    return;
  }
  initialized = true;
  console.log(`[RBQ] RBQ 数据库 v${VERSION} 启动中…`);

  applyUserSchemaIfAny();
  store.getData();                      // 触发一次初始化
  registerMacros();
  wirePanelOpener();
  bindEvents();

  try {
    mountPanel();
  } catch (e) {
    console.error('[RBQ] 面板挂载失败', e);
  }

  // 输入框按钮：延后一点，等酒馆把输入区渲染好
  setTimeout(() => startInputButtonInjection(), 500);

  exposeApi();
  console.log(`[RBQ] 就绪。表 ${getTables().length} 张；宏：{{tableData}} {{tablePrompt}} {{GET_ALL_TABLES_JSON}}；控制台可用 window.RBQ`);
}

/* 酒馆的 APP_READY 最可靠；同时用 document ready + 兜底超时 */
if (!onType('APP_READY', () => safeBoot())) {
  const d = doc() ?? (typeof document !== 'undefined' ? document : null);
  if (d && d.readyState !== 'loading') setTimeout(boot, 300);
  else d?.addEventListener?.('DOMContentLoaded', () => setTimeout(safeBoot, 300));
}
setTimeout(safeBoot, 2500);   // 双保险（必须 safeBoot ✗ 否则初始化不跑）

export { boot, processMessage, txn, store, protocol, getTable, chatMetadata, stopInputButton };
