/**
 * review.js —— 声明式表格审查
 *
 * 与旧实现的三点本质区别（对应痛点 ①）：
 *   1. **只产出建议 + 候选修复 ops，永不直接改消息**。落盘统一交给 txn.applyOps，
 *      所以每次修复都有 rev、有审计、可回滚。
 *   2. **规则声明化**：一条规则 = {id, desc, scope, severity, strategy, run()}。
 *      只有 strategy='safe'（幂等无损）才会在 autoFix='safe' 时被自动应用。
 *   3. **按列名定位**（走 alias 解析），不再靠硬编码列下标。
 */

import { getTable, getTables } from './schema.js';
import { matchRow } from './match.js';
import { resolveAttr } from './alias.js';
import * as store from './store.js';

/** 19 种名器（与 tableCustomConfig 的名器库一字不差） */
export const MEIKI_LIST = [
  '鸾凤凰吟', '金城汤池', '九环玉壶', '飞龙穴', '一枝独秀', '三江春水', '四季玉涡',
  '五龙戏珠', '六面埋伏', '七窍玲珑', '八方风雨', '九曲回廊', '十重天宫', '鹰勾穴',
  '盆子穴', '鸡雉穴', '葵蕊蜜壶', '融雪膏', '春露蛞蝓',
];

const col = (no, name) => resolveAttr(no, name)?.index ?? -1;
const cell = (row, idx) => (idx < 0 ? '' : String(row?.[idx] ?? '').trim());
const toNum = (v) => {
  const n = Number(String(v ?? '').replace(/[^\d.+-]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

/* ------------------------------------------------------------------ 规则 */

export const RULES = [
  {
    id: 'singleton-extra-rows',
    desc: '单例表（表0 宏观时空 / 表6 剧情大纲）只能有一行',
    severity: 'error',
    strategy: 'safe',
    run() {
      const issues = [];
      const fixes = [];
      for (const t of getTables()) {
        if (!t.singleton) continue;
        const rows = store.getRows(t.no, { create: false });
        if (rows.length <= 1) continue;
        issues.push({
          rule: 'singleton-extra-rows', table: t.no, severity: 'error',
          message: `表${t.no}「${t.name}」是单例表，却有 ${rows.length} 行。`,
        });
        // 修复：把后续行的非空值并入第 0 行，再删掉多余行
        const merged = [...(rows[0] ?? [])];
        for (let i = 1; i < rows.length; i++) {
          (rows[i] ?? []).forEach((v, ci) => {
            const sv = String(v ?? '').trim();
            if (sv && !String(merged[ci] ?? '').trim()) merged[ci] = sv;
          });
        }
        fixes.push({ op: 'replace', table: t.no, rows: [merged], allowReplace: true, __tag: 'review' });
      }
      return { issues, fixes };
    },
  },

  {
    id: 'vital-out-of-range',
    desc: 'HP/MP/SP 当前值越界（负数或超过上限）',
    severity: 'error',
    strategy: 'safe',
    run() {
      const issues = [];
      const fixes = [];
      const pairs = [
        [13, 'HP(当前)', 'HP(上限)'],
        [13, 'MP(当前)', 'MP(上限)'],
        [13, 'SP(当前)', 'SP(上限)'],
        [14, 'HP(当前)', 'HP(上限)'],
        [14, 'MP(当前)', 'MP(上限)'],
        [14, 'SP(当前)', 'SP(上限)'],
      ];
      for (const [no, curName, maxName] of pairs) {
        const t = getTable(no);
        if (!t) continue;
        const ci = col(no, curName);
        const mi = col(no, maxName);
        if (ci < 0) continue;
        store.getRows(no, { create: false }).forEach((row, ri) => {
          const cur = toNum(cell(row, ci));
          const max = mi >= 0 ? toNum(cell(row, mi)) : 0;
          const name = cell(row, col(no, '角色名称') >= 0 ? col(no, '角色名称') : col(no, '实体名称'));
          if (cur < 0) {
            issues.push({ rule: 'vital-out-of-range', table: no, row: ri, severity: 'error', message: `${name} 的 ${curName} 是负数（${cur}）。` });
            fixes.push({ op: 'set', table: no, rowIndex: ri, col: curName, value: '0', __tag: 'review' });
          } else if (max > 0 && cur > max) {
            issues.push({ rule: 'vital-out-of-range', table: no, row: ri, severity: 'error', message: `${name} 的 ${curName}（${cur}）超过上限 ${max}。` });
            fixes.push({ op: 'set', table: no, rowIndex: ri, col: curName, value: String(max), __tag: 'review' });
          }
        });
      }
      return { issues, fixes };
    },
  },

  {
    id: 'meiki-invalid',
    desc: '女性/双性角色的「名器类型」必须从 19 种名器里选，不能为空或自创',
    severity: 'error',
    strategy: 'safe',
    run() {
      const issues = [];
      const fixes = [];
      const t3 = getTable(3);
      if (!t3) return { issues, fixes };
      const rows = store.getRows(3, { create: false });
      const gi = col(3, '性别');
      const mi = col(3, '名器类型');
      const ni = col(3, '角色名称');
      if (gi < 0 || mi < 0) return { issues, fixes };

      // 现有占用统计 —— 修复时优先选"用得最少"的名器，避免所有人撞同一个
      const usage = new Map(MEIKI_LIST.map((m) => [m, 0]));
      for (const row of rows) {
        const g = cell(row, gi);
        const m = cell(row, mi);
        if ((g === '女' || g === '双性') && usage.has(m)) usage.set(m, usage.get(m) + 1);
      }

      rows.forEach((row, ri) => {
        const g = cell(row, gi);
        const m = cell(row, mi);
        if (g !== '女' && g !== '双性') return;
        if (m && MEIKI_LIST.includes(m)) return;
        const name = cell(row, ni);
        issues.push({
          rule: 'meiki-invalid', table: 3, row: ri, severity: 'error',
          message: `${name || `第${ri + 1}行`} 为${g}，名器类型是「${m || '空'}」，不在 19 种名器库中。`,
        });
        // 选当前用得最少的（并列取列表里靠前的），保证确定性
        let pick = MEIKI_LIST[0];
        let min = Infinity;
        for (const cand of MEIKI_LIST) {
          const c = usage.get(cand) ?? 0;
          if (c < min) { min = c; pick = cand; }
        }
        usage.set(pick, (usage.get(pick) ?? 0) + 1);
        fixes.push({ op: 'set', table: 3, rowIndex: ri, col: '名器类型', value: pick, __tag: 'review' });
      });
      return { issues, fixes };
    },
  },

  {
    id: 'departure-present-mismatch',
    desc: '表4 的离场状态与表0 的在场名单必须一致',
    severity: 'error',
    strategy: 'safe',
    run() {
      const issues = [];
      const fixes = [];
      const t0 = getTable(0);
      const presentIdx = col(0, '在场实体名单');
      const rows0 = store.getRows(0, { create: false });
      if (!t0 || presentIdx < 0 || !rows0.length) return { issues, fixes };

      const presentList = String(rows0[0]?.[presentIdx] ?? '')
        .split(/[/,，、]/).map((s) => s.trim()).filter(Boolean);

      const di = col(4, '离场状态');
      const ni = col(4, '角色名称');
      const rows4 = store.getRows(4, { create: false });
      const expectedPresent = [];   // 表4 里标记为"在场"（或空）的人
      const leftSet = new Set();    // 表4 里标记为"已离场"的人

      for (const row of rows4) {
        const name = cell(row, ni);
        if (!name) continue;
        const dep = cell(row, di);
        if (dep.includes('已离场')) leftSet.add(name);
        else expectedPresent.push(name);   // '在场' 或空
      }

      const missing = expectedPresent.filter((n) => !presentList.includes(n));
      const extra = presentList.filter((n) => leftSet.has(n));

      if (missing.length || extra.length) {
        issues.push({
          rule: 'departure-present-mismatch', table: 0, severity: 'error',
          message: '在场名单与表4 不一致：'
            + (missing.length ? ` 应含而缺失 [${missing.join('、')}]` : '')
            + (extra.length ? ` 不该含却存在 [${extra.join('、')}]` : ''),
        });
        const next = [...new Set(presentList.filter((n) => !extra.includes(n)).concat(missing))];
        fixes.push({ op: 'set', table: 0, rowIndex: 0, col: '在场实体名单', value: next.join('/'), __tag: 'review' });
      }
      return { issues, fixes };
    },
  },

  {
    id: 'expired-buff',
    desc: '表8 剩余持续为 0 轮 / 已痊愈的异常状态应删除',
    severity: 'warn',
    strategy: 'safe',
    run() {
      const issues = [];
      const fixes = [];
      const t8 = getTable(8);
      if (!t8) return { issues, fixes };
      const remainIdx = col(8, '剩余持续');
      const sevIdx = col(8, '层数/严重度');
      const nameIdx = col(8, '异常状态名称');
      const rows = store.getRows(8, { create: false });
      for (let i = rows.length - 1; i >= 0; i--) {
        const remain = cell(rows[i], remainIdx);
        const sev = cell(rows[i], sevIdx);
        const dead = /^0\s*轮?$/.test(remain) || /已痊愈|^无$/.test(sev);
        if (!dead) continue;
        issues.push({
          rule: 'expired-buff', table: 8, row: i, severity: 'warn',
          message: `异常状态「${cell(rows[i], nameIdx)}」已到期（剩余持续=${remain || '空'}，严重度=${sev || '空'}），应删除该行。`,
        });
        fixes.push({ op: 'delete', table: 8, rowIndex: i, __tag: 'review' });
      }
      return { issues, fixes };
    },
  },

  {
    id: 'duplicate-key',
    desc: '同一张表里不应出现主键完全相同的两行',
    severity: 'error',
    strategy: 'suggest',
    run() {
      const issues = [];
      for (const t of getTables()) {
        const rows = store.getRows(t.no, { create: false });
        if (rows.length < 2) continue;
        const seen = new Map();
        rows.forEach((row, i) => {
          const key = t.keyIdx.map((ki) => String(row?.[ki] ?? '').trim()).join('|');
          if (!key.replace(/\|/g, '')) return;
          if (seen.has(key)) {
            issues.push({
              rule: 'duplicate-key', table: t.no, row: i, severity: 'error',
              message: `表${t.no}「${t.name}」里主键「${key}」重复（第 ${seen.get(key) + 1} 行与第 ${i + 1} 行）。`,
            });
          } else seen.set(key, i);
        });
      }
      return { issues, fixes: [] };
    },
  },

  {
    id: 'empty-key',
    desc: '主键为空的行是脏数据',
    severity: 'warn',
    strategy: 'suggest',
    run() {
      const issues = [];
      for (const t of getTables()) {
        store.getRows(t.no, { create: false }).forEach((row, i) => {
          const key = t.keyIdx.map((ki) => String(row?.[ki] ?? '').trim()).join('');
          if (key) return;
          issues.push({
            rule: 'empty-key', table: t.no, row: i, severity: 'warn',
            message: `表${t.no}「${t.name}」第 ${i + 1} 行主键为空。`,
          });
        });
      }
      return { issues, fixes: [] };
    },
  },

  {
    id: 'relation-not-bidirectional',
    desc: '表5 的关系必须双向各有一条（A→B 与 B→A）',
    severity: 'warn',
    strategy: 'suggest',
    run() {
      const issues = [];
      const t5 = getTable(5);
      if (!t5) return { issues, fixes: [] };
      const ai = col(5, '发起方A');
      const bi = col(5, '承受方B');
      const rows = store.getRows(5, { create: false });
      const has = (a, b) => rows.some((r) => cell(r, ai) === a && cell(r, bi) === b);
      for (const r of rows) {
        const a = cell(r, ai);
        const b = cell(r, bi);
        if (!a || !b || a === b) continue;
        if (!has(b, a)) {
          issues.push({
            rule: 'relation-not-bidirectional', table: 5, severity: 'warn',
            message: `存在「${a}→${b}」但缺少反向的「${b}→${a}」。`,
          });
        }
      }
      return { issues, fixes: [] };
    },
  },

  {
    id: 'missing-critical-field',
    desc: '表2 的关键列（种族 / 等级 / 背景履历）不应为空',
    severity: 'warn',
    strategy: 'suggest',
    run() {
      const issues = [];
      const t2 = getTable(2);
      if (!t2) return { issues, fixes: [] };
      const ni = col(2, '角色名称');
      const checks = [
        ['种族', 1],
        ['等级', 1],
        ['背景履历', 20],     // 少于 20 字视为不合格（与表格说明的"至少50字"相比放宽，避免误报）
      ];
      store.getRows(2, { create: false }).forEach((row, i) => {
        const name = cell(row, ni) || `第${i + 1}行`;
        for (const [colName, minLen] of checks) {
          const ci = col(2, colName);
          const v = ci >= 0 ? cell(row, ci) : '';
          if (!v) {
            issues.push({ rule: 'missing-critical-field', table: 2, row: i, severity: 'warn', message: `${name} 的「${colName}」为空。` });
          } else if (v.length < minLen) {
            issues.push({ rule: 'missing-critical-field', table: 2, row: i, severity: 'warn', message: `${name} 的「${colName}」只有 ${v.length} 字，明显偏短。` });
          }
        }
      });
      return { issues, fixes: [] };
    },
  },

  {
    id: 'sp-over-max',
    desc: 'SP 上限固定为 100（与公式一致）',
    severity: 'warn',
    strategy: 'safe',
    run() {
      const issues = [];
      const fixes = [];
      for (const no of [13, 14]) {
        const mi = col(no, 'SP(上限)');
        if (mi < 0) continue;
        store.getRows(no, { create: false }).forEach((row, ri) => {
          const v = toNum(cell(row, mi));
          if (v && v !== 100) {
            const name = cell(row, col(no, '角色名称') >= 0 ? col(no, '角色名称') : col(no, '实体名称'));
            issues.push({ rule: 'sp-over-max', table: no, row: ri, severity: 'warn', message: `${name} 的 SP 上限是 ${v}，按公式应为 100。` });
            fixes.push({ op: 'set', table: no, rowIndex: ri, col: 'SP(上限)', value: '100', __tag: 'review' });
          }
        });
      }
      return { issues, fixes };
    },
  },

  {
    id: 'reverse-relation-missing-on-new',
    desc: '表5 新增关系时提醒补反向（与上一条同源，但只针对本轮新增）',
    severity: 'info',
    strategy: 'off',        // 默认关闭，避免噪音
    run() { return { issues: [], fixes: [] }; },
  },
];

/* ------------------------------------------------------------------ 执行 */

/**
 * 跑一遍审查。
 * @param {object} [opts]
 * @param {boolean} [opts.apply] 是否顺手把 safe 修复写进去（默认 false：只看不写）
 * @param {string}  [opts.autoFix] 'off' | 'safe' | 'all'
 * @param {boolean} [opts.silent]
 * @returns {Promise<{issues:Array, fixes:Array, applied:number, failed:Array}>}
 */
export async function review(opts = {}) {
  const cfg = store.getConfig();
  const autoFix = opts.autoFix ?? cfg.review.autoFix ?? 'safe';
  const issues = [];
  const fixes = [];
  const ruleReport = [];

  for (const rule of RULES) {
    if (rule.strategy === 'off' && opts.force !== true) {
      ruleReport.push({ id: rule.id, desc: rule.desc, skipped: 'off', found: 0, fixed: 0 });
      continue;
    }
    if (autoFix === 'safe' && rule.strategy !== 'safe') {
      // 仍然跑（要报告问题），但不采纳它的修复
      try {
        const r = rule.run() ?? { issues: [], fixes: [] };
        issues.push(...(r.issues ?? []));
        ruleReport.push({ id: rule.id, desc: rule.desc, found: (r.issues ?? []).length, fixed: 0, skipped: 'report-only' });
      } catch (e) {
        ruleReport.push({ id: rule.id, desc: rule.desc, error: e?.message ?? String(e) });
      }
      continue;
    }
    try {
      const r = rule.run() ?? { issues: [], fixes: [] };
      issues.push(...(r.issues ?? []));
      const useFixes = autoFix === 'all' || (autoFix === 'safe' && rule.strategy === 'safe');
      if (useFixes) fixes.push(...(r.fixes ?? []));
      ruleReport.push({ id: rule.id, desc: rule.desc, found: (r.issues ?? []).length, fixed: useFixes ? (r.fixes ?? []).length : 0 });
    } catch (e) {
      ruleReport.push({ id: rule.id, desc: rule.desc, error: e?.message ?? String(e) });
      console.warn(`[RBQ] 审查规则 ${rule.id} 执行失败`, e);
    }
  }

  const out = { issues, fixes, applied: 0, failed: [], rules: ruleReport };
  if (opts.apply && fixes.length) {
    const txn = await import('./txn.js');
    const res = await txn.applyOps(fixes, { source: 'review' });
    out.applied = res.applied;
    out.failed = res.failed;
  }
  return out;
}

/** 人话格式的问题清单（给面板/通知用） */
export function formatIssues(issues, { limit = 50 } = {}) {
  if (!issues?.length) return '';
  const head = `共发现 ${issues.length} 个问题：`;
  const lines = issues.slice(0, limit).map((i) => `· [${i.severity}] 表${i.table} ${i.message}`);
  if (issues.length > limit) lines.push(`· …另有 ${issues.length - limit} 条`);
  return [head, ...lines].join('\n');
}
