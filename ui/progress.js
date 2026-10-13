/**
 * ui/progress.js —— 侧路进度卡片（自绘，风格与 RBQ 面板统一）
 *   v1.73（用户反馈：看不到终止按钮、右下角没卡片、想要跟整体 UI 一致）
 *     · 「终止」放在标题行右侧，任何时候可见 ✓
 *     · 运行中常驻；结束后保留 30 秒（以前 6 秒收起 → 用户以为没弹过 ✗）
 *     · 手动运行（面板按钮）也会弹这张卡 ✓
 *     · 金色描边 + 玻璃质感 + 标题渐变，和面板同一套视觉 ✓
 */
const ID = 'rbq-side-progress';
const SPIN = 'rbq-spin';
let abortFn = null;

function ensureStyle() {
  if (document.getElementById(ID + '-css')) return;
  const st = document.createElement('style');
  st.id = ID + '-css';
  st.textContent = `
#${ID}{position:fixed;left:50%;transform:translateX(-50%);top:64px;z-index:2147483000;min-width:262px;max-width:350px;
  background:rgba(22,20,17,.97);border:1px solid var(--rbq-gold,#d9a441);border-radius:12px;
  box-shadow:0 10px 30px rgba(0,0,0,.55);color:#e8e2d6;font:13px/1.55 var(--rbq-font,system-ui,sans-serif);
  padding:0;display:none;backdrop-filter:blur(8px);overflow:hidden}
#${ID}.rbq-on{display:block}
#${ID} .rbq-sp-head{display:flex;align-items:center;gap:8px;padding:8px 10px;
  background:linear-gradient(180deg,rgba(217,164,65,.14),rgba(217,164,65,.04));
  border-bottom:1px solid rgba(217,164,65,.28)}
#${ID} .rbq-sp-title{flex:1;font-weight:600;color:var(--rbq-gold,#d9a441);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#${ID} .rbq-sp-abort{flex:0 0 auto;cursor:pointer;font-size:12px;padding:2px 10px;border-radius:7px;
  border:1px solid rgba(217,107,90,.8);color:#f2bdb2;background:rgba(122,42,31,.35)}
#${ID} .rbq-sp-abort:hover{background:rgba(150,52,38,.85);color:#fff}
#${ID} .rbq-sp-abort[disabled]{opacity:.45;cursor:default}
#${ID} .rbq-sp-close{flex:0 0 auto;cursor:pointer;opacity:.5;font-size:12px;padding:0 2px}
#${ID} .rbq-sp-close:hover{opacity:1}
#${ID} .rbq-sp-body{padding:8px 10px}
#${ID} .rbq-sp-row{display:flex;gap:8px;align-items:flex-start;padding:2px 0}
#${ID} .rbq-sp-ico{width:16px;flex:0 0 16px;text-align:center}
#${ID} .rbq-sp-name{flex:0 0 52px;opacity:.9}
#${ID} .rbq-sp-detail{flex:1;opacity:.85;word-break:break-all}
.${SPIN}{display:inline-block;animation:rbqspin 1s linear infinite}
@keyframes rbqspin{from{transform:rotate(0)}to{transform:rotate(360deg)}}
`;
  try { document.head.appendChild(st); } catch (e) { /* ignore */ }
}

function box() {
  ensureStyle();
  let el = document.getElementById(ID);
  if (el) return el;
  el = document.createElement('div');
  el.id = ID;
  el.innerHTML =
    '<div class="rbq-sp-head">' +
      '<span class="rbq-sp-title">侧路 API</span>' +
      '<span class="rbq-sp-abort" title="中止这一次侧路调用">终止</span>' +
      '<span class="rbq-sp-close" title="收起">✕</span>' +
    '</div>' +
    '<div class="rbq-sp-body"></div>';
  el.querySelector('.rbq-sp-close').addEventListener('click', () => el.classList.remove('rbq-on'));
  el.querySelector('.rbq-sp-abort').addEventListener('click', (ev) => {
    try { ev.stopPropagation(); } catch (e) { /* ignore */ }
    const btn = el.querySelector('.rbq-sp-abort');
    try { btn.setAttribute('disabled', '1'); btn.textContent = '正在终止…'; } catch (e) { /* ignore */ }
    try { if (typeof abortFn === 'function') abortFn(); else console.log('[RBQ] 当前没有可终止的任务'); } catch (e) { console.warn('[RBQ] 终止失败', e); }
  });
  (document.body ?? document.documentElement).appendChild(el);
  return el;
}

/** 注入"终止"要做的事（开始侧路时调用） */
export function setAbort(fn) {
  abortFn = typeof fn === 'function' ? fn : null;
  try {
    const el = box();
    const btn = el.querySelector('.rbq-sp-abort');
    btn.removeAttribute('disabled');
    btn.textContent = '终止';
  } catch (e) { /* ignore */ }
}

const ICON = { running: '<span class="' + SPIN + '">◌</span>', ok: '✓', empty: '○', failed: '✗', off: '—', idle: '—' };
const NAME = { fill: '填表', memory: '记忆', summary: '大总结', extras: '附加', test: '连接测试' };
let autoHide = null;

/* 【用户要求】只设标题，**不预建任务行** ✓ ——
   谁真的开始跑就由 update() 建那一行 ✓
   （否则"附加未开启""大总结没到轮次"也会在卡片上列出来 ✗） */
export function begin(title = '侧路 API（并发）', tasks = []) {
  void tasks;
  const el = box();
  if (autoHide) { clearTimeout(autoHide); autoHide = null; }
  el.querySelector('.rbq-sp-title').textContent = title;
  const body = el.querySelector('.rbq-sp-body');
  body.textContent = '';   // 清空旧行；新行由 update() 按需建立 ✓
  el.classList.add('rbq-on');
  return el;
}

export function update(task, state, detail = '') {
  // 【用户要求】卡片只显示真正在跑的任务：未开启/空闲的直接不显示（连行都不建 ✓）
  if (state === 'off' || state === 'idle') return;
  const el = box();
  let row = el.querySelector('.rbq-sp-row[data-task="' + task + '"]');
  if (!row) {   // 手动运行等路径没有预先 begin → 就地补一行，别静默失败（用户反馈"看不到卡片"就是这么来的）
    row = document.createElement('div');
    row.className = 'rbq-sp-row';
    row.dataset.task = task;
    row.innerHTML = '<span class="rbq-sp-ico">' + ICON.running + '</span><span class="rbq-sp-name">' + (NAME[task] ?? task) + '</span><span class="rbq-sp-detail"></span>';
    el.querySelector('.rbq-sp-body').appendChild(row);
    el.classList.add('rbq-on');
  }
  row.querySelector('.rbq-sp-ico').innerHTML = ICON[state] ?? '·';
  row.querySelector('.rbq-sp-detail').textContent = detail || (state === 'running' ? '进行中…' : state === 'ok' ? '完成' : state === 'empty' ? '没有可写内容' : state === 'off' ? '未开启' : '跳过');
}

export function end(summary = '', { hideAfter = 8000 } = {}) {   // 用户要求：完事几秒后自动消失
  const el = box();
  if (summary) el.querySelector('.rbq-sp-title').textContent = summary;
  try {
    const btn = el.querySelector('.rbq-sp-abort');
    // 【用户要求】后台还有任务在跑时，不要显示已完成（会被当成卡住/超时 ✗）
    const stillRunning = [...el.querySelectorAll('.rbq-sp-row')].some((r) => /rbq-spin/.test(r.querySelector('.rbq-sp-ico')?.innerHTML || ''));
    if (stillRunning) {
      btn.textContent = '收尾中…';
      btn.removeAttribute('disabled');
    } else {
      btn.setAttribute('disabled', '1');
      btn.textContent = '已完成';
    }
  } catch (e) { /* ignore */ }
  abortFn = null;
  if (autoHide) clearTimeout(autoHide);
  autoHide = setTimeout(() => { try { el.classList.remove('rbq-on'); } catch { /* ignore */ } }, hideAfter);
}

export function hide() { try { box().classList.remove('rbq-on'); } catch { /* ignore */ } }

/** 给"手动运行"用：先把卡片亮出来（哪怕任务还没开始） */
export function show(title = '侧路 API') {
  const el = box();
  try { el.querySelector('.rbq-sp-title').textContent = title; el.classList.add('rbq-on'); } catch (e) { /* ignore */ }
  return el;
}
