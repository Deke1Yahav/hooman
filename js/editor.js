// Mask editor. Draw: brush, contour brush, polygon, magic wand, pick a model's object, eraser.
// Fix: cut, merge, fill holes, delete, move. Objects + classes, undo/redo, channels, contrast.
// One finger draws, two fingers pan and zoom. The result is a label image (0 = background, 1..n = objects).

import { CardCanvas, labels as loadLabels, outlinePath, intensity, canvas2d } from "./view.js";
import { decodeLabelPNG, encodeLabelPNG } from "./png.js";
import { prefs } from "./prefs.js";
import { displayFor, openContrast, closeContrast } from "./contrast.js";

const PALETTE = ["#c6ff3d", "#ff8fab", "#4fc3f7", "#ffa94d", "#e599f7", "#3ddc97", "#f2c14e", "#b9e3ff", "#ff5d6c", "#9ad0a8"];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const rgb = (hex) => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };

const TOOLS = {
  brush: ["🖌", "Brush", "Paint the selected object. Other objects are protected."],
  contour: ["〰", "Contour", "Draw around an object. Close the line and the inside fills."],
  polygon: ["⬠", "Polygon", "Tap the corners. Tap the first corner, or ✓, to fill."],
  wand: ["✨", "Wand", "Tap an object to fill it. The slider makes it smaller or bigger."],
  pick: ["👆", "Pick", "Tap inside a model's outline to take that object."],
  erase: ["⌫", "Erase", "Erase anything under the brush."],
  cut: ["✂", "Cut", "Draw a line across an object to cut it in two."],
  merge: ["⊕", "Merge", "Tap an object to join it to the selected one."],
  fill: ["◉", "Fill holes", ""],
  delete: ["🗑", "Delete", ""],
  move: ["✋", "Move", "Drag to move, pinch to zoom, tap an object to select it."],
};
const PAN_TOOLS = new Set(["move", "wand", "pick", "merge", "polygon"]);

export const editorOpen = () => !!document.querySelector(".editor");

// Pixel indices inside a polygon (image px).
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
function inPolygon(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function otsu(vals, lo, hi) {
  const bins = 128, h = new Float64Array(bins), span = hi - lo || 1;
  for (const v of vals) h[Math.min(bins - 1, Math.floor(((v - lo) / span) * bins))]++;
  let total = vals.length, sum = 0, sumB = 0, wB = 0, best = 0, t = 0;
  for (let i = 0; i < bins; i++) sum += i * h[i];
  for (let i = 0; i < bins; i++) {
    wB += h[i]; if (!wB) continue;
    const wF = total - wB; if (!wF) break;
    sumB += i * h[i];
    const mB = sumB / wB, mF = (sum - sumB) / wF, between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; t = i; }
  }
  return lo + ((t + 1) / bins) * span;
}

/**
 * Opens the editor full-screen. Resolves {mask: Blob|null, objects: [{value, class?}], frame, count}, or null when cancelled.
 * initial: {mask: Blob, objects} to keep editing an earlier mask.
 */
export function openEditor({ rec, card, frame = 0, hidden = new Set(), initial = null, title = "Draw the mask", doneLabel = "Done", note = "" }) {
  return new Promise(async (resolve) => {
    const deck = rec.deck, W = card.w, H = card.h, N = W * H;
    const classes = deck.classes || [];
    const fromSources = deck.sources.filter((s) => card.overlays.some((o) => o.source === s.name && o.shape !== "point"));
    const multi = card.frames.length > 1;
    const toolBtn = (t) => `<button class="tool" data-tool="${t}"><b>${TOOLS[t][0]}</b>${TOOLS[t][1]}</button>`;
    const el = document.createElement("div");
    el.className = "editor";
    el.innerHTML = `
      <div class="bar">
        <button class="ghost" data-e="cancel">✕ Cancel</button>
        <h3>${esc(title)}${note ? `<small>${esc(note)}</small>` : ""}</h3>
        <button class="btn" data-e="done" style="min-height:40px;padding:0 14px">✓ ${esc(doneLabel)}</button>
      </div>
      <div class="rowx">
        <button class="chip" data-e="contrast" aria-label="Contrast"><span>◐</span></button>
        ${deck.sources.map((s) => `<button class="chip" data-src="${esc(s.name)}" aria-pressed="${!hidden.has(s.name)}" style="color:${esc(s.color)}"><i></i><span style="color:var(--text)">${esc(s.label)}</span></button>`).join("")}
        ${multi ? `<span class="sep"></span>${card.frames.map((f, i) => `<button class="chip frame" data-frame="${i}" aria-pressed="${i === frame}"><span>${esc(f.name || i + 1)}</span></button>`).join("")}` : ""}
      </div>
      <div class="cwrap"><canvas></canvas><div class="ehint"></div></div>
      <div class="rowx" data-objects></div>
      ${classes.length ? `<div class="rowx" data-classes></div>` : ""}
      <div class="tools t6">${["brush", "contour", "polygon", "wand", "pick", "erase"].map(toolBtn).join("")}</div>
      <div class="tools t5">${["cut", "merge", "fill", "delete", "move"].map(toolBtn).join("")}</div>
      <div class="rowx sizes">
        <span class="muted slabel" style="font-size:12px;flex:none"></span><input type="range" data-size aria-label="Brush size">
        <button class="tool small" data-e="undo" aria-label="Undo">↶</button><button class="tool small" data-e="redo" aria-label="Redo">↷</button>
      </div>
      <div class="rowx starts">
        ${fromSources.map((s) => `<button class="chip" data-from="${esc(s.name)}" style="color:${esc(s.color)}"><i></i><span style="color:var(--text)">Start from ${esc(s.label)}</span></button>`).join("")}
        <button class="chip" data-e="clear"><span>Clear all</span></button>
      </div>`;
    document.body.appendChild(el);
    const cv = el.querySelector("canvas");
    const view = new CardCanvas(cv);
    view.display = displayFor(rec.key, card);
    const $e = (s) => el.querySelector(s);

    // ---- state
    const lab = new Uint16Array(N);
    const meta = new Map();                     // object id -> {cls}
    let current = 1, tool = prefs.get("tool", "brush"), size = prefs.get("brush", 18), tol = prefs.get("wandTol", 0);
    if (!TOOLS[tool] || tool === "fill" || tool === "delete") tool = "brush";
    let defaultCls = classes[0] ? classes[0].value : undefined;
    let undoStack = [], redoStack = [], change = null, path = null, poly = null, cursor = null, lastWand = null, mergeInto = null;
    let outlineAll = null, outlineCur = null;
    const fill = canvas2d(W, H), fctx = fill.getContext("2d"), fdata = fctx.createImageData(W, H);
    const colorCache = new Map();
    const colorOf = (id) => {
      const m = meta.get(id), cls = m && m.cls ? classes.find((c) => c.value === m.cls) : null;
      return cls && cls.color ? cls.color : PALETTE[(id - 1) % PALETTE.length];
    };
    const rgbOf = (id) => { const c = colorOf(id); if (!colorCache.has(c)) colorCache.set(c, rgb(c)); return colorCache.get(c); };
    const ensure = (id, cls = defaultCls) => { if (!meta.has(id)) meta.set(id, { cls }); };
    const classOfLabel = (label) => {               // "apple 0.83" -> class "apple" when the deck has it
      if (!label || !classes.length) return undefined;
      const l = String(label).trim().toLowerCase(), w = l.split(/[\s:,(]+/)[0];
      const c = classes.find((c) => c.value.toLowerCase() === l || c.value.toLowerCase() === w || c.label.toLowerCase() === w);
      return c ? c.value : undefined;
    };
    const ensureAs = (id, label) => { ensure(id); const c = classOfLabel(label); if (c) meta.get(id).cls = c; };
    const nextId = () => { let m = 0; for (let i = 0; i < N; i++) if (lab[i] > m) m = lab[i]; for (const k of meta.keys()) if (k > m) m = k; return m + 1; };

    function setFillPx(i, v) {
      const d = fdata.data, k = 4 * i;
      if (!v) { d[k + 3] = 0; return; }
      const [r, g, b] = rgbOf(v);
      d[k] = r; d[k + 1] = g; d[k + 2] = b; d[k + 3] = 105;
    }
    function repaintFill() { for (let i = 0; i < N; i++) setFillPx(i, lab[i]); fctx.putImageData(fdata, 0, 0); }

    // ---- changes: each user action is one undo step
    function begin() { change = { old: new Map(), dirty: [Infinity, Infinity, -Infinity, -Infinity], t0: performance.now() }; }
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
      if (!change) return null;
      let step = null;
      if (change.old.size) {
        const after = new Map();
        for (const i of change.old.keys()) after.set(i, lab[i]);
        step = { old: change.old, after };
        undoStack.push(step); redoStack = [];
        if (undoStack.length > 60) undoStack.shift();
      }
      flush();
      change = null;
      refresh();
      return step;
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
    const undo = () => {
      if (poly && poly.length) { poly.pop(); if (!poly.length) poly = null; refresh(); return; }
      const s = undoStack.pop(); if (s) { redoStack.push(s); applyStep(s.old); }
    };
    const redo = () => { const s = redoStack.pop(); if (s) { undoStack.push(s); applyStep(s.after); } };

    // ---- brush strokes (brush, contour, erase)
    const brushR = () => Math.max(0.5, size / 2 / view.s);
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
      const r = brushR(), erase = tool === "erase";
      const [ax, ay] = change.last || p, dist = Math.hypot(p[0] - ax, p[1] - ay), steps = Math.max(1, Math.ceil(dist / Math.max(0.5, r * 0.4)));
      for (let k = 1; k <= steps; k++) stamp(ax + ((p[0] - ax) * k) / steps, ay + ((p[1] - ay) * k) / steps, r, erase);
      change.last = p;
      flush();
    }

    // ---- objects
    function presentIds() { const s = new Set(); for (let i = 0; i < N; i++) if (lab[i]) s.add(lab[i]); return s; }
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
      $e("[data-e=undo]").disabled = !undoStack.length && !(poly && poly.length);
      $e("[data-e=redo]").disabled = !redoStack.length;
      const sz = $e("[data-size]"), sl = $e(".slabel");
      if (tool === "wand") { sz.min = -1; sz.max = 1; sz.step = 0.02; sz.value = tol; sl.textContent = "smaller ◀ ▶ bigger"; }
      else { sz.min = 2; sz.max = 90; sz.step = 1; sz.value = size; sl.textContent = "size"; }
      const hint = $e(".ehint");
      let text = TOOLS[tool][2];
      if (tool === "merge") text = mergeInto ? `Tap objects to join them to object ${mergeInto}. Tap the background to start over.` : "Tap the object to keep, then the ones to join to it.";
      hint.innerHTML = `<span>${esc(text)}</span>${tool === "polygon" && poly && poly.length ? `<button class="chip" data-e="polyfill"><span>✓ Fill</span></button><button class="chip" data-e="polycancel"><span>✕</span></button>` : ""}`;
      view.draw();
    }
    function newObject() {                     // the selected object stays "new" until something is drawn in it
      if (presentIds().has(current)) current = nextId();
      ensure(current);
      if (!["brush", "contour", "polygon", "wand", "pick"].includes(tool)) tool = "brush";
      refresh();
    }
    // the object to draw a fresh shape into: the selected one if it is still empty, else a new one
    function freshId() { if (presentIds().has(current)) current = nextId(); ensure(current); return current; }
    const at = ([x, y]) => { const xi = Math.floor(x), yi = Math.floor(y); return xi < 0 || yi < 0 || xi >= W || yi >= H ? -1 : yi * W + xi; };
    function selectAt(p) { const i = at(p); if (i >= 0 && lab[i] && lab[i] !== current) { current = lab[i]; refresh(); } }

    // ---- polygon, contour fill
    function fillPolygon(pts, id) {
      for (const i of polygonPixels(pts, W, H)) if (!lab[i]) setPx(i, id);
    }
    function closePolygon() {
      if (!poly || poly.length < 3) { poly = null; refresh(); return; }
      const pts = poly; poly = null;
      begin(); fillPolygon(pts, current); commit();
    }

    // ---- magic wand: local Otsu threshold around the tap, connected region, holes filled
    function wandAt(p, forceId) {
      const i0 = at(p);
      if (i0 < 0) return;
      if (lab[i0] && !forceId) { current = lab[i0]; refresh(); return; }
      const src = view.sources[view.frame] || view.sources[0], I = intensity(src);
      const sx = i0 % W, sy = (i0 / W) | 0;
      const [vx0, vy0] = view.toImage(0, 0), [vx1, vy1] = view.toImage(cv.clientWidth, cv.clientHeight);
      const half = 384, minHalf = 24;
      const x0 = Math.max(0, Math.floor(Math.min(sx - minHalf, Math.max(vx0, sx - half)))), x1 = Math.min(W, Math.ceil(Math.max(sx + minHalf, Math.min(vx1, sx + half))));
      const y0 = Math.max(0, Math.floor(Math.min(sy - minHalf, Math.max(vy0, sy - half)))), y1 = Math.min(H, Math.ceil(Math.max(sy + minHalf, Math.min(vy1, sy + half))));
      const ww = x1 - x0, wh = y1 - y0, sm = new Float32Array(ww * wh);
      let lo = Infinity, hi = -Infinity;
      for (let y = 0; y < wh; y++) for (let x = 0; x < ww; x++) {      // 3x3 mean against noise
        let s = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const X = x0 + x + dx, Y = y0 + y + dy;
          if (X >= 0 && Y >= 0 && X < W && Y < H) { s += I[Y * W + X]; n++; }
        }
        const v = s / n; sm[y * ww + x] = v; if (v < lo) lo = v; if (v > hi) hi = v;
      }
      const T = otsu(sm, lo, hi), seed = sm[(sy - y0) * ww + (sx - x0)], bright = seed >= T;
      const T2 = T - (bright ? 1 : -1) * tol * 0.5 * (hi - lo);
      const ok = bright ? (v) => v >= T2 : (v) => v <= T2;
      const reg = new Uint8Array(ww * wh), stack = [(sy - y0) * ww + (sx - x0)];
      let bx0 = ww, by0 = wh, bx1 = 0, by1 = 0;
      if (!ok(seed)) return flashHint("Nothing to fill here: try the slider toward bigger");
      reg[stack[0]] = 1;
      while (stack.length) {
        const k = stack.pop(), x = k % ww, y = (k / ww) | 0;
        if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y;
        const nb = [x > 0 ? k - 1 : -1, x < ww - 1 ? k + 1 : -1, y > 0 ? k - ww : -1, y < wh - 1 ? k + ww : -1];
        for (const q of nb) if (q >= 0 && !reg[q] && !lab[(y0 + ((q / ww) | 0)) * W + x0 + (q % ww)] && ok(sm[q])) { reg[q] = 1; stack.push(q); }
      }
      fillHolesIn(reg, ww, wh, bx0, by0, bx1, by1);
      const id = forceId || freshId();
      begin();
      for (let y = by0; y <= by1; y++) for (let x = bx0; x <= bx1; x++) if (reg[y * ww + x]) { const i = (y0 + y) * W + x0 + x; if (!lab[i]) setPx(i, id); }
      current = id;
      const step = commit();
      lastWand = step ? { p, id, step } : null;
    }
    // region (window-sized) -> also mark enclosed background inside its bbox
    function fillHolesIn(reg, ww, wh, bx0, by0, bx1, by1) {
      const w = bx1 - bx0 + 3, h = by1 - by0 + 3, out = new Uint8Array(w * h), st = [0];
      const inReg = (x, y) => { const X = bx0 - 1 + x, Y = by0 - 1 + y; return X >= 0 && Y >= 0 && X < ww && Y < wh && reg[Y * ww + X]; };
      out[0] = 1;
      while (st.length) {
        const k = st.pop(), x = k % w, y = (k / w) | 0;
        for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const q = ny * w + nx;
          if (!out[q] && !inReg(nx, ny)) { out[q] = 1; st.push(q); }
        }
      }
      for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) if (!out[y * w + x]) reg[(by0 - 1 + y) * ww + bx0 - 1 + x] = 1;
    }
    function rerunWand() {
      if (!lastWand || undoStack[undoStack.length - 1] !== lastWand.step) return;
      undoStack.pop(); applyStep(lastWand.step.old);
      const { p, id } = lastWand;
      wandAt(p, id);
    }

    // ---- pick: take the model object under the tap
    async function pickAt(p) {
      const i0 = at(p);
      if (i0 < 0) return;
      if (lab[i0]) return selectAt(p);            // already drawn: select it instead of copying again
      const ovs = card.overlays.filter((o) => !hidden.has(o.source) && o.shape !== "point" && (o.frame === undefined || o.frame === view.frame));
      for (let k = ovs.length - 1; k >= 0; k--) {
        const o = ovs[k];
        if (o.shape === "mask") {
          const L = (await loadLabels(rec.key, o.mask)).labels, v = L[i0];
          if (!v || (o.value && v !== o.value)) continue;
          const id = freshId(); ensureAs(id, o.label);
          begin(); for (let i = 0; i < N; i++) if (L[i] === v && !lab[i]) setPx(i, id); commit();
          return;
        }
        const pts = o.shape === "box" ? [[o.box[0], o.box[1]], [o.box[0] + o.box[2], o.box[1]], [o.box[0] + o.box[2], o.box[1] + o.box[3]], [o.box[0], o.box[1] + o.box[3]]] : o.polygon;
        if (!inPolygon(p[0], p[1], pts)) continue;
        const id = freshId(); ensureAs(id, o.label);
        begin(); fillPolygon(pts, id); commit();
        return;
      }
      if (lab[i0]) selectAt(p); else flashHint("No model outline here. Show a model with its chip above");
    }

    // ---- cut: a line through objects splits them; the line's pixels go back to the nearest piece
    function cutAlong(pts) {
      const r = Math.max(0.75, 1.5 / view.s), cutPx = new Map();     // index -> old label
      const mark = (cx, cy) => {
        for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(H - 1, Math.floor(cy + r)); y++)
          for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(W - 1, Math.floor(cx + r)); x++) {
            const i = y * W + x;
            if (lab[i] && (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r) cutPx.set(i, lab[i]);
          }
      };
      for (let k = 1; k < pts.length; k++) {
        const [ax, ay] = pts[k - 1], [bx, by] = pts[k], n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / (r * 0.5)));
        for (let j = 0; j <= n; j++) mark(ax + ((bx - ax) * j) / n, ay + ((by - ay) * j) / n);
      }
      if (!cutPx.size) return flashHint("The line didn't cross an object");
      begin();
      for (const i of cutPx.keys()) setPx(i, 0);
      const touched = new Set(cutPx.values()), piecesOf = new Map([...touched].map((L) => [L, new Set([L])]));
      let made = 0;
      for (const L of touched) {                 // connected pieces of each cut object
        const seen = new Uint8Array(N), pieces = [];
        for (let i = 0; i < N; i++) {
          if (lab[i] !== L || seen[i]) continue;
          const comp = [i], st = [i]; seen[i] = 1;
          while (st.length) {
            const k = st.pop(), x = k % W;
            for (const q of [x > 0 ? k - 1 : -1, x < W - 1 ? k + 1 : -1, k - W, k + W]) if (q >= 0 && q < N && !seen[q] && lab[q] === L) { seen[q] = 1; st.push(q); comp.push(q); }
          }
          pieces.push(comp);
        }
        pieces.sort((a, b) => b.length - a.length);
        for (const comp of pieces.slice(1)) {
          const id = nextId(); meta.set(id, { cls: (meta.get(L) || {}).cls }); piecesOf.get(L).add(id);
          for (const i of comp) setPx(i, id);
          made++;
        }
      }
      for (let pass = 0; pass < Math.ceil(r) + 2; pass++) {             // give the cut line back to the pieces it came from
        let left = 0;
        for (const [i, old] of cutPx) {
          if (lab[i]) continue;
          const x = i % W, counts = new Map(), mine = piecesOf.get(old);
          for (const q of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i - W, i + W]) {
            if (q < 0 || q >= N || !mine.has(lab[q])) continue;
            counts.set(lab[q], (counts.get(lab[q]) || 0) + 1);
          }
          if (counts.size) { setPx(i, [...counts].sort((a, b) => b[1] - a[1])[0][0]); } else left++;
        }
        if (!left) break;
      }
      commit();
      if (!made) flashHint("Cut didn't split anything: draw all the way across");
    }

    // ---- merge, delete, fill holes
    function mergeAt(p) {                      // first tap: the object to keep; next taps join into it
      const i0 = at(p);
      if (i0 < 0 || !lab[i0]) { mergeInto = null; refresh(); return; }
      const t = lab[i0];
      if (!mergeInto || !presentIds().has(mergeInto) || t === mergeInto) { mergeInto = current = t; refresh(); return; }
      current = mergeInto;
      begin(); for (let i = 0; i < N; i++) if (lab[i] === t) setPx(i, mergeInto); commit();
    }
    function deleteCurrent() {
      begin(); for (let i = 0; i < N; i++) if (lab[i] === current) setPx(i, 0); commit();
    }
    function fillHolesCurrent() {
      let bx0 = W, by0 = H, bx1 = -1, by1 = -1;
      for (let i = 0; i < N; i++) if (lab[i] === current) { const x = i % W, y = (i / W) | 0; if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y; }
      if (bx1 < 0) return flashHint("Select an object first");
      const ww = bx1 - bx0 + 1, wh = by1 - by0 + 1, reg = new Uint8Array(ww * wh);
      for (let y = 0; y < wh; y++) for (let x = 0; x < ww; x++) reg[y * ww + x] = lab[(by0 + y) * W + bx0 + x] === current ? 1 : 0;
      fillHolesIn(reg, ww, wh, 0, 0, ww - 1, wh - 1);
      begin();
      for (let y = 0; y < wh; y++) for (let x = 0; x < ww; x++) if (reg[y * ww + x]) { const i = (by0 + y) * W + bx0 + x; if (!lab[i]) setPx(i, current); }
      const n = change.old.size;
      commit();
      flashHint(n ? `Filled ${n} pixel${n > 1 ? "s" : ""}` : "No holes in this object");
    }

    // ---- start from a model's mask / shapes
    async function startFrom(name) {
      const ovs = card.overlays.filter((o) => o.source === name && o.shape !== "point" && (o.frame === undefined || o.frame === view.frame));
      begin();
      let next = nextId(), first = null;
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
          fillPolygon(pts, id);
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
      const line = (pts, color, dash, close) => {
        ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); if (close) ctx.closePath();
        ctx.strokeStyle = color; ctx.lineWidth = 2 / v.s; ctx.setLineDash(dash ? [6 / v.s, 4 / v.s] : []); ctx.stroke(); ctx.setLineDash([]);
      };
      if (path && path.length > 1) line(path, tool === "cut" ? "#ff5d6c" : colorOf(current), true, false);
      if (poly && poly.length) {
        line(poly, colorOf(current), false, false);
        poly.forEach(([x, y], i) => { ctx.beginPath(); ctx.arc(x, y, (i ? 3.5 : 6) / v.s, 0, 7); ctx.fillStyle = i ? colorOf(current) : "#fff"; ctx.fill(); });
      }
      ctx.restore();
      if (cursor && ["brush", "erase", "contour"].includes(tool)) {
        ctx.beginPath(); ctx.arc(cursor[0], cursor[1], size / 2, 0, 7);
        ctx.strokeStyle = tool === "erase" ? "#fff" : colorOf(current); ctx.lineWidth = 1.5; ctx.stroke();
      }
    };
    let hintTimer;
    function flashHint(msg) {
      const h = $e(".ehint span"); if (!h) return;
      h.textContent = msg; h.classList.add("warn");
      clearTimeout(hintTimer); hintTimer = setTimeout(() => refresh(), 2200);
    }

    // ---- pointers: one finger draws (or pans, for tap tools), two fingers pan/zoom
    const pts = new Map();
    let pinch = null, pan = null, downAt = null;
    const local = (e) => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    cv.addEventListener("pointerdown", (e) => {
      cv.setPointerCapture(e.pointerId);
      const p = local(e);
      pts.set(e.pointerId, p);
      if (pts.size === 2) {                       // a second finger: this is a pinch, not a stroke
        if (change) { if (performance.now() - change.t0 < 300 || change.old.size < 40) revert(); else commit(); }
        path = null; pan = null; pinch = null; return;
      }
      if (pts.size > 2) return;
      downAt = { p, t: performance.now() };
      if (PAN_TOOLS.has(tool) || e.button === 1 || e.button === 2) { pan = { moved: false }; return; }
      const ip = view.toImage(...p);
      if (tool === "cut") { path = [ip]; return; }
      begin(); change.start = ip;
      if (tool === "contour") { current = freshId(); path = [ip]; }
      strokeTo(ip);
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
      const ip = view.toImage(...p);
      if (path) { const l = path[path.length - 1]; if (Math.hypot(ip[0] - l[0], ip[1] - l[1]) * view.s > 2) path.push(ip); }
      if (change) { cursor = p; strokeTo(ip); } else if (path) view.draw();
    });
    const up = (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.delete(e.pointerId);
      if (pts.size) return;
      pinch = null;
      const p = local(e), ip = view.toImage(...p);
      const tap = downAt && performance.now() - downAt.t < 400 && Math.hypot(p[0] - downAt.p[0], p[1] - downAt.p[1]) < 8;
      if (pan) {
        pan = null;
        if (!tap) return;
        if (tool === "wand") wandAt(ip);
        else if (tool === "pick") pickAt(ip);
        else if (tool === "merge") mergeAt(ip);
        else if (tool === "polygon") {
          if (poly && poly.length >= 3 && Math.hypot(ip[0] - poly[0][0], ip[1] - poly[0][1]) * view.s < 16) closePolygon();
          else { if (!poly) { poly = []; freshId(); } poly.push(ip); refresh(); }
        } else selectAt(ip);
        return;
      }
      if (tool === "cut") { const line = path; path = null; if (line && line.length > 1) cutAlong(line); else { if (tap) selectAt(ip); view.draw(); } return; }
      if (change) {
        if (tool === "contour" && path && path.length > 2) {   // a closed outline fills its inside
          const close = Math.hypot(ip[0] - path[0][0], ip[1] - path[0][1]) * view.s;
          if (close < Math.max(40, size * 2)) fillPolygon(path, current);
        }
        path = null;
        const nothing = change.old.size === 0, start = change.start;
        commit();
        if (nothing && tap) selectAt(start);     // tapping another object selects it
      }
      if (e.pointerType !== "mouse") { cursor = null; view.draw(); }
    };
    cv.addEventListener("pointerup", up);
    cv.addEventListener("pointercancel", (e) => { pts.delete(e.pointerId); if (change) revert(); path = null; pan = null; pinch = null; view.draw(); });
    cv.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") { cursor = null; view.draw(); } });
    cv.addEventListener("wheel", (e) => { e.preventDefault(); const p = local(e); view.zoomAt(Math.exp(-e.deltaY * 0.0015), p[0], p[1]); }, { passive: false });
    cv.addEventListener("contextmenu", (e) => e.preventDefault());

    // ---- buttons and keys
    let discardArmed = 0;
    const onContrast = () => view.draw();
    window.addEventListener("hooman:contrast", onContrast);
    function close(result) {
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("hooman:contrast", onContrast);
      closeContrast();
      el.remove();
      resolve(result);
    }
    async function finish() {
      if (poly && poly.length >= 3) closePolygon();
      const map = new Map(), out = new Uint16Array(N);
      let n = 0;
      for (let i = 0; i < N; i++) { const v = lab[i]; if (!v) continue; let m = map.get(v); if (!m) { m = ++n; map.set(v, m); } out[i] = m; }
      const objects = [...map].map(([old, value]) => { const m = meta.get(old); return m && m.cls ? { value, class: m.cls } : { value }; });
      const mask = n ? await encodeLabelPNG(out, W, H) : null;
      close({ mask, objects, frame, count: n });
    }
    function setTool(t) {
      if (t === "fill") return fillHolesCurrent();
      if (t === "delete") return deleteCurrent();
      if (tool === "polygon" && t !== "polygon") poly = null;
      mergeInto = null;
      tool = t; prefs.set("tool", tool); refresh();
    }
    el.addEventListener("click", (e) => {
      const t = e.target.closest("[data-e],[data-tool],[data-obj],[data-cls],[data-src],[data-from],[data-frame]");
      if (!t) return;
      if (t.dataset.tool) return setTool(t.dataset.tool);
      if (t.dataset.obj) { current = +t.dataset.obj; refresh(); return; }
      if (t.dataset.cls !== undefined) { ensure(current); meta.get(current).cls = t.dataset.cls; defaultCls = t.dataset.cls; repaintFill(); refresh(); return; }
      if (t.dataset.src !== undefined) {
        const n = t.dataset.src;
        if (hidden.has(n)) hidden.delete(n); else hidden.add(n);
        t.setAttribute("aria-pressed", String(!hidden.has(n))); view.setHidden(hidden); return;
      }
      if (t.dataset.frame !== undefined) {
        view.setFrame(+t.dataset.frame);
        el.querySelectorAll("[data-frame]").forEach((b) => b.setAttribute("aria-pressed", String(+b.dataset.frame === view.frame)));
        return;
      }
      if (t.dataset.from !== undefined) { startFrom(t.dataset.from); return; }
      const a = t.dataset.e;
      if (a === "undo") undo();
      else if (a === "redo") redo();
      else if (a === "new") newObject();
      else if (a === "polyfill") closePolygon();
      else if (a === "polycancel") { poly = null; refresh(); }
      else if (a === "contrast") {
        const src = view.sources[view.frame] || view.sources[0];
        openContrast(rec.key, multi ? card.frames[view.frame].name || "" : "", src.bits === 16);
      }
      else if (a === "clear") { begin(); for (let i = 0; i < N; i++) if (lab[i]) setPx(i, 0); fctx.putImageData(fdata, 0, 0); commit(); }
      else if (a === "done") finish();
      else if (a === "cancel") {
        if (!undoStack.length || Date.now() - discardArmed < 3000) return close(null);
        discardArmed = Date.now(); t.textContent = "Discard?";
        setTimeout(() => { if (t.isConnected) t.textContent = "✕ Cancel"; }, 3000);
      }
    });
    const sz = $e("[data-size]");
    sz.addEventListener("input", () => {
      if (tool === "wand") { tol = +sz.value; prefs.set("wandTol", tol); rerunWand(); return; }
      size = +sz.value; prefs.set("brush", size); cursor = [cv.clientWidth / 2, cv.clientHeight / 2]; view.draw();
    });
    sz.addEventListener("change", () => { cursor = null; view.draw(); });
    function onKey(e) {
      if (e.target.closest && e.target.closest("input[type=text], textarea")) return;
      const k = e.key.toLowerCase(), keys = { b: "brush", c: "contour", p: "polygon", w: "wand", k: "pick", e: "erase", x: "cut", j: "merge", m: "move", h: "move", f: "fill" };
      let used = true;
      if ((e.ctrlKey || e.metaKey) && k === "z") e.shiftKey ? redo() : undo();
      else if ((e.ctrlKey || e.metaKey) && k === "y") redo();
      else if (e.ctrlKey || e.metaKey || e.altKey) used = false;
      else if (k === "escape") { if (poly) { poly = null; refresh(); } else el.querySelector("[data-e=cancel]").click(); }
      else if (k === "enter") { if (poly) closePolygon(); else finish(); }
      else if (keys[k]) setTool(keys[k]);
      else if (k === "delete") deleteCurrent();
      else if (k === "n") newObject();
      else if (k === "[") { size = Math.max(2, size - 4); refresh(); }
      else if (k === "]") { size = Math.min(90, size + 4); refresh(); }
      else used = false;
      if (used) { e.preventDefault(); e.stopPropagation(); }
    }
    document.addEventListener("keydown", onKey, true);
    const onResize = () => view.resize();
    window.addEventListener("resize", onResize);
    el._debug = () => { const ids = presentIds(); let px = 0; for (let i = 0; i < N; i++) if (lab[i]) px++; return { objects: ids.size, pixels: px, current, tool, frame: view.frame, view: { s: view.s, ox: view.ox, oy: view.oy }, classes: [...ids].map((id) => (meta.get(id) || {}).cls || null) }; };

    // ---- load: earlier mask, then show
    if (initial && initial.mask) {
      try {
        const d = await decodeLabelPNG(await initial.mask.arrayBuffer());
        if (d.width === W && d.height === H) for (let i = 0; i < N; i++) lab[i] = d.labels[i];
        for (const o of initial.objects || []) meta.set(o.value, { cls: o.class });
      } catch (err) { console.error(err); }
    }
    const ids = presentIds();
    current = ids.size ? Math.min(...ids) : 1;
    for (const id of ids) ensure(id);
    repaintFill();
    await view.show(rec, card, { frame, hidden });
    refresh();
  });
}
