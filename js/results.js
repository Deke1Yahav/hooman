// Results: how the answers came out (counts, % with 95% Wilson intervals), time per card,
// and agreement with another annotator's export (Cohen's kappa, confusion table, the cards you disagree on).

import * as store from "./store.js";
import { answerDefs } from "./deck.js";
import { readAnswers } from "./backup.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const SLOT_ORDER = { left: 0, right: 1, up: 2, down: 3, button: 4 };
const pct = (x) => `${Math.round(x * 100)}%`;

export function wilson(k, n, z = 1.96) {
  if (!n) return [0, 0];
  const p = k / n, d = 1 + (z * z) / n, c = (p + (z * z) / (2 * n)) / d, h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}
export function kappa(pairs) {                 // pairs: [[a, b], ...]
  const n = pairs.length;
  if (!n) return { n: 0 };
  const cats = [...new Set(pairs.flat())], rows = new Map(), cols = new Map();
  let agree = 0;
  for (const [a, b] of pairs) { if (a === b) agree++; rows.set(a, (rows.get(a) || 0) + 1); cols.set(b, (cols.get(b) || 0) + 1); }
  const po = agree / n, pe = cats.reduce((s, c) => s + ((rows.get(c) || 0) * (cols.get(c) || 0)) / (n * n), 0);
  return { n, po, k: pe < 1 ? (po - pe) / (1 - pe) : 1, cats };
}
const kappaWords = (k) => (k < 0 ? "worse than chance" : k <= 0.2 ? "slight" : k <= 0.4 ? "fair" : k <= 0.6 ? "moderate" : k <= 0.8 ? "substantial" : "almost perfect");
function duration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

export async function renderResults(app, rec, { go, toast, copyText, openCard }) {
  const deck = rec.deck;
  const [answers, notes] = await Promise.all([store.answersOf(rec.key), store.notesOf(rec.key)]);
  const defs = answerDefs(rec).concat(deck.answers);
  const info = new Map();
  for (const d of defs) if (!info.has(d.value)) info.set(d.value, d);
  const counts = new Map();
  for (const a of answers) counts.set(a.answer, (counts.get(a.answer) || 0) + 1);
  const n = answers.length, total = deck.cards.length;
  const order = [...counts.keys()].sort((a, b) => {
    const da = info.get(a), db = info.get(b);
    return (da ? SLOT_ORDER[da.slot] : 9) - (db ? SLOT_ORDER[db.slot] : 9) || counts.get(b) - counts.get(a);
  });
  const rows = order.map((v) => {
    const k = counts.get(v), [lo, hi] = wilson(k, n), d = info.get(v) || {};
    return { v, k, p: n ? k / n : 0, lo, hi, label: d.label || v, color: d.color || "var(--muted)" };
  });
  const ms = answers.map((a) => a.ms).filter((x) => x > 0).sort((a, b) => a - b);
  const median = ms.length ? ms[Math.floor(ms.length / 2)] : 0, sumMs = ms.reduce((s, x) => s + x, 0);
  const changed = answers.filter((a) => a.changes > 0).length;
  const drawn = answers.filter((a) => a.mask || (a.masks && a.masks.length)).length;
  const tapped = answers.filter((a) => a.points && a.points.length).length;
  const people = [...new Set(answers.map((a) => a.by).filter(Boolean))];
  const srcNames = new Set(deck.sources.filter((s) => !s.guide).map((s) => s.name));
  const duel = rows.filter((r) => srcNames.has(r.v));

  const summary = [
    `${deck.title}: ${n} of ${total} cards answered${people.length ? ` by ${people.join(", ")}` : ""}.`,
    ...rows.map((r) => `${r.label}: ${r.k} (${pct(r.p)}, 95% CI ${pct(r.lo)}-${pct(r.hi)})`),
    median ? `Median ${(median / 1000).toFixed(1)} s per card, ${duration(sumMs)} in total.` : "",
  ].filter(Boolean).join("\n");

  app.innerHTML = `<main class="screen results">
    <div class="top"><button class="ghost" data-r="back">‹ Deck</button><h2>Results</h2><button class="ghost" data-r="copy">Copy summary</button></div>
    <p class="muted r-sub">${esc(deck.title)}</p>
    <div class="r-hero"><b class="mono">${n}</b><span>of ${total} cards answered${people.length ? ` · by ${esc(people.join(", "))}` : ""}</span></div>
    <div class="pbar"><i style="width:${total ? (100 * n) / total : 0}%"></i></div>
    ${duel.length >= 2 ? `<p class="r-duel">${duel.map((r) => `<b>${esc(r.label)}</b> ${pct(r.p)}`).join(" · ")}</p>` : ""}
    <div class="section-title">Answers</div>
    ${rows.length ? `<div class="r-bars" role="table" aria-label="Answers">
      ${rows.map((r) => `<div class="r-row" role="row" title="${esc(r.label)}: ${r.k} of ${n} (${pct(r.p)}, 95% CI ${pct(r.lo)}-${pct(r.hi)})">
        <span class="r-label" role="cell"><i style="background:${esc(r.color)}"></i>${esc(r.label)}</span>
        <span class="r-num mono" role="cell">${r.k} · ${pct(r.p)}</span>
        <span class="r-track" role="cell" aria-label="95% interval ${pct(r.lo)} to ${pct(r.hi)}">
          <span class="r-fill" style="width:${(r.p * 100).toFixed(1)}%;background:${esc(r.color)}"></span>
          <span class="r-ci" style="left:${(r.lo * 100).toFixed(1)}%;width:${((r.hi - r.lo) * 100).toFixed(1)}%"></span>
        </span>
        <span class="r-ci-text mono" role="cell">95% CI ${pct(r.lo)}–${pct(r.hi)}</span>
      </div>`).join("")}</div>` : `<p class="muted">No answers yet.</p>`}
    <div class="section-title">Effort</div>
    <div class="r-stats">
      <div><b class="mono">${median ? (median / 1000).toFixed(1) + " s" : "–"}</b><span>median per card</span></div>
      <div><b class="mono">${sumMs ? duration(sumMs) : "–"}</b><span>in total</span></div>
      <div><b class="mono">${changed}</b><span>answers changed</span></div>
      <div><b class="mono">${drawn}</b><span>masks drawn</span></div>
      ${tapped ? `<div><b class="mono">${tapped}</b><span>cards with taps</span></div>` : ""}
      <div><b class="mono">${notes.length}</b><span>notes</span></div>
    </div>
    <div class="section-title">Agreement</div>
    <div id="agree"><p class="muted" style="font-size:14px;line-height:1.5">Compare with someone else who answered the same deck. Ask them to export (⋮ → Export answers), then pick their file here.</p>
      <button class="btn quiet" data-r="compare">Compare with another export…</button></div>
    <input type="file" id="cmp-file" accept=".zip,application/zip,application/x-zip-compressed,application/octet-stream" hidden>
  </main>`;

  const fileIn = app.querySelector("#cmp-file");
  fileIn.addEventListener("change", async () => {
    const f = fileIn.files[0]; fileIn.value = "";
    if (!f) return;
    try {
      const other = await readAnswers(f);
      const theirs = other.answers || (other.decks && other.decks.get(rec.key));
      if (!theirs || (other.deck && other.deck !== rec.key)) return toast(`That file is for another deck${other.deck ? ` (${other.deck})` : ""}`, 3500);
      compare(theirs, other.who);
    } catch (e) { toast(e.errors ? e.errors[0] : `Could not read it: ${e.message}`, 3500); }
  });

  function compare(theirs, who) {
    const mine = new Map(answers.map((a) => [a.card, a]));
    const pairs = [], diffs = [];
    for (const [card, t] of theirs) {
      const m = mine.get(card);
      if (!m) continue;
      pairs.push([m.answer, t.answer]);
      if (m.answer !== t.answer) diffs.push({ card, me: m.answer, them: t.answer });
    }
    const K = kappa(pairs), name = (v) => (info.get(v) || {}).label || v;
    const el = app.querySelector("#agree");
    if (!K.n) { el.innerHTML = `<p class="muted">No cards answered by both of you yet.</p>`; return; }
    const cats = K.cats.sort((a, b) => ((info.get(a) || {}).slot ? SLOT_ORDER[info.get(a).slot] : 9) - ((info.get(b) || {}).slot ? SLOT_ORDER[info.get(b).slot] : 9));
    const cell = (a, b) => pairs.filter(([x, y]) => x === a && y === b).length;
    el.innerHTML = `<p class="r-duel"><b>${pct(K.po)}</b> agreement on ${K.n} cards · Cohen's κ <b>${K.k.toFixed(2)}</b> (${kappaWords(K.k)})</p>
      <div class="r-table-wrap"><table class="r-table">
        <thead><tr><th scope="col">you ↓ · ${esc(who)} →</th>${cats.map((c) => `<th scope="col">${esc(name(c))}</th>`).join("")}</tr></thead>
        <tbody>${cats.map((a) => `<tr><th scope="row">${esc(name(a))}</th>${cats.map((b) => { const v = cell(a, b); return `<td class="${a === b ? "diag" : v ? "off" : ""}">${v}</td>`; }).join("")}</tr>`).join("")}</tbody>
      </table></div>
      ${diffs.length ? `<div class="section-title">${diffs.length} card${diffs.length > 1 ? "s" : ""} you disagree on</div>
        <div class="r-diffs">${diffs.slice(0, 80).map((d) => `<button class="chip" data-card="${esc(d.card)}"><span>${esc(d.card)}: you ${esc(name(d.me))} · ${esc(who)} ${esc(name(d.them))}</span></button>`).join("")}</div>` : ""}`;
  }

  app.onclick = async (e) => {
    const t = e.target.closest("[data-r],[data-card]");
    if (!t) return;
    if (t.dataset.card !== undefined) return openCard(t.dataset.card);
    if (t.dataset.r === "back") return go(`#/deck/${encodeURIComponent(rec.key)}`);
    if (t.dataset.r === "copy") { if (await copyText(summary)) toast("Summary copied"); }
    if (t.dataset.r === "compare") fileIn.click();
  };
}
