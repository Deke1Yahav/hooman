// Folders the hooman picked (File System Access handles), kept between visits in their own small database:
// the live save folder and the decks folder.
//
// Some Chromium builds (Edge 153 in private windows, for one) kill the page when a stored handle is read back. A
// mark is stored (and confirmed) before each read and removed after it; if a start finds the mark, that read never
// finished: the browser version is remembered as one that can't keep folders, and the folder is asked for once per
// session instead (until the browser updates). A bad build costs one crash, never one on every start.

export const LOST = "This browser version can't remember the folder between visits: tap Reconnect to choose it (a browser update fixes this).";

function open() {
  return new Promise((res, rej) => {
    const r = indexedDB.open("hooman-handles", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("h");
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
const get = (d, k) => new Promise((res) => { const q = d.transaction("h").objectStore("h").get(k); q.onsuccess = () => res(q.result); q.onerror = () => res(undefined); });
const put = (d, k, v) => new Promise((res, rej) => {
  const tx = d.transaction("h", "readwrite");
  if (v === undefined) tx.objectStore("h").delete(k); else tx.objectStore("h").put(v, k);
  tx.oncomplete = res; tx.onerror = () => rej(tx.error);
});

// {handle} | {lost: message} | {} (nothing stored)
export async function loadHandle(name) {
  try {
    const d = await open(), mark = `reading:${name}`;
    if ((await get(d, "broken")) === navigator.userAgent) return { lost: LOST };
    if (await get(d, mark)) { await put(d, "broken", navigator.userAgent); await put(d, mark); return { lost: LOST }; }
    await put(d, mark, true);
    const handle = await get(d, name);
    await put(d, mark);
    return handle ? { handle } : {};
  } catch { return {}; }
}

// null removes it. On a browser version that can't read handles back, nothing is stored (kept for this session).
export async function saveHandle(name, handle) {
  const d = await open();
  if (handle && (await get(d, "broken")) === navigator.userAgent) return;
  await put(d, name, handle || undefined);
}
