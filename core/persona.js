/**
 * core/persona.js —— 把「用户角色设定（Persona）」用标签包起来 + 改插入位置
 *
 * 【来源】老 RBQ 代码里的两个函数（1.txt L3388 / L3398）：
 *     prefix = '<{{user}}角色设定>\n'   suffix = '\n</{{user}}角色设定>'
 *     persona.position = 4; persona.depth = 0; persona.role = 1;   // 4 = AT_DEPTH（聊天内）
 *   作用：让 AI 明确知道"这段是扮演{{user}}的人设"✓，
 *        并且把它放到**聊天末尾**（at depth 0）→ 比塞在提示词里更靠近正文、权重更实 ✓
 *
 * 【本机酒馆的真实字段】（`/scripts/power-user.js` 导出的 power_user ✓）
 *   power_user.personas[avatarId] = 名字 ✓
 *   power_user.persona_descriptions[avatarId] = { description, position, depth, role, lorebook, title } ✓
 *   位置枚举（`/scripts/personas.js`）：IN_PROMPT 0 / AFTER_CHAR 1 / TOP_AN 2 / BOTTOM_AN 3 / AT_DEPTH 4 / NONE 9 ✓
 *
 * 【重要】`ctx().power_user` 是**克隆**（读得到但改了不生效 ✗）→ 必须 import 真模块 ✓
 */
import { saveSettings } from './ctx.js';

export const PREFIX = '<{{user}}角色设定>\n';
export const SUFFIX = '\n</{{user}}角色设定>';

/** 与老 RBQ 一致：4 = 聊天内（AT_DEPTH）、深度 0 = 最靠近正文、role 1 = user */
export const TARGET_POSITION = 4;
export const TARGET_DEPTH = 0;
export const TARGET_ROLE = 1;

/** 拿真实的 power_user（不是 ctx 里那个克隆 ✓） */
async function realPowerUser() {
  try {
    const m = await import('/scripts/power-user.js');
    return m?.power_user ?? null;
  } catch (e) { return null; }
}

/**
 * 【用户实测】点完「立即应用」要**手动刷新页面**才看到变化 ✗
 *   → 我们改的是 `power_user`（真对象 ✓），但酒馆的人物设定界面不会自己重画 ✗
 *   修法：调酒馆自己的渲染函数 ✓（`personas.js` 导出的 ✓）
 *     · setPersonaDescription() → 把文本框/下拉框刷成最新值 ✓
 *     · getUserAvatars(false)   → 重画左边人物列表 ✓（传 false = 不要再整页渲染一遍 ✓）
 */
export async function refreshSTPersonaUI() {
  const done = [];
  try {
    const m = await import('/scripts/personas.js');
    if (typeof m?.setPersonaDescription === 'function') { try { m.setPersonaDescription(); done.push('描述框'); } catch (e) { /* ignore */ } }
    if (typeof m?.getUserAvatars === 'function') { try { await m.getUserAvatars(false); done.push('人物列表'); } catch (e) { /* ignore */ } }
  } catch (e) { /* 环境没有就算了 ✓ */ }
  if (done.length) console.log('[RBQ] 已刷新酒馆的人物设定界面：' + done.join(' + ') + ' ✓');
  return done;
}

/** 当前正在用的角色设定 id（酒馆的 user_avatar ✓ 拿不到就返回 null = 对所有设定都做） */
async function currentPersonaId() {
  try {
    const m = await import('/scripts/personas.js');
    const id = m?.user_avatar;
    if (id) return String(id);
  } catch (e) { /* ignore */ }
  return null;
}

/**
 * 包标签 + 改插入位置（幂等 ✓ 已经包过不会重复包 ✓）
 * @returns {Promise<{ok:boolean, wrapped:number, moved:number, ids:string[], reason?:string}>}
 */
export async function applyPersona(opts = {}) {
  const pu = await realPowerUser();
  if (!pu) return { ok: false, wrapped: 0, moved: 0, ids: [], reason: '读不到角色设定（版本/环境差异）' };

  const position = Number.isFinite(Number(opts.position)) ? Number(opts.position) : TARGET_POSITION;
  const depth = Number.isFinite(Number(opts.depth)) ? Number(opts.depth) : TARGET_DEPTH;
  const role = Number.isFinite(Number(opts.role)) ? Number(opts.role) : TARGET_ROLE;

  let wrapped = 0; let moved = 0; const touched = [];

  /* ① 新版结构：power_user.persona_descriptions[avatarId] = {description, position, depth, role} ✓ */
  const pd = pu.persona_descriptions;
  if (pd && typeof pd === 'object') {
    const onlyCurrent = opts.onlyCurrent !== false;
    const cur = await currentPersonaId();
    const all = Object.keys(pd);
    const target = (onlyCurrent && cur && pd[cur]) ? [cur] : all;
    for (const id of target) {
      const rec = pd[id];
      if (!rec) continue;
      const desc = String(rec.description ?? '');
      if (desc && (!desc.startsWith(PREFIX) || !desc.endsWith(SUFFIX))) { rec.description = PREFIX + desc + SUFFIX; wrapped++; }
      if (Number(rec.position) !== position || Number(rec.depth) !== depth || Number(rec.role) !== role) {
        rec.position = position; rec.depth = depth; rec.role = role; moved++;
      }
      touched.push(id);
    }
  }

  /* ② 【兼容旧结构】有些版本/环境把设定存在全局字段里 ✓
        power_user.persona_description（文本）+ persona_description_position / _depth / _role ✓
        用户实测"包裹没生效"✗ 很可能就是他的设定在这里 ✓ 所以两边都处理 ✓ */
  try {
    const g = String(pu.persona_description ?? '');
    if (g) {
      if (!g.startsWith(PREFIX) || !g.endsWith(SUFFIX)) { pu.persona_description = PREFIX + g + SUFFIX; wrapped++; }
      touched.push('(全局)persona_description');
    }
    if (Number(pu.persona_description_position) !== position) { pu.persona_description_position = position; moved++; }
    if (Number(pu.persona_description_depth) !== depth) { pu.persona_description_depth = depth; moved++; }
    if (Number(pu.persona_description_role) !== role) { pu.persona_description_role = role; moved++; }
  } catch (e) { /* ignore */ }

  try { saveSettings?.(); } catch (e) { /* ignore */ }
  if (wrapped || moved) {
    console.log('[RBQ] 角色设定已处理：包标签 ' + wrapped + ' 条 / 改插入位置 ' + moved + ' 处（聊天内 · 深度 ' + depth + '）→ ' + touched.join(','));
  } else if (touched.length) {
    console.log('[RBQ] 角色设定已经是目标状态 ✓（' + touched.join(',') + '）');
  }
  if (wrapped || moved) { try { await refreshSTPersonaUI(); } catch (e) { /* ignore */ } }
  return { ok: true, wrapped, moved, ids: touched };
}

/** 去掉包裹标签（关掉功能 / 想还原时用 ✓） */
export async function unwrapPersona() {
  const pu = await realPowerUser();
  if (!pu?.persona_descriptions) return { ok: false, unwrapped: 0 };
  let n = 0;
  for (const id of Object.keys(pu.persona_descriptions)) {
    const rec = pu.persona_descriptions[id];
    const d = String(rec?.description ?? '');
    if (!d) continue;
    const nv = d.replace(/^<\{\{user\}\}角色设定>\s*/, '').replace(/\s*<\/\{\{user\}\}角色设定>$/, '');
    if (nv !== d) { rec.description = nv; n++; }
  }
  /* 全局字段也一起还原 ✓ */
  try {
    const g = String(pu.persona_description ?? '');
    if (g) {
      const nv = g.replace(/^<\{\{user\}\}角色设定>\s*/, '').replace(/\s*<\/\{\{user\}\}角色设定>$/, '');
      if (nv !== g) { pu.persona_description = nv; n++; }
    }
  } catch (e) { /* ignore */ }
  try { saveSettings?.(); } catch (e) { /* ignore */ }
  if (n) { console.log('[RBQ] 已去掉角色设定的包裹标签：' + n + ' 处'); try { await refreshSTPersonaUI(); } catch (e) { /* ignore */ } }
  return { ok: true, unwrapped: n };
}

/** 只读状态（面板/排查用 ✓） */
export async function personaStatus() {
  try {
    const pu = await realPowerUser();
    const list = (pu?.persona_descriptions ?? {});
    const ids = Object.keys(list);
    return {
      total: ids.length,
      wrapped: ids.filter((id) => String(list[id]?.description ?? '').startsWith(PREFIX)).length,
      atDepth: ids.filter((id) => Number(list[id]?.position) === TARGET_POSITION).length,
      current: await currentPersonaId(),
      sample: ids.slice(0, 3).map((id) => ({ id, len: String(list[id]?.description ?? '').length, position: list[id]?.position, depth: list[id]?.depth })),
    };
  } catch (e) { return { total: 0, wrapped: 0, atDepth: 0, current: null, sample: [] }; }
}
