/**
 * presetImport.js —— 插件内置预设的一键导入
 *
 * 目录约定（以后换预设只改这里，不用动代码）：
 *   st-rbq/presets/index.json   清单：{ items: [{ key, label, file, kind }] }
 *   st-rbq/presets/*.json       预设文件本体
 *
 * 导入方式：走**酒馆自己的接口**，不碰 server 目录、不自己写文件
 *   · 预设   → POST /api/presets/save   body: { name, preset:<对象>, apiId }
 *   · 世界书 → 酒馆的 importWorldInfo(File)（清单里 kind = "worldinfo" 时）
 */

import { ctx, notify } from './ctx.js';
import * as store from './store.js';

const DIR = 'presets/';

/** 兜底清单（清单文件取不到时用） */
const FALLBACK = [
  { key: 'zero', label: '斯拉RBQ · 游戏：零', file: '斯拉RBQ-零.json', kind: 'preset', version: '1.0.0' },
  { key: 'worldbook', label: 'RBQ 世界书', file: 'RBQ世界书.json', kind: 'worldinfo', version: '1.0.0' },
];

let manifest = FALLBACK.slice();
let loaded = false;

export function list() { return manifest.map((x) => ({ ...x })); }
export function isLoaded() { return loaded; }

/** 解析内置文件的绝对 URL（相对本模块：core/ → ../presets/） */
export function fileUrl(file) {
  const rel = file.startsWith(DIR) ? '../' + file : '../' + DIR + file;
  try { return new URL(rel, import.meta.url).href; } catch { return './' + DIR + file; }
}

/** 读清单（幂等；失败就用兜底清单） */
export async function loadManifest({ force = false } = {}) {
  if (loaded && !force) return list();
  try {
    const res = await fetch(fileUrl('index.json'), { cache: 'no-store' });
    if (res.ok) {
      const j = await res.json();
      const items = Array.isArray(j?.items) ? j.items : [];
      const clean = items
        .filter((x) => x && x.file)
        .map((x, i) => ({
          key: String(x.key ?? ('p' + i)),
          label: String(x.label ?? x.file),
          file: String(x.file),
          kind: String(x.kind ?? 'preset'),
          version: String(x.version ?? ''),
        }));
      if (clean.length) manifest = clean;
    }
  } catch { /* 用兜底 */ }
  loaded = true;
  return list();
}

async function fetchJson(file) {
  const res = await fetch(fileUrl(file), { cache: 'no-store' });
  if (!res.ok) throw new Error('取不到内置文件（HTTP ' + res.status + '）');
  return await res.json();
}

function headers(json = true) {
  try {
    const h = ctx()?.getRequestHeaders?.() ?? {};
    return json ? { ...h, 'Content-Type': 'application/json' } : { ...h };
  } catch { return json ? { 'Content-Type': 'application/json' } : {}; }
}

/** 导入预设（保存进酒馆的预设目录） */
export async function importPreset(entry, { apiId = 'openai', name = '' } = {}) {
  const data = await fetchJson(entry.file);
  // 名字优先用清单里的中文 label（预设文件顶层常常没有 name，之前就退回英文 key 了）
  const presetName = String(name || entry.label || data?.name || entry.key).trim();
  const payload = { ...data, name: presetName };
  const res = await fetch('/api/presets/save', {
    method: 'POST',
    headers: headers(true),
    body: JSON.stringify({ name: presetName, preset: payload, apiId }),
  });
  if (!res.ok) throw new Error('保存预设失败（HTTP ' + res.status + '）');
  const out = await res.json().catch(() => ({}));
  const finalName = out?.name ?? presetName;
  // 导入后让酒馆的预设列表立刻出现它并切过去（不用刷新页面）
  await selectPresetInTavern(finalName, payload, apiId).catch(() => { /* 拿不到就算了 */ });
  return { ok: true, name: finalName };
}

/**
 * 导入后：刷新酒馆的预设列表并切到刚导入的那个（否则要刷新页面才出现）
 * 走酒馆自己的 PresetManager（getPresetList / updateList / selectPreset）
 */
async function selectPresetInTavern(presetName, payload, apiId = 'openai') {
  let mod = null;
  try { mod = await import('../../../../preset-manager.js'); } catch { mod = null; }
  const pm = mod?.getPresetManager?.(apiId) ?? null;
  if (!pm) return false;
  try { await pm.getPresetList?.(); } catch { /* ignore */ }
  try { pm.updateList?.(presetName, { ...payload, name: presetName }); } catch { /* ignore */ }
  // ST 的 selectPreset 收的是「预设对象」（见 preset-manager.js autoSelectPreset 的用法），不是名字
  try { const obj = pm.findPreset?.(presetName) ?? presetName; await pm.selectPreset?.(obj); return true; } catch { return false; }
}

/** 导入世界书（清单里 kind = worldinfo 时才会用到） */
export async function importWorldInfoFile(entry, { name = '' } = {}) {
  const data = await fetchJson(entry.file);
  let mod = null;
  try { mod = await import('../../../../world-info.js'); } catch { mod = null; }
  if (!mod?.importWorldInfo) throw new Error('拿不到酒馆的 importWorldInfo');
  const fileName = (name || entry.label || entry.key) + '.json';
  let file = null;
  try { file = new File([JSON.stringify(data)], fileName, { type: 'application/json' }); } catch { file = null; }
  if (!file) {
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    blob.name = fileName;
    file = blob;
  }
  await mod.importWorldInfo(file);
  return { ok: true, name: fileName };
}

/** 统一入口 */
/** 已导入版本记录（key → version） */
function importedVersions() { return store.getConfigValue('presetVersions', {}) ?? {}; }
function rememberVersion(entry) {
  try {
    const cur = importedVersions();
    store.updateConfig({ presetVersions: { ...cur, [entry.key]: String(entry.version ?? '') } });
  } catch { /* ignore */ }
}

/** 逐条对比：内置清单里的 version 是否比"已导入的"新 */
export function checkUpdates() {
  const done = importedVersions();
  const items = list().map((e) => {
    const installed = String(done[e.key] ?? '');
    const bundled = String(e.version ?? '');
    const need = !!bundled && bundled !== installed;
    return { ...e, installed, bundled, need };
  });
  return { hasUpdate: items.some((x) => x.need), items };
}

export async function importOne(entry, opts = {}) {
  try {
    const r = entry.kind === 'worldinfo' ? await importWorldInfoFile(entry, opts) : await importPreset(entry, opts);
    rememberVersion(entry);
    notify('success', '已导入：' + r.name);
    return r;
  } catch (e) {
    const msg = String(e?.message ?? e);
    notify('error', '导入失败：' + msg);
    return { ok: false, error: msg };
  }
}
