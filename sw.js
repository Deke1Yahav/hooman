// Offline app shell (stale-while-revalidate) + Android share target: a zip shared to the
// installed app is parked in the "hooman-inbox" cache and picked up by the page (?shared=1).

const VERSION = "hooman-0.4.1";
const SHELL = [
  "./", "index.html", "app.css", "manifest.webmanifest", "llms.txt", "deck.schema.json",
  "js/app.js", "js/store.js", "js/importer.js", "js/zip.js", "js/png.js", "js/deck.js", "js/view.js", "js/export.js", "js/editor.js", "js/prefs.js", "js/contrast.js", "js/settings.js", "js/tapping.js", "js/gestures.js", "js/backup.js", "js/results.js", "js/share.js", "js/photos.js", "js/drive.js", "js/config.js", "vendor/qrcode.mjs",
  "icons/icon.svg", "icons/icon-192.png", "icons/icon-512.png",
  "fonts/atkinson-400.woff2", "fonts/atkinson-700.woff2", "fonts/jetbrains-500.woff2",
  "examples/index.json",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== "hooman-inbox").map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

async function takeShare(req) {
  try {
    const form = await req.formData();
    const file = form.getAll("deck").find((f) => f && typeof f !== "string");
    if (file) {
      const c = await caches.open("hooman-inbox");
      await c.put("inbox", new Response(file, { headers: { "content-type": file.type || "application/zip", "x-name": encodeURIComponent(file.name || "shared.zip") } }));
    }
  } catch (e) { /* the page shows the empty inbox */ }
  return Response.redirect("./?shared=1", 303);
}

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method === "POST" && url.pathname.endsWith("/share-target")) return e.respondWith(takeShare(e.request));
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((hit) => {
    const net = fetch(e.request).then((r) => {
      if (r.ok && r.type === "basic") { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); }
      return r;
    }).catch(() => hit || Response.error());
    return hit || net;
  }));
});
