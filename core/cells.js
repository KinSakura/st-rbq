/**
 * core/cells.js —— 统一取列助手
 *
 * 为什么要它：代码里到处写 r[2]、v[19] 这类**写死的列下标**，
 * 用户一在结构页改列名/调列序，这些地方就会**静默读错列**（之前 {{tableData}}
 * 把"天气"当"世界法则"发给 AI 就是这个病）。
 * 一律改成按**列名/别名**解析，解析不到才退回老下标（保证老数据也能跑）。
 */

import { resolveAttr } from './alias.js';   // resolveAttr/listAttrs 都在 alias.js

export const S = (v) => (v == null ? '' : String(v));

/** 取一行的某个语义字段（列名或别名） */
export function cell(no, row, semantic, fallbackIndex) {
  if (!row) return undefined;
  let idx = -1;
  try {
    const r = resolveAttr(no, semantic);
    if (r && Number.isInteger(r.index) && r.index >= 0) idx = r.index;
  } catch { idx = -1; }
  if (idx < 0 && Number.isInteger(fallbackIndex)) idx = fallbackIndex;
  return idx >= 0 ? row[idx] : undefined;
}

/** 取字符串（常用组合） */
export function cellS(no, row, semantic, fallbackIndex) {
  return S(cell(no, row, semantic, fallbackIndex));
}
