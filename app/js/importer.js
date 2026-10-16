// Import a deck from a zip file, a lone deck.json (https images only) or a link.
// Nothing is saved here: the caller decides new / update / copy, then calls saveDeck().

import { readZip, mimeOf, ZipError } from "./zip.js";
import { imageSize } from "./png.js";
import { normalizeDeck } from "./deck.js";
import * as store from "./store.js";
import { driveFileId } from "./share.js";
import { googleReady, downloadPublic } from "./drive.js";
import { startLoading, forgetLoading } from "./loading.js";

const isURL = (p) => /^https?:\/\//i.test(p);
const q = (s) => JSON.stringify(s);
const IMAGE_TYPES = ["jpeg", "png", "webp", "gif"];

class ImportError extends Error {
  constructor(errors, warnings = []) { super(errors[0]); this.errors = errors; this.warnings = warnings; }
}

function parseJSON(text, name = "deck.json") {
  try { return JSON.parse(text.replace(/^﻿/, "")); }
  catch (e) {
    const m = /position (\d+)/.exec(e.message);
    let where = "";
    if (m) {
      const pos = +m[1], before = text.slice(0, pos);
      where = ` at line ${before.split("\n").length}, column ${pos - before.lastIndexOf("\n")}: …${text.slice(Math.max(0, pos - 30), pos + 10).replace(/\s+/g, " ")}…`;
    }
    throw new ImportError([`${name} is not valid JSON${where} (${e.message})`]);
  }
}

async function fetchBlob(url) {
  let r;
  try { r = await fetch(url, { mode: "cors" }); }
  catch { throw new Error(`could not download ${url} (no connection, or the server does not allow cross-origin downloads: host it on GitHub raw or a gist, or send the zip instead)`); }
  if (!r.ok) throw new Error(`could not download ${url} (HTTP ${r.status})`);
  return r.blob();
}

async function pool(items, n, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } });
  await Promise.all(workers);
}

// Zips with more image files (or bytes) than this open at once: the first card or two (up to FIRST_FILES files)
// are checked now, the rest load in the background while the hooman works (loading.js). Smaller decks (the
// examples have 24 images at most) are checked and stored whole, as before.
const LAZY_FILES = 40, LAZY_BYTES = 30e6, FIRST_FILES = 12;
export const cardPaths = (card) => [...new Set([...card.frames.flatMap((f) => [f.path, ...(f.channels || [])]),
  ...card.overlays.filter((o) => o.shape === "mask").map((o) => o.mask)])];

// One image: its bytes (typed) and size. Throws a hooman-readable message when it isn't a usable image.
async function readImage(source, path) {
  let blob = isURL(path) ? await fetchBlob(path) : await source.get(path);
  let sz = imageSize(new Uint8Array(await blob.slice(0, 65536).arrayBuffer()));         // sizes sit at the start
  if ((!sz || (sz.type === "jpeg" && !sz.w)) && blob.size > 65536) sz = imageSize(new Uint8Array(await blob.slice(0, 1 << 20).arrayBuffer()));
  if (!sz) throw new Error(`${q(path)} is not a JPEG, PNG, WebP or GIF image`);
  if (sz.type === "tiff") throw new Error(`${q(path)} is a TIFF; phones can't show TIFF. Convert it to PNG (llms.txt recipe 7.4)`);
  if (!IMAGE_TYPES.includes(sz.type)) throw new Error(`${q(path)} has an unsupported image type`);
  if (!blob.type || blob.type === "application/octet-stream") blob = new Blob([blob], { type: `image/${sz.type}` });
  return { blob, sz };
}

// Per-card geometry: frames share a size, masks match it, shapes fall inside it. Sets card.w / card.h.
// Returns true for a very big image.
function checkCard(card, i, sizes, errs, warnings) {
  const where = `cards[${i}] (id ${q(card.id)})`;
  const s0 = sizes.get(card.frames[0].path);
  card.w = s0.w; card.h = s0.h;
  if (s0.type === "jpeg" && !s0.w) { errs.push(`${where}: could not read the size of ${q(card.frames[0].path)}; re-save it as a normal JPEG or PNG`); return false; }
  card.frames.forEach((f, j) => {
    const s = sizes.get(f.path);
    if (j && (s.w !== s0.w || s.h !== s0.h)) errs.push(`${where}: frames[${j}] ${q(f.path)} is ${s.w}×${s.h} but frames[0] is ${s0.w}×${s0.h}; all frames must be the same size`);
    (f.channels || []).slice(1).forEach((p) => {
      const sc = sizes.get(p);
      if (sc && (sc.w !== s.w || sc.h !== s.h)) errs.push(`${where}${card.frames.length > 1 ? ` frames[${j}]` : ""}: channel image ${q(p)} is ${sc.w}×${sc.h} but its "image" is ${s.w}×${s.h}; every channel must be the same size`);
    });
  });
  const out = (x, y) => x < -0.05 * s0.w || y < -0.05 * s0.h || x > 1.05 * s0.w || y > 1.05 * s0.h;
  card.overlays.forEach((o, j) => {
    const ow = `${where} overlays[${j}]`;
    if (o.shape === "mask") {
      const s = sizes.get(o.mask);
      if (s.type !== "png") errs.push(`${ow}: mask ${q(o.mask)} must be a PNG (it is ${s.type.toUpperCase()})`);
      else if (s.w !== s0.w || s.h !== s0.h) errs.push(`${ow}: mask ${q(o.mask)} is ${s.w}×${s.h} but the image is ${s0.w}×${s0.h}; a mask must be exactly the image size`);
    } else if (o.shape === "box") {
      const [x, y, w, h] = o.box;
      if (out(x, y) || out(x + w, y + h)) warnings.push(`${ow}: box ${q(o.box)} is outside the ${s0.w}×${s0.h} image; boxes are [x, y, w, h] in pixels`);
    } else if (o.shape === "point") {
      if (out(...o.point)) warnings.push(`${ow}: point ${q(o.point)} is outside the ${s0.w}×${s0.h} image`);
    } else if (o.polygon.some((p) => out(...p))) warnings.push(`${ow}: polygon goes outside the ${s0.w}×${s0.h} image; points are [x, y] in pixels`);
  });
  if (card.focus) {
    const [x, y, w, h] = card.focus;
    if (out(x, y) || out(x + w, y + h)) warnings.push(`${where}: focus ${q(card.focus)} is outside the ${s0.w}×${s0.h} image`);
  }
  return Math.max(s0.w, s0.h) > 4096;
}

// source: {kind: "zip"|"web", name, get(path) -> Promise<Blob>, has, list, size?}
async function load(source, rawText, onProgress) {
  const raw = parseJSON(rawText);
  const { deck, errors, warnings, paths } = normalizeDeck(raw, source, source.name);
  if (!deck) throw new ImportError(errors, warnings);
  const list = [...paths], zipBytes = source.size ? list.reduce((t, p) => t + (isURL(p) ? 0 : source.size(p)), 0) : 0;
  const lazy = source.kind === "zip" && deck.cards.length > 1 && (list.length > LAZY_FILES || zipBytes > LAZY_BYTES);
  let now = deck.cards;
  if (lazy) {                                   // the first card, and the next ones while they stay small
    now = []; let k = 0;
    for (const c of deck.cards) { const n = cardPaths(c).length; if (now.length && k + n > FIRST_FILES) break; now.push(c); k += n; }
  }
  const inCards = new Set(deck.cards.flatMap(cardPaths));
  const read = lazy ? [...new Set([...now.flatMap(cardPaths), ...list.filter((p) => !inCards.has(p))])] : list;
  const blobs = new Map(), sizes = new Map(), errs = [];
  let n = 0, io = false;
  onProgress && onProgress(0, read.length);
  await pool(read, source.kind === "web" ? 6 : 4, async (path) => {
    try { const r = await readImage(source, path); blobs.set(path, r.blob); sizes.set(path, r.sz); }
    catch (e) { errs.push(e.message); if (e.name === "NotReadableError") io = true; }    // the zip lost its access, not the deck's fault
    onProgress && onProgress(++n, read.length);
  });
  if (errs.length) throw Object.assign(new ImportError(errs, warnings), { io });
  let big = 0;
  now.forEach((card, i) => { if (checkCard(card, i, sizes, errs, warnings)) big++; });
  if (big) warnings.push(`${big} card${big > 1 ? "s have images" : " has an image"} larger than 4096 px; phones may be slow (keep the long side at 2048 px or less)`);
  const bytes = lazy && source.size ? zipBytes : [...blobs.values()].reduce((t, b) => t + b.size, 0);
  if (bytes > 150e6) warnings.push(`this deck is ${Math.round(bytes / 1e6)} MB; phones are happiest under about 100 MB per deck. Split big sets into parts (llms.txt section 1b)`);
  if (deck.cards.length > 2000) warnings.push(`this deck has ${deck.cards.length} cards; split it into parts of up to about 1000 (llms.txt section 1b)`);
  if (errs.length) throw new ImportError(errs, warnings);
  return { deck, blobs, warnings, origin: source.name, bytes, lazy: lazy ? { source, first: now.map((c) => c.id) } : null };
}

// For a card whose size isn't known: read it from its stored files (null if some file isn't stored).
export async function storedCard(key, card) {
  const paths = cardPaths(card);
  if (paths.some(isURL)) return null;
  const got = await Promise.all(paths.map(async (p) => {
    const b = await store.getFile(key, p);
    if (!b) return null;
    let sz = imageSize(new Uint8Array(await b.slice(0, 65536).arrayBuffer()));
    if ((!sz || (sz.type === "jpeg" && !sz.w)) && b.size > 65536) sz = imageSize(new Uint8Array(await b.slice(0, 1 << 20).arrayBuffer()));
    return sz ? [p, sz] : null;
  }));
  if (got.some((x) => !x)) return null;
  const sizes = new Map(got);
  const errs = [];
  checkCard(card, 0, sizes, errs, []);
  return errs.length ? { broken: errs.join(" ") } : { w: card.w, h: card.h };
}

// Save a big deck's zip on the phone in the background (or, after picking the zip again, finish saving it).
// Returns how many cards weren't checked yet (they are checked as they're shown).
export function loadInBackground(rec, lazy) {
  startLoading(rec.key, { total: rec.deck.cards.length, file: lazy.file, get: (p) => lazy.source.get(p) });
  return rec.deck.cards.length - (lazy.first || []).length;
}

function zipSource(files, name) {
  const all = [...files.keys()];
  let root = "";
  if (!files.has("deck.json")) {
    const found = all.filter((p) => p.endsWith("/deck.json"));
    if (found.length === 1 && found[0].split("/").length === 2) root = found[0].slice(0, -"deck.json".length);
    else if (found.length > 1) throw new ImportError([`the zip has several deck.json files (${found.slice(0, 4).join(", ")}); put one deck.json at the top of the zip`]);
    else if (found.length === 1) throw new ImportError([`deck.json is at ${q(found[0])}; put it at the top of the zip (one wrapping folder is OK)`]);
    else {
      const other = all.find((p) => /\.json$/i.test(p));
      throw new ImportError([`no deck.json in the zip${other ? ` (found ${q(other)}; name it deck.json)` : ""}. The zip has: ${all.slice(0, 5).join(", ")}${all.length > 5 ? ", …" : ""}`]);
    }
  }
  const rel = all.filter((p) => p.startsWith(root)).map((p) => p.slice(root.length));
  return {
    kind: "zip", name,
    has: (p) => files.has(root + p),
    list: () => rel,
    get: (p) => files.get(root + p).blob(),
    size: (p) => (files.get(root + p) || { size: 0 }).size,
    deckText: async () => (await files.get(root + "deck.json").blob()).text(),
  };
}

function webSource(baseURL, name) {
  return {
    kind: "web folder", name,
    has: () => true,                           // checked when downloading
    list: () => [],
    get: (p) => fetchBlob(new URL(p, baseURL).href),
  };
}

// file: a File/Blob from the picker or the share sheet.
// It is read into memory once, first (up to 200 MB): a file from Google Drive on Android can stop being readable a
// moment later (NotReadableError), which left a big deck's background save and its cards with nothing to read, so
// black cards. From memory, the save and the cards shown meanwhile never touch the picked file again.
export async function importBlob(file, onProgress) {
  const name = file.name || "deck.zip";
  if (file.size && file.size <= 200e6) {
    try { file = new File([await file.arrayBuffer()], name, { type: file.type || "application/zip", lastModified: file.lastModified || Date.now() }); }
    catch (e) { throw Object.assign(new ImportError([`${name}: could not read the zip (${e.message})`]), { io: true }); }
  }
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  if (head[0] === 0x50 && head[1] === 0x4b) {
    let files;
    try { files = await readZip(file); }
    catch (e) {                                  // io: the file couldn't be read (Drive, the phone), the zip may be fine
      if (e instanceof ZipError) throw new ImportError([`${name}: ${e.message}`]);
      throw Object.assign(new ImportError([`${name}: could not read the zip (${e.message})`]), { io: true });
    }
    const src = zipSource(files, name);
    const r = await load(src, await src.deckText(), onProgress);
    if (r.lazy) { r.lazy.file = file; r.bytes = file.size; }      // a big deck is saved as this one zip
    return r;
  }
  const text = await file.text();
  if (/^\s*[{[]/.test(text)) {
    const src = { kind: "file", name, has: (p) => isURL(p), list: () => [], get: () => { throw new Error("no files"); } };
    try { return await load(src, text, onProgress); }
    catch (e) {
      if (e.errors && e.errors.some((m) => m.includes("is not in the file"))) e.errors.unshift(`${name} is a lone deck.json, so its images must be https:// links. Otherwise zip deck.json together with the images.`);
      throw e;
    }
  }
  throw new ImportError([`${name} is not a deck: import a .hooman.zip (or a .zip with deck.json at the top)`]);
}

export async function importURL(url, onProgress) {
  const fid = driveFileId(url);
  if (fid) {                                   // Google Drive doesn't let other sites download its links directly
    if (!googleReady()) throw new ImportError(["Google Drive links can't be opened by this copy of the app. Download the file from Drive, then tap Import (Drive also shows up in the phone's file picker)."]);
    let file;
    try { file = await downloadPublic(fid); } catch (e) { throw new ImportError([e.message]); }
    return Object.assign(await importBlob(file, onProgress), { sourceURL: url });
  }
  let blob;
  try { blob = await fetchBlob(url); } catch (e) { throw new ImportError([e.message]); }
  const name = decodeURIComponent(new URL(url).pathname.split("/").pop() || "deck");
  const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
  if (head[0] === 0x50 && head[1] === 0x4b) return Object.assign(await importBlob(new File([blob], name), onProgress), { sourceURL: url });
  return Object.assign(await load(webSource(url, name), await blob.text(), onProgress), { sourceURL: url });
}

// Shuffled decks keep one order for good, so the hooman's place never jumps.
function makeOrder(deck) {
  const idx = deck.cards.map((_, i) => i);
  if (!deck.shuffle) return null;
  for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
  return idx.map((i) => deck.cards[i].id);
}

// mode: "new" | "update" (same id, keep answers) | "copy" (new id)
export async function saveDeck(imported, mode, existing) {
  const { deck, blobs, origin } = imported;
  if (mode === "copy") {
    const keys = new Set((await store.listDecks()).map((d) => d.key));
    let k = 2;
    while (keys.has(`${deck.id}-${k}`)) k++;
    deck.id = `${deck.id}-${k}`;
  }
  const now = new Date().toISOString();
  await checkSpace(imported.bytes || 0, mode === "update" && existing ? existing.bytes || 0 : 0);
  if (mode === "update") { forgetLoading(deck.id); await store.clearFiles(deck.id); }
  await store.putFiles(deck.id, [...blobs].map(([path, blob]) => ({ path, blob })));
  const rec = {
    key: deck.id, deck, title: deck.title, origin, bytes: imported.bytes,
    sourceURL: imported.sourceURL || (mode === "update" && existing ? existing.sourceURL : undefined),
    drive: mode === "update" && existing ? existing.drive : undefined,
    importedAt: mode === "update" && existing ? existing.importedAt : now, updatedAt: now,
    custom: mode === "update" && existing ? existing.custom : undefined,
    order: mode === "update" && existing && existing.order && deck.shuffle ? mergeOrder(existing.order, deck) : makeOrder(deck),
  };
  await store.putDeck(rec);
  store.askPersistent();
  if (imported.lazy) rec.loadingLeft = loadInBackground(rec, imported.lazy);
  return rec;
}

// Before writing the images: is there room for them? (The browser gives each site a share of the free disk.)
async function checkSpace(bytes, freed) {
  let est;
  try { est = await navigator.storage.estimate(); } catch { return; }
  if (!est || !est.quota) return;
  const free = est.quota - (est.usage || 0) + freed, mb = (x) => Math.max(1, Math.round(x / 1e6));
  if (bytes * 1.15 > free) throw new ImportError([`This deck needs about ${mb(bytes)} MB, but this device has only about ${mb(free)} MB free for the app. Free up space, delete an old deck, or split the deck into parts (llms.txt section 1b).`]);
}

function mergeOrder(old, deck) {
  const ids = new Set(deck.cards.map((c) => c.id));
  const kept = old.filter((id) => ids.has(id)), have = new Set(kept);
  return kept.concat(deck.cards.map((c) => c.id).filter((id) => !have.has(id)));
}

export { ImportError, mimeOf };
