// Backup / restore. One zip with every deck's answers, notes, history and drawn masks (and, if asked,
// the decks themselves with their images). Restoring merges: per card the newer answer wins, history and
// notes are added without duplicates. A deck's own export (<id>.answers.zip) can be restored the same way.

import * as store from "./store.js";
import { readZip, writeZip } from "./zip.js";
import { annotator } from "./settings.js";
import { APP_VERSION } from "./export.js";

const safe = (s) => String(s).replace(/\//g, "__").replace(/[\\:*?"<>|]/g, "_");

// "backup" | "answers" | "deck" (or null when the file isn't a zip)
export async function zipKind(file) {
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  if (head[0] !== 0x50 || head[1] !== 0x4b) return null;
  let files;
  try { files = await readZip(file); } catch { return "deck"; }
  const names = [...files.keys()];
  if (files.has("hooman-backup.json")) return "backup";
  if (!names.some((n) => n === "deck.json" || /^[^/]+\/deck\.json$/.test(n)) && files.has("answers.json")) return "answers";
  return "deck";
}

export async function buildBackup({ images = false } = {}) {
  const decks = await store.listDecks(), entries = [];
  const manifest = { hooman_backup: 1, app: `Hooman in the Loop ${APP_VERSION}`, created: new Date().toISOString(), annotator: annotator(), images, decks: [] };
  let answersN = 0;
  for (const rec of decks) {
    const [answers, log, notes] = await Promise.all([store.answersOf(rec.key), store.logOf(rec.key), store.notesOf(rec.key)]);
    const A = [];
    for (const a of answers) {
      const { deck, mask, masks, ...item } = a;
      if (mask) { const name = `answers/${rec.key}/${safe(a.card)}.png`; entries.push({ name, data: mask }); item.mask = name; }
      if (masks) item.masks = masks.map((m) => { const name = `answers/${rec.key}/${safe(a.card)}_f${m.frame}.png`; entries.push({ name, data: m.mask }); return { frame: m.frame, mask: name, objects: m.objects }; });
      A.push(item);
    }
    answersN += A.length;
    const files = images ? await store.filesOf(rec.key) : [];
    for (const f of files) entries.push({ name: `files/${rec.key}/${f.path}`, data: f.blob });
    manifest.decks.push({ key: rec.key, title: rec.title, record: rec, answers: A, log: log.map(({ deck, ...e }) => e), notes: notes.map(({ deck, ...n }) => n), files: files.map((f) => f.path) });
  }
  entries.unshift({ name: "hooman-backup.json", data: JSON.stringify(manifest) });
  return { zip: await writeZip(entries), decks: decks.length, answers: answersN };
}

const logKey = (e) => `${e.card}|${e.at}|${e.answer}|${e.undo ? 1 : 0}`;

// Merge answers/log/notes for one deck that is on this device. items: answer records with blobs resolved.
async function mergeInto(key, items, log, notes) {
  const cur = new Map((await store.answersOf(key)).map((a) => [a.card, a]));
  const put = [];
  let added = 0, newer = 0;
  for (const a of items) {
    const c = cur.get(a.card);
    if (c && !(a.at > c.at)) continue;
    if (c) newer++; else added++;
    put.push({ ...a, deck: key });
  }
  await store.putRaw("answers", put);
  const have = new Set((await store.logOf(key)).map(logKey));
  const newLog = (log || []).filter((e) => e && e.card !== undefined && !have.has(logKey(e))).map((e) => ({ ...e, deck: key }));
  await store.addLog(newLog);
  const curNotes = new Map((await store.notesOf(key)).map((n) => [n.card, n]));
  const newNotes = (notes || []).filter((n) => n && n.text && (!curNotes.has(n.card) || n.at > curNotes.get(n.card).at)).map((n) => ({ ...n, deck: key }));
  await store.putRaw("notes", newNotes);
  return { added, newer, history: newLog.length, notes: newNotes.length };
}

export async function restoreBackup(file, onProgress) {
  const files = await readZip(file);
  const blobOf = async (name) => (files.has(name) ? files.get(name).blob() : null);
  const m = JSON.parse(await (await files.get("hooman-backup.json").blob()).text());
  if (m.hooman_backup !== 1) throw Object.assign(new Error("this backup was made by a newer app; update the app"), { errors: ["this backup was made by a newer version of the app; update the app first"] });
  const report = { decks: [], missing: [] };
  let i = 0;
  for (const d of m.decks || []) {
    onProgress && onProgress(++i, m.decks.length);
    let created = false;
    if (!(await store.getDeck(d.key))) {
      if (!d.files || !d.files.length) { report.missing.push(d.title || d.key); continue; }
      const out = [];
      for (const path of d.files) { const b = await blobOf(`files/${d.key}/${path}`); if (b) out.push({ path, blob: b }); }
      await store.putFiles(d.key, out);
      await store.putDeck(d.record);
      created = true;
    }
    const items = [];
    for (const a of d.answers || []) {
      const it = { ...a };
      if (a.mask) it.mask = await blobOf(a.mask);
      if (a.masks) it.masks = (await Promise.all(a.masks.map(async (x) => ({ frame: x.frame, objects: x.objects, mask: await blobOf(x.mask) })))).filter((x) => x.mask);
      items.push(it);
    }
    report.decks.push({ key: d.key, title: d.title || d.key, created, ...(await mergeInto(d.key, items, d.log, d.notes)) });
  }
  return report;
}

// A single deck's export: answers.json (+ masks/*.png). The deck must already be on this device.
export async function restoreAnswers(file) {
  const files = await readZip(file);
  const data = JSON.parse(await (await files.get("answers.json").blob()).text());
  if (data.hooman_answers !== 1 || !data.deck || !data.deck.id) throw Object.assign(new Error("not a Hooman answers file"), { errors: ["this zip has an answers.json that is not a Hooman in the Loop export"] });
  const key = data.deck.id;
  if (!(await store.getDeck(key))) return { decks: [], missing: [data.deck.title || key] };
  const blobOf = async (name) => (name && files.has(name) ? files.get(name).blob() : null);
  const items = [];
  for (const a of data.answers || []) {
    const it = { card: a.card, answer: a.answer, label: a.label, at: a.at, ms: a.ms, changes: a.changes || 0 };
    for (const k of ["by", "objects", "frame", "from", "points", "end", "number", "text"]) if (a[k] !== undefined) it[k] = a[k];
    if (!it.by && data.annotator) it.by = data.annotator;
    const mine = (a.overlays || []).filter((o) => o.source === "hooman" && o.mask);
    if (mine.length === 1 && mine[0].frame === undefined) it.mask = await blobOf(mine[0].mask);
    else if (mine.length) it.masks = (await Promise.all(mine.map(async (o) => ({ frame: o.frame || 0, objects: o.objects, mask: await blobOf(o.mask) })))).filter((x) => x.mask);
    items.push(it);
  }
  const notes = (data.answers || []).concat((data.notes || [])).filter((a) => a.note).map((a) => ({ card: a.card, text: a.note, at: a.note_at || a.at, by: a.by || data.annotator }));
  return { decks: [{ key, title: data.deck.title || key, created: false, ...(await mergeInto(key, items, data.history, notes)) }], missing: [] };
}

// For comparing annotators: read another export without storing anything.
export async function readAnswers(file) {
  const kind = await zipKind(file);
  const files = await readZip(file);
  if (kind === "answers") {
    const data = JSON.parse(await (await files.get("answers.json").blob()).text());
    return { deck: data.deck.id, who: data.annotator || "the other file", answers: new Map((data.answers || []).map((a) => [a.card, a])) };
  }
  if (kind === "backup") {
    const m = JSON.parse(await (await files.get("hooman-backup.json").blob()).text());
    return { decks: new Map((m.decks || []).map((d) => [d.key, new Map((d.answers || []).map((a) => [a.card, a]))])), who: m.annotator || "the other file" };
  }
  throw Object.assign(new Error("not an answers export"), { errors: ["pick an exported .answers.zip or a backup"] });
}
