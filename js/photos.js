// "New deck from photos": the hooman picks images (gallery, camera, Drive via the system picker),
// types a question, and the deck is built on the phone. No AI needed.

import { normalizeDeck } from "./deck.js";

const MAX = 2048;
const safe = (s) => s.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 40) || "photo";

// Big photos are shrunk to 2048 px JPEG; small JPEG/PNG/WebP files are kept as they are.
async function prepare(file) {
  const bmp = await createImageBitmap(file);
  const { width: w, height: h } = bmp;
  const keep = Math.max(w, h) <= MAX && /^image\/(jpeg|png|webp)$/.test(file.type);
  if (keep) { bmp.close && bmp.close(); return { blob: file, w, h, ext: file.type.split("/")[1].replace("jpeg", "jpg") }; }
  const k = Math.min(1, MAX / Math.max(w, h)), W = Math.max(1, Math.round(w * k)), H = Math.max(1, Math.round(h * k));
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  c.getContext("2d").drawImage(bmp, 0, 0, W, H);
  bmp.close && bmp.close();
  const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.9));
  return { blob, w: W, h: H, ext: "jpg" };
}

/**
 * files: File[]; opts: {title, mode: "swipe" | "annotate", question, answers: {right, left, up}, classes: string[]}
 * Returns what importer.saveDeck() takes.
 */
export async function buildPhotoDeck(files, opts, onProgress) {
  const blobs = new Map(), sizes = new Map(), cards = [];
  let i = 0;
  for (const f of files) {
    onProgress && onProgress(i, files.length);
    let p;
    try { p = await prepare(f); } catch { i++; continue; }            // not an image the phone can read
    const path = `img/${String(++i).padStart(3, "0")}_${safe(f.name || "photo")}.${p.ext}`;
    blobs.set(path, p.blob); sizes.set(path, p);
    cards.push(path);
  }
  if (!cards.length) throw Object.assign(new Error("no images"), { errors: ["None of those files is an image this phone can open (JPEG, PNG, WebP, GIF, or HEIC on iPhone)."] });
  const id = `photos-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}`;
  const raw = { hooman: 1, id, title: opts.title || "My photos", cards };
  if (opts.mode === "annotate") { if (opts.classes && opts.classes.length) raw.classes = opts.classes; }
  else {
    raw.question = opts.question || "Is this right?";
    raw.answers = {};
    for (const k of ["right", "left", "up"]) if (opts.answers && opts.answers[k]) raw.answers[k] = opts.answers[k];
  }
  const src = { kind: "photos", has: (p) => blobs.has(p), list: () => [...blobs.keys()] };
  const { deck, errors } = normalizeDeck(raw, src, raw.title);
  if (!deck) throw Object.assign(new Error(errors[0]), { errors });
  for (const c of deck.cards) { const s = sizes.get(c.frames[0].path); c.w = s.w; c.h = s.h; }
  const bytes = [...blobs.values()].reduce((s, b) => s + b.size, 0);
  return { deck, blobs, warnings: [], origin: "photos", bytes };
}
