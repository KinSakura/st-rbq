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
  /* 【用户预设实测】这些块名也在用（预设自己的正则产出的）→ 一并当元信息丢掉 ✓ */
  'history', 'last_brain_control', 'brain_control', 'rp_options_block', 'timestamp',
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
  /* 【用户实测】提示词里还能看到标签 ✗ —— 其中一类是 HTML 注释块（<!-- … -->）
     它不以字母开头，前面几段正则都匹配不到 ✗ → 这里先专门清掉 ✓ */
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = dropBlocks(s);
  s = dropTimeBox(s);
  // 行内残留的孤立标签（保留内容已在上一步处理，这里清掉漏网的）
  s = s.replace(/<\/?[a-zA-Z_][\w:-]*\b[^>]*>/g, '');
  s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return s;
}

/**
 * 【用户要求】给侧路的正文：**把所有被标签包裹的内容都剔除** ✓
 *   理由（用户原话）："只有正文是不被包裹的" ✓
 *   → 不管标签叫什么名字，只要成对包裹 → 整块丢掉 ✓
 *   → 剩下的孤立标签、注释、时间框也一并去掉 ✓
 *   比 extractProse 更狠：不再"保留不认识标签里的字" ✗
 */
export function extractProseStrict(raw) {
  let s = String(raw ?? "");
  s = s.replace(/<!--[\s\S]*?-->/g, "");                 // 注释
  /* 成对标签：整块丢弃（含内容）—— 用"先找开标签再找它自己的闭标签"的方式 ✓ */
  s = s.replace(/<([a-zA-Z_][\w:-]*)(?:"[^"]*"|'[^']*'|[^>"'])*>[\s\S]*?<\/\1\s*>/g, "");
  /* 未闭合的开标签：从这里一直吞到下一个标签或结尾 ✓ */
  s = s.replace(/<([a-zA-Z_][\w:-]*)(?:"[^"]*"|'[^']*'|[^>"'])*>[\s\S]*?(?=<[a-zA-Z_\/]|$)/g, "");
  /* 自闭合 / 孤立标签 */
  s = s.replace(/<\/?[a-zA-Z_][\w:-]*\b[^>]*\/?>/g, "");
  s = dropTimeBox(s);
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return s;
}
