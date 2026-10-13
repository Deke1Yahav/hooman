// Live save: a copy of each deck's answers (the same zip as Export) kept up to date in Google Drive and/or a
// folder on this device, a few seconds after every answer. Answers are always stored on the device first
// (IndexedDB); this copy is what survives a cleared browser or a lost phone.
//
// One file per deck and hooman: "<deck>.<name>.answers.zip". If another device changed that file since this one
// last wrote it (one hooman, two devices), it is merged in first (newer answers win), so nothing is overwritten.
// Drive files go to the deck's team folder when it has one (so Results can compare the team), otherwise to a
// "Hooman in the Loop" folder the app makes in the hooman's Drive.
//
// Nothing here opens a sign-in or permission prompt by itself: browsers block prompts that don't come from a tap.
// When Google's sign-in (about an hour) or the folder permission runs out, that target pauses, keeps a list of the
// decks still to save, and resumes from reconnect(), which runs inside the hooman's tap.
import * as store from "./store.js";
import * as drive from "./drive.js";
import { prefs } from "./prefs.js";
import { buildExport, APP_VERSION } from "./export.js";
import { restoreAnswers } from "./backup.js";
import { annotator, fileSafe } from "./settings.js";
import { loadHandle, saveHandle } from "./handles.js";

const QUIET = 4000, MAX_WAIT = 30000, RETRY = 60000, TARGETS = ["drive", "folder"];
export const canDrive = () => drive.googleReady();
export const canFolder = () => typeof window.showDirectoryPicker === "function";
export const fileName = (key) => `${key.replace(/[\\/:*?"<>|]/g, "_")}.${fileSafe(annotator())}.answers.zip`;

// status: off | saving | ok | paused | offline | error
const st = { drive: { status: "off" }, folder: { status: "off" } };
const timers = new Map(), gen = new Map(), mergingKeys = new Set(), listeners = new Set();
let dir = null, folderLost = false, chain = Promise.resolve(), retryTimer = null, driveFolderChecked = false;

const isOn = (t) => prefs.get(`live.${t}`, false) && (t === "drive" ? canDrive() : canFolder());
const dirtyOf = (t) => new Set(prefs.get(`live.dirty.${t}`, []));
const setDirty = (t, set) => prefs.set(`live.dirty.${t}`, [...set]);
const filesOf = (t) => prefs.get(`live.files.${t}`, {});              // deck key -> where this device last wrote it
const setFile = (t, key, info) => { const m = filesOf(t); m[key] = info; prefs.set(`live.files.${t}`, m); };

export const status = () => st;
export const anyOn = () => TARGETS.some(isOn);
export const folderName = () => (dir ? dir.name : prefs.get("live.folderName", ""));
export const lastSaved = (key) => prefs.get("live.savedAt", {})[key] || "";
export function onStatus(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function set(t, patch) { Object.assign(st[t], patch); listeners.forEach((fn) => { try { fn(st); } catch (e) { console.error(e); } }); }

async function ready(t) {
  if (!isOn(t)) return "off";
  if (!navigator.onLine && t === "drive") return "offline";
  if (t === "drive") return drive.signedIn(120000) ? "ready" : "paused";
  if (!dir && !folderLost) { const r = await loadHandle("live-folder"); dir = r.handle || null; folderLost = r.lost || false; }
  if (!dir) { st.folder.msg = folderLost || "Tap Reconnect to choose the folder again."; return "paused"; }
  try { return (await dir.queryPermission({ mode: "readwrite" })) === "granted" ? "ready" : "paused"; } catch { return "paused"; }
}

// ---------------------------------------------------------------- scheduling
store.onDeckChange((key, why) => {
  if (why === "restore" && mergingKeys.has(key)) return;        // our own merge, not a change to save again
  gen.set(key, (gen.get(key) || 0) + 1);
  let any = false;
  for (const t of TARGETS) if (isOn(t)) { const d = dirtyOf(t); d.add(key); setDirty(t, d); any = true; }
  if (any) schedule(key);
});

function schedule(key, now = false) {
  const p = timers.get(key) || { first: Date.now() };
  clearTimeout(p.timer);
  const wait = now ? 0 : Math.max(0, Math.min(QUIET, p.first + MAX_WAIT - Date.now()));
  p.timer = setTimeout(() => { timers.delete(key); chain = chain.then(() => saveDeck(key)).catch((e) => console.error(e)); }, wait);
  timers.set(key, p);
}

function flushAll() {
  const keys = new Set();
  for (const t of TARGETS) if (isOn(t)) dirtyOf(t).forEach((k) => keys.add(k));
  keys.forEach((k) => schedule(k, true));
  return chain;
}

function retryLater() {
  if (retryTimer) return;
  retryTimer = setTimeout(() => { retryTimer = null; flushAll(); }, RETRY);
}

function fail(t, e) {
  if (e && e.status === 401) { drive.forget(); return set(t, { status: "paused", msg: "" }); }
  if (e && (e.name === "NotAllowedError" || e.name === "SecurityError")) return set(t, { status: "paused", msg: "" });
  if (e && e.name === "NotFoundError" && t === "folder") return set(t, { status: "paused", msg: "The folder is gone: tap Reconnect to choose it again." });
  if (t === "drive" && (!navigator.onLine || e instanceof TypeError)) set(t, { status: "offline", msg: "" });
  else set(t, { status: "error", msg: (e && e.message) || String(e) });
  retryLater();
}

// ---------------------------------------------------------------- one deck
async function saveDeck(key) {
  const todo = [];
  for (const t of TARGETS) {
    if (!dirtyOf(t).has(key)) continue;
    const r = await ready(t);
    if (r === "ready") todo.push(t);
    else if (r !== "off") set(t, { status: r });
  }
  if (!todo.length) return;
  const rec = await store.getDeck(key);
  if (!rec) { for (const t of todo) { const d = dirtyOf(t); d.delete(key); setDirty(t, d); } return; }
  const g = gen.get(key) || 0, name = fileName(key), where = {};
  todo.forEach((t) => set(t, { status: "saving" }));
  for (const t of [...todo]) {                                   // 1. take in what other devices wrote
    try { where[t] = t === "drive" ? await driveBefore(rec, name) : await folderBefore(key, name); }
    catch (e) { todo.splice(todo.indexOf(t), 1); fail(t, e); }
  }
  if (!todo.length) return;
  const out = await buildExport(await store.getDeck(key));       // 2. write the merged answers
  for (const t of todo) {
    try {
      setFile(t, key, t === "drive" ? await driveWrite(key, name, out.zip, where[t]) : await folderWrite(name, out.zip));
      if (t === "folder") statusSoon();
      if ((gen.get(key) || 0) === g) { const d = dirtyOf(t); d.delete(key); setDirty(t, d); }
      const at = new Date().toISOString();
      prefs.set("live.savedAt", { ...prefs.get("live.savedAt", {}), [key]: at });
      prefs.set(`live.at.${t}`, at);
      set(t, { status: dirtyOf(t).size ? "saving" : "ok", at, msg: "" });
    } catch (e) { fail(t, e); }
  }
}

async function merge(key, file) {
  mergingKeys.add(key);
  try {
    const r = await restoreAnswers(file);
    const d = r.decks && r.decks[0];
    if (d && (d.added || d.newer || d.notes)) window.dispatchEvent(new CustomEvent("hooman:merged", { detail: key }));
  } catch (e) { console.warn("live save: the saved copy could not be read; it will be replaced", e); }
  finally { mergingKeys.delete(key); }
}

// ---------------------------------------------------------------- Google Drive
async function privateFolder() {
  let f = prefs.get("live.driveFolder", null);
  if (f && !driveFolderChecked) { if (!(await drive.meta(f.id))) f = null; else driveFolderChecked = true; }
  if (!f) { f = await drive.createFolder("Hooman in the Loop"); prefs.set("live.driveFolder", f); driveFolderChecked = true; }
  return f.id;
}

async function driveBefore(rec, name) {
  const known = filesOf("drive")[rec.key] || {};
  const team = rec.drive && rec.drive.folderId;
  const folderId = team || (await privateFolder());
  let id = known.folderId === folderId && known.name === name ? known.id : null;
  if (!id && team && rec.drive.answersFileId) id = rec.drive.answersFileId;     // "Save my answers to the folder"
  if (id) {
    const m = await drive.meta(id);
    if (!m) id = null;
    else if (id !== known.id || !known.version || m.version !== known.version) await merge(rec.key, await drive.download(id, name));
  }
  return { folderId, id };
}

async function driveWrite(key, name, zip, w) {
  const f = await drive.upload(zip, name, { folderId: w.folderId, fileId: w.id });
  const version = f.version || ((await drive.meta(f.id)) || {}).version || "";
  const raw = await store.getDeck(key);
  if (raw && raw.drive && raw.drive.folderId === w.folderId && raw.drive.answersFileId !== f.id) {
    raw.drive = { ...raw.drive, answersFileId: f.id }; await store.putDeck(raw);
  }
  return { id: f.id, folderId: w.folderId, name, version };
}

// ---------------------------------------------------------------- a folder on this device
async function folderBefore(key, name) {
  const known = filesOf("folder")[key] || {};
  let fh;
  try { fh = await dir.getFileHandle(name); } catch (e) { if (e.name === "NotFoundError" || e.name === "TypeError") return {}; throw e; }
  const f = await fh.getFile();
  if (known.name !== name || f.lastModified !== known.modified) await merge(key, f);      // a sync app or another device changed it
  return {};
}

async function folderWrite(name, zip) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(zip); await w.close();
  return { name, modified: (await fh.getFile()).lastModified };
}

// ---------------------------------------------------------------- switching on and off (from a tap)
async function markAll(t) {
  const d = dirtyOf(t);
  for (const rec of await store.listDecks()) if ((await store.answersOf(rec.key)).length) d.add(rec.key);
  setDirty(t, d);
}

export async function enable(t) {
  if (t === "drive") await drive.getToken();                    // Google's sign-in, inside the tap
  else return useFolder(await window.showDirectoryPicker({ id: "hooman-live", mode: "readwrite", startIn: "documents" }));
  prefs.set(`live.${t}`, true);
  await markAll(t);
  set(t, { status: "saving", msg: "" });
  return flushAll();
}

// Save into this folder from now on (a picked one, or the decks folder's "results").
export async function useFolder(h) {
  dir = h; folderLost = false; await saveHandle("live-folder", h);
  statusSoon();
  prefs.set("live.folderName", h.name); prefs.set("live.files.folder", {});
  const t = "folder";
  prefs.set(`live.${t}`, true);
  await markAll(t);
  set(t, { status: "saving", msg: "" });
  return flushAll();
}

export async function disable(t) {
  prefs.set(`live.${t}`, false); setDirty(t, new Set());
  if (t === "folder") { dir = null; await saveHandle("live-folder", null); prefs.set("live.folderName", ""); }
  set(t, { status: "off", msg: "" });
}

export async function reconnect(t) {
  if (t === "drive") await drive.getToken();
  else if (!dir || st.folder.msg) return enable("folder");
  else if ((await dir.requestPermission({ mode: "readwrite" })) !== "granted") return;
  await refresh();
  return flushAll();
}
export const paused = () => TARGETS.filter((t) => st[t].status === "paused");

// After the app was in the background (see decksfolder.regain): the live save folder's access, asked for inside a
// tap. When it is the decks folder's "results", the decks folder's access (asked for first) already covers it.
export async function regain() {
  if (!isOn("folder")) return false;
  if (!dir && !folderLost) { const r = await loadHandle("live-folder"); dir = r.handle || null; folderLost = r.lost || false; }
  if (!dir) return false;
  try {
    if ((await dir.queryPermission({ mode: "readwrite" })) !== "granted" && (await dir.requestPermission({ mode: "readwrite" })) !== "granted") return false;
  } catch { return false; }
  await refresh();
  flushAll();
  return true;
}

async function refresh() {
  for (const t of TARGETS) {
    const r = await ready(t);
    if (r === "off") set(t, { status: "off" });
    else if (r !== "ready") set(t, { status: r });
    else if (["off", "paused", "offline"].includes(st[t].status)) set(t, { status: dirtyOf(t).size ? "saving" : "ok", at: prefs.get(`live.at.${t}`, "") });
  }
}

// ---------------------------------------------------------------- the status table (next to the answers, for the hooman's AI)
// hooman-status.<name>.json and .csv: one row per deck on this device: its zip in the decks folder, cards, answered,
// open, state, last answer, the answers file, when it was saved, and how far the AI got (processed.json, which the
// AI writes: {"files": {answers file name: {"up_to": newest answer time it used, ...}}}).
const STATUS_COLS = ["deck", "title", "zip", "cards", "answered", "open", "state", "last_answer_at", "answers_file", "saved_at", "processed_up_to", "new_since_processed"];
let statusTimer = null;
export function statusSoon() {
  if (!isOn("folder")) return;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { writeStatus().catch((e) => console.warn("live save: status table", e)); }, 2500);
}
async function writeStatus() {
  if ((await ready("folder")) !== "ready") return;
  let ledger = {};
  try { ledger = JSON.parse(await (await (await dir.getFileHandle("processed.json")).getFile()).text()).files || {}; } catch { /* none yet */ }
  const zipOf = {};
  for (const [name, v] of Object.entries(prefs.get("decks.seen", {}))) if (v && v.deck) zipOf[v.deck] = name;
  const rows = [];
  for (const rec of await store.listDecks()) {
    const answers = await store.answersOf(rec.key), cards = rec.deck.cards.length, file = fileName(rec.key), led = ledger[file];
    rows.push({
      deck: rec.key, title: rec.title, zip: zipOf[rec.key] || "", cards, answered: answers.length, open: Math.max(0, cards - answers.length),
      state: !answers.length ? "not started" : answers.length >= cards ? "done" : "in progress",
      last_answer_at: answers.reduce((m, a) => (a.at > m ? a.at : m), ""), answers_file: answers.length ? file : "",
      saved_at: lastSaved(rec.key), processed_up_to: led ? led.up_to || "" : "",
      new_since_processed: led ? answers.filter((a) => a.at > (led.up_to || "")).length : null,
    });
  }
  const base = `hooman-status.${fileSafe(annotator())}`;
  const json = { hooman_status: 1, updated_at: new Date().toISOString(), annotator: annotator(), app: APP_VERSION, columns: STATUS_COLS, decks: rows };
  const cell = (v) => (v === null || v === undefined ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const csv = [STATUS_COLS.join(","), ...rows.map((r) => STATUS_COLS.map((c) => cell(r[c])).join(","))].join("\n") + "\n";
  for (const [name, text] of [[`${base}.json`, JSON.stringify(json, null, 1)], [`${base}.csv`, csv]]) {
    const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
    await w.write(new Blob([text], { type: name.endsWith(".csv") ? "text/csv" : "application/json" })); await w.close();
  }
}

export async function start() {
  addEventListener("online", () => { refresh().then(flushAll); });
  document.addEventListener("visibilitychange", () => {          // leaving the app: save now, not in 4 s
    if (document.visibilityState === "hidden") for (const k of [...timers.keys()]) schedule(k, true);
  });
  if (!anyOn()) return;
  statusSoon();
  if (isOn("drive")) drive.warmUp();                            // so a "Reconnect" tap can open Google's sign-in at once
  await refresh();
  return flushAll();
}

// For tests and the status line: wait until nothing is scheduled or being written.
export async function settled() { while (timers.size) await new Promise((r) => setTimeout(r, 100)); await chain; }
