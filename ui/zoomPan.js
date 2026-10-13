/**
 * ui/zoomPan.js —— 给视图里的 SVG 加"拖动平移 + 滚轮缩放"（改 viewBox，不改布局）
 *   在面板渲染完某个视图后调用 attach(host) 即可。
 */
const STORE = new WeakMap();

function svgsIn(host) {
  try { return [...host.querySelectorAll('svg')].filter((s) => s.getAttribute('viewBox')); } catch { return []; }
}

function baseBox(svg) {
  const vb = String(svg.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
  if (vb.length === 4 && vb.every((n) => Number.isFinite(n))) return { x: vb[0], y: vb[1], w: vb[2], h: vb[3] };
  const r = svg.getBoundingClientRect();
  return { x: 0, y: 0, w: Math.max(1, Math.round(r.width)), h: Math.max(1, Math.round(r.height)) };
}

export function attach(host) {
  if (!host) return 0;
  let n = 0;
  for (const svg of svgsIn(host)) {
    if (STORE.has(svg)) continue;
    const base = baseBox(svg);
    const cur = { x: base.x, y: base.y, w: base.w, h: base.h };
    const apply = () => svg.setAttribute('viewBox', cur.x + ' ' + cur.y + ' ' + cur.w + ' ' + cur.h);
    STORE.set(svg, true);
    svg.style.cursor = 'grab';
    svg.style.touchAction = 'none';

    // 滚轮缩放（以指针位置为中心）
    svg.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = svg.getBoundingClientRect();
      const fx = (e.clientX - r.left) / Math.max(1, r.width);
      const fy = (e.clientY - r.top) / Math.max(1, r.height);
      const k = e.deltaY > 0 ? 1.12 : 0.89;
      const nw = Math.min(base.w * 6, Math.max(base.w * 0.25, cur.w * k));
      const nh = cur.h * (nw / cur.w);
      cur.x += (cur.w - nw) * fx;
      cur.y += (cur.h - nh) * fy;
      cur.w = nw; cur.h = nh;
      apply();
    }, { passive: false });

    // 拖动平移
    let dragging = false; let lx = 0; let ly = 0; let moved = 0;
    svg.addEventListener('pointerdown', (e) => {
      dragging = true; lx = e.clientX; ly = e.clientY; moved = 0;
      svg.style.cursor = 'grab';
    });
    svg.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const r = svg.getBoundingClientRect();
      const mx = e.clientX - lx;
      const my = e.clientY - ly;
      moved += Math.abs(mx) + Math.abs(my);
      if (moved < 5) return;                         // 位移太小当作点击，不做平移
      const dx = mx / Math.max(1, r.width) * cur.w;
      const dy = my / Math.max(1, r.height) * cur.h;
      lx = e.clientX; ly = e.clientY;
      cur.x -= dx; cur.y -= dy;
      svg.style.cursor = 'grabbing';
      apply();
    });
    const up = () => { dragging = false; svg.style.cursor = 'grab'; };
    svg.addEventListener('pointerup', up);
    svg.addEventListener('pointercancel', up);
    // 双击复位
    svg.addEventListener('dblclick', () => { cur.x = base.x; cur.y = base.y; cur.w = base.w; cur.h = base.h; apply(); });
    n++;
  }
  return n;
}

export function resetAll(host) {
  for (const svg of svgsIn(host)) {
    const vb = String(svg.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
    if (vb.length === 4) svg.setAttribute('viewBox', vb.join(' '));
  }
}
