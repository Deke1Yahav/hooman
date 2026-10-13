// The decks folder: the hooman picks a folder once (on a computer it can be a Google Drive, OneDrive or Dropbox
// folder synced by their app) and every deck zip put in it shows up in the app by itself. It is checked when the
// app opens, when it comes back to the front, and on "Check now":
//   - a new zip is imported (big ones open at once and load in the background, see loading.js);
//   - a zip that changed since it was last seen updates its deck, keeping the answers; the deck on screen waits;
//   - a deck that was still loading when the app closed resumes from its zip here.
// Answer exports (*.answers.zip), backups and other files are skipped; the "results" subfolder is live save's.
// A browser can't watch a folder in the background, and reading it needs the hooman's permission: when that
// lapses, the folder pauses until a tap on Reconnect (which runs inside the tap).
import * as store from "./store.js";
import { prefs } from "./prefs.js";
import { importBlob, saveDeck, loadInBackground } from "./importer.js";
import { loadingOf } from "./loading.js";
import { loadHandle, saveHandle } from "./handles.js";

export const supported = () => typeof window.showDirectoryPicker === "function";
const NAME = "decks-folder", AGAIN = 20000;

// status: off | checking | ok | paused; found: zips seen; added / updated: deck titles from the last check;
// errors: [{name, errors}] for zips that aren't decks
const st = { status: "off", at: "", msg: "", note: "", found: 0, skipped: 0, added: [], updated: [], errors: [] };
const listeners = new Set();
let dir = null, lost = false, running = null, lastRun = 0;

export const status = () => st;
export const isOn = () => supported() && prefs.get("decks.on", false);
export const folderName = () => (dir ? dir.name : prefs.get("decks.name", ""));
export function onStatus(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function set(patch) { Object.assign(st, patch); listeners.forEach((fn) => { try { fn(st); } catch (e) { console.error(e); } }); }

async function folder() {
  if (!dir && !lost) { const r = await loadHandle(NAME); dir = r.handle || null; lost = r.lost || false; }
  if (!dir) return null;
  try { return (await dir.queryPermission({ mode: "readwrite" })) === "granted" ? dir : null; } catch { return null; }
}

// From a tap: pick the folder, then check it.
export async function choose() {
  const h = await window.showDirectoryPicker({ id: "hooman-decks", mode: "readwrite", startIn: "documents" });
  dir = h; lost = false;
  prefs.set("decks.on", true); prefs.set("decks.name", h.name); prefs.set("decks.seen", {});
  set({ status: "checking", msg: `Looking for decks in “${h.name}”…`, note: "" });
  try { await saveHandle(NAME, h); }
  catch (e) { console.warn("decks folder: could not keep the folder", e); set({ note: "This browser couldn't remember the folder, so it is used until the app closes." }); }
  return check({ force: true });
}
export async function turnOff() {
  dir = null; await saveHandle(NAME, null);
  prefs.set("decks.on", false); prefs.set("decks.name", ""); prefs.set("decks.seen", {});
  set({ status: "off", msg: "", found: 0, added: [], updated: [], errors: [] });
}
export async function reconnect() {
  if (!dir || lost) return choose();
  if ((await dir.requestPermission({ mode: "readwrite" })) !== "granted") return;
  return check({ force: true });
}
// The decks folder's "results" subfolder, for live save.
export async function resultsFolder() {
  const d = await folder();
  if (!d) throw new Error("the decks folder isn't connected: tap Reconnect first");
  return d.getDirectoryHandle("results", { create: true });
}

const isDeckZip = (name) => /\.zip$/i.test(name) && !/\.answers\.zip$/i.test(name) && !/^hooman-backup/i.test(name) && !name.startsWith(".");

// Every deck zip in the folder and its subfolders (4 levels; "results" and hidden folders skipped), named by their
// path inside the folder ("project/deck.hooman.zip"), newest first: when the same deck has an older copy beside it,
// the newest one is taken.
async function deckZips(d) {
  const out = [];
  const walk = async (h, prefix, depth) => {
    for await (const [name, e] of h.entries()) {
      if (e.kind === "directory") { if (depth < 4 && name !== "results" && !name.startsWith(".")) await walk(e, `${prefix}${name}/`, depth + 1); }
      else if (isDeckZip(name)) out.push({ name: prefix + name, file: await e.getFile() });
      else if (/\.answers\.zip$|^hooman-status\.|^processed\.json$/i.test(name)) skipped++;
    }
  };
  let skipped = 0;
  await walk(d, "", 0);
  return Object.assign(out.sort((a, b) => b.file.lastModified - a.file.lastModified), { skipped });
}

// openKey: the deck on screen (not updated under the hooman's hands; the next check takes it).
export function check({ force = false, openKey = null } = {}) {
  if (!isOn()) return Promise.resolve();
  if (running) return running;
  if (!force && Date.now() - lastRun < AGAIN) return Promise.resolve();
  running = (async () => {
    try {
      const d = await folder();
      if (!d) return set({ status: "paused", msg: lost || (dir ? "" : "Tap Reconnect to choose the folder again.") });
      set({ status: "checking", msg: `Looking for decks in “${d.name}”…` });
      const seen = prefs.get("decks.seen", {}), added = [], updated = [], errors = [];
      const zips = await deckZips(d), skipped = zips.skipped;
      let found = 0;
      for (const { name, file } of zips) {
        found++;
        const was = seen[name];
        const changed = !was || was.mod !== file.lastModified || was.size !== file.size;
        const resume = was && was.deck && loadingOf(was.deck) && !loadingOf(was.deck).active;
        if (!changed && !resume) { if (was.errors) errors.push({ name, errors: was.errors }); continue; }
        set({ msg: `Reading ${name.split("/").pop()} (${found} of ${zips.length}${file.size > 5e6 ? `, ${Math.round(file.size / 1e6)} MB: files on Drive download first` : ""})…` });
        const r = await take(file, was, openKey);
        if (r.later) continue;                                    // the deck on screen: next check
        seen[name] = { mod: file.lastModified, size: file.size, deck: r.deck, errors: r.errors };
        if (r.errors) errors.push({ name, errors: r.errors });
        if (r.added) added.push(r.added);
        if (r.updated) updated.push(r.updated);
        prefs.set("decks.seen", seen);
      }
      lastRun = Date.now();
      set({ status: "ok", msg: "", at: new Date().toISOString(), found, skipped, added, updated, errors });
    } catch (e) {
      if (e && (e.name === "NotAllowedError" || e.name === "SecurityError")) set({ status: "paused", msg: "" });
      else if (e && e.name === "NotFoundError") { dir = null; set({ status: "paused", msg: "The folder is gone: tap Reconnect to choose it again." }); }
      else set({ status: "ok", errors: [{ name: folderName(), errors: [(e && e.message) || String(e)] }] });
    } finally { running = null; }
  })();
  return running;
}

// One zip: import it, update its deck, or resume its loading.
async function take(file, was, openKey) {
  let imported;
  try { imported = await importBlob(file); }
  catch (e) { return { errors: e.errors || [e.message || String(e)] }; }
  const id = imported.deck.id, existing = await store.getDeck(id);
  if (existing && id === openKey) return { later: true };
  if (!existing) { const rec = await saveDeck(imported, "new"); return { deck: rec.key, added: rec.title }; }
  const lo = loadingOf(id);
  if (lo && !lo.active && imported.lazy && was && was.deck === id && was.mod === file.lastModified) {
    loadInBackground(existing, imported.lazy);                  // same zip, deck not fully saved: finish it
    return { deck: id };
  }
  // First sight of a deck that is already here: update only if the zip is newer than the deck on the phone.
  if (!was && Date.parse(existing.updatedAt || 0) >= file.lastModified) return { deck: id };
  const rec = await saveDeck(imported, "update", existing);
  return { deck: rec.key, updated: rec.title };
}

// openKey(): the key of the deck on screen, if any.
export function start(openKey) {
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") check({ openKey: openKey() }); });
  check({ force: true, openKey: openKey() });
}
