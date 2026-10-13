// Big decks open at once: their images are checked and stored card by card in the background, in the order the
// hooman will see them, and the card on screen (then the next ones) jump the queue. The picked zip can be read
// only while this page is open, so what is still to load is remembered (localStorage): picking the zip again
// finishes the job. When everything is in, the card sizes go into the deck record and the memory is dropped.
import * as store from "./store.js";
import { prefs } from "./prefs.js";

const jobs = new Map();                       // deck key -> running job
const done = new Map();                       // deck key -> Map(card id -> {w, h} | {broken}), for this session
const listeners = new Set();
const stateKey = (key) => `loading:${key}`;
const stateOf = (key) => prefs.get(stateKey(key), null);

export function onLoading(fn) { listeners.add(fn); return () => listeners.delete(fn); }
const emit = (key, ev) => listeners.forEach((fn) => { try { fn(key, ev); } catch (e) { console.error(e); } });

// null when the deck is complete; else {total, left, active} (active: loading now, in this session)
export function loadingOf(key) {
  const s = stateOf(key), job = jobs.get(key);
  if (!s) return null;
  return { total: s.total, left: job ? job.queue.length + (job.busy ? 1 : 0) : s.pending.length, active: !!job };
}
export const pendingIds = (key) => (stateOf(key) || { pending: [] }).pending;

// pending: card ids in display order; readCard(id) stores the card's files and resolves {w, h} or {broken}.
export function startLoading(key, { pending, total, readCard }) {
  stopLoading(key);
  const s = stateOf(key) || { total, pending: [], sizes: {}, broken: {} };
  s.total = total || s.total; s.pending = [...pending];
  prefs.set(stateKey(key), s);
  const job = { key, queue: [...pending], readCard, waiters: new Map(), busy: null, stop: false, state: s, saveTimer: null };
  jobs.set(key, job);
  emit(key, { progress: true });
  run(job);
}

async function run(job) {
  while (!job.stop && job.queue.length) {
    const id = job.queue.shift();
    job.busy = id;
    let r;
    try { r = await job.readCard(id); } catch (e) { r = { broken: (e && e.message) || String(e) }; }
    job.busy = null;
    if (job.stop) return;
    const m = done.get(job.key) || new Map(); done.set(job.key, m); m.set(id, r);
    if (r.broken) job.state.broken[id] = r.broken; else job.state.sizes[id] = [r.w, r.h];
    (job.waiters.get(id) || []).forEach((f) => f(r)); job.waiters.delete(id);
    saveSoon(job);
    emit(job.key, { progress: true });
  }
  if (!job.stop) await finish(job);
}

function saveSoon(job) {
  if (job.saveTimer) return;
  job.saveTimer = setTimeout(() => {
    job.saveTimer = null;
    if (job.stop) return;
    job.state.pending = [...(job.busy ? [job.busy] : []), ...job.queue];
    prefs.set(stateKey(job.key), job.state);
  }, 1500);
}

async function finish(job) {
  clearTimeout(job.saveTimer);
  jobs.delete(job.key);
  const s = job.state, rec = await store.getDeck(job.key);
  if (rec) {
    for (const c of rec.deck.cards) {
      const sz = s.sizes[c.id];
      if (sz) { c.w = sz[0]; c.h = sz[1]; }
      if (s.broken[c.id]) c.broken = s.broken[c.id];
    }
    await store.putDeck(rec);
  }
  prefs.del(stateKey(job.key));
  emit(job.key, { done: true, total: s.total, broken: Object.keys(s.broken).length });
}

// Before a card is shown: "ok" (its files are stored, card.w / card.h set), "broken" (card.broken says why), or
// "missing" (not loaded, and nothing to load it from in this session: the zip must be picked again).
// selfCheck(card) reads the card's stored files, for cards whose sizes were lost (or decks from older versions).
export async function ensureCard(key, card, selfCheck) {
  const apply = (r) => { if (r.broken) { card.broken = r.broken; return "broken"; } card.w = r.w; card.h = r.h; return "ok"; };
  const m = done.get(key);
  if (m && m.has(card.id)) return apply(m.get(card.id));
  const s = stateOf(key);
  if (s && s.sizes[card.id]) return apply({ w: s.sizes[card.id][0], h: s.sizes[card.id][1] });
  if (s && s.broken[card.id]) return apply({ broken: s.broken[card.id] });
  const job = jobs.get(key);
  if (job && (job.busy === card.id || job.queue.includes(card.id))) {
    want(key, card.id);
    return new Promise((res) => { const w = job.waiters.get(card.id) || []; w.push((r) => res(apply(r))); job.waiters.set(card.id, w); });
  }
  const r = selfCheck ? await selfCheck(card).catch(() => null) : null;
  return r ? apply(r) : "missing";
}

// Move a card to the front of the queue (the one on screen, then the next ones).
export function want(key, id) {
  const job = jobs.get(key);
  if (!job) return;
  const i = job.queue.indexOf(id);
  if (i > 0) { job.queue.splice(i, 1); job.queue.unshift(id); }
}
export function stopLoading(key) {
  const job = jobs.get(key);
  if (!job) return;
  job.stop = true; clearTimeout(job.saveTimer); jobs.delete(key);
  job.state.pending = [...(job.busy ? [job.busy] : []), ...job.queue];
  prefs.set(stateKey(key), job.state);
}
export function forgetLoading(key) { stopLoading(key); done.delete(key); prefs.del(stateKey(key)); }
