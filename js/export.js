// Answers out: <deck id>.answers.zip with answers.csv, answers.json (+ full history) and masks/*.png.

import * as store from "./store.js";
import { writeZip } from "./zip.js";
import { answerDefs } from "./deck.js";

export const APP_VERSION = "0.1.1";
const csvCell = (v) => {
  const s = v === undefined || v === null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const maskName = (cardId) => `masks/${cardId.replace(/\//g, "__").replace(/[\\:*?"<>|]/g, "_")}.png`;

export async function buildExport(rec) {
  const deck = rec.deck;
  const answers = await store.answersOf(rec.key), log = await store.logOf(rec.key);
  const byCard = new Map(answers.map((a) => [a.card, a]));
  const labelOf = new Map(answerDefs(rec).concat(deck.answers).map((d) => [d.value, d.label]));
  const rows = [], json = [], unanswered = [], files = [];
  for (const card of deck.cards) {
    const a = byCard.get(card.id);
    if (!a) { unanswered.push(card.id); continue; }
    const image = card.frames[0].path;
    const item = { card: card.id, image, answer: a.answer, label: a.label || labelOf.get(a.answer) || a.answer, at: a.at, ms: a.ms, changes: a.changes || 0 };
    let mask = "";
    if (a.mask) {
      mask = maskName(card.id);
      files.push({ name: mask, data: a.mask });
      item.overlays = [{ source: "hooman", mask }];
      if (a.objects) item.objects = a.objects;
    }
    json.push(item);
    rows.push([card.id, image, a.answer, item.label, a.at, a.ms, item.changes, mask].map(csvCell).join(","));
  }
  const csv = ["card_id,image,answer,label,answered_at,ms,changes,mask", ...rows].join("\n") + "\n";
  const out = {
    hooman_answers: 1,
    app: `Hooman in the Loop ${APP_VERSION}`,
    deck: { id: deck.id, title: deck.title, question: deck.question },
    exported_at: new Date().toISOString(),
    answers: json, unanswered,
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
