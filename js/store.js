// IndexedDB storage. Everything lives on this device.
//   decks:   {key, deck (normalized), title, importedAt, updatedAt, origin, custom?, order?, lastCard?}
//   files:   {deck, path, blob}                         key [deck, path]
//   answers: {deck, card, answer, label, at, ms, changes, mask?: Blob}   key [deck, card]  (current answer)
//   log:     {deck, card, answer|null, at, undo?}       append-only history, never edited

const DB_NAME = "hooman", DB_VERSION = 1;
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
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore("decks", { keyPath: "key" });
      d.createObjectStore("files", { keyPath: ["deck", "path"] }).createIndex("deck", "deck");
      d.createObjectStore("answers", { keyPath: ["deck", "card"] }).createIndex("deck", "deck");
      d.createObjectStore("log", { autoIncrement: true }).createIndex("deck", "deck");
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
  const d = await db();
  const r = await req(d.transaction("files").objectStore("files").get([deckKey, path]));
  return r ? r.blob : null;
}

export async function answersOf(deckKey) {
  const d = await db();
  return req(d.transaction("answers").objectStore("answers").index("deck").getAll(deckKey));
}
export async function logOf(deckKey) {
  const d = await db();
  return req(d.transaction("log").objectStore("log").index("deck").getAll(deckKey));
}

// rec null = card back to unanswered. The history entry is written in the same transaction.
export async function setAnswer(deckKey, card, rec, logEntry) {
  const d = await db();
  const tx = d.transaction(["answers", "log"], "readwrite");
  if (rec) tx.objectStore("answers").put({ ...rec, deck: deckKey, card });
  else tx.objectStore("answers").delete([deckKey, card]);
  tx.objectStore("log").add({ ...logEntry, deck: deckKey, card });
  return done(tx);
}

async function deleteByIndex(store, deckKey) {
  const d = await db();
  const tx = d.transaction(store, "readwrite"), st = tx.objectStore(store);
  const keys = await req(st.index("deck").getAllKeys(deckKey));
  for (const k of keys) st.delete(k);
  return done(tx);
}

// Removes a deck with its images, answers and history.
export async function deleteDeck(deckKey) {
  for (const s of ["files", "answers", "log"]) await deleteByIndex(s, deckKey);
  const d = await db();
  const tx = d.transaction("decks", "readwrite");
  tx.objectStore("decks").delete(deckKey);
  return done(tx);
}

// Replacing a deck's images (an update import) keeps answers and history.
export async function clearFiles(deckKey) {
  return deleteByIndex("files", deckKey);
}

export async function askPersistent() {
  try { if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist(); } catch {}
  return false;
}
