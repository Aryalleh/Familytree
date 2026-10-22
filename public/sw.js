// Service worker: keeps the app shell available offline. Family data is not cached here —
// the app keeps its own snapshot and queue of offline edits (see js/offline.js).
const VERSION = "ft-v6";
const SHELL = [
  "/",
  "/css/app.css",
  "/js/app.js",
  "/js/kinship.js",
  "/js/tree.js",
  "/js/print.js",
  "/js/offline.js",
  "/js/generations.js",
  "/js/config.js",
  "/vendor/dagre.esm.js",
  "/manifest.webmanifest",
  "/icon.svg",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === location.origin && url.pathname.startsWith("/api/")) return; // the app handles data itself

  // fonts: cache first (they never change)
  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    e.respondWith(
      caches.open(VERSION).then(async (c) => {
        const hit = await c.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        c.put(req, res.clone());
        return res;
      }),
    );
    return;
  }
  if (url.origin !== location.origin) return;

  // app shell: network first so updates arrive at once, cache when offline
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) caches.open(VERSION).then((c) => c.put(req.mode === "navigate" ? "/" : req, res.clone()));
        return res;
      })
      .catch(async () => (await caches.match(req.mode === "navigate" ? "/" : req)) || Response.error()),
  );
});
