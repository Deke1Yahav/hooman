// Mask editor: brush, eraser, lasso fill, objects + classes, undo/redo, "start from" a model's mask.
// One finger draws, two fingers pan and zoom. The result is a label image (0 = background, 1..n = objects).

import { CardCanvas, labels as loadLabels, outlinePath } from "./view.js";
import { decodeLabelPNG, encodeLabelPNG } from "./png.js";

const PALETTE = ["#c6ff3d", "#ff8fab", "#4fc3f7", "#ffa94d", "#e599f7", "#3ddc97", "#f2c14e", "#b9e3ff", "#ff5d6c", "#9ad0a8"];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const rgb = (hex) => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const prefs = {
  get(k, d) { try { const v = localStorage.getItem("hooman:" + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("hooman:" + k, JSON.stringify(v)); } catch {} },
};
const canvas2d = (w, h) => (typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(w, h) : Object.assign(document.createElement("canvas"), { width: w, height: h }));

export const editorOpen = () => !!document.querySelector(".editor");

// Rasterize a polygon (image px) -> list of pixel indices inside it.
function polygonPixels(points, W, H) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of points) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0)); x1 = Math.min(W, Math.ceil(x1)); y1 = Math.min(H, Math.ceil(y1));
  const w = x1 - x0, h = y1 - y0, out = [];
  if (w <= 0 || h <= 0) return out;
  const c = canvas2d(w, h), ctx = c.getContext("2d");
  ctx.beginPath();
  points.forEach(([x, y], i) => (i ? ctx.lineTo(x - x0, y - y0) : ctx.moveTo(x - x0, y - y0)));
  ctx.closePath(); ctx.fillStyle = "#fff"; ctx.fill();
  const d = ctx.getImageData(0, 0, w, h).data;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (d[4 * (y * w + x) + 3] >= 128) out.push((y + y0) * W + x + x0);
  return out;
}

/**
 * Opens the editor full-screen. Resolves {mask: Blob|null, objects: [{value, class?}], frame, count}, or null when cancelled.
 * initial: {mask: Blob, objects} to keep editing an earlier mask.
 */
export function openEditor({ rec, card, frame = 0, hidden = new Set(), initial = null, title = "Draw the mask", doneLabel = "Done", note = "" }) {
  return new Promise(async (resolve) => {
    const deck = rec.deck, W = card.w, H = card.h, N = W * H;
    const classes = deck.classes || [];
    const fromSources = deck.sources.filter((s) => card.overlays.some((o) => o.source === s.name && o.shape !== "point" && (o.frame === undefined || o.frame === frame)));
    const el = document.createElement("div");
    el.className = "editor";
    el.innerHTML = `
      <div class="bar">
        <button class="ghost" data-e="cancel">✕ Cancel</button>
        <h3>${esc(title)}${note ? `<small>${esc(note)}</small>` : ""}</h3>
        <button class="btn" data-e="done" style="min-height:40px;padding:0 14px">✓ ${esc(doneLabel)}</button>
      </div>
      ${deck.sources.length ? `<div class="rowx">${deck.sources.map((s) => `<button class="chip" data-src="${esc(s.name)}" aria-pressed="${!hidden.has(s.name)}" style="color:${esc(s.color)}"><i></i><span style="color:var(--text)">${esc(s.label)}</span></button>`).join("")}</div>` : ""}
      <canvas></canvas>
      <div class="rowx" data-objects></div>
      ${classes.length ? `<div class="rowx" data-classes></div>` : ""}
      <div class="tools">
        <button class="tool" data-tool="brush"><b>🖌</b>Brush</button>
        <button class="tool" data-tool="erase"><b>⌫</b>Erase</button>
        <button class="tool" data-tool="lasso"><b>◌</b>Lasso</button>
        <button class="tool" data-tool="move"><b>✋</b>Move</button>
      </div>
      <div class="rowx sizes">
        <span class="muted" style="font-size:12px">size</span><input type="range" min="2" max="90" data-size aria-label="Brush size">
        <button class="tool small" data-e="undo" aria-label="Undo">↶</button><button class="tool small" data-e="redo" aria-label="Redo">↷</button>
      </div>
      <div class="rowx starts">
        ${fromSources.map((s) => `<button class="chip" data-from="${esc(s.name)}" style="color:${esc(s.color)}"><i></i><span style="color:var(--text)">Start from ${esc(s.label)}</span></button>`).join("")}
        <button class="chip" data-e="clear"><span>Clear all</span></button>
      </div>`;
    document.body.appendChild(el);
    const cv = el.querySelector("canvas");
    const view = new CardCanvas(cv);
    const $e = (s) => el.querySelector(s);

    // ---- state
    const lab = new Uint16Array(N);
    const meta = new Map();                     // object id -> {cls}
    let current = 1, tool = prefs.get("tool", "brush"), size = prefs.get("brush", 18), defaultCls = classes[0] ? classes[0].value : undefined;
    let undoStack = [], redoStack = [], change = null, lasso = null, cursor = null;
    let outlineAll = null, outlineCur = null;
    const fill = canvas2d(W, H), fctx = fill.getContext("2d"), fdata = fctx.createImageData(W, H);
    const colorCache = new Map();
    const colorOf = (id) => {
      const m = meta.get(id), cls = m && m.cls ? classes.find((c) => c.value === m.cls) : null;
      return cls && cls.color ? cls.color : PALETTE[(id - 1) % PALETTE.length];
    };
    const rgbOf = (id) => { const c = colorOf(id); if (!colorCache.has(c)) colorCache.set(c, rgb(c)); return colorCache.get(c); };
    const ensure = (id) => { if (!meta.has(id)) meta.set(id, { cls: defaultCls }); };

    function setFillPx(i, v) {
      const d = fdata.data, k = 4 * i;
      if (!v) { d[k + 3] = 0; return; }
      const [r, g, b] = rgbOf(v);
      d[k] = r; d[k + 1] = g; d[k + 2] = b; d[k + 3] = 105;
    }
    function repaintFill() { for (let i = 0; i < N; i++) setFillPx(i, lab[i]); fctx.putImageData(fdata, 0, 0); }

    // ---- changes (one undo step each)
    function begin() { change = { old: new Map(), dirty: [Infinity, Infinity, -Infinity, -Infinity] }; }
    function setPx(i, v) {
      if (lab[i] === v) return;
      if (!change.old.has(i)) change.old.set(i, lab[i]);
      lab[i] = v; setFillPx(i, v);
      const x = i % W, y = (i / W) | 0, d = change.dirty;
      if (x < d[0]) d[0] = x; if (y < d[1]) d[1] = y; if (x > d[2]) d[2] = x; if (y > d[3]) d[3] = y;
    }
    function flush() {
      const d = change && change.dirty;
      if (d && d[2] >= d[0]) fctx.putImageData(fdata, 0, 0, d[0], d[1], d[2] - d[0] + 1, d[3] - d[1] + 1);
      view.draw();
    }
    function commit() {
      if (!change) return;
      if (change.old.size) {
        const after = new Map();
        for (const i of change.old.keys()) after.set(i, lab[i]);
        undoStack.push({ old: change.old, after }); redoStack = [];
        if (undoStack.length > 60) undoStack.shift();
      }
      change = null;
      refresh();
    }
    function revert() {
      if (!change) return;
      for (const [i, v] of change.old) { lab[i] = v; setFillPx(i, v); }
      fctx.putImageData(fdata, 0, 0);
      change = null; refresh();
    }
    function applyStep(map) {
      for (const [i, v] of map) { lab[i] = v; setFillPx(i, v); }
      fctx.putImageData(fdata, 0, 0); refresh();
    }
    const undo = () => { const s = undoStack.pop(); if (s) { redoStack.push(s); applyStep(s.old); } };
    const redo = () => { const s = redoStack.pop(); if (s) { undoStack.push(s); applyStep(s.after); } };

    // ---- painting
    function stamp(cx, cy, r, erase) {
      const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(W - 1, Math.floor(cx + r)), y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(H - 1, Math.floor(cy + r));
      const r2 = r * r, fx = Math.floor(cx), fy = Math.floor(cy);
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
        if (dx * dx + dy * dy > r2 && !(x === fx && y === fy)) continue;
        const i = y * W + x, v = lab[i];
        if (erase) { if (v) setPx(i, 0); }
        else if (v === 0) setPx(i, current);  // other objects are protected; erase first to repaint them
      }
    }
    function strokeTo(p) {
      const r = Math.max(0.5, size / 2 / view.s), erase = tool === "erase";
      const [ax, ay] = change.last || p, dist = Math.hypot(p[0] - ax, p[1] - ay), steps = Math.max(1, Math.ceil(dist / Math.max(0.5, r * 0.4)));
      for (let k = 1; k <= steps; k++) stamp(ax + ((p[0] - ax) * k) / steps, ay + ((p[1] - ay) * k) / steps, r, erase);
      change.last = p;
      flush();
    }

    // ---- objects UI
    function presentIds() {
      const seen = new Set();
      for (let i = 0; i < N; i++) if (lab[i]) seen.add(lab[i]);
      return seen;
    }
    function refresh() {
      const ids = presentIds();
      for (const id of [...meta.keys()]) if (!ids.has(id) && id !== current) meta.delete(id);
      ensure(current);
      outlineAll = ids.size ? outlinePath({ width: W, height: H, labels: lab }) : null;
      outlineCur = ids.has(current) ? outlinePath({ width: W, height: H, labels: lab }, current) : null;
      const list = [...new Set([...ids, current])].sort((a, b) => a - b);
      $e("[data-objects]").innerHTML = list.map((id) => {
        const m = meta.get(id) || {}, cls = classes.find((c) => c.value === m.cls);
        return `<button class="chip ${id === current ? "on" : ""}" data-obj="${id}" style="color:${esc(colorOf(id))}"><i></i><span style="color:var(--text)">${id}${cls ? ` ${esc(cls.label)}` : ""}${ids.has(id) ? "" : " (empty)"}</span></button>`;
      }).join("") + `<button class="chip" data-e="new"><span>＋ New object</span></button>`;
      if (classes.length) {
        const m = meta.get(current) || {};
        $e("[data-classes]").innerHTML = `<span class="muted" style="font-size:12px;flex:none">object ${current} is</span>` + classes.map((c) => `<button class="chip ${m.cls === c.value ? "on" : ""}" data-cls="${esc(c.value)}" style="color:${esc(c.color)}"><i></i><span style="color:var(--text)">${esc(c.label)}</span></button>`).join("");
      }
      el.querySelectorAll("[data-tool]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.tool === tool)));
      $e("[data-e=undo]").disabled = !undoStack.length; $e("[data-e=redo]").disabled = !redoStack.length;
      view.draw();
    }
    function newObject() {                     // the current object stays "new" until something is drawn in it
      const ids = presentIds();
      if (ids.has(current)) current = Math.max(0, ...ids, ...meta.keys()) + 1;
      ensure(current);
      if (tool === "erase" || tool === "move") tool = "brush";
      refresh();
    }

    // ---- start from a model's mask / shapes
    // a model label like "apple 0.83" names the class when it matches one of the deck's classes
    const classOfLabel = (label) => {
      if (!label || !classes.length) return undefined;
      const l = String(label).trim().toLowerCase(), w = l.split(/[\s:,(]+/)[0];
      const c = classes.find((c) => c.value.toLowerCase() === l || c.value.toLowerCase() === w || c.label.toLowerCase() === w);
      return c ? c.value : undefined;
    };
    const ensureAs = (id, label) => { ensure(id); const c = classOfLabel(label); if (c) meta.get(id).cls = c; };

    async function startFrom(name) {
      const ovs = card.overlays.filter((o) => o.source === name && o.shape !== "point" && (o.frame === undefined || o.frame === frame));
      begin();
      let next = Math.max(0, ...presentIds(), ...meta.keys()) + 1, first = null;
      for (const o of ovs) {
        if (o.shape === "mask") {
          const L = (await loadLabels(rec.key, o.mask)).labels;
          let vals = null;
          if (o.value) vals = new Set([o.value]);
          else if (card.focus) {                 // the object(s) this card is about: the biggest inside the focus box
            const [fx, fy, fw, fh] = card.focus.map(Math.round), counts = new Map();
            for (let y = Math.max(0, fy); y < Math.min(H, fy + fh); y++) for (let x = Math.max(0, fx); x < Math.min(W, fx + fw); x++) {
              const v = L[y * W + x]; if (v) counts.set(v, (counts.get(v) || 0) + 1);
            }
            const top = Math.max(0, ...counts.values());
            vals = new Set([...counts].filter(([, n]) => n >= 0.5 * top).map(([v]) => v));
          }
          const idmap = new Map();
          for (let i = 0; i < N; i++) {
            const v = L[i];
            if (!v || (vals && !vals.has(v)) || lab[i]) continue;
            let id = idmap.get(v);
            if (!id) { id = next++; idmap.set(v, id); ensureAs(id, o.label); }
            setPx(i, id);
          }
          if (first === null && idmap.size) first = [...idmap.values()][0];
        } else {
          const pts = o.shape === "box" ? [[o.box[0], o.box[1]], [o.box[0] + o.box[2], o.box[1]], [o.box[0] + o.box[2], o.box[1] + o.box[3]], [o.box[0], o.box[1] + o.box[3]]] : o.polygon;
          const id = next++; ensureAs(id, o.label);
          for (const i of polygonPixels(pts, W, H)) if (!lab[i]) setPx(i, id);
          if (first === null) first = id;
        }
      }
      repaintFill();                             // classes may have changed colours
      if (first !== null) current = first;
      commit();
    }

    // ---- drawing the hooman layer on top of the image
    view.after = (ctx, v) => {
      ctx.save();
      ctx.translate(v.ox, v.oy); ctx.scale(v.s, v.s);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(fill, 0, 0);
      if (outlineAll) { ctx.strokeStyle = "rgba(255,255,255,.9)"; ctx.lineWidth = 1.2 / v.s; ctx.stroke(outlineAll); }
      if (outlineCur) { ctx.strokeStyle = colorOf(current); ctx.lineWidth = 2.6 / v.s; ctx.stroke(outlineCur); }
      if (lasso && lasso.length > 1) {
        ctx.beginPath(); lasso.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.strokeStyle = colorOf(current); ctx.lineWidth = 2 / v.s; ctx.setLineDash([6 / v.s, 4 / v.s]); ctx.stroke(); ctx.setLineDash([]);
      }
      ctx.restore();
      if (cursor && (tool === "brush" || tool === "erase")) {
        ctx.beginPath(); ctx.arc(cursor[0], cursor[1], size / 2, 0, 7);
        ctx.strokeStyle = tool === "erase" ? "#fff" : colorOf(current); ctx.lineWidth = 1.5; ctx.stroke();
      }
    };

    // ---- pointers: one finger draws, two fingers pan/zoom
    const pts = new Map();
    let pinch = null, pan = null, downAt = null;
    const local = (e) => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    cv.addEventListener("pointerdown", (e) => {
      cv.setPointerCapture(e.pointerId);
      const p = local(e);
      pts.set(e.pointerId, p);
      if (pts.size === 2) {                       // second finger: this is a pinch, not a stroke
        if (change) { if (performance.now() - change.t0 < 300 || change.old.size < 40) revert(); else commit(); }
        lasso = null; pan = null; pinch = null; return;
      }
      if (pts.size > 2) return;
      downAt = { p, t: performance.now() };
      if (tool === "move" || e.button === 1 || e.button === 2) { pan = { last: p, moved: false }; return; }
      if (tool === "lasso") { lasso = [view.toImage(...p)]; return; }
      begin(); change.t0 = performance.now(); change.start = view.toImage(...p);
      strokeTo(change.start);
    });
    cv.addEventListener("pointermove", (e) => {
      const p = local(e);
      if (e.pointerType === "mouse") { cursor = p; if (!pts.size) view.draw(); }
      if (!pts.has(e.pointerId)) return;
      const prev = pts.get(e.pointerId);
      pts.set(e.pointerId, p);
      if (pts.size === 2) {
        const [a, b] = [...pts.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]), m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        if (pinch) { view.ox += m[0] - pinch.m[0]; view.oy += m[1] - pinch.m[1]; view.zoomAt(d / pinch.d, m[0], m[1]); }
        pinch = { d, m }; return;
      }
      if (pan) { view.ox += p[0] - prev[0]; view.oy += p[1] - prev[1]; if (Math.hypot(p[0] - downAt.p[0], p[1] - downAt.p[1]) > 6) pan.moved = true; view.draw(); return; }
      if (lasso) { const q = view.toImage(...p), l = lasso[lasso.length - 1]; if (Math.hypot(q[0] - l[0], q[1] - l[1]) * view.s > 3) { lasso.push(q); view.draw(); } return; }
      if (change) { cursor = p; strokeTo(view.toImage(...p)); }
    });
    const up = (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.delete(e.pointerId);
      if (pts.size) return;
      pinch = null;
      const tap = downAt && performance.now() - downAt.t < 350 && Math.hypot(local(e)[0] - downAt.p[0], local(e)[1] - downAt.p[1]) < 8;
      if (pan) {
        if (tap) selectAt(view.toImage(...local(e)));
        pan = null; return;
      }
      if (lasso) {
        if (lasso.length > 2) { begin(); for (const i of polygonPixels(lasso, W, H)) if (!lab[i]) setPx(i, current); lasso = null; flush(); commit(); }
        else { const q = lasso[0]; lasso = null; if (tap) selectAt(q); view.draw(); }
        return;
      }
      if (change) {
        const nothing = change.old.size === 0, start = change.start;
        commit();
        if (nothing && tap) selectAt(start);     // tapping another object selects it
      }
      if (e.pointerType !== "mouse") { cursor = null; view.draw(); }
    };
    cv.addEventListener("pointerup", up);
    cv.addEventListener("pointercancel", (e) => { pts.delete(e.pointerId); if (change) revert(); lasso = null; pan = null; pinch = null; view.draw(); });
    cv.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") { cursor = null; view.draw(); } });
    cv.addEventListener("wheel", (e) => { e.preventDefault(); const p = local(e); view.zoomAt(Math.exp(-e.deltaY * 0.0015), p[0], p[1]); }, { passive: false });
    cv.addEventListener("contextmenu", (e) => e.preventDefault());
    function selectAt([x, y]) {
      const xi = Math.floor(x), yi = Math.floor(y);
      if (xi < 0 || yi < 0 || xi >= W || yi >= H) return;
      const v = lab[yi * W + xi];
      if (v && v !== current) { current = v; refresh(); }
    }

    // ---- buttons and keys
    let discardArmed = 0;
    function close(result) {
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onResize);
      el.remove();
      resolve(result);
    }
    async function finish() {
      const map = new Map(), out = new Uint16Array(N);
      let n = 0;
      for (let i = 0; i < N; i++) { const v = lab[i]; if (!v) continue; let m = map.get(v); if (!m) { m = ++n; map.set(v, m); } out[i] = m; }
      const objects = [...map].map(([old, value]) => { const m = meta.get(old); return m && m.cls ? { value, class: m.cls } : { value }; });
      const mask = n ? await encodeLabelPNG(out, W, H) : null;
      close({ mask, objects, frame, count: n });
    }
    el.addEventListener("click", (e) => {
      const t = e.target.closest("[data-e],[data-tool],[data-obj],[data-cls],[data-src],[data-from]");
      if (!t) return;
      if (t.dataset.tool) { tool = t.dataset.tool; prefs.set("tool", tool); refresh(); return; }
      if (t.dataset.obj) { current = +t.dataset.obj; if (tool === "move") tool = "brush"; refresh(); return; }
      if (t.dataset.cls !== undefined) { ensure(current); meta.get(current).cls = t.dataset.cls; defaultCls = t.dataset.cls; repaintFill(); refresh(); return; }
      if (t.dataset.src !== undefined) {
        const n = t.dataset.src;
        if (hidden.has(n)) hidden.delete(n); else hidden.add(n);
        t.setAttribute("aria-pressed", String(!hidden.has(n))); view.setHidden(hidden); return;
      }
      if (t.dataset.from !== undefined) { startFrom(t.dataset.from); return; }
      const a = t.dataset.e;
      if (a === "undo") undo();
      else if (a === "redo") redo();
      else if (a === "new") newObject();
      else if (a === "clear") { begin(); for (let i = 0; i < N; i++) if (lab[i]) setPx(i, 0); fctx.putImageData(fdata, 0, 0); commit(); }
      else if (a === "done") finish();
      else if (a === "cancel") {
        if (!undoStack.length || Date.now() - discardArmed < 3000) return close(null);
        discardArmed = Date.now(); t.textContent = "Discard?";
        setTimeout(() => { if (t.isConnected) t.textContent = "✕ Cancel"; }, 3000);
      }
    });
    const sz = $e("[data-size]");
    sz.value = size;
    sz.addEventListener("input", () => { size = +sz.value; prefs.set("brush", size); cursor = [cv.clientWidth / 2, cv.clientHeight / 2]; view.draw(); });
    sz.addEventListener("change", () => { cursor = null; view.draw(); });
    function onKey(e) {
      if (e.target.closest && e.target.closest("input[type=text], textarea")) return;
      const k = e.key.toLowerCase();
      let used = true;
      if ((e.ctrlKey || e.metaKey) && k === "z") e.shiftKey ? redo() : undo();
      else if ((e.ctrlKey || e.metaKey) && k === "y") redo();
      else if (e.ctrlKey || e.metaKey || e.altKey) used = false;
      else if (k === "escape") el.querySelector("[data-e=cancel]").click();
      else if (k === "enter") finish();
      else if (k === "b") tool = "brush";
      else if (k === "e") tool = "erase";
      else if (k === "l") tool = "lasso";
      else if (k === "m" || k === "h") tool = "move";
      else if (k === "n") newObject();
      else if (k === "[") { size = Math.max(2, size - 4); sz.value = size; }
      else if (k === "]") { size = Math.min(90, size + 4); sz.value = size; }
      else used = false;
      if (used) { e.preventDefault(); e.stopPropagation(); if (!["escape", "enter"].includes(k)) refresh(); }
    }
    document.addEventListener("keydown", onKey, true);
    const onResize = () => view.resize();
    window.addEventListener("resize", onResize);

    // ---- load: earlier mask, then show
    if (initial && initial.mask) {
      try {
        const d = await decodeLabelPNG(await initial.mask.arrayBuffer());
        if (d.width === W && d.height === H) for (let i = 0; i < N; i++) lab[i] = d.labels[i];
        for (const o of initial.objects || []) meta.set(o.value, { cls: o.class });
      } catch (e) { console.error(e); }
    }
    const ids = presentIds();
    current = ids.size ? Math.min(...ids) : 1;
    for (const id of ids) ensure(id);
    repaintFill();
    await view.show(rec, card, { frame, hidden });
    refresh();
  });
}
