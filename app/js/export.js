// Answers out: <deck id>.answers.zip with answers.csv, answers.json (+ full history) and masks/*.png.

import * as store from "./store.js";
import { writeZip } from "./zip.js";
import { answerDefs } from "./deck.js";
import { annotator } from "./settings.js";

export const APP_VERSION = "0.14.0";
const csvCell = (v) => {
  const s = v === undefined || v === null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const maskName = (cardId) => `masks/${cardId.replace(/\//g, "__").replace(/[\\:*?"<>|]/g, "_")}.png`;

export async function buildExport(rec) {
  const deck = rec.deck;
  const [answers, log, notes] = await Promise.all([store.answersOf(rec.key), store.logOf(rec.key), store.notesOf(rec.key)]);
  const byCard = new Map(answers.map((a) => [a.card, a])), noteOf = new Map(notes.map((n) => [n.card, n]));
  const labelOf = new Map(answerDefs(rec).concat(deck.answers).map((d) => [d.value, d.label]));
  const rows = [], json = [], unanswered = [], files = [];
  for (const card of deck.cards) {
    const a = byCard.get(card.id), note = noteOf.get(card.id);
    if (!a) { unanswered.push(card.id); continue; }
    const image = card.frames[0].path;
    const item = { card: card.id, image, answer: a.answer, label: a.label || labelOf.get(a.answer) || a.answer, at: a.at, ms: a.ms, changes: a.changes || 0 };
    if (a.by) item.by = a.by;
    let mask = "";
    if (a.mask) {
      mask = maskName(card.id);
      files.push({ name: mask, data: a.mask });
      item.overlays = [{ source: "hooman", mask }];
    }
    if (a.masks && a.masks.length) {               // one mask per frame (frames_are "time"): a cell keeps its number
      item.overlays = a.masks.map((m) => {
        const name = maskName(`${card.id}_f${m.frame}`);
        files.push({ name, data: m.mask });
        return { source: "hooman", mask: name, frame: m.frame, objects: m.objects };
      });
      mask = item.overlays.map((o) => o.mask).join(" ");
    }
    if (a.objects) item.objects = a.objects;
    if (a.frame !== undefined && card.frames.length > 1) item.frame = a.frame;
    for (const k of ["from", "points", "end", "number", "text"]) if (a[k] !== undefined) item[k] = a[k];
    if (note) item.note = note.text;
    json.push(item);
    rows.push([card.id, image, a.answer, item.label, a.at, a.ms, item.changes, mask, a.by || "", note ? note.text : "",
      a.number ?? "", a.text ?? "", a.points ? JSON.stringify(a.points.map((p) => (p.missing ? { frame: p.frame, missing: true } : { x: p.x, y: p.y, frame: p.frame, ...(p.daughter ? { daughter: p.daughter } : {}), ...(p.hits ? { hits: p.hits } : {}) }))) : ""].map(csvCell).join(","));
  }
  const notesOnly = notes.filter((n) => !byCard.has(n.card)).map((n) => ({ card: n.card, note: n.text, at: n.at, by: n.by }));
  const csv = ["card_id,image,answer,label,answered_at,ms,changes,mask,annotator,note,number,text,points", ...rows].join("\n") + "\n";
  const out = {
    hooman_answers: 1,
    app: `Hooman in the Loop ${APP_VERSION}`,
    deck: { id: deck.id, title: deck.title, question: deck.question },
    annotator: annotator() || undefined,
    exported_at: new Date().toISOString(),
    answers: json, unanswered,
    ...(notesOnly.length ? { notes: notesOnly } : {}),
    history: log.map((e) => ({ card: e.card, answer: e.answer, at: e.at, ...(e.undo ? { undo: true } : {}) })),
  };
  const zip = await writeZip([{ name: "answers.csv", data: csv }, { name: "answers.json", data: JSON.stringify(out, null, 1) }, ...files]);
  return { zip, csv, count: json.length, unanswered: unanswered.length };
}

// Share sheet when the phone has one, otherwise a normal download.
export async function shareOrDownload(blob, name) {
  const file = new File([blob], name, { type: blob.type || "application/octet-stream" });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: name }); return "shared"; }
  } catch (e) { if (e && e.name === "AbortError") return "cancelled"; }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(file); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  return "downloaded";
}
