/**
 * core/prose.js —— 从 AI 原始输出里取出"正文"
 *
 * 规则（按用户给的原则）：**没被标签包裹的就是正文**。
 * 具体分两步，因为"标签"分两类：
 *   ① 元信息块（整块都不要）：思考/分析、<data>、<RP_OPTIONS>、角色记忆、旁白/CG/小剧场…
 *      —— 这些不是剧情，喂给抽取器只会干扰
 *   ② 其它标签（保留里面的字）：比如行内的 <user>/<char>、强调用的标签
 *      —— 直接删掉会连剧情里的字一起删掉
 * 另外还有两样"不是标签但也不是正文"的东西：插件插的时间框『…』、多余空行。
 */

/** 整块丢弃的标签（小写比较） */
export const DROP_BLOCKS = [
  'thinking', 'thinking_matrix', 'analysis', 'reasoning', 'thought', 'think',
  'data', 'data_reasoning', 'cot_tags', 'cot',
  'this_round_events', 'round_events', 'events',
  'rp_options', 'options', 'choices',
  'character_memory', 'memory',
  'aside', 'cg', 'zilla', 'narration',
  'status_bar', 'state', 'vars', 'variables', 'prompt', 'instructions', 'summary', 'epoch',
  'formatofmemorandum', 'memorandum',
];

/**
 * 这个名字算不算"元信息块"（整块都要丢）？
 * 【用户实测】以前只写死了一张名单 ✗，预设里真实的标签名一变（比如 data_reasoning、This_round_events）
 * 就漏掉了 → 整块思考/小总结被当成正文发给侧路 ✗（既浪费 token 又干扰抽取 ✓）
 * 所以这里改成"名单 + 关键词"双判 ✓
 */
function isMeta(name) {
  const n = String(name).toLowerCase().replace(/[-\s]/g, '_');
  if (DROP_BLOCKS.includes(n)) return true;
  if (n.startsWith('this_round') || n.endsWith('_events')) return true;
  if (/(^|_)(thinking|reason|thought|cot|analysis|memorandum)(_|$)/.test(n)) return true;
  if (n.startsWith('data_')) return true;
  return false;
}

function dropBlocks(text) {
  let out = String(text ?? '');
  /* ① 成对的 <name …>…</name>（含内容）—— 注意 [^>]* 会被属性里的 > 骗到 ✓ 所以用带引号容错的形式 */
  out = out.replace(/<([a-zA-Z_][\w:-]*)(?:"[^"]*"|'[^']*'|[^>"'])*>([\s\S]*?)<\/\1\s*>/g, (m, name) => {
    if (isMeta(name)) return '';
    // 不在丢弃名单里 → 只脱掉标签、保留内容
    return m.replace(/<\/?[a-zA-Z_][\w:-]*\b[^>]*>/g, '');
  });
  /* ② 【未闭合】的元信息块：从开标签一直吞到下一个标签或结尾 ✓
     （用户预设里有"自动补全起始标签"的正则，说明模型经常只写开标签 ✗
       以前这种块只被删掉标签、内容整段留在正文里 ✗） */
  out = out.replace(/<([a-zA-Z_][\w:-]*)(?:"[^"]*"|'[^']*'|[^>"'])*>[\s\S]*?(?=<[a-zA-Z_/]|$)/g, (m, name) => (isMeta(name) ? '' : m));
  out = out.replace(/<([a-zA-Z_][\w:-]*)(?:"[^"]*"|'[^']*'|[^>"'])*\/>/g, (m, name) => (isMeta(name) ? '' : m));
  /* ③ 漏网的孤立标签 */
  out = out.replace(/<\/?([a-zA-Z_][\w:-]*)\b[^>]*\/?>/g, (m, name) => (isMeta(name) ? '' : ''));
  return out;
}

/** 去掉插件插的时间框『时空坐标 - 地点 - 天气 - 氛围』 */
function dropTimeBox(text) {
  return String(text ?? '')
    .replace(/^[ \t]*『[^』]*』[ \t]*$/gm, '')
    .replace(/『[^』]{4,}』/g, (m) => (m.includes(' - ') || m.includes('｜') ? '' : m));
}

/** 取正文 */
export function extractProse(raw) {
  let s = String(raw ?? '');
  s = dropBlocks(s);
  s = dropTimeBox(s);
  // 行内残留的孤立标签（保留内容已在上一步处理，这里清掉漏网的）
  s = s.replace(/<\/?[a-zA-Z_][\w:-]*\b[^>]*>/g, '');
  s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return s;
}
