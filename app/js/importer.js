// Import a deck from a zip file, a lone deck.json (https images only) or a link.
// Nothing is saved here: the caller decides new / update / copy, then calls saveDeck().

import { readZip, mimeOf, ZipError } from "./zip.js";
import { imageSize } from "./png.js";
import { normalizeDeck } from "./deck.js";
import * as store from "./store.js";

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

// source: {kind: "zip"|"web", name, get(path) -> Promise<Blob>, has, list}
async function load(source, rawText, onProgress) {
  const raw = parseJSON(rawText);
  const { deck, errors, warnings, paths } = normalizeDeck(raw, source, source.name);
  if (!deck) throw new ImportError(errors, warnings);
  const list = [...paths], blobs = new Map(), sizes = new Map(), errs = [];
  let n = 0;
  onProgress && onProgress(0, list.length);
  await pool(list, source.kind === "web" ? 6 : 4, async (path) => {
    try {
      let blob = isURL(path) ? await fetchBlob(path) : await source.get(path);
      const head = new Uint8Array(await blob.slice(0, 262144).arrayBuffer());
      const sz = imageSize(head);
      if (!sz) throw new Error(`${q(path)} is not a JPEG, PNG, WebP or GIF image`);
      if (sz.type === "tiff") throw new Error(`${q(path)} is a TIFF; phones can't show TIFF. Convert it to PNG (llms.txt recipe 7.4)`);
      if (!IMAGE_TYPES.includes(sz.type)) throw new Error(`${q(path)} has an unsupported image type`);
      if (!blob.type || blob.type === "application/octet-stream") blob = new Blob([blob], { type: `image/${sz.type}` });
      blobs.set(path, blob); sizes.set(path, sz);
    } catch (e) { errs.push(e.message); }
    onProgress && onProgress(++n, list.length);
  });
  if (errs.length) throw new ImportError(errs, warnings);

  // per-card geometry checks: frames share a size, masks match it, shapes fall inside it
  let big = 0;
  deck.cards.forEach((card, i) => {
    const where = `cards[${i}] (id ${q(card.id)})`;
    const s0 = sizes.get(card.frames[0].path);
    card.w = s0.w; card.h = s0.h;
    if (s0.type === "jpeg" && !s0.w) { errs.push(`${where}: could not read the size of ${q(card.frames[0].path)}; re-save it as a normal JPEG or PNG`); return; }
    if (Math.max(s0.w, s0.h) > 4096) big++;
    card.frames.forEach((f, j) => {
      const s = sizes.get(f.path);
      if (j && (s.w !== s0.w || s.h !== s0.h)) errs.push(`${where}: frames[${j}] ${q(f.path)} is ${s.w}×${s.h} but frames[0] is ${s0.w}×${s0.h}; all frames must be the same size`);
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
  });
  if (big) warnings.push(`${big} card${big > 1 ? "s have images" : " has an image"} larger than 4096 px; phones may be slow (keep the long side at 2048 px or less)`);
  const bytes = [...blobs.values()].reduce((s, b) => s + b.size, 0);
  if (bytes > 150e6) warnings.push(`this deck is ${Math.round(bytes / 1e6)} MB; phones are happiest under about 100 MB per deck. Split big sets into parts (llms.txt section 1b)`);
  if (deck.cards.length > 2000) warnings.push(`this deck has ${deck.cards.length} cards; split it into parts of up to about 1000 (llms.txt section 1b)`);
  if (errs.length) throw new ImportError(errs, warnings);
  return { deck, blobs, warnings, origin: source.name, bytes };
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
export async function importBlob(file, onProgress) {
  const name = file.name || "deck.zip";
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  if (head[0] === 0x50 && head[1] === 0x4b) {
    let files;
    try { files = await readZip(file); } catch (e) { throw new ImportError([e instanceof ZipError ? `${name}: ${e.message}` : `${name}: could not read the zip (${e.message})`]); }
    const src = zipSource(files, name);
    return load(src, await src.deckText(), onProgress);
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
  let blob;
  try { blob = await fetchBlob(url); } catch (e) { throw new ImportError([e.message]); }
  const name = decodeURIComponent(new URL(url).pathname.split("/").pop() || "deck");
  const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
  if (head[0] === 0x50 && head[1] === 0x4b) return importBlob(new File([blob], name), onProgress);
  return load(webSource(url, name), await blob.text(), onProgress);
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
  if (mode === "update") await store.clearFiles(deck.id);
  await store.putFiles(deck.id, [...blobs].map(([path, blob]) => ({ path, blob })));
  const rec = {
    key: deck.id, deck, title: deck.title, origin, bytes: imported.bytes,
    importedAt: mode === "update" && existing ? existing.importedAt : now, updatedAt: now,
    custom: mode === "update" && existing ? existing.custom : undefined,
    order: mode === "update" && existing && existing.order && deck.shuffle ? mergeOrder(existing.order, deck) : makeOrder(deck),
  };
  await store.putDeck(rec);
  store.askPersistent();
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
