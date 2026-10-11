// Contrast per deck: black/white points as percentiles of each image, gamma, invert.
// Settings apply to all frames, or to one frame name (a channel such as "DAPI") when the hooman picks that.
// Changes are announced with a "hooman:contrast" event so every open view redraws.

import { prefs } from "./prefs.js";
import { AUTO } from "./view.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const load = (key) => prefs.get(`contrast:${key}`, {});

export function contrastFor(deckKey, frameName) {
  const c = load(deckKey);
  return (frameName && c.byName && c.byName[frameName]) || c.all || null;
}
// The function a CardCanvas calls per frame index.
export const contrastName = (deck, card, f, c = 0) => (deck.channels && deck.channels.length > 1
  ? (deck.channels[c] || {}).name || "" : card.frames.length > 1 ? (card.frames[f] && card.frames[f].name) || "" : "");
export const displayFor = (deckKey, card, deck) => (f, c = 0) => contrastFor(deckKey, contrastName(deck || {}, card, f, c));

function save(deckKey, frameName, params) {
  const c = load(deckKey);
  if (frameName) { c.byName = c.byName || {}; if (params) c.byName[frameName] = params; else delete c.byName[frameName]; }
  else if (params) c.all = params; else delete c.all;
  prefs.set(`contrast:${deckKey}`, c);
  window.dispatchEvent(new Event("hooman:contrast"));
}

let panel = null;
export function closeContrast() { if (panel) { panel.remove(); panel = null; } }

// frameName: the name of the frame on screen when the card has several frames ("" otherwise).
export function openContrast(deckKey, frameName, is16) {
  closeContrast();
  const c = load(deckKey);
  let scope = frameName && c.byName && c.byName[frameName] ? frameName : "";
  const el = document.createElement("div");
  el.className = "cpanel";
  el.setAttribute("role", "dialog"); el.setAttribute("aria-label", "Contrast");
  const current = () => contrastFor(deckKey, scope) || (scope ? contrastFor(deckKey, "") : null);
  const render = () => {
    const p = current() || (is16 ? AUTO : { min: 0, max: 100, gamma: 1, invert: false });
    el.innerHTML = `<div class="cp-head"><b>◐ Contrast</b>
        <button class="chip" data-cp="auto">Auto</button><button class="chip" data-cp="reset">Reset</button><button class="icon-btn" data-cp="close" aria-label="Close">✕</button></div>
      <label class="cp-row">Black<input type="range" min="0" max="50" step="0.1" value="${p.min}" data-k="min"><span class="mono">${(+p.min).toFixed(1)}%</span></label>
      <label class="cp-row">White<input type="range" min="50" max="100" step="0.1" value="${p.max}" data-k="max"><span class="mono">${(+p.max).toFixed(1)}%</span></label>
      <label class="cp-row">Gamma<input type="range" min="-2" max="2" step="0.05" value="${Math.log2(p.gamma || 1)}" data-k="gamma"><span class="mono">${(p.gamma || 1).toFixed(2)}</span></label>
      <div class="cp-foot"><label class="cp-inv"><input type="checkbox" data-k="invert" ${p.invert ? "checked" : ""}> Invert</label>
        ${frameName ? `<span class="seg"><button data-scope="" aria-pressed="${!scope}">All</button><button data-scope="${esc(frameName)}" aria-pressed="${!!scope}">Only ${esc(frameName)}</button></span>` : ""}</div>`;
  };
  const read = () => {
    const v = (k) => el.querySelector(`[data-k=${k}]`);
    return { min: +v("min").value, max: +v("max").value, gamma: +Math.pow(2, +v("gamma").value).toFixed(3), invert: v("invert").checked };
  };
  let raf = 0;
  el.addEventListener("input", (e) => {
    const t = e.target;
    if (!t.dataset.k) return;
    const p = read();
    const out = t.parentElement.querySelector(".mono");
    if (out) out.textContent = t.dataset.k === "gamma" ? p.gamma.toFixed(2) : `${(+t.value).toFixed(1)}%`;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => save(deckKey, scope, p));
  });
  el.addEventListener("change", (e) => { if (e.target.dataset.k === "invert") save(deckKey, scope, read()); });
  el.addEventListener("click", (e) => {
    const t = e.target.closest("[data-cp],[data-scope]");
    if (!t) return;
    if (t.dataset.scope !== undefined) { scope = t.dataset.scope; render(); return; }
    if (t.dataset.cp === "close") return closeContrast();
    if (t.dataset.cp === "auto") save(deckKey, scope, { ...AUTO, invert: read().invert });
    if (t.dataset.cp === "reset") save(deckKey, scope, null);
    render();
  });
  render();
  document.body.appendChild(el);
  panel = el;
}
