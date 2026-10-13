/**
 * core/expand.js —— 把"需要派生计算的事实"展开成表格操作
 *
 * 这些标签不是简单的列赋值，而要走规则引擎：
 *   <skill> / <skill_use> / <attack> / <combat>   → 战斗结算（伤害、消耗、CD）
 *   <departure> / <leave>                          → 离场（表4 标记 + 表0 在场名单同步）
 *   <memory> / <character_memory>                  → 长期记忆
 *
 * 【为什么单独成模块】v1.95 起填表**只走侧路 API**（不再解析正文里的 <data> ✓），
 * 而原来这段逻辑是写死在 index.js 的正文解析路径里的 ✗ ——
 * 侧路如果不调它，战斗/离场这两种功能就等于死了 ✓ 所以搬出来给侧路调用 ✓
 */
import * as rules from './rules.js';
import * as memory from './memory.js';
import * as store from './store.js';

export async function expandUnparsed(unparsed) {
  const r = rules.expandFacts(unparsed ?? [], { round: store.getRev() + 1 });
  try {
    const mem = memory.collectFromFacts(unparsed ?? []);
    if (mem.added) {
      r.notes = r.notes ?? [];
      r.notes.push(`已记入长期记忆 ${mem.added} 条（${mem.characters.join('、')}）`);
      await store.commit({ persist: false });
    }
  } catch (e) {
    console.warn('[RBQ] 记忆写入失败', e);
  }
  return r;
}
