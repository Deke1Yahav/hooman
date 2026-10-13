// Big decks open at once. The zip the hooman picked is saved on the phone whole, in the background: one straight
// copy, the fastest thing phone storage does (store.putArchive). Each card's images are read out of the zip when
// the card is shown, and its size checked then (ensureCard). Until the copy is saved, cards are read from the
// picked zip itself, which stays readable only while this page is open: if the app closes first, the deck says so
// and picking the zip again (or the decks folder) finishes the job.
import * as store from "./store.js";
import { prefs } from "./prefs.js";

const jobs = new Map();                       // deck key -> saving now, in this session
const sized = new Map();                      // deck key -> Map(card id -> {w, h} | {broken})
const listeners = new Set();
const stateKey = (key) => `loading:${key}`;

export function onLoading(fn) { listeners.add(fn); return () => listeners.delete(fn); }
const emit = (key, ev) => listeners.forEach((fn) => { try { fn(key, ev); } catch (e) { console.error(e); } });

// null when the deck is saved whole; else {total (cards), active (saving now, in this session)}
export function loadingOf(key) {
  const s = prefs.get(stateKey(key), null);
  return s ? { total: s.total, active: jobs.has(key) } : null;
}

// file: the picked zip; get(path): a file out of it (for the cards shown before the copy is saved).
export function startLoading(key, { total, file, get }) {
  stopLoading(key);
  prefs.set(stateKey(key), { total });
  store.useSession(key, get);
  const job = { stop: false };
  jobs.set(key, job);
  emit(key, { progress: true });
  store.putArchive(key, file).then(() => {
    if (job.stop) return;
    jobs.delete(key); prefs.del(stateKey(key));
    emit(key, { done: true, total });
  }, (e) => {
    if (job.stop) return;
    jobs.delete(key);
    emit(key, { failed: (e && e.message) || String(e) });
  });
}

// Before a card is shown: "ok" (card.w / card.h set), "broken" (card.broken says why), or "missing" (its files
// aren't on the phone, and the picked zip is gone). sizeOf(card) reads and checks the card's files.
export async function ensureCard(key, card, sizeOf) {
  const apply = (r) => { if (r.broken) { card.broken = r.broken; return "broken"; } card.w = r.w; card.h = r.h; return "ok"; };
  const m = sized.get(key) || new Map(); sized.set(key, m);
  if (m.has(card.id)) return apply(m.get(card.id));
  const r = await sizeOf(card).catch(() => null);
  if (!r) return "missing";
  m.set(card.id, r);
  return apply(r);
}

export function stopLoading(key) { const job = jobs.get(key); if (job) { job.stop = true; jobs.delete(key); } }
export function forgetLoading(key) { stopLoading(key); sized.delete(key); prefs.del(stateKey(key)); }
