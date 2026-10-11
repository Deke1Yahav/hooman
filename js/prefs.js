// Per-viewer conveniences in localStorage (never answers: those live in IndexedDB).
export const prefs = {
  get(k, d) { try { const v = localStorage.getItem("hooman:" + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("hooman:" + k, JSON.stringify(v)); } catch {} },
};
