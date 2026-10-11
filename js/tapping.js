// Answers made by tapping the image:
//   openTapper: one point ("where does the cell really go?") or several ("tap both daughters").
//   openFollow: manual tracking, the same cell tapped frame after frame (from Cell Follow).
// Every tap records the mask objects under it (source + label value), so it links to the segmentation's IDs.

import { CardCanvas, labels as loadLabels, viewRect, channelColors, channelsOf, framePaths } from "./view.js";
import { attachTapZoom } from "./gestures.js";
import { displayFor, openContrast, closeContrast, contrastName } from "./contrast.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const R1 = (v) => Math.round(v * 10) / 10;

async function hitsAt(rec, card, frame, x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), hits = [];
  if (xi < 0 || yi < 0 || xi >= card.w || yi >= card.h) return hits;
  const guides = new Set(rec.deck.sources.filter((g) => g.guide).map((g) => g.name));
  for (const o of card.overlays) {
    if (o.shape !== "mask" || guides.has(o.source) || (o.frame !== undefined && o.frame !== frame)) continue;
    try {
      const v = (await loadLabels(rec.key, o.mask)).labels[yi * card.w + xi];
      if (v && (!o.value || v === o.value)) hits.push({ source: o.source, value: v });
    } catch {}
  }
  return hits;
}

// Full-screen shell: bar, chips (contrast, sources, frames), canvas with hint, bottom controls.
function shell({ rec, card, frame, hidden, title, note, doneLabel, frameButtons = true, bottom, cview = "one", chan = 0 }) {
  const deck = rec.deck, multi = card.frames.length > 1;
  const el = document.createElement("div");
  el.className = "editor tapper";
  el.innerHTML = `
    <div class="bar">
      <button class="ghost" data-t="cancel">✕ Cancel</button>
      <h3>${esc(title)}<small data-note>${esc(note || "")}</small></h3>
      ${doneLabel ? `<button class="btn" data-t="done" style="min-height:40px;padding:0 14px" disabled>✓ ${esc(doneLabel)}</button>` : `<span style="width:40px"></span>`}
    </div>
    <div class="rowx">
      <button class="chip" data-t="contrast" aria-label="Contrast"><span>◐</span></button>
      ${deck.sources.filter((s) => !s.guide).map((s) => `<button class="chip" data-src="${esc(s.name)}" aria-pressed="${!hidden.has(s.name)}" style="color:${esc(s.color)}"><i></i><span style="color:var(--text)">${esc(s.label)}</span></button>`).join("")}
      ${multi && frameButtons ? `<span class="sep"></span>${card.frames.map((f, i) => `<button class="chip frame" data-frame="${i}" aria-pressed="${i === frame}"><span>${esc(f.name || i + 1)}</span></button>`).join("")}` : ""}
      ${framePaths(card, 0).length > 1 ? `<span class="sep"></span><span class="chipset" data-chans></span>` : ""}
    </div>
    <div class="cwrap"><canvas></canvas><div class="ehint"><span></span></div></div>
    ${bottom}`;
  document.body.appendChild(el);
  const view = new CardCanvas(el.querySelector("canvas"));
  view.display = displayFor(rec.key, card, deck);
  view.cview = cview; view.chan = chan;
  const chanList = channelsOf(deck), chanColors = channelColors(chanList);
  const chans = () => {
    const cb = el.querySelector("[data-chans]");
    if (cb) cb.innerHTML = chanList.map((c, i) => `<button class="chip frame" data-chan="${i}" aria-pressed="${view.cview === "one" && view.chan === i}"><i style="color:${esc(chanColors[i])}"></i><span>${esc(c.name || i + 1)}</span></button>`).join("")
      + `<button class="chip frame" data-chan="mix" aria-pressed="${view.cview === "mix"}"><span>Mix</span></button>`;
  };
  chans();
  const onContrast = () => view.draw(), onResize = () => view.resize();
  window.addEventListener("hooman:contrast", onContrast);
  window.addEventListener("resize", onResize);
  const close = () => { window.removeEventListener("hooman:contrast", onContrast); window.removeEventListener("resize", onResize); closeContrast(); el.remove(); };
  el.addEventListener("click", (e) => {
    const t = e.target.closest("[data-src],[data-frame],[data-chan],[data-t=contrast]");
    if (!t) return;
    if (t.dataset.src !== undefined) {
      const n = t.dataset.src;
      if (hidden.has(n)) hidden.delete(n); else hidden.add(n);
      t.setAttribute("aria-pressed", String(!hidden.has(n))); view.setHidden(hidden);
    } else if (t.dataset.chan !== undefined) {
      const v = t.dataset.chan;
      view.setChannels(v === "mix" ? "mix" : "one", v === "mix" ? view.chan : +v); chans();
    } else if (t.dataset.frame !== undefined) {
      view.setFrame(+t.dataset.frame);
      el.querySelectorAll("[data-frame]").forEach((b) => b.setAttribute("aria-pressed", String(+b.dataset.frame === view.frame)));
    } else {
      const c = view.activeChannel(), src = view.source(view.frame, c);
      openContrast(rec.key, contrastName(deck, card, view.frame, c), !!src && src.bits === 16);
    }
  });
  const hint = (text, warn) => { const h = el.querySelector(".ehint span"); h.textContent = text; h.classList.toggle("warn", !!warn); };
  return { el, view, close, hint };
}

function ring(ctx, v, x, y, color, r = 9, label = "", dashed = false) {
  const sx = v.ox + x * v.s, sy = v.oy + y * v.s;
  ctx.setLineDash(dashed ? [4, 3] : []);
  ctx.lineWidth = 4; ctx.strokeStyle = "rgba(0,0,0,.6)"; ctx.beginPath(); ctx.arc(sx, sy, r, 0, 7); ctx.stroke();
  ctx.lineWidth = 2.2; ctx.strokeStyle = color; ctx.beginPath(); ctx.arc(sx, sy, r, 0, 7); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = color; ctx.beginPath(); ctx.arc(sx, sy, 2.2, 0, 7); ctx.fill();
  if (label) {
    ctx.font = "700 11px 'JetBrains Mono', monospace"; ctx.textBaseline = "middle";
    const w = ctx.measureText(label).width + 8;
    ctx.fillStyle = "rgba(0,0,0,.75)"; ctx.fillRect(sx + r + 2, sy - 9, w, 18);
    ctx.fillStyle = color; ctx.fillText(label, sx + r + 6, sy);
  }
}

/** One point (multi = false) or several. Resolves {points: [{x, y, frame, hits}]} or null. */
export function openTapper({ rec, card, frame = 0, hidden = new Set(), multi = false, title = "Tap the image", note = "", color = "#c6ff3d", cview = "one", chan = 0 }) {
  return new Promise(async (resolve) => {
    const S = shell({ rec, card, frame, hidden, title, note, doneLabel: "Save", cview: cview === "side" ? "mix" : cview, chan,
      bottom: `<div class="rowx sizes"><button class="tool small" data-t="undo" aria-label="Undo">↶</button><span class="muted" data-count style="font-size:13px"></span></div>` });
    const { el, view } = S;
    const pts = [];
    el._debug = () => ({ frame: view.frame, view: { s: view.s, ox: view.ox, oy: view.oy }, points: pts });
    const update = () => {
      el.querySelector("[data-t=done]").disabled = !pts.length;
      el.querySelector("[data-t=undo]").disabled = !pts.length;
      el.querySelector("[data-count]").textContent = multi ? `${pts.length} point${pts.length === 1 ? "" : "s"}` : pts.length ? "tap again to move it" : "";
      S.hint(multi ? "Tap each point. Tap a point again to remove it." : "Tap the spot. Two fingers zoom.");
      view.draw();
    };
    view.after = (ctx, v) => pts.forEach((p, i) => (p.frame === v.frame || !card.frames[1]) && ring(ctx, v, p.x, p.y, color, 9, multi ? String(i + 1) : ""));
    attachTapZoom(el.querySelector("canvas"), view, {
      onTap: async ([x, y]) => {
        if (x < 0 || y < 0 || x > card.w || y > card.h) return;
        if (multi) {
          const near = pts.findIndex((p) => p.frame === view.frame && Math.hypot(p.x - x, p.y - y) * view.s < 14);
          if (near >= 0) { pts.splice(near, 1); return update(); }
        } else pts.length = 0;
        const hits = await hitsAt(rec, card, view.frame, x, y);
        pts.push({ x: R1(x), y: R1(y), frame: view.frame, ...(hits.length ? { hits } : {}) });
        update();
      },
    });
    el.addEventListener("click", (e) => {
      const t = e.target.closest("[data-t]");
      if (!t) return;
      if (t.dataset.t === "cancel") { S.close(); resolve(null); }
      if (t.dataset.t === "done" && pts.length) { S.close(); resolve({ points: pts.slice() }); }
      if (t.dataset.t === "undo") { pts.pop(); update(); }
    });
    await view.show(rec, card, { frame, hidden, cview: view.cview, chan: view.chan });
    update();
  });
}

/**
 * Manual tracking. card.start = [x, y, frame?] is the cell to follow (else the first tap sets it).
 * Resolves {points: [{frame, x, y, hits?} | {frame, missing: true} | {frame, x, y, daughter: 1|2}], end} or null.
 */
export function openFollow({ rec, card, hidden = new Set(), title = "Follow the cell", note = "", cview = "one", chan = 0 }) {
  return new Promise(async (resolve) => {
    const n = card.frames.length;
    const S = shell({ rec, card, frame: 0, hidden, title, note, frameButtons: false, cview: cview === "side" ? "mix" : cview, chan,
      bottom: `<div class="tools t4 follow">
          <button class="tool" data-t="missing"><b>∅</b>Not here</button>
          <button class="tool" data-t="divides"><b>⑂</b>Divides</button>
          <button class="tool" data-t="ends"><b>✕</b>Cell ends</button>
          <button class="tool" data-t="leaves"><b>↗</b>Leaves view</button>
        </div>
        <div class="rowx sizes"><button class="tool small" data-t="back" aria-label="Back one frame">↶</button><span class="muted" data-count style="font-size:13px"></span>
          <span style="flex:1"></span><button class="chip" data-t="skip"><span>Skip card</span></button></div>` });
    const { el, view } = S;
    const pts = [];
    let f = 0, divide = 0, peek = false;
    el._debug = () => ({ frame: view.frame, f, divide, view: { s: view.s, ox: view.ox, oy: view.oy }, points: pts });
    if (card.start) { const sf = card.start[2] || 0; pts.push({ frame: sf, x: card.start[0], y: card.start[1], start: true }); f = sf + 1; }
    const last = () => [...pts].reverse().find((p) => !p.missing && !p.daughter);
    const finish = (end) => { S.close(); resolve({ points: pts.slice(), end }); };
    const keepInView = (p) => {
      if (!p) return;
      const sx = view.ox + p.x * view.s, sy = view.oy + p.y * view.s, W = view.canvas.clientWidth, H = view.canvas.clientHeight;
      if (sx < W * 0.2 || sx > W * 0.8 || sy < H * 0.2 || sy > H * 0.8) { view.ox += W / 2 - sx; view.oy += H / 2 - sy; }
    };
    const show = () => {
      if (f >= n) return finish("last_frame");
      view.setFrame(peek && f > 0 ? f - 1 : f);
      el.querySelector("[data-note]").textContent = `frame ${f + 1} of ${n}${card.frames[f].name ? ` · ${card.frames[f].name}` : ""}${peek ? " · previous frame" : ""}`;
      S.hint(divide ? `Tap daughter ${divide} of 2` : !last() ? "Tap the cell to follow" : "Tap the same cell. Hold the image to see the previous frame.");
      el.querySelector("[data-count]").textContent = `${pts.filter((p) => !p.missing).length} taps`;
      el.querySelector("[data-t=back]").disabled = !pts.some((p) => !p.start);
      keepInView(last());
      view.draw();
    };
    view.after = (ctx, v) => {
      const trail = pts.filter((p) => !p.missing && !p.daughter);
      if (trail.length > 1) {
        ctx.beginPath(); trail.forEach((p, i) => { const sx = v.ox + p.x * v.s, sy = v.oy + p.y * v.s; i ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy); });
        ctx.strokeStyle = "rgba(198,255,61,.5)"; ctx.lineWidth = 2; ctx.stroke();
      }
      const l = last();
      if (l) ring(ctx, v, l.x, l.y, l.frame === v.frame ? "#c6ff3d" : "#ffffff", 11, l.frame === v.frame ? "" : card.frames[l.frame].name || `frame ${l.frame + 1}`, l.frame !== v.frame);
      pts.filter((p) => p.daughter && p.frame === v.frame).forEach((p) => ring(ctx, v, p.x, p.y, "#b48cff", 9, `d${p.daughter}`));
    };
    attachTapZoom(el.querySelector("canvas"), view, {
      onTap: async ([x, y]) => {
        if (peek || x < 0 || y < 0 || x > card.w || y > card.h) return;
        const hits = await hitsAt(rec, card, f, x, y);
        const p = { frame: f, x: R1(x), y: R1(y), ...(hits.length ? { hits } : {}) };
        if (divide) {
          pts.push({ ...p, daughter: divide });
          if (divide === 2) return finish("divides");
          divide = 2; return show();
        }
        if (!last() && !card.start) { pts.push({ ...p, start: true }); f++; return show(); }
        pts.push(p); f++;
        view.draw();
        setTimeout(show, 120);
      },
      onHold: (on) => { if (f > 0 && !divide) { peek = on; show(); } },
    });
    el.addEventListener("click", (e) => {
      const t = e.target.closest("[data-t]");
      if (!t) return;
      const a = t.dataset.t;
      if (a === "cancel") { S.close(); resolve(null); }
      else if (a === "skip") { S.close(); resolve({ skip: true }); }
      else if (a === "missing") { if (!last() && !card.start) return S.hint("Tap the cell to follow first", true); pts.push({ frame: f, missing: true }); f++; show(); }
      else if (a === "divides") { if (!last()) return S.hint("Tap the cell to follow first", true); divide = 1; show(); }
      else if (a === "ends" || a === "leaves") { if (!last() && !card.start) return S.hint("Tap the cell to follow first", true); finish(a); }
      else if (a === "back") {
        if (divide) { const d = pts.findIndex((p) => p.daughter); if (d >= 0) pts.splice(d); divide = 0; return show(); }
        const p = pts[pts.length - 1];
        if (!p || p.start && card.start) return;
        pts.pop(); f = p.frame; show();
      }
    });
    const r = card.start ? [card.start[0] - 48, card.start[1] - 48, 96, 96] : card.focus ? null : null;
    await view.show(rec, card, { frame: Math.min(f, n - 1), hidden, rect: r ? fitInside(r, card) : viewRect(card), cview: view.cview, chan: view.chan });
    show();
  });
}

function fitInside([x, y, w, h], card) {
  const x0 = Math.max(0, x), y0 = Math.max(0, y);
  return [x0, y0, Math.min(card.w - x0, w), Math.min(card.h - y0, h)];
}
