// Hooman in the Loop: screens, gestures and flows. No framework: one module, plain DOM.

import * as store from "./store.js";
import { importBlob, importURL, saveDeck } from "./importer.js";
import { CardCanvas, viewRect, frameSource, maskLayer, rendered } from "./view.js";
import { answerDefs, DIRS, slug } from "./deck.js";
import { buildExport, shareOrDownload, APP_VERSION } from "./export.js";
import { openEditor, editorOpen } from "./editor.js";
import { prefs } from "./prefs.js";
import { displayFor, openContrast, closeContrast } from "./contrast.js";
import { annotator, setAnnotator, colorMode, setColorMode, themed, untone, lastBackup, markBackup } from "./settings.js";
import { openTapper, openFollow } from "./tapping.js";
import { zipKind, buildBackup, restoreBackup, restoreAnswers } from "./backup.js";
import { renderResults } from "./results.js";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const app = $("#app");
const ARROW = { right: "→", left: "←", up: "↑", down: "↓", button: "" };
const SLOT_NAME = { right: "swipe right", left: "swipe left", up: "swipe up", down: "swipe down", button: "button" };


// ---------------------------------------------------------------- toast, sheets, clipboard
let toastTimer;
function toast(msg, ms = 2200) {
  const t = $("#toast");
  t.textContent = msg; t.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), ms);
}

let sheetOpen = null;
function openSheet(html, { dismissable = true, onClose } = {}) {
  closeSheet();
  const bd = document.createElement("div");
  bd.className = "backdrop";
  bd.innerHTML = `<div class="sheet" role="dialog" aria-modal="true">${html}</div>`;
  const sheet = { el: bd.firstElementChild, dismissable, close: () => { if (sheetOpen === sheet) sheetOpen = null; bd.remove(); onClose && onClose(); } };
  bd.addEventListener("click", (e) => { if (e.target === bd && sheet.dismissable) sheet.close(); });
  document.body.appendChild(bd);
  sheetOpen = sheet;
  const f = sheet.el.querySelector("[autofocus]");
  if (f) setTimeout(() => f.focus(), 50);
  return sheet;
}
function closeSheet() { if (sheetOpen) sheetOpen.close(); }

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    const ta = document.createElement("textarea");
    ta.value = text; document.body.appendChild(ta); ta.select();
    let ok = false; try { ok = document.execCommand("copy"); } catch {}
    ta.remove(); return ok;
  }
}

// The dopamine answer: a burst from the card, plus a short buzz on phones that have one.
function blast(color) {
  const box = document.createElement("div"), cols = [color, "#3ddc97", "#f2c14e", "#4fc3f7", "#ff8fab", "#c6ff3d", "#b48cff", "#ffffff"];
  const card = S && S.cardEl ? S.cardEl.getBoundingClientRect() : null;
  box.className = "yay blast";
  if (card) { box.style.left = `${card.left + card.width / 2}px`; box.style.top = `${card.top + card.height / 2}px`; }
  let h = "";
  for (let i = 0; i < 90; i++) {
    const t = Math.random() * Math.PI * 2, r = 80 + Math.random() * 220;
    h += `<i style="--x:${Math.round(Math.cos(t) * r)}px;--y:${Math.round(Math.sin(t) * r * 0.8 + 120)}px;--r:${Math.round(Math.random() * 900 - 450)}deg;--d:${(0.7 + Math.random() * 0.6).toFixed(2)}s;background:${cols[i % cols.length]};width:${6 + (i % 4) * 2}px;height:${8 + (i % 3) * 3}px"></i>`;
  }
  box.innerHTML = h + `<b style="color:${color}">🎉</b>`;
  document.body.appendChild(box);
  try { navigator.vibrate && navigator.vibrate([18, 40, 28]); } catch {}
  setTimeout(() => box.remove(), 1500);
}

function confetti() {
  const box = document.createElement("div"), cols = ["#3ddc97", "#f2c14e", "#4fc3f7", "#ff8fab", "#c6ff3d", "#b48cff"];
  box.className = "yay";
  let h = "";
  for (let i = 0; i < 36; i++) {
    const t = (i / 36) * Math.PI * 2, r = 90 + Math.random() * 90;
    h += `<i style="--x:${Math.round(Math.cos(t) * r)}px;--y:${Math.round(Math.sin(t) * r + 40)}px;--r:${Math.round(Math.random() * 540 - 270)}deg;background:${cols[i % cols.length]}"></i>`;
  }
  box.innerHTML = h; document.body.appendChild(box);
  setTimeout(() => box.remove(), 1100);
}

// ---------------------------------------------------------------- routing
let cleanup = [];
function leaveScreen() { cleanup.forEach((f) => f()); cleanup = []; S = null; stopPlay(); closeZoom(); closeContrast(); }

function parseHash() {
  const h = location.hash.replace(/^#/, "") || "/";
  const [path, query = ""] = h.split("?");
  const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  return { page: parts[0] || "home", id: parts[1], params: new URLSearchParams(query) };
}
async function route() {
  closeSheet();
  const { page, id, params } = parseHash();
  leaveScreen();
  if (page === "deck" && id) await openDeck(id, params);
  else if (page === "review" && id) await openReview(id);
  else if (page === "results" && id) await openResults(id);
  else await home();
}
window.addEventListener("hashchange", route);
const go = (hash) => { if (location.hash === hash) route(); else location.hash = hash; };

// Deck records may be colour-themed copies (settings.js); this writes the stored record back.
function saveRec(rec) {
  if (!rec || !rec._raw) return store.putDeck(rec);
  const raw = rec._raw;
  for (const k of ["openedAt", "lastCard", "exportedAt", "order"]) if (rec[k] !== undefined) raw[k] = rec[k];
  raw.custom = rec.custom && rec.custom.answers ? { ...rec.custom, answers: rec.custom.answers.map((a) => ({ ...a, color: untone(a.color) })) } : rec.custom;
  return store.putDeck(raw);
}
const modeOf = (deck) => deck.mode || (deck.question ? "swipe" : "annotate");
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const standalone = () => navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;

// ---------------------------------------------------------------- home
async function home() {
  const decks = (await store.listDecks()).sort((a, b) => (b.openedAt || b.updatedAt).localeCompare(a.openedAt || a.updatedAt));
  const all = await Promise.all(decks.map((d) => store.answersOf(d.key)));
  const counts = all.map((a) => a.length);
  const since = lastBackup();
  const unsaved = all.flatMap((list, i) => list.filter((a) => a.at > since && a.at > (decks[i].exportedAt || "")));
  const oldest = unsaved.reduce((m, a) => (a.at < m ? a.at : m), "9999");
  const stale = unsaved.length && (unsaved.length >= 20 || Date.now() - Date.parse(oldest) > 2 * 864e5);
  const rows = decks.map((d, i) => {
    const n = d.deck.cards.length, done = counts[i], pct = n ? (100 * done) / n : 0;
    const mode = modeOf(d.deck), kind = mode === "swipe" ? "" : ` · ${mode}`;
    return `<button class="deckrow" data-open="${esc(d.key)}">
      <b>${esc(d.title)}</b><span class="count">${done} / ${n}</span>
      <div class="pbar"><i style="width:${pct}%"></i></div>
      <span class="sub">${esc(d.key)}${kind} · ${esc((d.updatedAt || "").slice(0, 10))}</span></button>`;
  }).join("");
  app.innerHTML = `<main class="screen">
    <div class="hero"><img src="icons/icon-192.png" alt=""><div><h1>Hooman in the Loop</h1><p>The AI guesses. The hooman decides.</p></div>
      <button class="icon-btn" data-act="settings" aria-label="Settings and backup" style="margin-left:auto">⚙</button></div>
    ${isIOS() && !standalone() ? `<div class="banner"><span>On iPhone, add Hooman to your Home Screen (Share → Add to Home Screen). Otherwise Safari may delete your answers after 7 days without use.</span></div>` : ""}
    ${stale ? `<div class="banner"><span>⚠ ${unsaved.length} answer${unsaved.length > 1 ? "s are" : " is"} only on this device.</span><button class="btn quiet" data-act="backup">Back up</button></div>` : ""}
    <div class="actions">
      <button class="btn" data-act="import">＋ Import deck</button>
      <button class="btn quiet" data-act="link">From a link</button>
      <button class="btn quiet" data-act="ai">✨ Make a deck with AI</button>
      <button class="btn quiet" data-act="examples">Try an example</button>
    </div>
    <div class="section-title">Your decks</div>
    ${decks.length ? `<div class="decks">${rows}</div>` : `<div class="empty"><b>No decks yet.</b> A deck is a zip of images plus a small <span class="mono">deck.json</span> that says what to ask. Ask any AI chat to make one for your images (✨ above), or try an example.</div>`}
    <p class="foot-note">Everything stays on this device. No account, no server.<br><a href="llms.txt" target="_blank">Deck format (for your AI)</a> · <a href="https://github.com/Deke1Yahav/hooman" target="_blank" rel="noopener">Free and open source (MIT)</a> · v${APP_VERSION}</p>
  </main>
  <input type="file" id="file" accept=".zip,.json,application/zip,application/x-zip-compressed,application/json,application/octet-stream" hidden>`;
  const file = $("#file");
  file.addEventListener("change", () => { const f = file.files[0]; file.value = ""; if (f) importFile(f); });
  app.onclick = (e) => {
    const b = e.target.closest("[data-act],[data-open]");
    if (!b) return;
    if (b.dataset.open) return go(`#/deck/${encodeURIComponent(b.dataset.open)}`);
    ({ import: () => file.click(), link: linkSheet, ai: aiSheet, examples: examplesSheet, settings: settingsSheet, backup: () => backupNow(false) })[b.dataset.act]();
  };
}

// ---------------------------------------------------------------- import flows
// A zip can be a deck, a backup, or a deck's exported answers (restored into that deck).
async function importFile(f) {
  const kind = await zipKind(f).catch(() => null);
  if (kind === "backup") return runRestore(() => restoreBackup(f));
  if (kind === "answers") return runRestore(() => restoreAnswers(f));
  runImport((p) => importBlob(f, p));
}

async function runRestore(fn) {
  const sh = openSheet(`<h3>Restoring…</h3><p>Merging the answers into this device. Newer answers win.</p>`, { dismissable: false });
  let r;
  try { r = await fn(); } catch (e) { sh.close(); return showErrors(e.errors || [e.message], []); }
  sh.el.innerHTML = `<h3>Restored</h3>
    ${r.decks.map((d) => `<p><b style="color:var(--text)">${esc(d.title)}</b>${d.created ? " (added to this device)" : ""}: ${d.added} new answer${d.added === 1 ? "" : "s"}, ${d.newer} newer than this device's, ${d.history} history lines, ${d.notes} notes.</p>`).join("") || "<p>Nothing to restore.</p>"}
    ${r.missing.length ? `<p style="color:var(--yellow)">Not restored: ${r.missing.map(esc).join(", ")}. That deck isn't on this device and the file has no images. Import the deck first, then restore again.</p>` : ""}
    <div class="stack"><button class="btn" data-close>OK</button></div>`;
  sh.dismissable = true;
  sh.el.onclick = (e) => { if (e.target.closest("[data-close]")) { sh.close(); route(); } };
}

async function backupNow(images) {
  const sh = openSheet(`<h3>Making the backup…</h3><p>${images ? "Answers, notes, masks and every deck's images." : "Answers, notes, drawn masks and history."}</p>`, { dismissable: false });
  try {
    const b = await buildBackup({ images });
    sh.close();
    const r = await shareOrDownload(b.zip, `hooman-backup-${new Date().toISOString().slice(0, 10)}${images ? "-full" : ""}.zip`);
    if (r !== "cancelled") { markBackup(); toast(`Backed up ${b.answers} answers from ${b.decks} deck${b.decks === 1 ? "" : "s"}`); if (parseHash().page === "home") home(); }
  } catch (e) { sh.close(); showErrors([`Backup failed: ${e.message}`], []); }
}

async function settingsSheet() {
  let est = "", kept = false;
  try { const e = await navigator.storage.estimate(); est = ` · ${Math.round(e.usage / 1e6)} MB used`; } catch {}
  try { kept = await navigator.storage.persisted(); } catch {}
  const lb = lastBackup();
  const sh = openSheet(`<h3>Settings & backup</h3>
    <label class="field">Your name <span class="muted">(goes into exports, to compare annotators)</span><input type="text" id="set-name" value="${esc(annotator())}" placeholder="e.g. Dekel" maxlength="60" autocomplete="name"></label>
    <div class="field">Colours <span class="seg"><button data-col="standard" aria-pressed="${colorMode() !== "cb"}">Standard</button><button data-col="cb" aria-pressed="${colorMode() === "cb"}">Colour-blind safe</button></span></div>
    <div class="section-title">Backup</div>
    <p>Answers live only on this device. A backup holds every deck's answers, notes, drawn masks and history. Import it on any device to continue there; newer answers win.</p>
    <p class="mono" style="font-size:12px">last backup: ${lb ? esc(lb.slice(0, 16).replace("T", " ")) : "never"}${est}${kept ? " · storage kept" : " · the browser may clear storage"}</p>
    <div class="stack"><button class="btn" data-b="answers">Back up answers (small)</button>
      <button class="btn quiet" data-b="all">Back up everything, with images</button>
      <button class="btn quiet" data-b="restore">Restore a backup…</button></div>
    <p class="muted" style="font-size:12px">Restore also takes a deck's exported <span class="mono">.answers.zip</span>, to continue someone's work or merge two devices.</p>
    <div class="stack"><button class="btn quiet" data-b="tour">Show the tour again</button></div>
    <input type="file" id="restore-file" accept=".zip,application/zip,application/x-zip-compressed,application/octet-stream" hidden>`);
  const nameIn = $("#set-name", sh.el);
  nameIn.addEventListener("change", () => { setAnnotator(nameIn.value); toast(nameIn.value.trim() ? `Hi ${nameIn.value.trim()}` : "Name cleared"); });
  const rf = $("#restore-file", sh.el);
  rf.addEventListener("change", () => { const f = rf.files[0]; rf.value = ""; if (f) importFile(f); });
  sh.el.onclick = (e) => {
    const t = e.target.closest("[data-col],[data-b]");
    if (!t) return;
    if (t.dataset.col) { setColorMode(t.dataset.col); $$("[data-col]", sh.el).forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.col === colorMode()))); toast(colorMode() === "cb" ? "Colour-blind safe colours on" : "Standard colours"); return; }
    if (t.dataset.b === "answers" || t.dataset.b === "all") { setAnnotator(nameIn.value); return backupNow(t.dataset.b === "all"); }
    if (t.dataset.b === "restore") return rf.click();
    if (t.dataset.b === "tour") { prefs.set("toured", false); toast("The tour shows when you next open a deck"); }
  };
}
async function runImport(getter) {
  const sh = openSheet(`<h3>Importing…</h3><p class="mono" id="imp-msg">Reading the deck</p><div class="progress"><i id="imp-bar"></i></div>`, { dismissable: false });
  let imported;
  try {
    imported = await getter((n, total) => {
      const m = $("#imp-msg", sh.el), b = $("#imp-bar", sh.el);
      if (m) m.textContent = `Checking images ${n} / ${total}`;
      if (b) b.style.width = `${total ? (100 * n) / total : 0}%`;
    });
  } catch (e) {
    if (!e.errors) console.error(e);           // deck problems are shown to the hooman, not logged
    return showErrors(e.errors || [e.message || String(e)], e.warnings || []);
  }
  const existing = await store.getDeck(imported.deck.id);
  if (!existing) return finishImport(imported, "new");
  const n = (await store.answersOf(existing.key)).length;
  sh.el.innerHTML = `<h3>This deck is already here</h3>
    <p>“${esc(existing.title)}” (id <span class="mono">${esc(existing.key)}</span>) has <b>${n}</b> answer${n === 1 ? "" : "s"} on this device.</p>
    <p>Updating keeps every answer whose card id is still in the new deck. A copy starts empty.</p>
    <div class="stack"><button class="btn" data-m="update">Update it, keep the answers</button>
    <button class="btn quiet" data-m="copy">Import as a separate copy</button>
    <button class="btn quiet" data-m="cancel">Cancel</button></div>`;
  sh.dismissable = true;
  sh.el.onclick = (e) => {
    const m = e.target.closest("[data-m]");
    if (!m) return;
    if (m.dataset.m === "cancel") return sh.close();
    finishImport(imported, m.dataset.m, existing);
  };
}

async function finishImport(imported, mode, existing) {
  const sh = openSheet(`<h3>Saving…</h3><p>Storing the images on this device.</p>`, { dismissable: false });
  let rec;
  try { rec = await saveDeck(imported, mode, existing); }
  catch (e) {
    sh.close();
    return showErrors(e.errors || [`Could not save the deck on this device: ${e.message}. The phone may be out of storage.`], []);
  }
  const w = imported.warnings;
  sh.el.innerHTML = `<h3>Ready: ${esc(rec.title)}</h3>
    <p>${rec.deck.cards.length} cards${rec.deck.question ? "" : " to annotate"}. ${mode === "update" ? "Your earlier answers are kept." : ""}</p>
    ${w.length ? `<details><summary>${w.length} warning${w.length > 1 ? "s" : ""} (the deck still works)</summary><ul class="errors warn">${w.slice(0, 40).map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
      <button class="btn quiet" data-copy>Copy warnings for the AI</button></details>` : ""}
    <div class="stack"><button class="btn" data-go>Open the deck</button></div>`;
  sh.dismissable = true;
  sh.el.onclick = async (e) => {
    if (e.target.closest("[data-copy]")) { if (await copyText(w.join("\n"))) toast("Copied"); }
    if (e.target.closest("[data-go]")) { sh.close(); go(`#/deck/${encodeURIComponent(rec.key)}`); }
  };
  if (!S && parseHash().page === "home") home();
}

function showErrors(errors, warnings) {
  const shown = errors.slice(0, 30), more = errors.length - shown.length;
  const text = errors.join("\n");
  const sh = openSheet(`<h3>This deck can't be opened yet</h3>
    <p>${errors.length} problem${errors.length > 1 ? "s" : ""}. If an AI made the deck, paste these into that chat. It can fix them.</p>
    <ul class="errors">${shown.map((x) => `<li>${esc(x)}</li>`).join("")}${more > 0 ? `<li>…and ${more} more (all included when you copy)</li>` : ""}</ul>
    ${warnings.length ? `<details><summary>${warnings.length} warning${warnings.length > 1 ? "s" : ""}</summary><ul class="errors warn">${warnings.slice(0, 20).map((x) => `<li>${esc(x)}</li>`).join("")}</ul></details>` : ""}
    <div class="row"><button class="btn" data-copy>Copy for the AI</button><button class="btn quiet" data-close>Close</button></div>`);
  sh.el.onclick = async (e) => {
    if (e.target.closest("[data-copy]")) {
      const msg = `The Hooman in the Loop app rejected the deck with these errors. Please fix the deck and give me the new zip:\n\n${text}${warnings.length ? `\n\nWarnings:\n${warnings.join("\n")}` : ""}`;
      if (await copyText(msg)) toast("Copied. Paste it into your AI chat");
    }
    if (e.target.closest("[data-close]")) sh.close();
  };
}

function linkSheet(prefill = "") {
  const sh = openSheet(`<h3>Open a deck from a link</h3>
    <p>A link to a <span class="mono">.hooman.zip</span>, or to a <span class="mono">deck.json</span> whose images sit next to it. The host must allow downloads from other sites (GitHub raw and gists do).</p>
    <input type="url" id="link-url" placeholder="https://…/deck.json" value="${esc(prefill)}" autofocus>
    <div class="row"><button class="btn" data-go>Import</button><button class="btn quiet" data-close>Cancel</button></div>`);
  sh.el.onclick = (e) => {
    if (e.target.closest("[data-close]")) sh.close();
    if (e.target.closest("[data-go]")) {
      const url = $("#link-url", sh.el).value.trim();
      if (!/^https?:\/\//i.test(url)) return toast("Paste a link that starts with https://");
      runImport((p) => importURL(url, p));
    }
  };
}

function specURL() { return new URL("llms.txt", location.href.split("#")[0].split("?")[0]).href; }
function appURL() { return location.href.split("#")[0].split("?")[0]; }

function aiSheet() {
  const prompt = `Build me a deck for the app "Hooman in the Loop".
The deck format is here, read it first: ${specURL()}

My images: [attach them, or describe where they are]
What I want to answer for each image: [for example "Is there a cat?", or "Which of the two models' masks is right?"]
What the model found (optional): [masks / boxes / points, and in which files]

Give me the finished .hooman.zip file.`;
  const sh = openSheet(`<h3>✨ Make a deck with any AI chat</h3>
    <p>ChatGPT, Claude, Gemini and others can build a deck from your images and your model's results. Copy this prompt, fill in the brackets, and attach your images. Then import the zip it gives you.</p>
    <textarea id="ai-prompt" spellcheck="false">${esc(prompt)}</textarea>
    <div class="row"><button class="btn" data-copy>Copy prompt</button><a class="btn quiet" href="llms.txt" target="_blank" style="text-decoration:none">Read the format</a></div>`);
  sh.el.onclick = async (e) => {
    if (e.target.closest("[data-copy]")) { if (await copyText($("#ai-prompt", sh.el).value)) toast("Copied. Paste it into your AI chat"); }
  };
}

async function examplesSheet() {
  let list = [];
  try { list = await (await fetch("examples/index.json")).json(); } catch { return toast("Examples are not available offline yet"); }
  const sh = openSheet(`<h3>Try an example</h3><p>Small decks that show what the app can do.</p>
    <div class="stack">${list.map((x, i) => `<button class="example" data-i="${i}"><b>${esc(x.title)}</b><span>${esc(x.about)}</span></button>`).join("")}</div>`);
  sh.el.onclick = (e) => {
    const b = e.target.closest("[data-i]");
    if (!b) return;
    const url = new URL(`examples/${list[+b.dataset.i].file}`, location.href.split("#")[0]).href;
    runImport((p) => importURL(url, p));
  };
}

// ---------------------------------------------------------------- deck (swipe) screen
let S = null;

function currentCard() { return S && S.pos >= 0 ? S.cardsById.get(S.order[S.pos]) : null; }
function nextUnanswered(from) {
  const n = S.order.length;
  for (let k = 1; k <= n; k++) { const i = (from + k) % n; if (!S.answers.has(S.order[i])) return i; }
  return -1;
}

async function openDeck(key, params) {
  const rec = themed(await store.getDeck(key));
  if (!rec) { toast("That deck is not on this device"); return go("#/"); }
  rec.openedAt = new Date().toISOString();
  saveRec(rec);
  const answers = new Map((await store.answersOf(key)).map((a) => [a.card, a]));
  const notes = new Map((await store.notesOf(key)).map((n) => [n.card, n]));
  const cardsById = new Map(rec.deck.cards.map((c) => [c.id, c]));
  const order = (rec.order || rec.deck.cards.map((c) => c.id)).filter((id) => cardsById.has(id));
  S = { rec, key, answers, notes, cardsById, order, pos: -1, stack: [], frame: 0, busy: false, autoEdit: modeOf(rec.deck) !== "swipe",
        hidden: new Set(prefs.get(`hidden:${key}`, [])), revisit: params.get("from") === "review" };
  const want = params.get("card");
  if (want && cardsById.has(want)) S.pos = order.indexOf(want);
  else {
    const last = rec.lastCard ? order.indexOf(rec.lastCard) : -1;
    S.pos = last >= 0 && !answers.has(order[last]) ? last : nextUnanswered(order.length - 1);
  }
  buildDeckScreen();
  showCard();
  if (!prefs.get("toured", false)) tourSheet();
}

function defsNow() {
  const all = answerDefs(S.rec);
  const vis = all.filter((d) => !d.hidden);
  S.dirDefs = new Map(vis.filter((d) => d.slot !== "button").map((d) => [d.slot, d]));
  S.buttonDefs = vis.filter((d) => d.slot === "button");
  S.allDefs = all;
}

function buildDeckScreen() {
  defsNow();
  const deck = S.rec.deck;
  app.onclick = null;
  app.innerHTML = `<main class="screen deckscreen">
    <div class="top">
      <button class="ghost" data-act="back">‹ ${S.revisit ? "Back" : "Decks"}</button>
      <h2>${esc(deck.title)}</h2>
      <span class="count" id="count"></span>
      <button class="icon-btn" data-act="menu" aria-label="Deck menu">⋮</button>
    </div>
    <div class="pbar"><i id="pbar"></i></div>
    <div class="tally" id="tally"></div>
    <p class="question" id="question" data-act="caption"></p>
    <div class="chips" id="chips"><button class="chip" data-act="contrast" aria-label="Contrast">◐</button>${deck.sources.filter((s) => !s.guide).map((s) => `<button class="chip" data-src="${esc(s.name)}" style="color:${esc(s.color)}"><i></i><span style="color:var(--text)">${esc(s.label)}</span></button>`).join("")}</div>
    <div class="stage" id="stage"></div>
    <div class="answers" id="answers"></div>
    <div class="hint" id="hint"></div>
  </main>`;
  renderAnswerButtons();
  updateChips();
  app.onclick = onDeckClick;
  const onContrast = () => { if (S && S.view) S.view.draw(); if (Z) Z.view.draw(); };
  window.addEventListener("hooman:contrast", onContrast);
  cleanup.push(() => window.removeEventListener("hooman:contrast", onContrast));
  const onResize = () => { clearTimeout(S && S.rz); if (S) S.rz = setTimeout(layoutCard, 120); };
  window.addEventListener("resize", onResize);
  document.addEventListener("keydown", onDeckKey);
  cleanup.push(() => { window.removeEventListener("resize", onResize); document.removeEventListener("keydown", onDeckKey); app.onclick = null; });
}

function renderAnswerButtons() {
  const el = $("#answers"), mode = modeOf(S.rec.deck);
  if (mode === "follow") {
    el.innerHTML = `<button class="ans" data-act="follow" style="grid-column:span 6;border-color:var(--lime);color:var(--lime)"><span class="lbl">▶ Follow this cell</span></button>
      <button class="ans undo" data-act="skip" style="grid-column:span 3"><span class="lbl">Skip</span></button>
      <button class="ans undo" data-act="undo" style="grid-column:span 3"><span class="lbl">Undo</span></button>`;
    $("#hint").textContent = "tap the cell in every frame · hold to see the previous frame";
    return;
  }
  if (mode === "annotate") {
    el.innerHTML = `<button class="ans" data-act="draw" style="grid-column:span 6;border-color:var(--lime);color:var(--lime)"><span class="lbl">✎ Draw the mask</span></button>
      <button class="ans undo" data-act="skip" style="grid-column:span 3"><span class="lbl">Skip</span></button>
      <button class="ans undo" data-act="undo" style="grid-column:span 3"><span class="lbl">Undo</span></button>`;
    $("#hint").textContent = "tap the image or ✎ to draw · one finger draws, two fingers move";
    return;
  }
  const btn = (d, cls = "", span) => `<button class="ans ${cls}" data-val="${esc(d.value)}" data-slot="${d.slot}" style="border-color:${esc(d.color)};color:${esc(d.color)}${span ? `;grid-column:span ${span}` : ""}">
      ${ARROW[d.slot] ? `<span class="arrow">${ARROW[d.slot]}</span>` : ""}<span class="lbl">${esc(d.label)}</span></button>`;
  const L = S.dirDefs.get("left"), R = S.dirDefs.get("right"), U = S.dirDefs.get("up"), D = S.dirDefs.get("down");
  let h = "";
  const row1 = [L, R].filter(Boolean);
  h += row1.map((d) => btn(d, "big", row1.length === 1 ? 6 : 3)).join("");
  const row2 = [U, D].filter(Boolean);
  const span2 = 6 / (row2.length + 1);
  h += row2.map((d) => btn(d, "", span2)).join("");
  h += `<button class="ans undo" data-act="undo" style="grid-column:span ${span2}"><span class="lbl">Undo</span></button>`;
  const n = S.buttonDefs.length, spanB = n === 1 ? 6 : n === 2 || n === 4 ? 3 : 2;
  h += S.buttonDefs.map((d) => btn(d, "", spanB)).join("");
  el.innerHTML = h;
  const parts = ["left", "right", "up", "down"].filter((k) => S.dirDefs.get(k)).map((k) => `${ARROW[k]} ${esc(S.dirDefs.get(k).label)}`);
  $("#hint").innerHTML = `${parts.join(" · ")} · tap = zoom`;
}

// the order the buttons appear in: left, right, up, down, then the extra buttons
const SLOT_ORDER = { left: 0, right: 1, up: 2, down: 3, button: 4 };
const byButtonOrder = (defs) => defs.map((d, i) => [d, i]).sort((a, b) => SLOT_ORDER[a[0].slot] - SLOT_ORDER[b[0].slot] || a[1] - b[1]).map(([d]) => d);

function updateChips() {
  $$("#chips .chip").forEach((c) => c.setAttribute("aria-pressed", String(!S.hidden.has(c.dataset.src))));
}

function updateCounts() {
  const n = S.order.length, done = S.answers.size;
  $("#count").textContent = `${done} / ${n}`;
  $("#pbar").style.width = `${n ? (100 * done) / n : 0}%`;
  const tallies = new Map();
  for (const a of S.answers.values()) tallies.set(a.answer, (tallies.get(a.answer) || 0) + 1);
  const seen = new Set();
  const parts = [];
  for (const d of byButtonOrder(S.allDefs)) {
    if (seen.has(d.value) || (d.hidden && !tallies.get(d.value))) continue;
    seen.add(d.value);
    parts.push(`<span>${esc(d.label)} <b style="color:${esc(d.color)}">${tallies.get(d.value) || 0}</b></span>`);
  }
  for (const [v, k] of tallies) if (!seen.has(v)) parts.push(`<span>${esc(v)} <b>${k}</b></span>`);
  $("#tally").innerHTML = parts.join("");
}

function layoutCard() {
  const card = currentCard();
  if (!S || !S.cardEl || !card) return;
  const stage = $("#stage"), sw = stage.clientWidth, sh = stage.clientHeight;
  const extra = 26 + (card.frames.length > 1 ? 36 : 0) + 2;
  const r = viewRect(card), aspect = r[2] / r[3];
  let h = Math.max(60, sh - extra), w = h * aspect;
  if (w > sw - 2) { w = sw - 2; h = w / aspect; }
  w = Math.floor(w); h = Math.floor(h);
  S.cardEl.style.width = `${w + 2}px`;
  const cv = $("canvas", S.cardEl);
  cv.style.width = `${w}px`; cv.style.height = `${h}px`;
  if (S.view && S.view.sources) S.view.resize(viewRect(card));
}

async function showCard() {
  stopPlay();
  updateCounts();
  const stage = $("#stage"), deck = S.rec.deck;
  const card = currentCard();
  const m = modeOf(deck);
  $("#question").textContent = card ? card.question || deck.question || (m === "follow" ? "Follow the cell through the frames" : "Draw the objects you see") : deck.question || "";
  const undoBtn = $("[data-act=undo]");
  $$("#answers .ans:not(.undo)").forEach((b) => (b.disabled = !card));
  if (undoBtn) undoBtn.disabled = S.answers.size === 0;
  if (!card) { S.cardEl = null; return showDone(); }
  S.frame = 0;
  S.rec.lastCard = card.id;
  const el = document.createElement("div");
  el.className = "card enter";
  el.innerHTML = `<canvas></canvas><div class="stamp"></div><span class="zoomhint">tap = zoom</span>
    ${card.frames.length > 1 ? `<div class="frames">${card.frames.map((f, i) => `<button data-frame="${i}" aria-pressed="${i === 0}">${esc(f.name || i + 1)}</button>`).join("")}<button class="play" data-act="play" aria-label="Play frames">▶</button></div>` : ""}
    <div class="cardfoot"><span class="caption" data-act="caption" title="${esc(card.info || "")}">${esc(card.info || "")}</span><button class="note-btn ${S.notes.has(card.id) ? "has" : ""}" data-act="note" aria-label="Note on this card">✎ note</button><span>${esc(card.id)}</span></div>`;
  stage.replaceChildren(el);
  S.cardEl = el;
  attachSwipe(el);
  layoutCard();
  S.view = new CardCanvas($("canvas", el));
  S.view.display = displayFor(S.key, card);
  try { await S.view.show(S.rec, card, { hidden: S.hidden }); }
  catch (e) { console.error(e); toast(`Could not show this card: ${e.message}`, 4000); }
  S.shownAt = performance.now();
  prefetch();
  const mode = modeOf(deck);
  if (mode === "annotate" && S.autoEdit) annotateCard();
  if (mode === "follow" && S.autoEdit) followCard();
}

function prefetch() {
  if (!S) return;
  let i = S.pos;
  for (let k = 0; k < 2; k++) {
    i = (i + 1) % S.order.length;
    const c = S.cardsById.get(S.order[i]);
    if (!c || S.answers.has(c.id)) continue;
    c.frames.forEach((f) => frameSource(S.key, f.path).catch(() => {}));
    const colors = Object.fromEntries(S.rec.deck.sources.map((s) => [s.name, s.color]));
    c.overlays.filter((o) => o.shape === "mask").forEach((o) => maskLayer(S.key, o.mask, o.value, colors[o.source], o.style === "fill").catch(() => {}));
  }
}

function showDone() {
  const n = S.order.length;
  $("#stage").innerHTML = `<div class="done"><div class="big-emoji">🎉</div><h3>All ${n} cards answered</h3>
    <p class="muted">The hooman has spoken. Export the answers, or review and change any of them.</p>
    <button class="btn" data-act="results">See the results</button><button class="btn quiet" data-act="export">Export answers</button><button class="btn quiet" data-act="review">Review answers</button></div>`;
  $("#question").textContent = "";
  saveRec(S.rec);
}

// --- gestures
const dirOf = (dx, dy) => (Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : dy > 0 ? "down" : "up");

function attachSwipe(el) {
  let pid = null, start = null;
  const stamp = $(".stamp", el);
  const threshold = () => Math.min(120, el.clientWidth * 0.3);
  const reset = () => {
    el.classList.add("back"); el.style.transform = ""; stamp.style.opacity = "0";
    setTimeout(() => el.classList.remove("back"), 220);
  };
  el.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".frames") || e.target.closest(".cardfoot") || S.busy) return;
    if (pid !== null) { pid = null; reset(); return; }        // a second finger cancels the swipe
    pid = e.pointerId; el.setPointerCapture(pid);
    start = { x: e.clientX, y: e.clientY, t: performance.now() };
    el.classList.remove("back", "fly", "enter");
  });
  el.addEventListener("pointermove", (e) => {
    if (e.pointerId !== pid) return;
    const dx = e.clientX - start.x, dy = e.clientY - start.y, dist = Math.hypot(dx, dy);
    el.style.transform = `translate(${dx}px, ${dy}px) rotate(${dx / 20}deg)`;
    const def = S.dirDefs.get(dirOf(dx, dy));
    if (def && dist > 12) {
      stamp.textContent = def.label; stamp.style.color = def.color; stamp.style.borderColor = def.color;
      stamp.style.opacity = String(Math.min(1, dist / threshold()));
    } else stamp.style.opacity = "0";
  });
  const end = (e, cancelled) => {
    if (e.pointerId !== pid) return;
    pid = null;
    const dx = e.clientX - start.x, dy = e.clientY - start.y, dist = Math.hypot(dx, dy), dt = performance.now() - start.t;
    if (cancelled) return reset();
    if (dist < 10 && dt < 450) { reset(); const m = modeOf(S.rec.deck); return m === "swipe" ? openZoom() : m === "follow" ? followCard() : annotateCard(); }
    const dir = dirOf(dx, dy), def = S.dirDefs.get(dir);
    if (def && (dist > threshold() || (dist > 50 && dist / dt > 0.6))) answer(def, { dx, dy });
    else reset();
  };
  el.addEventListener("pointerup", (e) => end(e, false));
  el.addEventListener("pointercancel", (e) => end(e, true));
}

function flyOut(def, from) {
  return new Promise((res) => {
    const el = S.cardEl;
    if (!el) return res();
    const stamp = $(".stamp", el);
    stamp.textContent = def.label; stamp.style.color = def.color; stamp.style.borderColor = def.color; stamp.style.opacity = "1";
    const W = window.innerWidth, H = window.innerHeight;
    const v = { right: [W, 0], left: [-W, 0], up: [0, -H], down: [0, H] }[def.slot] || [0, -H * 0.5];
    const sx = from ? from.dx : 0, sy = from ? from.dy : 0;
    el.classList.remove("enter"); el.classList.add("fly");
    requestAnimationFrame(() => {
      el.style.transform = `translate(${sx + v[0]}px, ${sy + v[1]}px) rotate(${(sx + v[0]) / 20}deg)`;
      el.style.opacity = "0";
    });
    setTimeout(res, 210);
  });
}

function snapBack() {
  const el = S && S.cardEl;
  if (!el) return;
  el.classList.add("back"); el.style.transform = ""; el.style.opacity = "";
  const st = $(".stamp", el); if (st) st.style.opacity = "0";
  setTimeout(() => el.classList.remove("back"), 220);
}

// Opens the editor for the current card; resolves the drawing or null (cancelled).
function drawFor(card, prev, title, note, doneLabel = "Save") {
  stopPlay();
  return openEditor({ rec: S.rec, card, frame: S.frame, hidden: new Set(S.hidden), initial: prev && prev.mask ? prev : null, title, note, doneLabel });
}

async function answer(def, from) {
  const card = currentCard();
  if (!card || S.busy) return;
  S.busy = true;
  const prev = S.answers.get(card.id) || null;
  let drawn = null, extra = null;
  if (def.then === "draw") {
    snapBack();
    drawn = await drawFor(card, prev, def.label, "draw the right mask");
    if (!drawn) { S.busy = false; return; }   // cancelled: no answer
  } else if (def.then === "point" || def.then === "points") {
    snapBack(); stopPlay();
    const r = await openTapper({ rec: S.rec, card, frame: S.frame, hidden: new Set(S.hidden), multi: def.then === "points", title: def.label,
      note: def.then === "points" ? "tap each point" : "tap the spot", color: def.color });
    if (!r) { S.busy = false; return; }
    extra = { points: r.points };
  } else if (def.then === "number" || def.then === "text") {
    snapBack();
    const v = await askValue(def, prev);
    if (v === null) { S.busy = false; return; }
    extra = def.then === "number" ? { number: v } : { text: v };
  }
  if (!(await saveAnswer(card, def, prev, drawn, extra))) return;
  if (def.celebrate) blast(def.color);
  await flyOut(def, drawn || extra ? null : from);
  S.busy = false;
  advance();
}

async function saveAnswer(card, def, prev, drawn, extra) {
  try {
    const at = new Date().toISOString();
    const rec = { answer: def.value, label: def.label, at, ms: Math.round(performance.now() - (S.shownAt || performance.now())), changes: prev ? (prev.changes || 0) + 1 : 0 };
    if (annotator()) rec.by = annotator();
    if (drawn) {
      if (drawn.masks) rec.masks = drawn.masks; else rec.mask = drawn.mask;
      rec.objects = drawn.objects; rec.frame = drawn.frame;
      if (drawn.from && drawn.from.length) rec.from = drawn.from;
    }
    if (extra) Object.assign(rec, extra);
    await store.setAnswer(S.key, card.id, rec, { answer: def.value, at, ...(drawn ? { objects: drawn.count } : {}) });
    S.answers.set(card.id, { ...rec, deck: S.key, card: card.id });
    S.stack.push({ card: card.id, prev });
    return true;
  } catch (e) {
    console.error(e);
    toast(`Could not save the answer: ${e.message}`, 4000);
    S.busy = false;
    snapBack();
    return false;
  }
}

function advance() {
  if (S.revisit) return history.back();
  S.pos = nextUnanswered(S.pos);
  if (S.pos < 0) confetti();
  showCard();
}

// "then": "number" | "text": a small sheet asks for the value. Resolves the value, or null when cancelled.
function askValue(def, prev) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
    const num = def.then === "number", old = prev && prev.answer === def.value ? (num ? prev.number : prev.text) : "";
    const sh = openSheet(`<h3>${esc(def.label)}</h3>
      ${num ? `<input type="text" inputmode="decimal" id="ask-v" value="${esc(old ?? "")}" placeholder="a number" autofocus>` : `<textarea id="ask-v" placeholder="type here" autofocus>${esc(old ?? "")}</textarea>`}
      <p id="ask-err" style="color:var(--red)"></p>
      <div class="row"><button class="btn" data-ok>Save</button><button class="btn quiet" data-no>Cancel</button></div>`, { onClose: () => finish(null) });
    const ok = () => {
      const raw = $("#ask-v", sh.el).value.trim();
      if (num) {
        const v = Number(raw.replace(",", "."));
        if (!raw || !Number.isFinite(v)) { $("#ask-err", sh.el).textContent = "Type a number, like 12 or 3.5"; return; }
        finish(v);
      } else finish(raw);
      sh.close();
    };
    sh.el.onclick = (e) => { if (e.target.closest("[data-no]")) sh.close(); if (e.target.closest("[data-ok]")) ok(); };
    sh.el.addEventListener("keydown", (e) => { if (e.key === "Enter" && num) { e.preventDefault(); ok(); } });
  });
}

// Follow decks: tap the same cell frame after frame.
async function followCard() {
  const card = currentCard();
  if (!card || S.busy || document.querySelector(".tapper")) return;
  S.busy = true;
  const prev = S.answers.get(card.id) || null;
  const pos = S.order.indexOf(card.id) + 1;
  const r = await openFollow({ rec: S.rec, card, hidden: new Set(S.hidden), title: S.rec.deck.title, note: `card ${pos} of ${S.order.length}` });
  if (!r) { S.busy = false; S.autoEdit = false; return; }
  if (r.skip) {
    S.busy = false;
    S.pos = nextUnanswered(S.pos);
    if (S.order[S.pos] === card.id) { S.autoEdit = false; toast("This is the last open card"); }
    return showCard();
  }
  const def = S.rec.deck.answers.find((d) => d.value === r.end) || { value: r.end, label: r.end, slot: "button" };
  if (!(await saveAnswer(card, def, prev, null, { points: r.points, end: r.end }))) return;
  S.busy = false;
  S.autoEdit = true;
  advance();
}

// The card's caption and question in full (on the card they are cut to fit).
function captionSheet() {
  const card = currentCard();
  if (!card) return;
  const q = card.question || S.rec.deck.question;
  openSheet(`<h3 class="mono" style="font-size:15px">${esc(card.id)}</h3>
    ${q ? `<p style="color:var(--text)"><b>${esc(q)}</b></p>` : ""}
    ${card.info ? `<p style="color:var(--text);white-space:pre-wrap">${esc(card.info)}</p>` : ""}
    <p class="mono" style="font-size:12px">${card.frames.map((f) => esc(f.path)).join("<br>")} · ${card.w}×${card.h}</p>`);
}

// Notes: free text per card, kept even before the card is answered.
function noteSheet() {
  const card = currentCard();
  if (!card) return;
  const cur = S.notes.get(card.id);
  const sh = openSheet(`<h3>Note · <span class="mono" style="font-size:15px">${esc(card.id)}</span></h3>
    <textarea id="note-text" placeholder="Anything worth remembering about this card" autofocus>${esc(cur ? cur.text : "")}</textarea>
    <div class="row"><button class="btn" data-save>Save</button><button class="btn quiet" data-close>Cancel</button></div>`);
  sh.el.onclick = async (e) => {
    if (e.target.closest("[data-close]")) return sh.close();
    if (!e.target.closest("[data-save]")) return;
    const text = $("#note-text", sh.el).value.trim();
    await store.setNote(S.key, card.id, text, annotator() || undefined);
    if (text) S.notes.set(card.id, { text }); else S.notes.delete(card.id);
    sh.close();
    const b = S.cardEl && $(".note-btn", S.cardEl); if (b) b.classList.toggle("has", !!text);
    toast(text ? "Note saved" : "Note removed");
  };
}

// Annotate decks (no question): every card is a mask to draw.
async function annotateCard() {
  const card = currentCard();
  if (!card || S.busy || editorOpen()) return;
  S.busy = true;
  const prev = S.answers.get(card.id) || null;
  const pos = S.order.indexOf(card.id) + 1;
  const drawn = await drawFor(card, prev, S.rec.deck.title, `card ${pos} of ${S.order.length}`, "Save");
  if (!drawn) { S.busy = false; S.autoEdit = false; return; }
  const def = drawn.count
    ? { value: "annotated", label: `${drawn.count} object${drawn.count > 1 ? "s" : ""}`, slot: "button" }
    : { value: "empty", label: "Nothing to mark", slot: "button" };
  if (!(await saveAnswer(card, def, prev, drawn))) return;
  S.busy = false;
  S.autoEdit = true;
  advance();
}

async function undo() {
  if (!S || S.busy) return;
  let entry = S.stack.pop();
  if (!entry) {
    let latest = null;
    for (const a of S.answers.values()) if (!latest || a.at > latest.at) latest = a;
    if (!latest) return toast("Nothing to undo");
    entry = { card: latest.card, prev: null };
  }
  S.busy = true;
  try {
    const at = new Date().toISOString();
    const prev = entry.prev ? (({ deck, card, ...rest }) => rest)(entry.prev) : null;
    await store.setAnswer(S.key, entry.card, prev, { answer: prev ? prev.answer : null, at, undo: true });
    if (prev) S.answers.set(entry.card, { ...prev, deck: S.key, card: entry.card }); else S.answers.delete(entry.card);
    S.pos = S.order.indexOf(entry.card);
    toast(prev ? `Back to “${prev.label}”` : "Undone");
  } finally { S.busy = false; }
  showCard();
}

// --- frames
function setFrame(i) {
  const card = currentCard();
  if (!card || !S.view) return;
  S.frame = (i + card.frames.length) % card.frames.length;
  S.view.setFrame(S.frame);
  $$(".frames [data-frame]", S.cardEl).forEach((b) => b.setAttribute("aria-pressed", String(+b.dataset.frame === S.frame)));
  if (Z) Z.view.setFrame(S.frame), $$("[data-zframe]", Z.el).forEach((b) => b.setAttribute("aria-pressed", String(+b.dataset.zframe === S.frame)));
}
let playTimer = null;
function togglePlay() {
  if (playTimer) return stopPlay();
  playTimer = setInterval(() => setFrame(S.frame + 1), 550);
  $$("[data-act=play]").forEach((b) => (b.textContent = "❚❚"));
}
function stopPlay() {
  clearInterval(playTimer); playTimer = null;
  $$("[data-act=play]").forEach((b) => (b.textContent = "▶"));
}

function toggleSource(name) {
  if (S.hidden.has(name)) S.hidden.delete(name); else S.hidden.add(name);
  prefs.set(`hidden:${S.key}`, [...S.hidden]);
  updateChips();
  if (S.view) S.view.setHidden(S.hidden);
  if (Z) { Z.view.setHidden(S.hidden); $$("[data-zsrc]", Z.el).forEach((c) => c.setAttribute("aria-pressed", String(!S.hidden.has(c.dataset.zsrc)))); }
}
function toggleAllSources() {
  const names = S.rec.deck.sources.filter((s) => !s.guide).map((s) => s.name);
  const anyShown = names.some((n) => !S.hidden.has(n));
  S.hidden = new Set(anyShown ? names : []);
  prefs.set(`hidden:${S.key}`, [...S.hidden]);
  updateChips();
  if (S.view) S.view.setHidden(S.hidden);
}

function onDeckClick(e) {
  const t = e.target.closest("[data-act],[data-val],[data-frame],[data-src]");
  if (!t || !S) return;
  if (t.dataset.val !== undefined) {
    const def = S.allDefs.find((d) => d.value === t.dataset.val && d.slot === t.dataset.slot && !d.hidden);
    if (def) answer(def);
    return;
  }
  if (t.dataset.frame !== undefined) { stopPlay(); return setFrame(+t.dataset.frame); }
  if (t.dataset.src !== undefined) return toggleSource(t.dataset.src);
  const act = t.dataset.act;
  if (act === "back") return S.revisit ? history.back() : go("#/");
  if (act === "undo") return undo();
  if (act === "contrast") return contrastPanel();
  if (act === "draw") return annotateCard();
  if (act === "follow") return followCard();
  if (act === "note") return noteSheet();
  if (act === "caption") return captionSheet();
  if (act === "skip") { const c = currentCard(); if (c) { S.pos = nextUnanswered(S.pos); if (S.order[S.pos] === c.id) toast("This is the last open card"); showCard(); } return; }
  if (act === "menu") return deckMenu();
  if (act === "play") return togglePlay();
  if (act === "export") return exportSheet(S.rec);
  if (act === "review") return go(`#/review/${encodeURIComponent(S.key)}`);
  if (act === "results") return go(`#/results/${encodeURIComponent(S.key)}`);
}

function onDeckKey(e) {
  if (!S || sheetOpen || editorOpen() || document.querySelector(".tapper") || e.ctrlKey && e.key !== "z" || e.metaKey || e.altKey) return;
  if (e.target.closest && e.target.closest("input, textarea, select")) return;
  if (Z) { if (e.key === "Escape") closeZoom(); return; }
  const k = e.key;
  const dirKey = { ArrowRight: "right", ArrowLeft: "left", ArrowUp: "up", ArrowDown: "down" }[k];
  if (dirKey) { e.preventDefault(); const d = S.dirDefs.get(dirKey); if (d) answer(d); return; }
  if (k === "Backspace" || k === "z" || k === "u") { e.preventDefault(); return undo(); }
  if (k === "i") return captionSheet();
  if (/^[1-6]$/.test(k)) { const d = S.buttonDefs[+k - 1]; if (d) answer(d); return; }
  if (k === "o") return toggleAllSources();
  if (k === "Enter" || k === " ") { e.preventDefault(); return currentCard() && openZoom(); }
  if (k === "[") return setFrame(S.frame - 1);
  if (k === "]") return setFrame(S.frame + 1);
  if (k === "p") return togglePlay();
  if (k === "n") return noteSheet();
}

// --- zoom viewer
let Z = null;
async function openZoom() {
  const card = currentCard();
  if (!card || Z) return;
  const deck = S.rec.deck;
  const el = document.createElement("div");
  el.className = "zoom";
  el.innerHTML = `<div class="bar">
      <button class="ghost" data-z="close">✕ Close</button>
      <button class="chip" data-act="contrast" aria-label="Contrast">◐</button>
      ${deck.sources.filter((s) => !s.guide).map((s) => `<button class="chip" data-zsrc="${esc(s.name)}" aria-pressed="${!S.hidden.has(s.name)}" style="color:${esc(s.color)}"><i></i><span style="color:var(--text)">${esc(s.label)}</span></button>`).join("")}
    </div>
    <canvas></canvas>
    <div class="bottom">${card.frames.length > 1 ? `<div class="frames" style="border:0;padding:0">${card.frames.map((f, i) => `<button data-zframe="${i}" aria-pressed="${i === S.frame}">${esc(f.name || i + 1)}</button>`).join("")}<button class="play" data-act="play">${playTimer ? "❚❚" : "▶"}</button></div>` : ""}
      ${card.info ? `<p class="zoom-info">${esc(card.info)}</p>` : ""}
      <p class="hint" style="margin:6px 0 0">pinch or scroll to zoom · drag to move · double-tap to zoom in</p></div>`;
  document.body.appendChild(el);
  Z = { el, view: new CardCanvas($("canvas", el), { interactive: true }) };
  Z.view.display = displayFor(S.key, card);
  el.onclick = (e) => {
    const t = e.target.closest("[data-z],[data-zsrc],[data-zframe],[data-act]");
    if (!t) return;
    if (t.dataset.z === "close") closeZoom();
    else if (t.dataset.act === "contrast") contrastPanel();
    else if (t.dataset.zsrc !== undefined) toggleSource(t.dataset.zsrc);
    else if (t.dataset.zframe !== undefined) { stopPlay(); setFrame(+t.dataset.zframe); }
    else if (t.dataset.act === "play") togglePlay();
  };
  const onR = () => Z && Z.view.resize();
  window.addEventListener("resize", onR);
  Z.off = () => window.removeEventListener("resize", onR);
  await Z.view.show(S.rec, card, { frame: S.frame, hidden: S.hidden });
}
function contrastPanel() {
  const card = currentCard();
  if (!card || !S.view || !S.view.sources) return;
  const src = S.view.sources[S.frame] || S.view.sources[0];
  openContrast(S.key, card.frames.length > 1 ? card.frames[S.frame].name || "" : "", src.bits === 16);
}
function closeZoom() {
  if (!Z) return;
  Z.off(); Z.el.remove(); Z = null;
}

// --- deck menu, help, answer editor
function deckMenu() {
  const sh = openSheet(`<h3>${esc(S.rec.title)}</h3>
    <div class="menu">
      <button class="btn quiet" data-m="results">Results</button>
      <button class="btn quiet" data-m="review">Review and change answers</button>
      ${modeOf(S.rec.deck) === "swipe" ? `<button class="btn quiet" data-m="edit">Edit the answer buttons</button>` : ""}
      <button class="btn quiet" data-m="export">Export answers</button>
      <button class="btn quiet" data-m="settings">Settings & backup</button>
      <button class="btn quiet" data-m="help">Help</button>
      <button class="btn danger" data-m="delete">Delete this deck</button>
    </div>`);
  sh.el.onclick = (e) => {
    const m = e.target.closest("[data-m]");
    if (!m) return;
    const rec = S.rec;
    ({
      review: () => { sh.close(); go(`#/review/${encodeURIComponent(rec.key)}`); },
      results: () => { sh.close(); go(`#/results/${encodeURIComponent(rec.key)}`); },
      settings: () => settingsSheet(),
      edit: () => answerEditor(rec),
      export: () => exportSheet(rec),
      help: () => helpSheet(rec),
      delete: () => deleteSheet(rec),
    })[m.dataset.m]();
  };
}

const THEN_WORDS = { draw: ", then draw the right mask", point: ", then tap the spot", points: ", then tap each point", number: ", then type a number", text: ", then type a few words" };
function guideHTML(rec) {
  defsNow();
  const deck = rec.deck, mode = modeOf(deck);
  const lines = mode === "follow" ? [
      "<li>Tap the cell in each frame; the app moves to the next frame by itself.</li>",
      "<li>Hold the image to see the previous frame. <b>Not here</b> skips a frame; <b>Divides</b> asks for both daughters; <b>Cell ends</b> or <b>Leaves view</b> finish the track.</li>",
      "<li>Two fingers zoom. ↶ goes back one frame.</li>"]
    : mode === "annotate" ? [
      "<li>Every card opens the mask editor. Draw each object; <b>＋ New object</b> between objects.</li>",
      "<li>✨ Wand fills a cell in one tap; 〰 Contour fills what you draw around; ✂ Cut splits, ⊕ Merge joins.</li>",
      "<li>One finger draws, two fingers zoom. ◐ changes the contrast.</li>"]
    : S.allDefs.filter((d) => !d.hidden).map((d) => `<li><b style="color:${esc(d.color)}">${esc(d.label)}</b>: ${SLOT_NAME[d.slot]}${d.slot === "button" ? "" : ` or the ${ARROW[d.slot]} button`}${THEN_WORDS[d.then] || ""}${d.celebrate ? " 🎉" : ""}</li>`)
      .concat(["<li>UNDO takes back the last answer. Tap the image to zoom; ◐ changes the contrast; the coloured chips show or hide outlines.</li>"]);
  return `${deck.help ? `<p style="color:var(--text);white-space:pre-wrap">${esc(deck.help)}</p>` : ""}
    ${deck.question ? `<p><b style="color:var(--text)">${esc(deck.question)}</b></p>` : ""}
    <ul class="guide">${lines.join("")}<li>✎ note adds a note to a card. The ⋮ menu has Results, Review, Export and Backup.</li></ul>`;
}
function helpSheet(rec) {
  openSheet(`<h3>How this deck works</h3>${guideHTML(rec)}
    <p class="mono" style="font-size:12px">Keyboard: arrows answer · 1-6 buttons · Backspace undo · N note · O outlines · Enter zoom · [ ] frames · P play</p>`);
}
// First time on this device: who is answering, and how this deck works.
function tourSheet() {
  const sh = openSheet(`<h3>Welcome, hooman 👋</h3>
    <p>The AI guessed. Now you decide, one card at a time.</p>
    <label class="field">Your name <span class="muted">(optional: it goes into exports, so two people's answers can be compared)</span><input type="text" id="tour-name" value="${esc(annotator())}" placeholder="e.g. Dekel" maxlength="60"></label>
    ${guideHTML(S.rec)}
    <div class="stack"><button class="btn" data-go>Let's go</button></div>`, { onClose: () => prefs.set("toured", true) });
  sh.el.onclick = (e) => { if (e.target.closest("[data-go]")) { setAnnotator($("#tour-name", sh.el).value); sh.close(); } };
}

function deleteSheet(rec) {
  const sh = openSheet(`<h3>Delete “${esc(rec.title)}”?</h3>
    <p>This removes the deck, its images and <b>all its answers</b> from this device. Export the answers first if you need them.</p>
    <div class="row"><button class="btn danger" data-del>Delete</button><button class="btn quiet" data-close>Cancel</button></div>`);
  sh.el.onclick = async (e) => {
    if (e.target.closest("[data-close]")) sh.close();
    if (e.target.closest("[data-del]")) { await store.deleteDeck(rec.key); sh.close(); toast("Deleted"); go("#/"); }
  };
}

function answerEditor(rec) {
  const used = new Set(S ? [...S.answers.values()].map((a) => a.answer) : []);
  let defs = answerDefs(rec).map((d) => ({ ...d }));
  const slots = ["right", "left", "up", "down", "button"];
  const render = () => `<h3>Answer buttons</h3>
    <p>Rename, add or hide answers. Answers are saved by their <span class="mono">value</span>; a value already used on a card can't change, but its label can.</p>
    <div class="defs">${defs.map((d, i) => `<div class="def ${d.hidden ? "hidden-def" : ""}" style="--c:${esc(d.color)}">
        <select data-i="${i}" data-f="slot" aria-label="Where">${slots.map((s) => `<option value="${s}" ${s === d.slot ? "selected" : ""}>${ARROW[s] || "btn"}</option>`).join("")}</select>
        <input type="text" data-i="${i}" data-f="label" value="${esc(d.label)}" aria-label="Label">
        <button class="icon-btn" data-hide="${i}" aria-label="${d.hidden ? "Show" : "Hide"}">${d.hidden ? "↺" : "✕"}</button>
        <div class="meta"><label>value <input type="text" data-i="${i}" data-f="value" value="${esc(d.value)}" ${used.has(d.value) || d.locked ? "readonly title=\"already used\"" : ""}></label>
          <label>then <select data-i="${i}" data-f="then">${[["", "nothing"], ["draw", "draw a mask"], ["point", "tap a spot"], ["points", "tap points"], ["number", "type a number"], ["text", "type text"]].map(([v, t]) => `<option value="${v}" ${(d.then || "") === v ? "selected" : ""}>${t}</option>`).join("")}</select></label>
          <label><input type="checkbox" data-i="${i}" data-f="celebrate" ${d.celebrate ? "checked" : ""}> 🎉 confetti</label></div>
      </div>`).join("")}</div>
    <div class="stack"><button class="btn quiet" data-add>＋ Add an answer</button></div>
    <div class="row"><button class="btn" data-save>Save</button><button class="btn quiet" data-reset>Reset to the deck's</button></div>
    <p id="ae-err" style="color:var(--red)"></p>`;
  const sh = openSheet(render());
  const rerender = () => { sh.el.innerHTML = render(); };
  sh.el.addEventListener("input", (e) => {
    const t = e.target, i = t.dataset.i;
    if (i === undefined) return;
    const d = defs[+i], f = t.dataset.f;
    if (f === "label") { const wasAuto = d.value === slug(d.label) && !used.has(d.value) && d.fresh; d.label = t.value; if (wasAuto) { d.value = slug(t.value); const v = sh.el.querySelector(`[data-i="${i}"][data-f=value]`); if (v) v.value = d.value; } }
    else if (f === "value") d.value = t.value.trim();
    else if (f === "slot") d.slot = t.value;
    else if (f === "then") d.then = t.value || undefined;
    else if (f === "celebrate") d.celebrate = t.checked || undefined;
  });
  sh.el.addEventListener("click", async (e) => {
    const t = e.target;
    if (t.closest("[data-hide]")) { const d = defs[+t.closest("[data-hide]").dataset.hide]; if (d.fresh && !used.has(d.value)) defs = defs.filter((x) => x !== d); else d.hidden = !d.hidden; rerender(); }
    else if (t.closest("[data-add]")) {
      const free = ["right", "left", "up", "down"].find((s) => !defs.some((d) => d.slot === s && !d.hidden)) || "button";
      defs.push({ slot: free, label: "New answer", value: "new_answer", color: ["#4fc3f7", "#ff8fab", "#c6ff3d", "#ffa94d"][defs.length % 4], fresh: true });
      rerender();
      const inp = sh.el.querySelector(`[data-i="${defs.length - 1}"][data-f=label]`); if (inp) { inp.focus(); inp.select(); }
    } else if (t.closest("[data-reset]")) { rec.custom = undefined; await saveRec(rec); sh.close(); toast("Back to the deck's answers"); refreshDeck(); }
    else if (t.closest("[data-save]")) {
      const vis = defs.filter((d) => !d.hidden), err = (m) => { $("#ae-err", sh.el).textContent = m; };
      if (vis.some((d) => !d.label.trim() || !d.value)) return err("Every answer needs a label and a value.");
      for (const s of ["right", "left", "up", "down"]) if (vis.filter((d) => d.slot === s).length > 1) return err(`Only one answer can be on ${SLOT_NAME[s]}.`);
      if (vis.filter((d) => d.slot === "button").length > 6) return err("At most 6 extra buttons fit.");
      const vals = vis.map((d) => d.value);
      if (new Set(vals).size !== vals.length) return err("Two answers have the same value; give each its own.");
      rec.custom = { answers: defs.map(({ fresh, ...d }) => ({ ...d, label: d.label.trim() })) };
      await saveRec(rec);
      sh.close(); toast("Answers saved"); refreshDeck();
    }
  });
}

function refreshDeck() {
  if (!S) return;
  defsNow(); renderAnswerButtons(); updateCounts();
  const undoBtn = $("[data-act=undo]"); if (undoBtn) undoBtn.disabled = S.answers.size === 0;
  if (!currentCard()) $$("#answers .ans:not(.undo)").forEach((b) => (b.disabled = true));
}

async function exportSheet(rec) {
  const sh = openSheet(`<h3>Export answers</h3><p>Preparing…</p>`);
  let out;
  try { out = await buildExport(rec); } catch (e) { sh.el.innerHTML = `<h3>Export failed</h3><p>${esc(e.message)}</p>`; return; }
  sh.el.innerHTML = `<h3>Export answers</h3>
    <p><b>${out.count}</b> answered, <b>${out.unanswered}</b> still open. The zip has <span class="mono">answers.csv</span> and <span class="mono">answers.json</span> (with the full history), keyed by card id. Give it to your AI or open the CSV in a spreadsheet.</p>
    <div class="stack"><button class="btn" data-zip>Share or save the .zip</button><button class="btn quiet" data-copy>Copy for the AI (CSV text, no masks)</button><button class="btn quiet" data-csv>Only the CSV file</button></div>`;
  sh.el.onclick = async (e) => {
    if (e.target.closest("[data-zip]")) {
      const r = await shareOrDownload(out.zip, `${rec.key}.answers.zip`);
      if (r !== "cancelled") { toast(r === "shared" ? "Shared" : "Saved to downloads"); rec.exportedAt = new Date().toISOString(); saveRec(rec); }
    }
    if (e.target.closest("[data-copy]")) {
      if (out.csv.length > 400000) return toast("Too big to paste into a chat: share the .zip instead", 3500);
      const who = annotator();
      const text = `Answers from the app "Hooman in the Loop" for deck "${rec.key}" (${rec.title})${who ? `, annotated by ${who}` : ""}, exported ${new Date().toISOString().slice(0, 16).replace("T", " ")}.
Format: ${specURL()} section 6. One row per answered card${out.unanswered ? ` (${out.unanswered} cards are not answered yet)` : ""}. Masks are not included; the "mask" column names the files in the exported zip.

${out.csv}`;
      if (await copyText(text)) toast(`Copied ${out.count} answers. Paste them into your AI chat`, 3000);
    }
    if (e.target.closest("[data-csv]")) { const r = await shareOrDownload(new Blob([out.csv], { type: "text/csv" }), `${rec.key}.answers.csv`); if (r !== "cancelled") toast(r === "shared" ? "Shared" : "Saved to downloads"); }
  };
}

// ---------------------------------------------------------------- review screen
async function thumbURL(key, card) {
  const blob = await store.getFile(key, card.frames[0].path);
  if (!blob) return null;
  const params = displayFor(key, card)(0), head = new Uint8Array(await blob.slice(0, 26).arrayBuffer());
  const is16 = head[0] === 137 && head[24] === 16;
  if (!params && !is16) return URL.createObjectURL(blob);
  const src = await frameSource(key, card.frames[0].path), img = rendered(src, params);
  const k = Math.min(1, 320 / Math.max(card.w, card.h)), c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(card.w * k)); c.height = Math.max(1, Math.round(card.h * k));
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  const small = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.85));
  return URL.createObjectURL(small);
}
async function openResults(key) {
  const rec = themed(await store.getDeck(key));
  if (!rec) return go("#/");
  await renderResults(app, rec, { go, toast, copyText, openCard: (card) => go(`#/deck/${encodeURIComponent(key)}?card=${encodeURIComponent(card)}&from=review`) });
  cleanup.push(() => { app.onclick = null; });
}

async function openReview(key) {
  const rec = themed(await store.getDeck(key));
  if (!rec) return go("#/");
  const answers = new Map((await store.answersOf(key)).map((a) => [a.card, a]));
  const notes = new Set((await store.notesOf(key)).map((n) => n.card));
  const defs = answerDefs(rec);
  const color = new Map(), label = new Map();
  for (const d of defs.concat(rec.deck.answers)) { if (!color.has(d.value)) color.set(d.value, d.color); if (!label.has(d.value)) label.set(d.value, d.label); }
  const order = rec.order || rec.deck.cards.map((c) => c.id);
  const byId = new Map(rec.deck.cards.map((c) => [c.id, c]));
  const counts = new Map();
  for (const a of answers.values()) counts.set(a.answer, (counts.get(a.answer) || 0) + 1);
  let filter = prefs.get(`filter:${key}`, "all");
  const urls = [];
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      io.unobserve(en.target);
      const card = byId.get(en.target.dataset.card);
      thumbURL(key, card).then((u) => {
        if (!u) return;
        urls.push(u);
        const T = en.target.clientWidth, [x, y, w, h] = viewRect(card), k = Math.max(T / w, T / h);
        Object.assign(en.target.style, { backgroundImage: `url(${u})`, backgroundSize: `${card.w * k}px ${card.h * k}px`,
          backgroundPosition: `${T / 2 - (x + w / 2) * k}px ${T / 2 - (y + h / 2) * k}px` });
      }).catch(() => {});
    }
  }, { rootMargin: "300px" });
  cleanup.push(() => { io.disconnect(); urls.forEach((u) => URL.revokeObjectURL(u)); app.onclick = null; });

  const render = () => {
    const ids = order.filter((id) => byId.has(id) && (filter === "all" || (filter === "__open" ? !answers.has(id) : answers.get(id)?.answer === filter)));
    const chip = (v, text, n, c) => `<button class="chip ${filter === v ? "on" : ""}" data-f="${esc(v)}"${c ? ` style="color:${esc(c)}"` : ""}>${c ? "<i></i>" : ""}<span style="color:var(--text)">${esc(text)}</span> <span class="muted">${n}</span></button>`;
    const chips = [chip("all", "All", order.length), chip("__open", "Not answered", order.length - answers.size)]
      .concat([...counts].map(([v, n]) => chip(v, label.get(v) || v, n, color.get(v)))).join("");
    app.innerHTML = `<main class="screen">
      <div class="top"><button class="ghost" data-act="back">‹ Deck</button><h2>${esc(rec.title)}</h2><button class="ghost" data-act="results">Results</button><button class="ghost" data-act="export">Export</button></div>
      <div class="filters">${chips}</div>
      <div class="grid">${ids.map((id) => { const a = answers.get(id), c = a ? color.get(a.answer) || "var(--focus)" : null;
        return `<button class="thumb" data-card="${esc(id)}" style="${c ? `border-color:${esc(c)}` : ""}" aria-label="${esc(id)}"><span class="tag ${a ? "" : "none"}" style="${c ? `color:${esc(c)}` : ""}">${notes.has(id) ? "✎ " : ""}${a ? esc(a.label || label.get(a.answer) || a.answer) : "not answered"}</span></button>`; }).join("")}</div>
      ${ids.length ? "" : `<p class="muted" style="text-align:center;margin-top:30px">Nothing here.</p>`}
    </main>`;
    $$(".thumb").forEach((t) => io.observe(t));
  };
  render();
  app.onclick = (e) => {
    const t = e.target.closest("[data-act],[data-f],[data-card]");
    if (!t) return;
    if (t.dataset.f !== undefined) { filter = t.dataset.f; prefs.set(`filter:${key}`, filter); render(); return; }
    if (t.dataset.card !== undefined) return go(`#/deck/${encodeURIComponent(key)}?card=${encodeURIComponent(t.dataset.card)}&from=review`);
    if (t.dataset.act === "back") return go(`#/deck/${encodeURIComponent(key)}`);
    if (t.dataset.act === "export") return exportSheet(rec);
    if (t.dataset.act === "results") return go(`#/results/${encodeURIComponent(key)}`);
  };
}

// ---------------------------------------------------------------- start
async function start() {
  if ("serviceWorker" in navigator && location.protocol !== "file:") navigator.serviceWorker.register("sw.js").catch(() => {});
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && sheetOpen && sheetOpen.dismissable) closeSheet(); });
  const qs = new URLSearchParams(location.search);
  await route();
  if (qs.has("shared")) {                     // a zip shared to the installed app (see sw.js)
    history.replaceState(null, "", appURL() + location.hash);
    try {
      const c = await caches.open("hooman-inbox"), r = await c.match("inbox");
      if (r) { const blob = await r.blob(), name = decodeURIComponent(r.headers.get("x-name") || "shared.zip"); await c.delete("inbox"); importFile(new File([blob], name)); }
    } catch (e) { toast(`Could not read the shared file: ${e.message}`); }
  } else if (qs.has("deck")) {                // ?deck=<url>: a link or QR code from someone's AI
    const url = qs.get("deck");
    history.replaceState(null, "", appURL() + location.hash);
    const sh = openSheet(`<h3>Import a deck from a link?</h3><p class="mono" style="word-break:break-all">${esc(url)}</p>
      <div class="row"><button class="btn" data-yes>Import</button><button class="btn quiet" data-no>Cancel</button></div>`);
    sh.el.onclick = (e) => { if (e.target.closest("[data-no]")) sh.close(); if (e.target.closest("[data-yes]")) runImport((p) => importURL(url, p)); };
  }
}
start();
