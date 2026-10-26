// Sharing decks: rebuild deck.json (the llms.txt format) from what is stored, zip it with its images,
// draw QR codes for deck links, and recognise Google Drive links.

import * as store from "./store.js";
import { writeZip } from "./zip.js";
import { answerDefs } from "./deck.js";
import qrcode from "../vendor/qrcode.mjs";

// The stored (normalized) deck back in the format an LLM would write. The hooman's own answer edits are kept.
export function toDeckJSON(rec) {
  const d = rec.deck, mode = d.mode || (d.question ? "swipe" : "annotate");
  const out = { hooman: 1, id: d.id, title: d.title };
  if (d.question) out.question = d.question;
  if (mode === "follow" || (mode === "annotate" && d.question)) out.mode = mode;
  if (d.framesAre === "time" && mode !== "follow") out.frames_are = "time";
  if (d.channels) {
    out.channels = d.channels.map((c) => ({ name: c.name, ...(c.color ? { color: c.color } : {}) }));
    if (d.channelView !== 0 && d.channelView !== undefined) out.channel_view = typeof d.channelView === "number" ? d.channels[d.channelView].name : d.channelView;
  }
  if (d.help) out.help = d.help;
  if (d.about) out.about = d.about;
  if (d.shuffle) out.shuffle = true;
  if (mode === "swipe") {
    const ans = (a) => {
      const o = { label: a.label, value: a.value };
      for (const k of ["then", "color", "celebrate"]) if (a[k]) o[k] = a[k];
      return o;
    };
    const defs = answerDefs(rec).filter((a) => !a.hidden);
    out.answers = Object.fromEntries(defs.filter((a) => a.slot !== "button").map((a) => [a.slot, ans(a)]));
    const buttons = defs.filter((a) => a.slot === "button").map(ans);
    if (buttons.length) out.buttons = buttons;
  }
  if (d.sources.length) out.sources = Object.fromEntries(d.sources.map((s) => [s.name, { label: s.label, color: s.color, ...(s.guide ? { guide: true } : {}) }]));
  if (d.classes && d.classes.length) out.classes = d.classes.map((c) => ({ value: c.value, label: c.label, color: c.color }));
  out.cards = d.cards.map((c) => {
    const o = { id: c.id };
    const extra = (f) => (f.channels && f.channels.length > 1 ? { channels: f.channels.slice(1) } : {});
    if (c.frames.length === 1 && !c.frames[0].name) { o.image = c.frames[0].path; Object.assign(o, extra(c.frames[0])); }
    else o.frames = c.frames.map((f) => (f.name || extra(f).channels ? { image: f.path, ...(f.name ? { name: f.name } : {}), ...extra(f) } : f.path));
    for (const k of ["question", "info", "focus", "start"]) if (c[k] !== undefined) o[k] = c[k];
    if (c.overlays.length) o.overlays = c.overlays.map((v) => {
      const x = { [v.shape]: v[v.shape], source: v.source };
      for (const k of ["label", "value", "style", "frame"]) if (v[k] !== undefined) x[k] = v[k];
      return x;
    });
    return o;
  });
  return out;
}

// <id>.hooman.zip: deck.json + every image and mask, ready to send to someone.
export async function buildDeckZip(rec) {
  const files = await store.filesOf(rec.key);
  const entries = [{ name: "deck.json", data: JSON.stringify(toDeckJSON(rec), null, 1) }];
  for (const f of files) if (!/^https?:/i.test(f.path)) entries.push({ name: f.path, data: f.blob });
  return writeZip(entries);
}

// An SVG QR code for a link (dark on white, so phone cameras read it on any theme).
export function qrSVG(text, size = 240) {
  const q = qrcode(0, "M");
  q.addData(text);
  q.make();
  const n = q.getModuleCount(), m = 4, cell = size / (n + 2 * m);
  let d = "";
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (q.isDark(y, x)) d += `M${(x + m) * cell} ${(y + m) * cell}h${cell}v${cell}h-${cell}z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="QR code"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

// The app link that imports a deck from a URL (used for "?deck=" links and QR codes).
export const deckLink = (appURL, deckURL) => `${appURL}?deck=${encodeURIComponent(deckURL)}`;

// Google Drive file id from the usual link shapes, or null.
export function driveFileId(url) {
  try {
    const u = new URL(url);
    if (!/(^|\.)drive\.google\.com$|(^|\.)docs\.google\.com$|drive\.usercontent\.google\.com$/.test(u.hostname)) return null;
    const m = u.pathname.match(/\/(?:file\/)?d\/([A-Za-z0-9_-]{10,})/);
    return (m && m[1]) || u.searchParams.get("id");
  } catch { return null; }
}
