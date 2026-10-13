// The decks folder: the hooman picks a folder once (on a computer it can be a Google Drive, OneDrive or Dropbox
// folder synced by their app) and every deck zip put in it shows up in the app. It is checked when the app opens,
// when it comes back to the front, and on "Check now":
//   - a new zip is imported (big ones open at once and load in the background, see loading.js). On a phone, a zip
//     over AUTO_MAX waits for a tap instead ("available"): a Google Drive folder there downloads every zip in full
//     before it can be read, and a dozen decks would be hundreds of MB on mobile data;
//   - a zip that changed since it was last seen updates its deck, keeping the answers; the deck on screen waits;
//   - a deck that was still being saved when the app closed finishes from its zip here.
// Answer exports (*.answers.zip), backups and other files are skipped; the "results" subfolder is live save's.
// Every step that waits on the folder has a time limit (counted only while the app is on screen), and a check can be
// stopped: a slow Google Drive ends a check with "couldn't reach the folder, tap to try again", never a check that
// hangs, and never with a zip blamed for it. Reading the folder needs the hooman's permission; when that lapses, it
// pauses until a tap on Reconnect (which runs inside the tap).
import * as store from "./store.js";
import { prefs } from "./prefs.js";
import { importBlob, saveDeck, loadInBackground } from "./importer.js";
import { loadingOf } from "./loading.js";
import { loadHandle, saveHandle } from "./handles.js";

export const supported = () => typeof window.showDirectoryPicker === "function";
const NAME = "decks-folder", AGAIN = 120000;          // background checks (app opened or back in front): at most this often
const PHONE = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
const autoMax = () => prefs.get("decks.autoMax", PHONE ? 5e6 : Infinity);
const MB = (n) => `${n >= 1e7 ? Math.round(n / 1e6) : (n / 1e6).toFixed(1)} MB`;
const short = (name) => name.split("/").pop();

// status: off | checking | ok | paused; found: deck zips seen; added / updated: deck titles from the last check;
// errors: [{name, errors}] zips that aren't decks (an AI can fix those); fail: the last check couldn't read the folder
// or a zip in it (Drive slow or offline: not the zips' fault), failAt its time; available: [{name, size, update}] zips
// waiting for a tap (phones)
const st = { status: "off", at: "", msg: "", note: "", quiet: false, found: 0, skipped: 0, added: [], updated: [], errors: [], fail: "", failAt: "",
             available: prefs.get("decks.available", []) };
const listeners = new Set(), handles = new Map();     // zip name -> file handle, from the last listing (this session)
let dir = null, lost = false, running = null, lastRun = 0, runId = 0;

export const status = () => st;
export const isOn = () => supported() && prefs.get("decks.on", false);
export const folderName = () => (dir ? dir.name : prefs.get("decks.name", ""));
export function onStatus(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function set(patch) { Object.assign(st, patch); listeners.forEach((fn) => { try { fn(st); } catch (e) { console.error(e); } }); }

// The zip a deck came from (for "finish from the decks folder").
export function zipOf(deckKey) {
  let best = null;
  for (const [name, v] of Object.entries(prefs.get("decks.seen", {}))) if (v && v.deck === deckKey && (!best || v.mod > best.mod)) best = { name, mod: v.mod };
  return best ? best.name : "";
}

// A time limit that counts only while the app is on screen: a phone freezes a page in the background, and the folder's
// answer waits with it, so time spent there is no sign that Drive is slow.
let hiddenMs = 0, hiddenAt = document.visibilityState === "hidden" ? performance.now() : 0;
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") { if (!hiddenAt) hiddenAt = performance.now(); }
  else if (hiddenAt) { hiddenMs += performance.now() - hiddenAt; hiddenAt = 0; }
});
const hiddenNow = () => hiddenMs + (hiddenAt ? performance.now() - hiddenAt : 0);
function within(p, ms, what) {
  let t;
  const t0 = performance.now(), h0 = hiddenNow();
  return Promise.race([p, new Promise((_, rej) => {
    const arm = (wait) => { t = setTimeout(() => {
      const left = ms - (performance.now() - t0 - (hiddenNow() - h0));
      if (left > 200 || document.visibilityState === "hidden") return arm(Math.max(left, 1000));
      rej(Object.assign(new Error(`${what} didn't answer within ${Math.round(ms / 1000)} s`), { name: "TimeoutError" }));
    }, wait); };
    arm(ms);
  })]).finally(() => clearTimeout(t));
}
const listMs = () => prefs.get("decks.listMs", 30000);         // one folder's next entry; asked again once, for 1.5×

async function folder() {
  if (!dir && !lost) { const r = await loadHandle(NAME); dir = r.handle || null; lost = r.lost || false; }
  if (!dir) return null;
  try { return (await within(dir.queryPermission({ mode: "readwrite" }), 15000, "The folder")) === "granted" ? dir : null; } catch { return null; }
}

// From a tap: pick the folder, then check it.
export async function choose() {
  const h = await window.showDirectoryPicker({ id: "hooman-decks", mode: "readwrite", startIn: "documents" });
  dir = h; lost = false;
  prefs.set("decks.on", true); prefs.set("decks.name", h.name); prefs.set("decks.seen", {}); prefs.set("decks.available", []);
  set({ status: "checking", quiet: false, msg: `Looking for decks in “${h.name}”…`, note: "", available: [] });
  try { await saveHandle(NAME, h); }
  catch (e) { console.warn("decks folder: could not keep the folder", e); set({ note: "This browser couldn't remember the folder, so it is used until the app closes." }); }
  return check({ force: true, fresh: true });
}
export async function turnOff() {
  stop(true);
  dir = null; await saveHandle(NAME, null);
  prefs.set("decks.on", false); prefs.set("decks.name", ""); prefs.set("decks.seen", {}); prefs.set("decks.available", []);
  set({ status: "off", msg: "", note: "", found: 0, added: [], updated: [], errors: [], available: [] });
}
// From a tap: ask again for access; a check that hung is dropped and a new one starts.
export async function reconnect() {
  if (!dir || lost) return choose();
  let p = "denied";
  try { p = await dir.requestPermission({ mode: "readwrite" }); } catch (e) { console.warn("decks folder: permission", e); }
  if (p !== "granted") {
    set({ status: "paused", msg: "The phone didn't give access. In Settings, tap Turn off, then Choose a folder to pick it again." });
    return "denied";
  }
  return check({ force: true, fresh: true });
}
// Chrome drops folder access when the app has been in the background a while (one-time permissions). Called
// inside the hooman's next tap: asks for it again (a phone that kept the permission answers at once, no prompt).
export async function regain() {
  if (!isOn()) return false;
  if (!dir && !lost) { const r = await loadHandle(NAME); dir = r.handle || null; lost = r.lost || false; }
  if (!dir) return false;
  try {
    if ((await dir.queryPermission({ mode: "readwrite" })) === "granted") return true;
    if ((await dir.requestPermission({ mode: "readwrite" })) !== "granted") return false;
  } catch { return false; }
  check({ force: true, fresh: true, quiet: true });
  return true;
}

// Drop the running check or load (its results are ignored if it ever finishes).
export function stop(silent = false) {
  runId++; running = null;
  if (!silent) set({ status: "ok", msg: "", quiet: false, note: "Stopped. Tap Check now to try again." });
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
// the newest one is taken. Subfolders are listed, and files asked for their size and date, several at a time: on a
// phone each of these can wait on the network (a Google Drive folder). A listing that stalls is asked for once more from
// the start (Drive often answers the second time), then the check ends with "couldn't reach".
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]); }));
}
async function entriesOf(h, label, onSlow) {
  for (let again = 0; ; again++) {
    const got = [], it = h.entries();
    try {
      for (;;) {
        const { value, done } = await within(it.next(), again ? listMs() * 1.5 : listMs(), `Listing “${label}”`);
        if (done) return got;
        got.push(value);
      }
    } catch (e) { if (e.name !== "TimeoutError" || again) throw e; onSlow(label); }
  }
}
async function deckZips(d, onFound, onSlow = () => {}) {
  const out = [];
  let skipped = 0;
  const t0 = performance.now();
  const list = async (h, prefix, depth) => {
    const subs = [];
    for (const [name, e] of await entriesOf(h, prefix ? prefix.slice(0, -1) : d.name, onSlow)) {
      if (e.kind === "directory") { if (depth < 4 && name !== "results" && !name.startsWith(".")) subs.push(list(e, `${prefix}${name}/`, depth + 1)); }
      else if (isDeckZip(name)) { out.push({ name: prefix + name, handle: e }); onFound(out.length); }
      else if (/\.answers\.zip$|^hooman-status\.|^processed\.json$/i.test(name)) skipped++;
    }
    await Promise.all(subs);
  };
  await list(d, "", 0);
  const t1 = performance.now();
  await pool(out, 6, async (z) => {
    try { z.file = await within(z.handle.getFile(), 60000, `Getting ${short(z.name)}`); }
    catch (e) { if (e.name !== "TimeoutError" && e.name !== "NotReadableError") throw e; z.unread = `${short(z.name)}: ${e.message}`; }
  });
  const t2 = performance.now();
  const zips = out.filter((z) => z.file).sort((x, y) => y.file.lastModified - x.file.lastModified);
  return Object.assign(zips, { skipped, unread: out.filter((z) => !z.file).map((z) => ({ name: z.name, msg: z.unread })), timing: { list: t1 - t0, info: t2 - t1 } });
}

// The folder couldn't be read: paused (needs a tap: permission, folder gone) or fail (try again later). The zips'
// own errors from the last check stay as they were.
function failed(e, mine) {
  if (e && (e.name === "NotAllowedError" || e.name === "SecurityError")) mine({ status: "paused", msg: "", quiet: false, fail: "" });
  else if (e && e.name === "NotFoundError") { dir = null; mine({ status: "paused", quiet: false, fail: "", msg: "The folder is gone: tap Reconnect to choose it again." }); }
  else mine({ status: "ok", msg: "", quiet: false, failAt: new Date().toISOString(),
              fail: `${((e && e.message) || String(e)).replace(/\.$/, "")}. ${e && e.name === "TimeoutError" ? "Google Drive may be slow or offline: try" : "Try"} again in a minute.` });
}

// openKey: the deck on screen (not updated under the hooman's hands; the next check takes it).
// quiet: a background check (no progress banner on the home screen). fresh: drop a check that may have hung.
export function check({ force = false, openKey = null, quiet = false, fresh = false } = {}) {
  if (!isOn()) return Promise.resolve();
  if (fresh) stop(true);
  if (running) return running;
  if (!force && Date.now() - lastRun < AGAIN) return Promise.resolve();
  const my = ++runId, mine = (patch) => { if (my === runId) set(patch); };
  running = (async () => {
    try {
      const d = await folder();
      if (my !== runId) return;
      if (!d) return mine({ status: "paused", quiet: false, fail: "", msg: lost || (dir ? "" : "Tap Reconnect to choose the folder again.") });
      const t0 = performance.now();
      mine({ status: "checking", quiet, msg: `Looking for decks in “${d.name}”…`, note: "" });
      const zips = await deckZips(d, (n) => mine({ msg: `Looking for decks in “${d.name}”… ${n} found` }),
                                  (label) => mine({ msg: `Google Drive is slow. Asking again for “${label}”…` }));
      if (my !== runId) return;
      handles.clear(); zips.forEach((z) => handles.set(z.name, z.handle));
      const seen = prefs.get("decks.seen", {}), decks = new Set((await store.listDecks()).map((r) => r.key));
      const added = [], updated = [], errors = [], unread = zips.unread.map((u) => u.msg);
      const available = st.available.filter((a) => zips.unread.some((u) => u.name === a.name));   // still waiting: Drive didn't say
      let found = 0, reading = 0;
      for (const { name, file } of zips) {
        found++;
        let was = seen[name];
        const base = short(name).replace(/\.hooman\.zip$|\.zip$/i, "");
        if (!was && decks.has(base)) {                         // a deck already on the phone, imported by hand: known
          const rec = await store.getDeck(base);
          if (Date.parse(rec.updatedAt || 0) >= file.lastModified) { seen[name] = was = { mod: file.lastModified, size: file.size, deck: base }; prefs.set("decks.seen", seen); }
        }
        if (was && was.hidden && was.mod === file.lastModified) continue;          // hidden by the hooman, until it changes
        if (was && was.removed && was.mod === file.lastModified) { available.push({ name, size: file.size, mod: file.lastModified, update: false }); continue; }
        // (before 0.11.4 a zip that couldn't be read was kept as broken: read again)
        const changed = !was || was.mod !== file.lastModified || was.size !== file.size
          || (was.errors && was.errors.some((m) => /could not read the zip|could not be read/i.test(m)));
        const resume = was && was.deck && loadingOf(was.deck) && !loadingOf(was.deck).active;
        if (!changed && !resume) { if (was.errors) errors.push({ name, errors: was.errors }); continue; }
        if (!resume && file.size > autoMax()) { available.push({ name, size: file.size, mod: file.lastModified, update: !!(was && was.deck) }); continue; }
        mine({ msg: `Reading ${short(name)} (${found} of ${zips.length}${file.size > 5e6 ? `, ${MB(file.size)}: files on Drive download first` : ""})…` });
        const r0 = performance.now();
        let r;
        try { r = await within(take(file, was, openKey), 15 * 60000, `Reading ${short(name)}`); }
        catch (e) { if (e.name !== "TimeoutError") throw e; r = { unread: e.message }; }
        reading += performance.now() - r0;
        if (my !== runId) return;
        if (r.later) continue;                                  // the deck on screen: next check
        if (r.unread) { unread.push(r.unread); continue; }       // not kept as seen: read again next check
        seen[name] = { mod: file.lastModified, size: file.size, deck: r.deck, errors: r.errors };
        if (r.errors) errors.push({ name, errors: r.errors });
        if (r.added) added.push(r.added);
        if (r.updated) updated.push(r.updated);
        prefs.set("decks.seen", seen);
      }
      lastRun = Date.now();
      prefs.set("decks.available", available);
      const at = new Date().toISOString();
      mine({ status: "ok", msg: "", quiet: false, at, found, skipped: zips.skipped, added, updated, errors, available,
             fail: unread.length ? `${unread.join("; ")}. Google Drive may be slow, or the zip is still uploading: try again in a minute.` : "", failAt: unread.length ? at : "",
             timing: { ...zips.timing, reading, total: performance.now() - t0 } });
    } catch (e) {
      if (my === runId) failed(e, mine);
    } finally { if (my === runId) running = null; }
  })();
  return running;
}

// From a tap: load one zip that was waiting ("tap to load"), or finish a deck's saving from its zip.
// Resolves the deck's key (or null).
export function load(name, openKey = null) {
  stop(true);
  const my = ++runId, mine = (patch) => { if (my === runId) set(patch); };
  running = (async () => {
    try {
      let h = handles.get(name);
      if (!h) {                                                 // after a restart: list the folder first (no downloads)
        const d = await folder();
        if (!d) { mine({ status: "paused", quiet: false, msg: "" }); return null; }
        mine({ status: "checking", quiet: false, msg: `Looking for ${short(name)}…` });
        (await deckZips(d, () => {}, (label) => mine({ msg: `Google Drive is slow. Asking again for “${label}”…` }))).forEach((z) => handles.set(z.name, z.handle));
        h = handles.get(name);
      }
      if (!h) throw new Error(`${short(name)} isn't in the decks folder any more`);
      const file = await within(h.getFile(), 60000, `Getting ${short(name)}`);
      mine({ status: "checking", quiet: false, msg: `Loading ${short(name)} (${MB(file.size)} from your folder)…` });
      const seen = prefs.get("decks.seen", {});
      const r = await take(file, seen[name], openKey, true);
      if (my !== runId) return null;
      if (r.unread) {                                           // still waits for a tap
        mine({ status: "ok", msg: "", quiet: false, failAt: new Date().toISOString(), fail: `${r.unread}. Google Drive may be slow or offline: try again in a minute.` });
        return null;
      }
      const available = st.available.filter((a) => a.name !== name);
      if (!r.later) { seen[name] = { mod: file.lastModified, size: file.size, deck: r.deck, errors: r.errors }; prefs.set("decks.seen", seen); }
      prefs.set("decks.available", available);
      mine({ status: "ok", msg: "", quiet: false, fail: "", available, added: r.added ? [r.added] : [], updated: r.updated ? [r.updated] : [],
             errors: [...st.errors.filter((x) => x.name !== name), ...(r.errors ? [{ name, errors: r.errors }] : [])] });
      return r.deck || null;
    } catch (e) {
      if (my === runId) failed(e, mine);
      return null;
    } finally { if (my === runId) running = null; }
  })();
  return running;
}

// A deck from the folder was deleted from the phone: its zip goes back to "tap to load" (never loaded by itself).
export function removed(deckKey) {
  const seen = prefs.get("decks.seen", {}), available = st.available.slice();
  for (const [name, v] of Object.entries(seen)) {
    if (!v || v.deck !== deckKey) continue;
    seen[name] = { ...v, removed: true };
    if (!available.some((a) => a.name === name)) available.push({ name, size: v.size, mod: v.mod, update: false });
  }
  prefs.set("decks.seen", seen); prefs.set("decks.available", available);
  set({ available });
}
// "Hide from this list": a zip waiting for a tap stays out of the list until it changes.
export function hide(name) {
  const a = st.available.find((x) => x.name === name), seen = prefs.get("decks.seen", {});
  seen[name] = { ...(seen[name] || {}), mod: a ? a.mod : (seen[name] || {}).mod, size: a ? a.size : 0, hidden: true };
  const available = st.available.filter((x) => x.name !== name);
  prefs.set("decks.seen", seen); prefs.set("decks.available", available);
  set({ available });
}

// One zip: import it, update its deck, or finish its saving. asked: the hooman tapped it (update even if not newer).
// unread: the zip couldn't be read (Drive, the phone): not an error of the zip, tried again next time.
async function take(file, was, openKey, asked = false) {
  let imported;
  try { imported = await importBlob(file); }
  catch (e) {
    if (e.errors && !e.io) return { errors: e.errors };
    const m = (e.errors && e.errors[0]) || e.message || String(e);
    return { unread: m.startsWith(file.name) ? m : `${file.name}: ${m}` };
  }
  const id = imported.deck.id, existing = await store.getDeck(id);
  if (!existing) { const rec = await saveDeck(imported, "new"); return { deck: rec.key, added: rec.title }; }
  const lo = loadingOf(id);
  // The deck wasn't fully saved, or (asked: "Finish now") it has no saved zip yet, as decks loaded by 0.7 card by
  // card, where cards whose files couldn't be read are missing: save this zip whole, which fills them in.
  if (imported.lazy && ((lo && !lo.active) || (asked && !(await store.hasArchive(id))))) {
    loadInBackground(existing, imported.lazy);                  // saving never changes the deck: fine while it is open
    return { deck: id };
  }
  if (id === openKey) return { later: true };                   // an update waits until the deck isn't on screen
  // First sight of a deck that is already here: update only if the zip is newer than the deck on the phone.
  if (!asked && !was && Date.parse(existing.updatedAt || 0) >= file.lastModified) return { deck: id };
  if (asked && was && was.deck === id && was.mod === file.lastModified && !lo) return { deck: id };
  const rec = await saveDeck(imported, "update", existing);
  return { deck: rec.key, updated: rec.title };
}

// openKey(): the key of the deck on screen, if any.
export function start(openKey) {
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") check({ openKey: openKey(), quiet: true }); });
  check({ force: true, openKey: openKey(), quiet: true });
}
