// Who is answering, colour mode, backup bookkeeping. Per device (localStorage).

import { prefs } from "./prefs.js";

export const annotator = () => prefs.get("annotator", "");
export const setAnnotator = (name) => prefs.set("annotator", String(name || "").trim().slice(0, 60));
// A name that is safe in file names: "<deck>.<fileSafe(annotator)>.answers.zip".
export const fileSafe = (s) => String(s || "").normalize("NFKD").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "anonymous";

// Colour-blind mode swaps the red/green pair (model A/B, no/yes) for orange/sky blue,
// which every kind of colour vision tells apart; the colours a deck sets on purpose map the same way.
const CB = {
  "#ff5d6c": "#ff9f1c",   // red    -> orange
  "#3ddc97": "#56b4e9",   // green  -> sky blue
  "#4fc3f7": "#e48fc0",   // blue   -> pink-purple (keeps it apart from sky blue)
  "#f2c14e": "#f0e442",   // yellow -> lemon (keeps it apart from orange)
};
export const colorMode = () => prefs.get("colors", "standard");
export const setColorMode = (m) => prefs.set("colors", m === "cb" ? "cb" : "standard");
export const tone = (c) => (colorMode() === "cb" && c && CB[String(c).toLowerCase()]) || c;

// A copy of a deck record with its colours in the current mode; _raw points at the stored record.
export function themed(rec) {
  if (colorMode() !== "cb" || !rec) return rec;
  const t = (list) => (list || []).map((x) => ({ ...x, color: tone(x.color) }));
  const deck = { ...rec.deck, sources: t(rec.deck.sources), answers: t(rec.deck.answers), classes: t(rec.deck.classes) };
  const custom = rec.custom && rec.custom.answers ? { ...rec.custom, answers: t(rec.custom.answers) } : rec.custom;
  return { ...rec, deck, custom, _raw: rec };
}
const UNCB = Object.fromEntries(Object.entries(CB).map(([a, b]) => [b, a]));
export const untone = (c) => (c && UNCB[String(c).toLowerCase()]) || c;

export const lastBackup = () => prefs.get("lastBackupAt", "");
export const markBackup = () => prefs.set("lastBackupAt", new Date().toISOString());
