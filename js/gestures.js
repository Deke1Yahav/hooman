// Tap / drag-to-pan / pinch / wheel / hold on a CardCanvas, for the tap-answer and follow screens.
// onTap([x, y] in image px), onHold(start|end) for "hold to see the previous frame".

export function attachTapZoom(canvas, view, { onTap, onHold } = {}) {
  const pts = new Map();
  let pinch = null, down = null, holdTimer = 0, holding = false;
  const local = (e) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  const endHold = () => { clearTimeout(holdTimer); if (holding) { holding = false; onHold && onHold(false); } };
  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    const p = local(e);
    pts.set(e.pointerId, p);
    if (pts.size === 1) {
      down = { p, t: performance.now(), moved: false };
      if (onHold) holdTimer = setTimeout(() => { if (down && !down.moved && pts.size === 1) { holding = true; onHold(true); } }, 350);
    } else { down = null; endHold(); pinch = null; }
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!pts.has(e.pointerId)) return;
    const prev = pts.get(e.pointerId), p = local(e);
    pts.set(e.pointerId, p);
    if (pts.size === 2) {
      const [a, b] = [...pts.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]), m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      if (pinch) { view.ox += m[0] - pinch.m[0]; view.oy += m[1] - pinch.m[1]; view.zoomAt(d / pinch.d, m[0], m[1]); }
      pinch = { d, m }; return;
    }
    if (down && Math.hypot(p[0] - down.p[0], p[1] - down.p[1]) > 8) { down.moved = true; clearTimeout(holdTimer); }
    if (down && down.moved && !holding) { view.ox += p[0] - prev[0]; view.oy += p[1] - prev[1]; view.draw(); }
  });
  const up = (e, cancel) => {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    if (pts.size) return;
    pinch = null;
    const wasHold = holding;
    endHold();
    if (!cancel && down && !down.moved && !wasHold && performance.now() - down.t < 450 && onTap) onTap(view.toImage(...down.p));
    down = null;
  };
  canvas.addEventListener("pointerup", (e) => up(e, false));
  canvas.addEventListener("pointercancel", (e) => up(e, true));
  canvas.addEventListener("wheel", (e) => { e.preventDefault(); const p = local(e); view.zoomAt(Math.exp(-e.deltaY * 0.0015), p[0], p[1]); }, { passive: false });
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
}
