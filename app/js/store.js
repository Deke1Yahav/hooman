// IndexedDB storage. Everything lives on this device.
//   decks:   {key, deck (normalized), title, importedAt, updatedAt, origin, custom?, order?, lastCard?}
//   files:   {deck, path, blob}                         key [deck, path]; big decks: their whole zip at path ARCHIVE
//   answers: {deck, card, answer, label, at, ms, changes, mask?: Blob}   key [deck, card]  (current answer)
//   log:     {deck, card, answer|null, at, undo?}       append-only history, never edited
//   notes:   {deck, card, text, at, by}                 key [deck, card]  (v2)

import { readZip } from "./zip.js";

const DB_NAME = "hooman", DB_VERSION = 2;
let dbp;

function req(r) {
  return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}
function done(tx) {
  return new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error || new Error("aborted")); });
}

export function db() {
  if (!dbp) dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = (e) => {
      const d = r.result;
      if (e.oldVersion < 1) {
        d.createObjectStore("decks", { keyPath: "key" });
        d.createObjectStore("files", { keyPath: ["deck", "path"] }).createIndex("deck", "deck");
        d.createObjectStore("answers", { keyPath: ["deck", "card"] }).createIndex("deck", "deck");
        d.createObjectStore("log", { autoIncrement: true }).createIndex("deck", "deck");
      }
      if (e.oldVersion < 2) d.createObjectStore("notes", { keyPath: ["deck", "card"] }).createIndex("deck", "deck");
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.onblocked = () => rej(new Error("storage is blocked by another open tab of this app; close it and reload"));
  });
  return dbp;
}

export async function listDecks() {
  const d = await db();
  return req(d.transaction("decks").objectStore("decks").getAll());
}
export async function getDeck(key) {
  const d = await db();
  return req(d.transaction("decks").objectStore("decks").get(key));
}
export async function putDeck(rec) {
  const d = await db();
  const tx = d.transaction("decks", "readwrite");
  tx.objectStore("decks").put(rec);
  return done(tx);
}

// files: [{path, blob}] written in batches so a big import doesn't hold one huge transaction.
export async function putFiles(deckKey, files) {
  const d = await db();
  for (let i = 0; i < files.length; i += 50) {
    const tx = d.transaction("files", "readwrite"), st = tx.objectStore("files");
    for (const f of files.slice(i, i + 50)) st.put({ deck: deckKey, path: f.path, blob: f.blob });
    await done(tx);
  }
}
export async function getFile(deckKey, path) {
  if (sessions.has(deckKey) || (await archiveOf(deckKey))) {     // a big deck: straight from its zip
    const b = await fromArchive(deckKey, path);
    if (b) return b;
  }
  const d = await db();
  const r = await req(d.transaction("files").objectStore("files").get([deckKey, path]));
  return r ? r.blob : null;
}

// Big decks keep their zip whole, as one record: saving it is a single straight copy (the fastest thing phone
// storage does), and a card's images are read out of it when the card is shown. Until that copy is saved, they
// come from the zip the hooman picked (useSession). Small decks store each image as its own record, as before.
export const ARCHIVE = "\u0000deck.zip";
const sessions = new Map(), archives = new Map();
export function useSession(deckKey, get) { sessions.set(deckKey, get); }
export async function putArchive(deckKey, blob) {
  const d = await db();
  const tx = d.transaction("files", "readwrite");
  tx.objectStore("files").put({ deck: deckKey, path: ARCHIVE, blob });
  await done(tx);
  archives.delete(deckKey);
}
function archiveOf(deckKey) {
  if (!archives.has(deckKey)) {
    archives.set(deckKey, (async () => {
      const d = await db();
      const r = await req(d.transaction("files").objectStore("files").get([deckKey, ARCHIVE]));
      if (!r) return null;
      const files = await readZip(r.blob);
      const top = [...files.keys()].filter((n) => n === "deck.json" || n.endsWith("/deck.json")).sort((a, b) => a.length - b.length)[0] || "deck.json";
      return { files, root: top.slice(0, -"deck.json".length) };
    })().catch(() => null));
  }
  return archives.get(deckKey);                 // null (no zip: a small deck) is remembered too
}
async function fromArchive(deckKey, path) {
  const s = sessions.get(deckKey);
  if (s) { try { const b = await s(path); if (b) return b; } catch { /* not in the picked zip: try the saved one */ } }
  const a = await archiveOf(deckKey);
  const e = a && a.files.get(a.root + path);
  return e ? e.blob() : null;
}

export async function answersOf(deckKey) {
  const d = await db();
  return req(d.transaction("answers").objectStore("answers").index("deck").getAll(deckKey));
}
export async function logOf(deckKey) {
  const d = await db();
  return req(d.transaction("log").objectStore("log").index("deck").getAll(deckKey));
}

// Live save listens here: fn(deckKey, "user" | "restore") after every answer, note or restore that touches a deck.
const watchers = new Set();
export function onDeckChange(fn) { watchers.add(fn); return () => watchers.delete(fn); }
const changed = (deckKey, why) => watchers.forEach((fn) => { try { fn(deckKey, why); } catch (e) { console.error(e); } });

// rec null = card back to unanswered. The history entry is written in the same transaction.
export async function setAnswer(deckKey, card, rec, logEntry) {
  const d = await db();
  const tx = d.transaction(["answers", "log"], "readwrite");
  if (rec) tx.objectStore("answers").put({ ...rec, deck: deckKey, card });
  else tx.objectStore("answers").delete([deckKey, card]);
  tx.objectStore("log").add({ ...logEntry, deck: deckKey, card });
  await done(tx);
  changed(deckKey, "user");
}

async function deleteByIndex(store, deckKey) {
  const d = await db();
  const tx = d.transaction(store, "readwrite"), st = tx.objectStore(store);
  const keys = await req(st.index("deck").getAllKeys(deckKey));
  for (const k of keys) st.delete(k);
  return done(tx);
}

// Notes: one free-text note per card, separate from the answer (a card can have a note before it is answered).
export async function notesOf(deckKey) {
  const d = await db();
  return req(d.transaction("notes").objectStore("notes").index("deck").getAll(deckKey));
}
export async function setNote(deckKey, card, text, by) {
  const d = await db();
  const tx = d.transaction("notes", "readwrite");
  if (text && text.trim()) tx.objectStore("notes").put({ deck: deckKey, card, text: text.trim(), at: new Date().toISOString(), by });
  else tx.objectStore("notes").delete([deckKey, card]);
  await done(tx);
  changed(deckKey, "user");
}

// Restore: write answers / notes as they are, and add history entries (no new log lines of our own).
export async function putRaw(store, records) {
  const d = await db();
  for (let i = 0; i < records.length; i += 200) {
    const tx = d.transaction(store, "readwrite"), st = tx.objectStore(store);
    for (const r of records.slice(i, i + 200)) st.put(r);
    await done(tx);
  }
  if (store === "answers" || store === "notes") new Set(records.map((r) => r.deck)).forEach((k) => changed(k, "restore"));
}
export async function addLog(entries) {
  const d = await db();
  for (let i = 0; i < entries.length; i += 200) {
    const tx = d.transaction("log", "readwrite"), st = tx.objectStore("log");
    for (const r of entries.slice(i, i + 200)) st.add(r);
    await done(tx);
  }
}
// Every image of a deck (for sharing and backups): its own records, plus a big deck's images out of its zip.
export async function filesOf(deckKey) {
  const d = await db();
  const own = (await req(d.transaction("files").objectStore("files").index("deck").getAll(deckKey))).filter((f) => f.path !== ARCHIVE);
  const a = await archiveOf(deckKey);
  if (!a) return own;
  const have = new Set(own.map((f) => f.path));
  for (const [name, e] of a.files) {
    const path = name.slice(a.root.length);
    if (!name.startsWith(a.root) || have.has(path) || !/\.(png|jpe?g|webp|gif)$/i.test(path)) continue;
    own.push({ deck: deckKey, path, blob: await e.blob() });
  }
  return own;
}

// Removes a deck with its images, answers, notes and history.
export async function deleteDeck(deckKey) {
  archives.delete(deckKey); sessions.delete(deckKey);
  for (const s of ["files", "answers", "log", "notes"]) await deleteByIndex(s, deckKey);
  const d = await db();
  const tx = d.transaction("decks", "readwrite");
  tx.objectStore("decks").delete(deckKey);
  return done(tx);
}

// Replacing a deck's images (an update import) keeps answers and history.
export async function clearFiles(deckKey) {
  archives.delete(deckKey); sessions.delete(deckKey);
  return deleteByIndex("files", deckKey);
}

export async function askPersistent() {
  try { if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist(); } catch {}
  return false;
}
