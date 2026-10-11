// Draws a card: the image (or one of its frames) and its overlays, on one canvas.
// Mask outlines are vector paths along pixel borders, so they line up exactly with the image at any zoom.

import * as store from "./store.js";
import { decodeLabelPNG } from "./png.js";

// Small LRU caches; big microscopy frames get the smallest budget.
const LIMITS = { f: 8, l: 12, m: 24 };
const caches = { f: new Map(), l: new Map(), m: new Map() };
function cached(key, make) {
  const kind = key[0], cache = caches[kind];
  if (cache.has(key)) { const v = cache.get(key); cache.delete(key); cache.set(key, v); return v; }
  const v = make();
  v.catch(() => cache.delete(key));
  cache.set(key, v);
  while (cache.size > LIMITS[kind]) cache.delete(cache.keys().next().value);
  return v;
}
export const canvas2d = (w, h) => (typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(w, h) : Object.assign(document.createElement("canvas"), { width: w, height: h }));

// A frame's pixels: {w, h, bits, bmp | gray}. Raw 16-bit grey PNGs (microscopy) are decoded here,
// because the browser would crush them to 8 bits; the hooman's contrast settings then pick the window.
export function frameSource(deckKey, path) {
  return cached(`f|${deckKey}|${path}`, async () => {
    const blob = await store.getFile(deckKey, path);
    if (!blob) throw new Error(`missing file ${path}`);
    const head = new Uint8Array(await blob.slice(0, 26).arrayBuffer());
    if (head[0] === 137 && head[1] === 80 && head[24] === 16 && (head[25] === 0 || head[25] === 4)) {
      const d = await decodeLabelPNG(await blob.arrayBuffer());
      return { w: d.width, h: d.height, bits: 16, gray: d.labels };
    }
    const bmp = await createImageBitmap(blob);
    return { w: bmp.width, h: bmp.height, bits: 8, bmp };
  });
}

// One intensity per pixel (16-bit value, or 8-bit luminance), for contrast and the magic wand.
export function intensity(src) {
  if (src.int) return src.int;
  if (src.gray) return (src.int = src.gray);
  const c = canvas2d(src.w, src.h), ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(src.bmp, 0, 0);
  const d = (src.rgba = ctx.getImageData(0, 0, src.w, src.h).data), out = new Uint8Array(src.w * src.h);
  for (let i = 0, j = 0; i < out.length; i++, j += 4) out[i] = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8;
  return (src.int = out);
}
function percentile(src) {
  if (src.pct) return src.pct;
  const I = intensity(src), bins = src.bits === 16 ? 65536 : 256, hist = new Float64Array(bins);
  for (let i = 0; i < I.length; i++) hist[I[i]]++;
  for (let v = 1; v < bins; v++) hist[v] += hist[v - 1];
  const n = I.length;
  return (src.pct = (p) => { const want = (p / 100) * n; let lo = 0, hi = bins - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (hist[m] < want) lo = m + 1; else hi = m; } return lo; });
}
export const AUTO = { min: 0.5, max: 99.8, gamma: 1, invert: false };

// What to draw for a frame: the plain bitmap, or a contrast-adjusted copy (black/white points are percentiles).
export function rendered(src, params) {
  if (!params && src.bmp) return src.bmp;
  const p = params || AUTO, key = `${p.min}|${p.max}|${p.gamma}|${p.invert ? 1 : 0}`;
  if (src.rkey === key) return src.rcanvas;
  const I = intensity(src), pct = percentile(src);
  let lo = pct(p.min), hi = pct(p.max);
  if (hi <= lo) hi = lo + 1;
  const n = src.bits === 16 ? 65536 : 256, lut = new Uint8Array(n), g = p.gamma || 1;
  for (let v = 0; v < n; v++) { let t = (v - lo) / (hi - lo); t = t < 0 ? 0 : t > 1 ? 1 : Math.pow(t, g); lut[v] = Math.round((p.invert ? 1 - t : t) * 255); }
  const c = src.rcanvas || canvas2d(src.w, src.h), ctx = c.getContext("2d");
  const img = ctx.createImageData(src.w, src.h), o = img.data;
  if (src.gray) for (let i = 0, j = 0; i < I.length; i++, j += 4) { const v = lut[I[i]]; o[j] = v; o[j + 1] = v; o[j + 2] = v; o[j + 3] = 255; }
  else { const d = src.rgba; for (let j = 0; j < d.length; j += 4) { o[j] = lut[d[j]]; o[j + 1] = lut[d[j + 1]]; o[j + 2] = lut[d[j + 2]]; o[j + 3] = 255; } }
  ctx.putImageData(img, 0, 0);
  src.rcanvas = c; src.rkey = key;
  return c;
}

export function labels(deckKey, path) {
  return cached(`l|${deckKey}|${path}`, async () => {
    const blob = await store.getFile(deckKey, path);
    if (!blob) throw new Error(`missing file ${path}`);
    return decodeLabelPNG(await blob.arrayBuffer());
  });
}

// Pixel-border outline of a label image (optionally one value only), as a Path2D in image pixels.
export function outlinePath({ width: w, height: h, labels: L }, value) {
  const path = new Path2D();
  const inObj = value ? (v) => v === value : null;
  const differ = inObj ? (a, b) => inObj(a) !== inObj(b) : (a, b) => a !== b;
  for (let y = 0; y <= h; y++) {               // horizontal borders between rows y-1 and y
    let run = -1;
    for (let x = 0; x <= w; x++) {
      const edge = x < w && differ(y > 0 ? L[(y - 1) * w + x] : 0, y < h ? L[y * w + x] : 0);
      if (edge && run < 0) run = x;
      else if (!edge && run >= 0) { path.moveTo(run, y); path.lineTo(x, y); run = -1; }
    }
  }
  for (let x = 0; x <= w; x++) {               // vertical borders between columns x-1 and x
    let run = -1;
    for (let y = 0; y <= h; y++) {
      const edge = y < h && differ(x > 0 ? L[y * w + x - 1] : 0, x < w ? L[y * w + x] : 0);
      if (edge && run < 0) run = y;
      else if (!edge && run >= 0) { path.moveTo(x, run); path.lineTo(x, y); run = -1; }
    }
  }
  return path;
}

function fillCanvas({ width: w, height: h, labels: L }, value, color) {
  const c = canvas2d(w, h), ctx = c.getContext("2d");
  ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  const img = ctx.createImageData(w, h), d = img.data;
  for (let i = 0; i < L.length; i++) {
    const v = L[i];
    if (v && (!value || v === value)) { d[4 * i] = r; d[4 * i + 1] = g; d[4 * i + 2] = b; d[4 * i + 3] = 90; }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

export function maskLayer(deckKey, path, value, color, fill) {
  return cached(`m|${deckKey}|${path}|${value || 0}|${fill ? color : ""}`, async () => {
    const lab = await labels(deckKey, path);
    return { outline: outlinePath(lab, value), fill: fill ? fillCanvas(lab, value, color) : null };
  });
}

// The part of the image a card opens on: the whole image, or the focus box with a margin.
export function viewRect(card) {
  if (!card.focus) return [0, 0, card.w, card.h];
  const [x, y, w, h] = card.focus;
  const m = Math.max(0.5 * Math.max(w, h), 24);
  const x0 = Math.max(0, x - m), y0 = Math.max(0, y - m), x1 = Math.min(card.w, x + w + m), y1 = Math.min(card.h, y + h + m);
  return [x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0)];
}

export class CardCanvas {
  constructor(canvas, { interactive = false } = {}) {
    this.canvas = canvas; this.ctx = canvas.getContext("2d");
    this.s = 1; this.ox = 0; this.oy = 0;
    this.frame = 0; this.hidden = new Set(); this.layers = [];
    this.token = 0;
    if (interactive) this.enableGestures();
  }

  // Loads what the card needs, then draws. Resolves when the first frame is visible.
  async show(rec, card, { frame = 0, hidden = new Set(), rect = null } = {}) {
    const t = ++this.token;
    this.rec = rec; this.card = card; this.frame = frame; this.hidden = hidden;
    const key = rec.key, colors = Object.fromEntries(rec.deck.sources.map((s) => [s.name, s.color]));
    const sources = await Promise.all(card.frames.map((f) => frameSource(key, f.path)));
    const layers = await Promise.all(card.overlays.map(async (o) => {
      const color = colors[o.source] || "#fff";
      if (o.shape !== "mask") return { o, color };
      return { o, color, ...(await maskLayer(key, o.mask, o.value, color, o.style === "fill")) };
    }));
    if (t !== this.token) return false;
    this.sources = sources; this.layers = layers;
    this.resize(rect || viewRect(card));
    return true;
  }

  // Fits the canvas backing store to its CSS size and maps rect (image px) into it.
  resize(rect = null) {
    const c = this.canvas, dpr = window.devicePixelRatio || 1;
    const cw = c.clientWidth, ch = c.clientHeight;
    if (!cw || !ch) return;
    c.width = Math.round(cw * dpr); c.height = Math.round(ch * dpr);
    this.dpr = dpr;
    if (rect) this.fitTo(rect);
    this.draw();
  }
  fitTo([x, y, w, h]) {
    const cw = this.canvas.clientWidth, ch = this.canvas.clientHeight;
    this.s = Math.min(cw / w, ch / h);
    this.ox = (cw - w * this.s) / 2 - x * this.s;
    this.oy = (ch - h * this.s) / 2 - y * this.s;
    this.minS = Math.min(cw / this.card.w, ch / this.card.h) * 0.5;
  }
  setFrame(i) { this.frame = i; this.draw(); }
  setHidden(set) { this.hidden = set; this.draw(); }

  draw() {
    if (!this.sources) return;
    const { ctx, s, ox, oy, dpr } = this, card = this.card;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#000"; ctx.fillRect(0, 0, this.canvas.clientWidth, this.canvas.clientHeight);
    ctx.imageSmoothingEnabled = s < 2; ctx.imageSmoothingQuality = "high";
    const src = this.sources[this.frame] || this.sources[0];
    ctx.drawImage(rendered(src, this.display ? this.display(this.frame) : null), ox, oy, card.w * s, card.h * s);
    const labelsToDraw = [];
    for (const L of this.layers) {
      const o = L.o;
      if (this.hidden.has(o.source) || (o.frame !== undefined && o.frame !== this.frame)) continue;
      ctx.save();
      ctx.translate(ox, oy); ctx.scale(s, s);
      ctx.lineJoin = "round";
      let path, anchor;
      if (o.shape === "mask") {
        if (L.fill) { ctx.imageSmoothingEnabled = false; ctx.drawImage(L.fill, 0, 0); }
        path = L.outline;
      } else if (o.shape === "box") {
        path = new Path2D(); path.rect(...o.box); anchor = [o.box[0], o.box[1]];
        if (o.style === "fill") { ctx.globalAlpha = 0.3; ctx.fillStyle = L.color; ctx.fill(path); ctx.globalAlpha = 1; }
      } else if (o.shape === "polygon") {
        path = new Path2D(); o.polygon.forEach(([x, y], i) => (i ? path.lineTo(x, y) : path.moveTo(x, y))); path.closePath();
        anchor = o.polygon.reduce((a, p) => (p[1] < a[1] ? p : a), o.polygon[0]);
        if (o.style === "fill") { ctx.globalAlpha = 0.3; ctx.fillStyle = L.color; ctx.fill(path); ctx.globalAlpha = 1; }
      }
      if (path) {
        ctx.strokeStyle = "rgba(0,0,0,.55)"; ctx.lineWidth = 3.2 / s; ctx.stroke(path);
        ctx.strokeStyle = L.color; ctx.lineWidth = 1.6 / s; ctx.stroke(path);
      }
      ctx.restore();
      if (o.shape === "point") {
        const x = ox + o.point[0] * s, y = oy + o.point[1] * s;
        ctx.lineWidth = 3.5; ctx.strokeStyle = "rgba(0,0,0,.55)";
        ctx.beginPath(); ctx.arc(x, y, 8, 0, 7); ctx.stroke();
        ctx.lineWidth = 2; ctx.strokeStyle = L.color;
        ctx.beginPath(); ctx.arc(x, y, 8, 0, 7); ctx.stroke();
        ctx.fillStyle = L.color; ctx.beginPath(); ctx.arc(x, y, 2, 0, 7); ctx.fill();
        anchor = [o.point[0] + 10 / s, o.point[1] - 8 / s];
      }
      if (o.label && anchor) labelsToDraw.push([o.label, ox + anchor[0] * s, oy + anchor[1] * s, L.color]);
    }
    ctx.font = "600 11px 'JetBrains Mono', ui-monospace, monospace"; ctx.textBaseline = "bottom";
    for (const [text, x, y, color] of labelsToDraw) {
      const w = ctx.measureText(text).width + 8, ty = Math.max(16, y - 2);
      ctx.fillStyle = "rgba(0,0,0,.7)"; ctx.fillRect(x, ty - 15, w, 15);
      ctx.fillStyle = color; ctx.fillText(text, x + 4, ty - 2);
    }
    if (this.after) this.after(ctx, this);      // the mask editor draws its layer here
  }

  // Zoom by f around a point in canvas CSS pixels.
  zoomAt(f, x, y) {
    const ns = Math.min(Math.max(this.s * f, this.minS || 0.05), 60);
    f = ns / this.s; this.ox = x - (x - this.ox) * f; this.oy = y - (y - this.oy) * f; this.s = ns; this.draw();
  }
  toImage(x, y) { return [(x - this.ox) / this.s, (y - this.oy) / this.s]; }

  // Pinch, drag, wheel and double-tap zoom (zoom viewer only).
  enableGestures() {
    const c = this.canvas, pts = new Map();
    let last = null, lastTap = 0;
    const zoomAt = (f, x, y) => {
      const ns = Math.min(Math.max(this.s * f, this.minS || 0.05), 60);
      f = ns / this.s; this.ox = x - (x - this.ox) * f; this.oy = y - (y - this.oy) * f; this.s = ns; this.draw();
    };
    const local = (e) => { const r = c.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    c.addEventListener("pointerdown", (e) => {
      c.setPointerCapture(e.pointerId); pts.set(e.pointerId, local(e)); last = null;
      if (pts.size === 1) {
        const now = performance.now();
        if (now - lastTap < 300) { const [x, y] = local(e); zoomAt(this.s < 3 * (this.minS * 2) ? 2.5 : 0.4, x, y); lastTap = 0; }
        else lastTap = now;
      }
    });
    c.addEventListener("pointermove", (e) => {
      if (!pts.has(e.pointerId)) return;
      const prev = pts.get(e.pointerId), cur = local(e);
      pts.set(e.pointerId, cur);
      if (pts.size === 1) { this.ox += cur[0] - prev[0]; this.oy += cur[1] - prev[1]; this.draw(); }
      else if (pts.size === 2) {
        const [a, b] = [...pts.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]), m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        if (last) { this.ox += m[0] - last.m[0]; this.oy += m[1] - last.m[1]; zoomAt(d / last.d, m[0], m[1]); }
        last = { d, m };
      }
    });
    const up = (e) => { pts.delete(e.pointerId); last = null; };
    c.addEventListener("pointerup", up); c.addEventListener("pointercancel", up);
    c.addEventListener("wheel", (e) => { e.preventDefault(); const [x, y] = local(e); zoomAt(Math.exp(-e.deltaY * 0.0015), x, y); }, { passive: false });
  }
}
