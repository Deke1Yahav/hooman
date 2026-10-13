// Hooman in the Loop: screens, gestures and flows. No framework: one module, plain DOM.

import * as store from "./store.js";
import { importBlob, importURL, saveDeck, storedCard, loadInBackground } from "./importer.js";
import { CardCanvas, viewRect, frameSource, maskLayer, rendered, channelColors, channelsOf, framePaths } from "./view.js";
import { answerDefs, DIRS, slug } from "./deck.js";
import { buildExport, shareOrDownload, APP_VERSION } from "./export.js";
import { openEditor, editorOpen } from "./editor.js";
import { prefs } from "./prefs.js";
import { displayFor, openContrast, closeContrast, contrastName } from "./contrast.js";
import { annotator, setAnnotator, colorMode, setColorMode, themed, untone, lastBackup, markBackup, fileSafe } from "./settings.js";
import { openTapper, openFollow } from "./tapping.js";
import { zipKind, buildBackup, restoreBackup, restoreAnswers } from "./backup.js";
import { renderResults } from "./results.js";
import { buildDeckZip, qrSVG, deckLink } from "./share.js";
import { buildPhotoDeck } from "./photos.js";
import * as drive from "./drive.js";
import { readAnswers } from "./backup.js";
import { installState, promptInstall, markInstalled, watchInstall, isIOS, isAndroid } from "./install.js";
import * as live from "./livesave.js";
import * as dfolder from "./decksfolder.js";
import { loadingOf, onLoading, ensureCard, forgetLoading } from "./loading.js";

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

// Writes back what the screens change on a deck record (when it was opened, the last card, the answer buttons,
// the last export, the order) onto the stored record, read fresh: other parts of the app write it meanwhile
// (a big deck's background loading, live save, the team folder). Records may be colour-themed copies (settings.js).
async function saveRec(rec) {
  if (!rec) return;
  const raw = await store.getDeck(rec.key);
  if (!raw) return;
  for (const k of ["openedAt", "lastCard", "exportedAt", "order", "shelf"]) if (rec[k] !== undefined) raw[k] = rec[k];
  raw.custom = rec._raw && rec.custom && rec.custom.answers ? { ...rec.custom, answers: rec.custom.answers.map((a) => ({ ...a, color: untone(a.color) })) } : rec.custom;
  return store.putDeck(raw);
}
const modeOf = (deck) => deck.mode || (deck.question ? "swipe" : "annotate");

// ---------------------------------------------------------------- home
// A new hooman sees how to start: an example, a deck made with AI, a decks folder. Someone with decks sees their
// decks: the decks folder's status line, at most one banner, one list (what is in progress first), and "+ Add a deck"
// for every other way in. Nothing is out of reach: the rest is in the "+ Add a deck" and Help sheets.
const whenShort = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString() ? hhmm(iso) : d.toLocaleDateString([], { day: "numeric", month: "short" });
};
const zipTitle = (name) => name.split("/").pop().replace(/\.hooman\.zip$|\.zip$/i, "");
const sizeMB = (n) => `${n >= 1e7 ? Math.round(n / 1e6) : (n / 1e6).toFixed(1)} MB`;
function deckRow(d, done) {
  const n = d.deck.cards.length, pct = n ? (100 * done) / n : 0, lo = loadingOf(d.key);
  const zip = lo && !lo.active && dfolder.isOn() ? dfolder.zipOf(d.key) : "";
  const sub = lo ? (lo.active ? "Saving to the phone…" : `<b class="warn">Not fully on the phone · ${zip ? "tap to finish" : "pick its zip again"}</b>`)
    : n && done >= n ? `Done${d.openedAt ? ` · opened ${whenShort(d.openedAt)}` : ""}`
    : done ? `Opened ${whenShort(d.openedAt || d.updatedAt)}` : `New · ${n} card${n === 1 ? "" : "s"}`;
  return `<div class="deckitem"><button class="deckrow" ${zip ? `data-act="finishzip" data-zip="${esc(zip)}"` : `data-open="${esc(d.key)}"`}>
      <b>${esc(d.title)}</b><span class="count">${n && done >= n ? "✓ " : ""}${done} / ${n}</span>
      <div class="pbar"><i style="width:${pct}%"></i></div><span class="sub">${sub}</span></button>
      <button class="rowmenu" data-act="rowmenu" data-key="${esc(d.key)}" aria-label="More for ${esc(d.title)}">⋮</button></div>`;
}
const cloudRow = (a) => `<div class="deckitem"><button class="deckrow cloud" data-act="loadzip" data-zip="${esc(a.name)}">
      <b>${esc(zipTitle(a.name))}</b><span class="count">☁ ${sizeMB(a.size)}</span>
      <span class="sub">${a.update ? "A newer version is in your folder · tap to load" : "In your folder · tap to load"}</span></button>
      <button class="rowmenu" data-act="zipmenu" data-zip="${esc(a.name)}" aria-label="More for ${esc(zipTitle(a.name))}">⋮</button></div>`;

// The ⋮ on a deck row: open, archive or bring back, delete from this phone.
async function rowMenu(key) {
  const rec = await store.getDeck(key);
  if (!rec) return;
  const archived = isArchived(rec, (await store.answersOf(key)).length);
  const sh = openSheet(`<h3>${esc(rec.title)}</h3><p class="mono muted" style="font-size:12px;margin:-4px 0 0">${esc(key)}</p>
    <div class="menu">
      <button class="btn quiet" data-r="open">Open</button>
      <button class="btn quiet" data-r="shelf">${archived ? "Back to To do" : "Move to archive"}</button>
      <button class="btn danger" data-r="delete">Delete from this phone</button>
    </div>`);
  sh.el.onclick = async (e) => {
    const r = e.target.closest("[data-r]");
    if (!r) return;
    if (r.dataset.r === "open") { sh.close(); return go(`#/deck/${encodeURIComponent(key)}`); }
    if (r.dataset.r === "delete") return deleteSheet(rec);
    rec.shelf = archived ? "active" : "archive"; await saveRec(rec);
    sh.close(); toast(archived ? "Back in To do" : "Moved to the Archive"); home();
  };
}
// The ⋮ on a "tap to load" row: load it, or hide it from the list.
function zipMenu(name) {
  const sh = openSheet(`<h3>${esc(zipTitle(name))}</h3><p class="mono muted" style="font-size:12px;margin:-4px 0 0">${esc(name)} · in your decks folder</p>
    <div class="menu">
      <button class="btn quiet" data-z="load">Load now</button>
      <button class="btn quiet" data-z="hide">Hide from this list<small>it comes back if the zip changes</small></button>
    </div>`);
  sh.el.onclick = (e) => {
    const z = e.target.closest("[data-z]");
    if (!z) return;
    sh.close();
    if (z.dataset.z === "load") return loadZip(name);
    dfolder.hide(name); toast("Hidden from the list"); home();
  };
}

function folderLine() {
  if (!dfolder.isOn()) return "";
  const s = dfolder.status(), name = dfolder.folderName();
  if (s.status === "checking") return `<div class="folder-line busy"><span>📂 ${esc(s.msg || `Checking “${name}”…`)}</span><button class="btn quiet" data-act="stopcheck">Stop</button></div>`;
  if (s.status === "paused") return `<button class="folder-line warn" data-act="checkdecks"><span>📂 “${esc(name)}” needs a tap to be read again</span><b>Reconnect</b></button>`;
  const n = s.found, errs = s.errors.length;
  return `<button class="folder-line" data-act="checkdecks" aria-label="Check the decks folder now"><span>📂 ${esc(name)}${s.at ? ` · ${n} deck${n === 1 ? "" : "s"} · checked ${hhmm(s.at)}` : " · tap to check"}</span><b aria-hidden="true">↻</b></button>
    ${errs ? `<button class="link-btn folder-errs" data-act="folderrors">${errs} zip${errs > 1 ? "s" : ""} in the folder couldn't be opened: see why</button>` : ""}`;
}

async function home() {
  const decks = await store.listDecks();
  const all = await Promise.all(decks.map((d) => store.answersOf(d.key)));
  const counts = new Map(decks.map((d, i) => [d.key, all[i].length]));
  const since = lastBackup();
  const unsaved = all.flatMap((list, i) => list.filter((a) => a.at > since && a.at > (decks[i].exportedAt || "") && a.at > live.lastSaved(decks[i].key)));
  const oldest = unsaved.reduce((m, a) => (a.at < m ? a.at : m), "9999");
  const stale = unsaved.length && (unsaved.length >= 20 || Date.now() - Date.parse(oldest) > 2 * 864e5);
  const folderOn = dfolder.isOn(), avail = folderOn ? dfolder.status().available : [];
  // Finished decks (every card answered) go to the Archive tab, unless the hooman moved them (deck menu: rec.shelf).
  const archivedOf = (d) => d.shelf === "archive" || (d.shelf !== "active" && d.deck.cards.length > 0 && counts.get(d.key) >= d.deck.cards.length);
  const active = decks.filter((d) => !archivedOf(d)), archived = decks.filter(archivedOf);
  const nArch = archived.length, nTodo = active.length + avail.length;
  const tab = nArch && prefs.get("homeTab", "decks") === "archive" ? "archive" : "decks";
  const newcomer = !decks.length && !avail.length && !folderOn;
  const opened = (x, y) => (y.openedAt || y.updatedAt || "").localeCompare(x.openedAt || x.updatedAt || "");
  const arrived = (x, y) => (y.importedAt || y.updatedAt || "").localeCompare(x.importedAt || x.updatedAt || "");
  const going = active.filter((d) => counts.get(d.key) > 0).sort(opened), fresh = active.filter((d) => !counts.get(d.key)).sort(arrived);
  const row = (d) => deckRow(d, counts.get(d.key));
  const list = tab === "archive" ? archived.sort(opened).map(row).join("")
    : (going.length && fresh.length + avail.length ? `<div class="list-div">Continue</div>` : "") + going.map(row).join("")
      + (going.length && fresh.length + avail.length ? `<div class="list-div">New</div>` : "") + fresh.map(row).join("") + avail.map(cloudRow).join("");
  const gear = `<button class="icon-btn" data-act="settings" aria-label="Settings and backup" style="margin-left:auto">⚙</button>`;
  const banner = stale ? `<div class="banner"><span>⚠ ${unsaved.length} answer${unsaved.length > 1 ? "s are" : " is"} only on this phone.</span><button class="btn quiet" data-act="backup">Back up</button></div>`
    : `<div id="install-slot">${installBanner()}</div>`;
  app.innerHTML = `<main class="screen home">
    ${newcomer ? `<div class="hero"><img src="icons/icon-192.png" alt=""><div><h1>Hooman in the Loop</h1><p>The AI guesses. The hooman decides.</p></div>${gear}</div>`
      : `<div class="hero compact"><img src="icons/icon-192.png" alt=""><h1>Hooman in the Loop</h1>${gear}</div>`}
    ${banner}
    <div id="folder-line">${folderLine()}</div>
    ${newcomer ? `<div class="empty"><b>No decks yet.</b> A deck is a zip of images plus a small <span class="mono">deck.json</span> that says what to ask.</div>
    <div class="start">
      <button class="btn" data-act="examples">🎯 Try an example</button>
      <button class="btn quiet" data-act="ai">✨ Make a deck with AI</button>
      ${dfolder.supported() ? `<button class="btn quiet two" data-act="connect">📂 Connect a decks folder<small>Put deck zips in a folder (Google Drive works): they show up here by themselves.</small></button>` : ""}
      <button class="link-btn" data-act="add">More ways to add a deck</button>
      <button class="link-btn" data-videos>▶ Watch the ${GUIDE_VIDEOS[0].min} video guide</button>
    </div>` : `
    ${nArch ? `<div class="tabs-row"><span class="seg tabs"><button data-act="tab" data-tab="decks" aria-pressed="${tab === "decks"}">To do (${nTodo})</button><button data-act="tab" data-tab="archive" aria-pressed="${tab === "archive"}">Archive (${nArch})</button></span></div>`
      : `<div class="section-title">To do${nTodo ? ` (${nTodo})` : ""}</div>`}
    ${list ? `<div class="decks">${list}</div>` : `<div class="empty">${tab === "decks" ? `<b>All done.</b> Finished decks are in the Archive.${folderOn ? ` New zips put in “${esc(dfolder.folderName())}” show up here.` : ""}` : "Nothing archived."}</div>`}
    ${tab === "decks" ? `<button class="btn quiet add-deck" data-act="add">+ Add a deck</button>` : ""}`}
    <p class="foot-note">Stays on this device · <button class="link-btn" data-act="help">Help</button> · v${APP_VERSION}</p>
  </main>
  <input type="file" id="file" accept=".zip,.json,application/zip,application/x-zip-compressed,application/json,application/octet-stream" hidden>`;
  const file = $("#file");
  file.addEventListener("change", () => { const f = file.files[0]; file.value = ""; if (f) importFile(f); });
  drive.warmUp();
  app.onclick = (e) => {
    const b = e.target.closest("[data-act],[data-open]");
    if (!b) return;
    if (b.dataset.open) return go(`#/deck/${encodeURIComponent(b.dataset.open)}`);
    if (b.dataset.act === "tab") { prefs.set("homeTab", b.dataset.tab); return home(); }
    ({ import: () => file.click(), link: linkSheet, ai: aiSheet, examples: examplesSheet, settings: settingsSheet, backup: () => backupNow(false),
       photos: photosSheet, drive: openFromDrive, install: installFlow, installno: () => { prefs.set("installNo", true); home(); },
       repick: pickZipAgain, checkdecks: decksCheckNow, stopcheck: () => dfolder.stop(), folderrors: () => decksAction("errors"),
       loadzip: () => loadZip(b.dataset.zip), finishzip: () => loadZip(b.dataset.zip, true), connect: () => decksAction("on"),
       add: addSheet, help: appHelp, rowmenu: () => rowMenu(b.dataset.key), zipmenu: () => zipMenu(b.dataset.zip) })[b.dataset.act]();
  };
}

// Every way to add a deck, behind "+ Add a deck" (the same actions as the newcomer's buttons).
function addSheet() {
  const folder = dfolder.isOn() ? dfolder.folderName() : "";
  const sh = openSheet(`<h3>Add a deck</h3>
    ${folder ? `<p>Or put a <span class="mono">.hooman.zip</span> in “${esc(folder)}”: it shows up here by itself.</p>` : ""}
    <div class="menu add-menu">
      <button class="btn quiet" data-act="import">＋ Import a zip from this phone</button>
      <button class="btn quiet" data-act="link">🔗 From a link</button>
      <button class="btn quiet" data-act="ai">✨ Make a deck with AI<small>copies a prompt for ChatGPT, Claude or Gemini</small></button>
      <button class="btn quiet" data-act="photos">📷 New deck from photos</button>
      <button class="btn quiet" data-act="examples">🎯 Try an example</button>
      ${drive.googleReady() ? `<button class="btn quiet" data-act="drive">Open from Google Drive</button>` : ""}
      ${!folder && dfolder.supported() ? `<button class="btn quiet" data-act="connect">📂 Connect a decks folder<small>deck zips put in it show up here by themselves</small></button>` : ""}
    </div>
    <p style="font-size:13px;margin-top:14px"><a href="llms.txt" target="_blank" style="color:var(--focus)">Deck format (for your AI)</a></p>`);
  sh.el.onclick = (e) => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const act = b.dataset.act;
    if (act === "import") { sh.close(); const f = $("#file"); return f && f.click(); }
    ({ link: linkSheet, ai: aiSheet, photos: photosSheet, examples: examplesSheet, drive: openFromDrive, connect: () => { sh.close(); decksAction("on"); } })[act]();
  };
}

// Help: the guides, the deck format, installing, the source.
function appHelp() {
  const canInstall = ["prompt", "steps", "installed"].includes(installState());
  const sh = openSheet(`<h3>Help</h3>
    <div class="menu">
      <button class="btn quiet" data-videos>▶ Video guide (YouTube)</button>
      <button class="btn quiet" data-guide>☁ Google Drive, OneDrive, Dropbox: how to</button>
      <a class="btn quiet" href="llms.txt" target="_blank">Deck format (for your AI)</a>
      ${canInstall ? `<button class="btn quiet" data-act="install">📲 Install the app</button>` : ""}
      <a class="btn quiet" href="https://github.com/Deke1Yahav/hooman" target="_blank" rel="noopener">Free and open source (MIT)</a>
    </div>
    <p class="muted" style="font-size:12px;margin-top:14px">Everything stays on this device: no account, no server. Version ${APP_VERSION}.</p>`);
  sh.el.addEventListener("click", (e) => { if (e.target.closest("[data-act=install]")) installFlow(); });
}

// ---------------------------------------------------------------- install the app (shown only until it is installed)
function installBanner() {
  const s = installState();
  if ((s !== "prompt" && s !== "steps") || prefs.get("installNo", false)) return "";
  const text = isIOS() ? "<b>Add Hooman to your Home Screen.</b> It works offline, and Safari can't clear your answers after 7 days unused."
    : isAndroid() ? "<b>Install Hooman on this phone.</b> It opens from your home screen, full screen, and works offline."
    : "<b>Install Hooman on this computer.</b> It opens in its own window and works offline.";
  return `<div class="banner install"><span>📲 ${text}</span><button class="btn" data-act="install">${s === "prompt" ? "Install" : "Show me"}</button><button class="x" data-act="installno" aria-label="Not now (Help keeps Install the app)">✕</button></div>`;
}
function refreshInstall(event) {
  const slot = $("#install-slot");
  if (slot) slot.innerHTML = installBanner();
  if (event === "installed") toast("Installed. Open Hooman from your home screen.", 3500);
}
async function installFlow() {
  if (installState() !== "prompt") return installSteps();
  const r = await promptInstall();
  if (r === "dismissed") toast("Not now. The button stays here if you change your mind.");
}
function installSteps() {
  const sh = openSheet(`${isIOS() ? `<h3>📲 Add to Home Screen</h3>
    <ol class="steps">
      <li>Tap <b>Share</b>: the square with an arrow ↑, at the bottom of Safari (top right on iPad).</li>
      <li>Scroll down and tap <b>Add to Home Screen</b>.</li>
      <li>Tap <b>Add</b>, then open Hooman from its new icon.</li></ol>
    <p>In Chrome on iPhone, the Share button ↑ has <b>Add to Home Screen</b> too.</p>
    <p class="muted" style="font-size:13px">The Home Screen app keeps its own decks and answers. Answered cards here? Back them up first (⚙ → Back up answers), then restore the backup in the app.</p>`
    : `<h3>📲 Install the app</h3>
    <ol class="steps">
      <li>Open the browser menu: <b>⋮</b> at the top right in Chrome, <b>≡</b> at the bottom in Samsung Internet.</li>
      <li>Tap <b>Install app</b> or <b>Add to Home screen</b>.</li>
      <li>Open Hooman from its new icon. Your decks and answers come with it.</li></ol>
    <p class="muted" style="font-size:13px">Not in the menu? Open <span class="mono">${esc(appURL())}</span> in Chrome.</p>`}
    <div class="row"><button class="btn" data-done>I've installed it</button><button class="btn quiet" data-close>Close</button></div>`);
  sh.el.onclick = (e) => {
    if (e.target.closest("[data-close]")) sh.close();
    if (e.target.closest("[data-done]")) { markInstalled(); sh.close(); toast("Great. The install button won't show here again."); }
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
  if (images) {
    const still = (await store.listDecks()).find((d) => loadingOf(d.key));
    if (still) return toast(`“${still.title}” is still being saved on the phone. Back up with images when it's done (answers only works now).`, 4000);
  }
  const sh = openSheet(`<h3>Making the backup…</h3><p>${images ? "Answers, notes, masks and every deck's images." : "Answers, notes, drawn masks and history."}</p>`, { dismissable: false });
  try {
    const b = await buildBackup({ images });
    sh.close();
    const r = await shareOrDownload(b.zip, `hooman-backup-${new Date().toISOString().slice(0, 10)}${images ? "-full" : ""}.zip`);
    if (r !== "cancelled") { markBackup(); toast(`Backed up ${b.answers} answers from ${b.decks} deck${b.decks === 1 ? "" : "s"}`); if (parseHash().page === "home") home(); }
  } catch (e) { sh.close(); showErrors([`Backup failed: ${e.message}`], []); }
}

// ---------------------------------------------------------------- big decks that are still loading (loading.js)
function loadNote(key) {
  const lo = loadingOf(key);
  return !lo ? "" : lo.active ? "saving to the phone…" : "needs its zip again";
}
function pickZipAgain() {
  const inp = document.createElement("input");
  inp.type = "file"; inp.accept = ".zip,application/zip,application/x-zip-compressed,application/octet-stream";
  inp.onchange = () => { const f = inp.files[0]; if (f) importFile(f); };
  inp.click();
}
// The card on screen can't be shown yet: still loading (wait), broken, or not on the phone (pick the zip again).
function showUnloaded(card, why) {
  const stage = $("#stage");
  if (!stage) return;
  stage.innerHTML = `<div class="card-note">${why === "broken"
    ? `<b>This card can't be shown.</b><p>${esc(card.broken || "")}</p><div class="row"><button class="btn" data-act="skip">Skip it</button></div>`
    : dfolder.isOn() && dfolder.zipOf(S.key)
    ? `<b>This card isn't on the phone yet.</b><p>The app closed before this deck was saved on the phone. It finishes from your decks folder; your answers stay.</p>
       <div class="row"><button class="btn" data-act="finishzip" data-zip="${esc(dfolder.zipOf(S.key))}">Finish now</button><button class="btn quiet" data-act="skip">Skip</button></div>`
    : `<b>This card isn't on the phone yet.</b><p>The app closed before this deck was saved on the phone. Pick the deck's zip again to finish; your answers stay.</p>
       <div class="row"><button class="btn" data-act="repick">Pick the zip again</button><button class="btn quiet" data-act="skip">Skip</button></div>`}</div>`;
}

// ---------------------------------------------------------------- decks folder (decksfolder.js)
function decksRow() {
  const s = dfolder.status(), on = dfolder.isOn(), name = dfolder.folderName();
  const computer = !(isIOS() || isAndroid());
  if (!on) return `<div class="live-row"><div><b>📂 Decks folder</b><span>Off. Pick a folder once: every deck zip you put in it shows up here by itself${computer ? ". A Google Drive, OneDrive or Dropbox folder on this computer works too" : ""}.</span></div><button class="btn" data-decks="on">Choose a folder</button></div>`;
  const line = s.status === "paused" ? `Paused. ${s.msg || "Tap Reconnect."}` : s.status === "checking" ? (s.msg || "Checking…")
    : `Folder “${name}”${s.at ? ` · ${s.found} deck zip${s.found === 1 ? "" : "s"} · checked ${hhmm(s.at)}` : ""}${s.timing ? ` · took ${secs(s.timing.total)} (folders ${secs(s.timing.list)} · file info ${secs(s.timing.info)} · reading ${secs(s.timing.reading)})` : ""}`;
  const resultsHere = live.status().folder.status !== "off" && live.folderName() === "results";
  return `<div class="live-row"><div><b>📂 Decks folder</b><span>${esc(line)}${s.note ? `<br>${esc(s.note)}` : ""}</span></div>
      ${s.status === "paused" ? `<button class="btn" data-decks="reconnect">Reconnect</button>` : `<button class="btn quiet" data-decks="check">Check now</button>`}<button class="btn quiet" data-decks="off">Turn off</button></div>
    ${s.errors.length ? `<p style="font-size:13px;margin:6px 0 0"><button class="link-btn" data-decks="errors" style="color:var(--yellow)">${s.errors.length} zip${s.errors.length > 1 ? "s" : ""} in the folder couldn't be opened: see why</button></p>` : ""}
    ${live.canFolder() ? `<p class="muted" style="font-size:13px;margin:6px 0 0">${resultsHere ? `Your answers are saved into “results” in this folder (live save).` : `<button class="link-btn" data-decks="results">Save my answers into this folder too</button> (a “results” folder inside it, a few seconds after each answer, with a summary table your AI can read)`}</p>` : ""}`;
}
async function decksAction(what) {
  try {
    if (what === "on") { await dfolder.choose(); decksNothingNew(); }
    else if (what === "off") { await dfolder.turnOff(); toast("The decks folder is off"); }
    else if (what === "reconnect") {
      if ((await dfolder.reconnect()) === "denied") toast("The phone didn't give access to the folder. Settings → Decks folder → Turn off, then Choose a folder.", 6000);
      else live.regain();                         // live save in the folder's "results" comes back with it
    }
    else if (what === "stop") dfolder.stop();
    else if (what === "check") { await dfolder.check({ force: true, openKey: S && S.key }); decksNothingNew(); }
    else if (what === "errors") {
      const e = dfolder.status().errors;
      return showErrors(e.flatMap((x) => x.errors.map((m) => `${x.name}: ${m}`)), []);
    }
    else if (what === "results") { await live.useFolder(await dfolder.resultsFolder()); toast("Your answers now go into “results” in the decks folder"); }
  } catch (err) {
    if (err && err.name === "AbortError") toast("No folder was chosen");
    else showErrors([`The decks folder: ${(err && err.message) || String(err)}`], []);
  }
}
function decksNothingNew() {
  const s = dfolder.status(), n = s.errors.length;
  if (s.status !== "ok" || s.added.length || s.updated.length) return;
  const wait = s.available.length;
  const why = !s.found ? `no deck zips (*.hooman.zip) there${s.skipped ? `; ${s.skipped} answers file${s.skipped > 1 ? "s are" : " is"} results, not decks` : ""}`
    : wait ? `${wait} deck${wait > 1 ? "s wait" : " waits"} for a tap on the home screen (big zips load when you open them)` : "nothing new";
  toast(`“${dfolder.folderName()}”: ${why}${n ? ` (${n} zip${n > 1 ? "s" : ""} couldn't be opened: see Settings)` : ""}`, 5000);
}
const secs = (ms) => `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`;
// "Tap to load" a deck waiting in the decks folder (or finish one that wasn't fully saved), then open it.
async function loadZip(name, finish = false) {
  const key = await dfolder.load(name, S ? S.key : null);
  if (!key) { const e = dfolder.status().errors; if (e.length) showErrors(e.flatMap((x) => x.errors.map((m) => `${x.name}: ${m}`)), []); return; }
  if (finish) { toast("Saving the rest of the deck on the phone…", 3000); if (S && S.key === key) return showCard(); }
  go(`#/deck/${encodeURIComponent(key)}`);
}
function decksCheckNow() { return decksAction(dfolder.status().status === "paused" ? "reconnect" : "check"); }

// ---------------------------------------------------------------- live save (Settings rows, deck header mark)
const hhmm = (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
function liveLine(t) {
  const s = live.status()[t];
  if (s.status === "off") return t === "drive" ? "Off. Saves to a “Hooman in the Loop” folder in your Drive, or to the deck's team folder."
    : `Off. Pick a folder once${isIOS() || isAndroid() ? "" : ": a OneDrive, Dropbox or Google Drive folder on this computer works too"}.`;
  const word = s.status === "paused" && s.msg ? `Paused. ${s.msg}` : s.status === "error" ? `Couldn't save: ${s.msg || "unknown error"}. Retrying every minute.`
    : { ok: s.at ? `On · saved ${hhmm(s.at)}` : "On", saving: "Saving…", paused: "Paused: tap Reconnect", offline: "Offline: saves when back online" }[s.status];
  return t === "folder" && live.folderName() ? `${word} · folder “${live.folderName()}”` : word;
}
function liveRow(t, label) {
  const s = live.status()[t].status;
  const btns = s === "off" ? `<button class="btn" data-live="on" data-lt="${t}">${t === "folder" ? "Choose a folder" : "Turn on"}</button>`
    : `${s === "paused" ? `<button class="btn" data-live="reconnect" data-lt="${t}">Reconnect</button>` : ""}<button class="btn quiet" data-live="off" data-lt="${t}">Turn off</button>`;
  return `<div class="live-row" data-row="${t}"><div><b>${label}</b><span>${esc(liveLine(t))}</span></div>${btns}</div>`;
}
function liveRows() {
  const rows = [live.canDrive() ? liveRow("drive", "☁ Google Drive") : "", live.canFolder() ? liveRow("folder", "📁 A folder on this device") : ""].join("");
  return rows || `<p class="muted" style="font-size:13px">This browser can't keep a live copy in a folder${isIOS() ? " (iPhone and iPad browsers can't)" : ""}. Your answers are safe on this device; for a copy elsewhere, use Back up below. <button class="link-btn" data-guide>Drive guide</button></p>`;
}
async function liveAction(what, t) {
  try {
    if (what === "on") { await live.enable(t); toast(t === "drive" ? "Live save to Google Drive is on" : `Live save to “${live.folderName()}” is on`); }
    else if (what === "off") { await live.disable(t); toast("Live save is off"); }
    else await live.reconnect(t);
  } catch (err) { if (err && err.name !== "AbortError") showErrors([err.message || String(err)], []); }
}
function liveMark() {
  const el = $("#live-mark");
  if (!el) return;
  const s = live.status(), on = ["drive", "folder"].filter((t) => s[t].status !== "off");
  el.hidden = !on.length;
  if (!on.length) return;
  const worst = ["paused", "error", "offline", "saving", "ok"].find((x) => on.some((t) => s[t].status === x));
  el.dataset.s = worst;
  el.textContent = { ok: "☁✓", saving: "☁…", paused: "☁!", error: "☁!", offline: "☁…" }[worst];
  el.setAttribute("aria-label", `Live save: ${worst === "paused" ? "paused, tap to reconnect" : worst}`);
}
function liveTap() {
  const p = live.paused();
  if (p.includes("folder") && dfolder.isOn() && live.folderName() === "results") return decksAction("reconnect");   // one tap, both folders
  if (p.length) return liveAction("reconnect", p[0]);
  const s = live.status();
  toast(["drive", "folder"].filter((t) => s[t].status !== "off")
    .map((t) => `${t === "drive" ? "Google Drive" : `Folder “${live.folderName()}”`}: ${liveLine(t).replace(/^On · /, "").replace(/ · folder “.*”$/, "")}`).join(" · "), 3500);
}

async function settingsSheet() {
  let est = "", kept = false, offLive = () => {};
  try { const e = await navigator.storage.estimate(); est = ` · ${Math.round(e.usage / 1e6)} MB used`; } catch {}
  try { kept = await navigator.storage.persisted(); } catch {}
  const lb = lastBackup();
  const sh = openSheet(`<h3>Settings & backup</h3>
    <label class="field">Your name <span class="muted">(goes into exports, to compare annotators)</span><input type="text" id="set-name" value="${esc(annotator())}" placeholder="e.g. Dekel" maxlength="60" autocomplete="name"></label>
    <div class="field">Colours <span class="seg"><button data-col="standard" aria-pressed="${colorMode() !== "cb"}">Standard</button><button data-col="cb" aria-pressed="${colorMode() === "cb"}">Colour-blind safe</button></span></div>
    ${dfolder.supported() ? `<div class="section-title">Decks folder</div><div id="decks-row">${decksRow()}</div>` : ""}
    <div class="section-title">Live save</div>
    <p>Every answer is stored on this device the moment you give it. Live save also keeps a copy elsewhere, a few seconds later: one answers file per deck, like Export.</p>
    <div id="live-rows">${liveRows()}</div>
    <div class="section-title">Backup</div>
    <p>${live.anyOn() ? "A backup is one file for every deck at once." : "Without live save, answers live only on this device."} A backup holds every deck's answers, notes, drawn masks and history. Import it on any device to continue there; newer answers win.</p>
    <p class="mono" style="font-size:12px">last backup: ${lb ? esc(lb.slice(0, 16).replace("T", " ")) : "never"}${est}${kept ? " · storage kept" : " · the browser may clear storage"}</p>
    <div class="stack"><button class="btn" data-b="answers">Back up answers (small)</button>
      <button class="btn quiet" data-b="all">Back up everything, with images</button>
      <button class="btn quiet" data-b="restore">Restore a backup…</button></div>
    <p class="muted" style="font-size:12px">Restore also takes a deck's exported <span class="mono">.answers.zip</span>, to continue someone's work or merge two devices.</p>
    <div class="stack">${["prompt", "steps", "installed"].includes(installState()) ? `<button class="btn quiet" data-b="install">📲 Install the app</button>` : ""}
      <button class="btn quiet" data-videos>▶ Video guide (YouTube)</button>
      <button class="btn quiet" data-guide>☁ Google Drive, OneDrive, Dropbox: how to</button>
      <button class="btn quiet" data-b="tour">Show the tour again</button></div>
    <input type="file" id="restore-file" accept=".zip,application/zip,application/x-zip-compressed,application/octet-stream" hidden>`, { onClose: () => offLive() });
  const offLive1 = live.onStatus(() => { const box = $("#live-rows", sh.el); if (box) box.innerHTML = liveRows(); const dr = $("#decks-row", sh.el); if (dr) dr.innerHTML = decksRow(); });
  const offDecks = dfolder.onStatus(() => { const dr = $("#decks-row", sh.el); if (dr) dr.innerHTML = decksRow(); });
  offLive = () => { offLive1(); offDecks(); };
  const nameIn = $("#set-name", sh.el);
  nameIn.addEventListener("change", () => { setAnnotator(nameIn.value); toast(nameIn.value.trim() ? `Hi ${nameIn.value.trim()}` : "Name cleared"); });
  const rf = $("#restore-file", sh.el);
  rf.addEventListener("change", () => { const f = rf.files[0]; rf.value = ""; if (f) importFile(f); });
  sh.el.onclick = (e) => {
    const lv = e.target.closest("[data-live]");
    if (lv) return liveAction(lv.dataset.live, lv.dataset.lt);
    const dk = e.target.closest("[data-decks]");
    if (dk) return decksAction(dk.dataset.decks);
    const t = e.target.closest("[data-col],[data-b]");
    if (!t) return;
    if (t.dataset.col) { setColorMode(t.dataset.col); $$("[data-col]", sh.el).forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.col === colorMode()))); toast(colorMode() === "cb" ? "Colour-blind safe colours on" : "Standard colours"); return; }
    if (t.dataset.b === "answers" || t.dataset.b === "all") { setAnnotator(nameIn.value); return backupNow(t.dataset.b === "all"); }
    if (t.dataset.b === "restore") return rf.click();
    if (t.dataset.b === "install") return installFlow();
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
  if (imported.lazy && loadingOf(existing.key)) {             // the zip of a deck that was still loading: finish it
    loadInBackground(existing, imported.lazy);
    sh.close(); toast("Saving the rest of the deck on the phone. You can work meanwhile.", 3500);
    if (S && S.key === existing.key) showCard(); else if (!S && parseHash().page === "home") home();
    return;
  }
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
    ${rec.loadingLeft ? `<p><b style="color:var(--text)">Start now:</b> the first card${rec.deck.cards.length - rec.loadingLeft > 1 ? "s are" : " is"} ready. The whole zip is being saved on the phone in the background, and every card opens as you reach it. Keep the app open until the deck list says it's saved.</p>` : ""}
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
    <div class="row"><button class="btn" data-copy>Copy prompt</button><a class="btn quiet" href="llms.txt" target="_blank" style="text-decoration:none">Read the format</a></div>
    <p style="font-size:13px">Using Claude? Add the <a href="skill/hooman-deck-builder.zip" download style="color:var(--focus)">Hooman deck-builder skill</a> (claude.ai: Settings → Capabilities → Skills → Upload). It builds, checks and reads decks with tested scripts.</p>`);
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
        hidden: new Set(prefs.get(`hidden:${key}`, [])), revisit: params.get("from") === "review",
        ...channelStart(key, rec.deck) };
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

// The channel view a deck opens in: the hooman's last choice, else the deck's "channel_view", else channel 1.
function channelStart(key, deck) {
  const saved = prefs.get(`chview:${key}`, null), dv = deck.channelView, n = channelsOf(deck).length;
  if (saved && (saved.cview !== "one" || saved.chan < n)) return { cview: saved.cview, chan: Math.min(saved.chan || 0, n - 1) };
  return dv === "mix" || dv === "side" ? { cview: dv, chan: 0 } : { cview: "one", chan: typeof dv === "number" ? dv : 0 };
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
      <button class="loadmark" id="loadmark" data-act="loadinfo" hidden></button>
      <button class="live-mark" id="live-mark" data-act="live" hidden></button>
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
  liveMark();
  cleanup.push(live.onStatus(liveMark));
  const loadMark = () => { const el = $("#loadmark"), t = S && loadNote(S.key); if (el) { el.hidden = !t; el.textContent = t ? `⤓ ${t}` : ""; } };
  loadMark();
  cleanup.push(onLoading((key) => { if (S && key === S.key) loadMark(); }));
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
  const total = S.dirDefs.size + S.buttonDefs.length, compact = total > 6 || !!S.forceCompact;
  el.classList.toggle("compact", compact);
  $(".deckscreen").classList.toggle("compact", compact);
  if (compact) {
    const dirs = [L, R, U, D].filter(Boolean), nb = S.buttonDefs.length;
    h += dirs.map((d) => btn(d, "", 12 / dirs.length)).join("");
    const per = nb <= 4 ? nb : nb <= 6 ? 3 : 4;
    h += S.buttonDefs.map((d) => btn(d, "", 12 / Math.max(1, per))).join("");
    h += `<button class="ans undo" data-act="undo" style="grid-column:span 12"><span class="lbl">Undo</span></button>`;
    el.innerHTML = h;
    $("#hint").textContent = "";
    return;
  }
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
  const stage = $("#stage"), main = $(".deckscreen");
  main.classList.remove("scroll"); stage.style.minHeight = "";
  const sw = stage.clientWidth, sh = stage.clientHeight;
  const foot = $(".cardfoot", S.cardEl), two = !!card.info && (sw < 400 || card.info.length > 28);
  foot.classList.toggle("two", two);                 // a long caption gets its own line
  const extra = (two ? 58 : 26) + (card.frames.length > 1 ? 36 : 0) + (nch(card) > 1 ? 36 : 0) + 2;
  const r = viewRect(card), grid = S.cview === "side" && nch(card) > 1, aspect = r[2] / r[3];
  let h = Math.max(60, sh - extra), w = grid ? sw - 2 : h * aspect;
  if (w > sw - 2) { w = sw - 2; h = w / aspect; }
  if (!grid && w < 0.8 * sw && !S.forceCompact && modeOf(S.rec.deck) === "swipe" && !$("#answers").classList.contains("compact")) {
    S.forceCompact = true; renderAnswerButtons(); return layoutCard();   // first make room with compact buttons
  }
  const minW = Math.min(sw - 2, Math.round(0.75 * sw));
  if (!grid && w < minW) {                           // still too narrow: keep the width, let the page scroll a little
    w = minW; h = w / aspect;
    main.classList.add("scroll"); stage.style.minHeight = `${Math.ceil(h + extra + 4)}px`;
  }
  w = Math.floor(w); h = Math.floor(h);
  S.cardEl.style.width = `${w + 2}px`;
  const cv = $("canvas", S.cardEl);
  cv.style.width = `${w}px`; cv.style.height = `${h}px`;
  if (S.view && S.view.loaded) S.view.resize(viewRect(card));
  fitFrameLabels(S.cardEl);
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
  // 0.7 marked cards whose files couldn't be read as broken for good; only a failed check (its message starts
  // with "cards[") is. The others are checked again: shown if their files are here, else finished from the zip.
  if (card.broken && !/^cards\[/.test(card.broken)) delete card.broken;
  if (!card.w || card.broken) {                 // a big deck still loading: this card first
    if (!card.broken) {
      stage.innerHTML = `<div class="card-note"><b>Loading this card…</b></div>`;
      const r = await ensureCard(S.key, card, (c) => storedCard(S.key, c));
      if (!S || currentCard() !== card) return;   // the hooman moved on meanwhile
      if (r === "missing") return showUnloaded(card, "missing");
    }
    if (card.broken) return showUnloaded(card, "broken");
  }
  S.frame = 0;
  S.rec.lastCard = card.id;
  const el = document.createElement("div");
  el.className = "card enter";
  el.innerHTML = `<canvas></canvas><div class="stamp"></div><span class="zoomhint">tap = zoom</span>
    ${nch(card) > 1 ? `<div class="frames chanbar">${chanBar(card, "chan")}</div>` : ""}
    ${card.frames.length > 1 ? `<div class="frames">${framesBar(card, "frame")}</div>` : ""}
    <div class="cardfoot"><span class="caption" data-act="caption" title="${esc(card.info || "")}">${esc(card.info || "")}</span><button class="note-btn ${S.notes.has(card.id) ? "has" : ""}" data-act="note" aria-label="Note on this card">✎ note</button><span>${esc(card.id)}</span></div>`;
  stage.replaceChildren(el);
  S.cardEl = el;
  attachSwipe(el);
  layoutCard();
  S.view = new CardCanvas($("canvas", el));
  S.view.display = displayFor(S.key, card, S.rec.deck);
  try { await S.view.show(S.rec, card, { hidden: S.hidden, cview: S.cview, chan: S.chan }); }
  catch (e) { console.error(e); toast(`Could not show this card: ${e.message}`, 4000); }
  if (!S || currentCard() !== card) return;     // left the deck (or moved on) while the card was drawn
  S.shownAt = performance.now();
  prefetch();
  const mode = modeOf(deck);
  if (mode === "annotate" && S.autoEdit) annotateCard();
  if (mode === "follow" && S.autoEdit) followCard();
}

// While the hooman looks at a card, the next ones are prepared in the background: sized and checked (big decks),
// their first time point decoded and its masks outlined, so a swipe shows a card that is ready.
const AHEAD = 3;
function prefetch() {
  if (!S) return;
  const key = S.key, colors = Object.fromEntries(S.rec.deck.sources.map((s) => [s.name, s.color]));
  const warm = (c) => {
    framePaths(c, 0).forEach((p) => frameSource(key, p).catch(() => {}));
    c.overlays.filter((o) => o.shape === "mask" && (o.frame === undefined || o.frame === 0))
      .forEach((o) => maskLayer(key, o.mask, o.value, colors[o.source], o.style === "fill").catch(() => {}));
  };
  let i = S.pos;
  for (let k = 0; k < AHEAD; k++) {
    i = (i + 1) % S.order.length;
    const c = S.cardsById.get(S.order[i]);
    if (!c || S.answers.has(c.id)) continue;
    if (c.w) warm(c);
    else ensureCard(key, c, (x) => storedCard(key, x)).then((r) => { if (r === "ok" && S && S.key === key) warm(c); });
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
  return openEditor({ rec: S.rec, card, frame: S.frame, hidden: new Set(S.hidden), initial: prev && (prev.mask || prev.masks) ? prev : null, title, note, doneLabel,
    cview: S.cview, chan: S.chan });
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
    const r = await openTapper({ rec: S.rec, card, frame: S.frame, hidden: new Set(S.hidden), multi: def.then === "points", title: def.label, cview: S.cview, chan: S.chan,
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
  const r = await openFollow({ rec: S.rec, card, hidden: new Set(S.hidden), title: S.rec.deck.title, note: `card ${pos} of ${S.order.length}`, cview: S.cview, chan: S.chan });
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

// --- time frames and channels
const nch = (card) => framePaths(card, 0).length;
function framesBar(card, attr) {               // time frames (or one frame per picture in older decks)
  return card.frames.map((f, i) => `<button data-${attr}="${i}" aria-pressed="${i === S.frame}" title="${esc(f.name || i + 1)}" data-name="${esc(f.name || i + 1)}">${esc(f.name || i + 1)}</button>`).join("")
    + `<button class="play" data-act="play" aria-label="Play frames">${playTimer ? "❚❚" : "▶"}</button>`;
}
function chanBar(card, attr) {                 // each channel, "Mix" (added up in colour), "Side by side"
  const chans = channelsOf(S.rec.deck), colors = channelColors(chans);
  const b = (v, label, on, color) => `<button data-${attr}="${v}" aria-pressed="${on}">${color ? `<i style="background:${esc(color)}"></i>` : ""}${esc(label)}</button>`;
  return chans.map((c, i) => b(i, c.name || `channel ${i + 1}`, S.cview === "one" && S.chan === i, colors[i])).join("")
    + b("mix", "Mix", S.cview === "mix") + b("side", "Side by side", S.cview === "side");
}
// Frame buttons whose names don't fit fall back to 1, 2, 3, …; a crowded channel bar says "Side" and scrolls.
function fitFrameLabels(root) {
  const side = root && $(".chanbar [data-chan=side], .chanbar [data-zchan=side]", root);
  if (side) { side.textContent = "Side by side"; const bar = side.parentElement; if (bar.scrollWidth > bar.clientWidth + 1) side.textContent = "Side"; }
  const btns = $$("[data-frame],[data-zframe]", root);
  btns.forEach((b) => { b.textContent = b.dataset.name; });
  if (btns.some((b) => b.scrollWidth > b.clientWidth + 1)) btns.forEach((b, i) => { b.textContent = String(i + 1); });
}
function refreshBars() {
  const card = currentCard();
  if (!card) return;
  for (const [root, fa, ca] of [[S.cardEl, "frame", "chan"], [Z && Z.el, "zframe", "zchan"]]) {
    if (!root) continue;
    $$(`[data-${fa}]`, root).forEach((b) => b.setAttribute("aria-pressed", String(+b.dataset[fa] === S.frame)));
    const cb = $(".chanbar", root);
    if (cb) cb.innerHTML = chanBar(card, ca);
  }
}
// Switching the channel keeps the frame; switching the frame keeps the channel (or Mix).
function setChannel(v) {
  const card = currentCard();
  if (!card || !S.view) return;
  const wasSide = S.cview === "side";
  if (v === "mix" || v === "side") S.cview = v; else { S.cview = "one"; S.chan = +v; }
  prefs.set(`chview:${S.key}`, { cview: S.cview, chan: S.chan });
  const relayout = wasSide !== (S.cview === "side");
  S.view.setChannels(S.cview, S.chan, relayout ? viewRect(card) : null);
  if (relayout) layoutCard();
  if (Z) Z.view.setChannels(S.cview, S.chan, relayout ? viewRect(card) : null);
  refreshBars();
}
function setFrame(i) {
  const card = currentCard();
  if (!card || !S.view) return;
  S.frame = (i + card.frames.length) % card.frames.length;
  S.view.setFrame(S.frame);
  if (Z) Z.view.setFrame(S.frame);
  refreshBars();
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
  const t = e.target.closest("[data-act],[data-val],[data-frame],[data-chan],[data-src]");
  if (!t || !S) return;
  if (t.dataset.val !== undefined) {
    const def = S.allDefs.find((d) => d.value === t.dataset.val && d.slot === t.dataset.slot && !d.hidden);
    if (def) answer(def);
    return;
  }
  if (t.dataset.frame !== undefined) { stopPlay(); return setFrame(+t.dataset.frame); }
  if (t.dataset.chan !== undefined) return setChannel(t.dataset.chan);
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
  if (act === "live") return liveTap();
  if (act === "repick") return pickZipAgain();
  if (act === "finishzip") return loadZip(t.dataset.zip, true);
  if (act === "loadinfo") { const lo = loadingOf(S.key); return toast(!lo ? "The deck is saved on the phone" : lo.active ? "Saving the deck on the phone. You can work meanwhile." : "Pick the deck's zip again to finish saving it.", 4000); }
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
    <div class="bottom">${nch(card) > 1 ? `<div class="frames chanbar" style="border:0;padding:0 0 6px">${chanBar(card, "zchan")}</div>` : ""}
      ${card.frames.length > 1 ? `<div class="frames" style="border:0;padding:0">${framesBar(card, "zframe")}</div>` : ""}
      ${card.info ? `<p class="zoom-info">${esc(card.info)}</p>` : ""}
      <p class="hint" style="margin:6px 0 0">pinch or scroll to zoom · drag to move · double-tap to zoom in</p></div>`;
  document.body.appendChild(el);
  Z = { el, view: new CardCanvas($("canvas", el), { interactive: true }) };
  Z.view.display = displayFor(S.key, card, S.rec.deck);
  el.onclick = (e) => {
    const t = e.target.closest("[data-z],[data-zsrc],[data-zframe],[data-zchan],[data-act]");
    if (!t) return;
    if (t.dataset.z === "close") closeZoom();
    else if (t.dataset.act === "contrast") contrastPanel();
    else if (t.dataset.zsrc !== undefined) toggleSource(t.dataset.zsrc);
    else if (t.dataset.zframe !== undefined) { stopPlay(); setFrame(+t.dataset.zframe); }
    else if (t.dataset.zchan !== undefined) setChannel(t.dataset.zchan);
    else if (t.dataset.act === "play") togglePlay();
  };
  const onR = () => Z && Z.view.resize();
  window.addEventListener("resize", onR);
  Z.off = () => window.removeEventListener("resize", onR);
  await Z.view.show(S.rec, card, { frame: S.frame, hidden: S.hidden, cview: S.cview, chan: S.chan });
  fitFrameLabels(Z.el);
}
function contrastPanel() {
  const card = currentCard();
  if (!card || !S.view || !S.view.loaded) return;
  const c = S.view.activeChannel(), src = S.view.source(S.frame, c);
  openContrast(S.key, contrastName(S.rec.deck, card, S.frame, c), !!src && src.bits === 16);
}
function closeZoom() {
  if (!Z) return;
  Z.off(); Z.el.remove(); Z = null;
}

// --- deck menu, help, answer editor
const isArchived = (rec, answered) => rec.shelf === "archive" || (rec.shelf !== "active" && rec.deck.cards.length > 0 && answered >= rec.deck.cards.length);
function deckMenu() {
  const sh = openSheet(`<h3>${esc(S.rec.title)}</h3><p class="mono muted" style="font-size:12px;margin:-4px 0 0">${esc(S.rec.key)}</p>
    <div class="menu">
      <button class="btn quiet" data-m="results">Results</button>
      <button class="btn quiet" data-m="review">Review and change answers</button>
      ${modeOf(S.rec.deck) === "swipe" ? `<button class="btn quiet" data-m="edit">Edit the answer buttons</button>` : ""}
      <button class="btn quiet" data-m="export">Export answers</button>
      <button class="btn quiet" data-m="share">Share this deck</button>
      <button class="btn quiet" data-m="team">Team folder on Google Drive</button>
      <button class="btn quiet" data-m="settings">Settings & backup</button>
      <button class="btn quiet" data-m="help">Help</button>
      <button class="btn quiet" data-m="shelf">${isArchived(S.rec, S.answers.size) ? "Back to To do" : "Move to archive"}</button>
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
      share: () => shareDeckSheet(rec.key),
      team: () => teamSheet(rec.key),
      edit: () => answerEditor(rec),
      export: () => exportSheet(rec),
      help: () => helpSheet(rec),
      shelf: async () => {
        const back = isArchived(rec, S.answers.size);
        rec.shelf = back ? "active" : "archive"; await saveRec(rec);
        prefs.set("homeTab", back ? "decks" : "archive");
        sh.close(); toast(back ? "Back in To do" : "Moved to the Archive"); go("#/");
      },
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
  const zip = dfolder.isOn() ? dfolder.zipOf(rec.key) : "", saved = live.lastSaved(rec.key);
  const sh = openSheet(`<h3>Delete “${esc(rec.title)}”?</h3>
    <p>This removes the deck, its images and <b>all its answers</b> from this phone.
      ${saved ? `Live save kept a copy of the answers (saved ${whenShort(saved)}).` : "Export the answers first if you need them."}</p>
    ${zip ? `<p>The zip stays in “${esc(dfolder.folderName())}”: it shows up there as “tap to load”, if you want it back.</p>` : ""}
    <div class="row"><button class="btn danger" data-del>Delete</button><button class="btn quiet" data-close>Cancel</button></div>`);
  sh.el.onclick = async (e) => {
    if (e.target.closest("[data-close]")) sh.close();
    if (e.target.closest("[data-del]")) {
      forgetLoading(rec.key); await store.deleteDeck(rec.key);
      if (zip) dfolder.removed(rec.key);
      live.statusSoon(); sh.close(); toast("Deleted"); go("#/");
    }
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

// ---------------------------------------------------------------- sharing, Google Drive, photos
const mb = (bytes) => (bytes < 1e6 ? `${Math.max(1, Math.round(bytes / 1e3))} KB` : `${(bytes / 1e6).toFixed(1)} MB`);
const noDrive = `<p class="muted" style="font-size:13px">Built-in Google Drive isn't switched on in this copy of the app, but any drive app works through the phone's share menu and file picker. <button class="link-btn" data-guide>How to use a drive</button></p>`;

// The YouTube user guide: a part is listed once it is published.
const GUIDE_VIDEOS = [
  { part: 1, title: "Getting started", min: "3-minute", url: "https://youtu.be/PI-3ms1sx_E",
    what: "Swiping, zoom and contrast, the mask editor, results, microscopy channels, decks from AI or photos, export" },
  { part: 2, title: "An AI builds the deck, you fix the masks", min: "2-minute", url: "https://youtu.be/9HHWi0D_Dms",
    what: "A real microscopy image: Claude builds the deck, then start from the model, cut, magic wand, brush, export" },
  { part: 3, title: "Tracking, review and your own answers", min: "2-minute", url: "https://youtu.be/Bi8DEyOR9Fc",
    what: "Fixing a track, divisions, follow mode, review and notes, editing the answer buttons, colours and backup" },
];
function videoSheet() {
  const sh = openSheet(`<h3>▶ Video guide</h3>
    <p>Short videos on YouTube, in English with subtitles.</p>
    <div class="stack">${GUIDE_VIDEOS.map((v) => `<a class="btn quiet video-link" href="${v.url}" target="_blank" rel="noopener"><b>Part ${v.part}: ${esc(v.title)} <span class="mono">${esc(v.min.replace("-minute", " min"))}</span></b><span>${esc(v.what)}</span></a>`).join("")}</div>
    ${GUIDE_VIDEOS.length < 3 ? `<p class="muted" style="font-size:13px">Coming next: tracking, reviewing answers and making the buttons your own.</p>` : ""}
    <div class="stack"><button class="btn" data-close>Close</button></div>`);
  sh.el.addEventListener("click", (e) => { if (e.target.closest("[data-close]")) sh.close(); });
}

// How to use Google Drive, OneDrive, Dropbox or iCloud: the phone's own file picker and share menu always work;
// the built-in Google Drive features are added when this copy of the app has its Google ids (config.js).
function driveGuide() {
  const ios = isIOS();
  openSheet(`<h3>☁ Google Drive, OneDrive, Dropbox</h3>
    ${drive.googleReady() ? `<div class="section-title">Built in: Google Drive</div>
    <ul class="steps">
      <li><b>Open from Google Drive</b> on the home screen picks a deck from your Drive.</li>
      <li>Deck menu ⋮ → <b>Share this deck</b> → <b>Share a link</b> uploads the deck and gives a link and a QR code.</li>
      <li>Deck menu ⋮ → <b>Team folder on Google Drive</b>: everyone saves their answers to one shared folder, and Results compares the whole team.</li>
      <li>Google asks you to sign in the first time. Hooman sees only the files you pick or that it saved itself.</li></ul>
    <div class="section-title">Any drive app</div>` : `<p>Hooman works with any drive app on this ${ios ? "iPhone" : "phone"}, through the phone's own file picker and share menu. The drive's app needs to be installed.</p>`}
    <div class="section-title">Open a deck from a drive</div>
    <ol class="steps">
      <li>Tap <b>＋ Import deck</b>.</li>
      ${ios ? `<li>Tap <b>Choose File</b>, then <b>Browse</b>, and pick <b>Google Drive</b>, <b>OneDrive</b>, <b>Dropbox</b> or <b>iCloud Drive</b> under Locations.</li>`
            : `<li>In the file picker, open the menu <b>☰</b> and pick <b>Drive</b>, <b>OneDrive</b> or <b>Dropbox</b>.</li>`}
      <li>Tap the deck's <span class="mono">.zip</span>.</li></ol>
    ${live.canDrive() || live.canFolder() ? `<div class="section-title">Save automatically</div>
    <p>⚙ → <b>Live save</b>${live.canDrive() ? " → <b>Google Drive</b>" : ""}${live.canDrive() && live.canFolder() ? ", or" : ""}${live.canFolder() ? ` a folder${isIOS() || isAndroid() ? "" : " that your drive app syncs (OneDrive, Dropbox, Google Drive for desktop)"}` : ""}. Each deck's answers are copied there a few seconds after every answer, and the ☁ mark on the deck shows when they're saved.</p>` : ""}
    ${dfolder.supported() ? `<div class="section-title">Decks that appear by themselves</div>
    <p>⚙ → <b>Decks folder</b>: pick a folder${isIOS() || isAndroid() ? "" : " that your drive app syncs"}. Every deck zip put in it shows up in the app, and a newer zip of the same deck updates it (answers kept).</p>` : ""}
    <div class="section-title">Save answers or a backup to a drive</div>
    <ol class="steps">
      <li>Deck menu ⋮ → <b>Export answers</b> → <b>Share or save the .zip</b>. For everything at once: ⚙ → <b>Back up answers</b>.</li>
      ${ios ? `<li>In the share menu, tap <b>Save to Files</b> and pick the drive, or tap the drive's own app.</li>`
            : `<li>In the share menu, tap <b>Drive</b> (Save to Drive), <b>OneDrive</b> or <b>Dropbox</b>.</li>
      <li>Saved to Downloads instead? Open the drive's app, tap <b>＋</b> → <b>Upload</b>, and pick the file.</li>`}</ol>
    <div class="section-title">Work as a team</div>
    <ol class="steps">
      <li>Make a shared folder on your drive and put the deck's <span class="mono">.zip</span> in it.</li>
      <li>Everyone imports the deck from the folder, sets their name (⚙), answers, and saves their export back to the folder.</li>
      <li>To compare: deck menu ⋮ → <b>Results</b> → <b>Compare with another export…</b>, and pick a teammate's file.</li></ol>
    ${drive.googleReady() ? "" : `<p class="muted" style="font-size:13px">A Google Drive share link won't open with <b>From a link</b> in this copy of the app. Import the file from the Drive app instead.</p>`}
    <div class="stack"><button class="btn" data-close>Got it</button></div>`).el.addEventListener("click", (e) => { if (e.target.closest("[data-close]")) closeSheet(); });
}

function linkBlock(link) {
  return `<div class="share-link"><div class="qr">${qrSVG(link)}</div>
    <input type="text" readonly value="${esc(link)}" aria-label="Deck link">
    <div class="row"><button class="btn" data-l="copy">Copy link</button>${navigator.share ? `<button class="btn quiet" data-l="share">Share link</button>` : ""}</div>
    <p class="muted" style="font-size:12px">Anyone who opens the link (or scans the code) gets this deck in Hooman. Their answers stay on their phone until they export them or save them to the team folder.</p></div>`;
}
function wireLink(el, link, title) {
  el.addEventListener("click", async (e) => {
    const t = e.target.closest("[data-l]");
    if (!t) return;
    if (t.dataset.l === "copy" && (await copyText(link))) toast("Link copied");
    if (t.dataset.l === "share") { try { await navigator.share({ title, url: link }); } catch {} }
  });
}

async function shareDeckSheet(key) {
  if (loadingOf(key)) return toast("This deck is still being saved on the phone. Share it when it's done.", 3500);
  const rec = await store.getDeck(key);
  const sh = openSheet(`<h3>Share this deck</h3>
    <p>Send it as a file: a <span class="mono">.hooman.zip</span> with deck.json and every image (${rec.bytes ? mb(rec.bytes) : "size unknown"}). The other person taps Import, or on Android shares it to Hooman.</p>
    <div class="stack"><button class="btn" data-s="file">Send as a file</button>
    ${drive.googleReady() ? `<button class="btn quiet" data-s="drive">Share a link (Google Drive)</button>` : ""}</div>
    ${drive.googleReady() ? "" : noDrive}
    <div id="share-out">${rec.sourceURL ? `<div class="section-title">This deck came from a link</div>${linkBlock(deckLink(appURL(), rec.sourceURL))}` : ""}</div>`);
  if (rec.sourceURL) wireLink($("#share-out", sh.el), deckLink(appURL(), rec.sourceURL), rec.title);
  sh.el.addEventListener("click", async (e) => {
    const t = e.target.closest("[data-s]");
    if (!t) return;
    t.disabled = true;
    try {
      const zip = await buildDeckZip(rec);
      if (t.dataset.s === "file") {
        const r = await shareOrDownload(zip, `${rec.key}.hooman.zip`);
        if (r !== "cancelled") toast(r === "shared" ? "Shared" : "Saved to downloads");
      } else {
        toast("Uploading to your Google Drive…", 4000);
        const f = await drive.upload(zip, `${rec.key}.hooman.zip`, { fileId: rec.sharedFileId, folderId: rec.drive && rec.drive.folderId });
        const view = await drive.makePublic(f.id);
        rec.sharedFileId = f.id; rec.sourceURL = view; await store.putDeck(rec);
        const link = deckLink(appURL(), view), out = $("#share-out", sh.el);
        out.innerHTML = `<div class="section-title">Link to this deck</div>${linkBlock(link)}`;
        wireLink(out, link, rec.title);
      }
    } catch (err) { showErrors([`Sharing failed: ${err.message}`], []); }
    t.disabled = false;
  });
}

async function openFromDrive() {
  try {
    const picked = await drive.pick({ title: "Open a deck, backup or answers file" });
    if (!picked.length) return;
    toast("Downloading from Google Drive…", 4000);
    importFile(await drive.download(picked[0].id, picked[0].name));
  } catch (e) { showErrors([e.message], []); }
}

async function teamSheet(key) {
  const rec = await store.getDeck(key);
  const d = rec.drive || {};
  const sh = openSheet(`<h3>Team folder on Google Drive</h3>
    <p>One shared Drive folder for the whole team: put the deck in it, everyone saves their answers back to it, and <b>Results</b> compares everyone.</p>
    ${drive.googleReady() ? `<p>Folder: <b style="color:var(--text)">${d.folderName ? esc(d.folderName) : "none chosen yet"}</b></p>
    <div class="stack"><button class="btn ${d.folderId ? "quiet" : ""}" data-t="choose">${d.folderId ? "Choose another folder" : "Choose the folder"}</button>
      <button class="btn" data-t="answers" ${d.folderId ? "" : "disabled"}>Save my answers to the folder</button>
      <button class="btn quiet" data-t="deck" ${d.folderId ? "" : "disabled"}>Put this deck in the folder</button>
      <button class="btn quiet" data-t="results">Compare with the team (Results)</button></div>
    <p class="muted" style="font-size:12px">Your answers are saved as <span class="mono">${esc(rec.key)}.${esc(fileSafe(annotator()))}.answers.zip</span>; set your name in Settings first. Teammates open the deck with "Open from Google Drive".</p>` : noDrive}`);
  sh.el.addEventListener("click", async (e) => {
    const t = e.target.closest("[data-t]");
    if (!t) return;
    const a = t.dataset.t, d = rec.drive || {};          // read fresh: an earlier save stored the file ids
    if (a === "results") { sh.close(); return go(`#/results/${encodeURIComponent(key)}`); }
    t.disabled = true;
    try {
      if (a === "choose") {
        const [f] = await drive.pick({ kind: "folder", title: "Pick the team's folder" });
        if (f) { rec.drive = { folderId: f.id, folderName: f.name }; await store.putDeck(rec); toast(`Team folder: ${f.name}`); teamSheet(key); return; }
      } else if (a === "answers") {
        const out = await buildExport(rec);
        const name = `${rec.key}.${fileSafe(annotator())}.answers.zip`;
        const f = await drive.upload(out.zip, name, { folderId: d.folderId, fileId: d.answersFileId });
        rec.drive = { ...d, answersFileId: f.id }; rec.exportedAt = new Date().toISOString(); await store.putDeck(rec);
        toast(`Saved ${out.count} answers to Drive as ${name}`, 3500);
      } else if (a === "deck") {
        const f = await drive.upload(await buildDeckZip(rec), `${rec.key}.hooman.zip`, { folderId: d.folderId, fileId: d.deckFileId });
        rec.drive = { ...d, deckFileId: f.id }; await store.putDeck(rec);
        toast("The deck is in the team folder", 3000);
      }
    } catch (err) { showErrors([err.message], []); }
    t.disabled = false;
  });
}

// Results: pick teammates' answer files from the team folder.
async function loadTeam(rec) {
  const raw = await store.getDeck(rec.key);
  const picked = await drive.pick({ multi: true, parent: raw.drive && raw.drive.folderId, title: "Pick your team's answers files" });
  const me = `${rec.key}.${fileSafe(annotator())}.answers.zip`, team = [];
  for (const p of picked) {
    if (p.name === me) continue;
    const x = await readAnswers(await drive.download(p.id, p.name));
    const answers = x.answers || (x.decks && x.decks.get(rec.key));
    if (answers && (!x.deck || x.deck === rec.key)) team.push({ who: x.who !== "the other file" ? x.who : p.name.replace(/\.answers\.zip$/, ""), answers });
  }
  if (!team.length) toast("None of those files has answers for this deck", 3000);
  return team;
}

function photosSheet() {
  const sh = openSheet(`<h3>📷 New deck from photos</h3>
    <p>Pick photos from this phone (the picker also shows Google Drive). Big photos are shrunk to 2048 px. No AI needed.</p>
    <input type="file" id="ph-files" accept="image/*" multiple hidden>
    <div class="row"><button class="btn quiet" data-p="pick">Choose photos</button><span class="muted" id="ph-count" style="align-self:center">none yet</span></div>
    <label class="field">Title<input type="text" id="ph-title" value="My photos" maxlength="80"></label>
    <div class="field">What to do <span class="seg"><button data-pm="swipe" aria-pressed="true">Answer a question</button><button data-pm="annotate" aria-pressed="false">Draw masks</button></span></div>
    <div id="ph-swipe"><label class="field">Question<input type="text" id="ph-q" value="Is this right?" maxlength="200"></label>
      <div class="field">Answers<div class="ph-ans"><span>→</span><input type="text" id="ph-r" value="Yes"><span>←</span><input type="text" id="ph-l" value="No"><span>↑</span><input type="text" id="ph-u" value="Unsure"></div></div></div>
    <div id="ph-annotate" hidden><label class="field">Classes <span class="muted">(optional, comma separated)</span><input type="text" id="ph-classes" placeholder="cell, debris"></label></div>
    <div class="stack"><button class="btn" data-p="go" disabled>Make the deck</button></div>`);
  const fin = $("#ph-files", sh.el);
  let files = [], mode = "swipe";
  fin.addEventListener("change", () => {
    files = [...fin.files];
    $("#ph-count", sh.el).textContent = files.length ? `${files.length} photo${files.length > 1 ? "s" : ""}` : "none yet";
    sh.el.querySelector("[data-p=go]").disabled = !files.length;
  });
  sh.el.addEventListener("click", async (e) => {
    const t = e.target.closest("[data-p],[data-pm]");
    if (!t) return;
    if (t.dataset.pm) {
      mode = t.dataset.pm;
      $$("[data-pm]", sh.el).forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.pm === mode)));
      $("#ph-swipe", sh.el).hidden = mode !== "swipe"; $("#ph-annotate", sh.el).hidden = mode !== "annotate";
      return;
    }
    if (t.dataset.p === "pick") return fin.click();
    if (t.dataset.p !== "go" || !files.length) return;
    t.disabled = true; t.textContent = "Making the deck…";
    const v = (id) => $(id, sh.el).value.trim();
    try {
      const imported = await buildPhotoDeck(files, {
        title: v("#ph-title"), mode, question: v("#ph-q"),
        answers: { right: v("#ph-r"), left: v("#ph-l"), up: v("#ph-u") },
        classes: v("#ph-classes").split(",").map((x) => x.trim()).filter(Boolean),
      }, (i, n) => { t.textContent = `Preparing photo ${i + 1} of ${n}…`; });
      sh.close();
      finishImport(imported, "new");
    } catch (err) { t.disabled = false; t.textContent = "Make the deck"; showErrors(err.errors || [err.message], []); }
  });
}

// ---------------------------------------------------------------- review screen
async function thumbURL(key, card) {
  if (!card.w && (await ensureCard(key, card, (c) => storedCard(key, c))) !== "ok") return null;
  const blob = await store.getFile(key, card.frames[0].path);
  if (!blob) return null;
  const params = displayFor(key, card, (await store.getDeck(key)).deck)(0, 0), head = new Uint8Array(await blob.slice(0, 26).arrayBuffer());
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
  await renderResults(app, rec, { go, toast, copyText, openCard: (card) => go(`#/deck/${encodeURIComponent(key)}?card=${encodeURIComponent(card)}&from=review`),
    pickTeam: drive.googleReady() ? () => loadTeam(rec) : null });
  drive.warmUp();
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
  watchInstall(refreshInstall);
  document.addEventListener("click", (e) => { if (e.target.closest("[data-guide]")) driveGuide(); if (e.target.closest("[data-videos]")) videoSheet(); });
  window.addEventListener("hooman:merged", async (e) => {      // live save took in answers from another device
    if (!S || S.key !== e.detail) return;
    S.answers = new Map((await store.answersOf(S.key)).map((a) => [a.card, a]));
    S.notes = new Map((await store.notesOf(S.key)).map((n) => [n.card, n]));
    if ($("#count")) updateCounts();
    toast("Answers from your other device were added");
  });
  live.start().catch((e) => console.error(e));
  let folderShown = "";
  dfolder.onStatus((s) => {                       // new and updated decks from the decks folder
    const fl = $("#folder-line");
    if (fl) fl.innerHTML = folderLine();
    const now = `${s.status}|${s.quiet}`;
    if (s.status === "checking") {               // the reconnect banner goes as soon as a check starts
      if (now !== folderShown && !S && parseHash().page === "home") { folderShown = now; home(); }
      return;
    }
    folderShown = now;
    if (s.status === "ok" && (s.added.length || s.updated.length)) {
      live.statusSoon();
      const parts = [];
      if (s.added.length) parts.push(`New from your folder: ${s.added.map((t) => `“${t}”`).join(", ")}`);
      if (s.updated.length) parts.push(`Updated (answers kept): ${s.updated.map((t) => `“${t}”`).join(", ")}`);
      toast(parts.join(" · "), 4500);
    }
    if (!S && parseHash().page === "home") home();       // new decks, or the reconnect banner comes and goes
  });
  dfolder.start(() => (S ? S.key : null));
  // Chrome drops folder access when the app has been in the background a while, and only a tap may ask for it
  // again: the first tap after coming back (or after starting) does, for the decks folder, then live save.
  let regain = true;
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") regain = true; });
  document.addEventListener("click", () => {
    if (!regain || (!dfolder.isOn() && !live.anyOn())) return;
    regain = false;
    dfolder.regain().then(() => live.regain()).catch((e) => console.warn("folders", e));
  }, true);
  onLoading((key, ev) => {
    if (ev.failed) return toast(`Could not save the deck on the phone: ${ev.failed}. The phone may be out of storage.`, 5000);
    if (!ev.done) return;
    store.getDeck(key).then((rec) => rec && toast(`“${rec.title}” is saved on the phone`, 3500));
    if (!S && parseHash().page === "home") home();
  });
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
