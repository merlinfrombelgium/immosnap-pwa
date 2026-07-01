// ImmoSnap service worker — NETWORK-FIRST for the app shell.
// The old worker was cache-first for HTML/JS/CSS, so phones served stale builds
// forever (looked "slow" and "nothing changed"). Now: always try the network for
// same-origin GETs and fall back to cache only when offline. Static third-party
// assets (Leaflet, exifr from CDN) are left to the browser cache.
const CACHE = "immosnap-shell-v10";
const SHELL = ["/", "/app.css", "/app.js", "/manifest.json", "/icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // let CDN + APIs pass through

  // Never cache dynamic endpoints — always live.
  if (url.pathname.startsWith("/match") || url.pathname.startsWith("/captures") ||
      url.pathname.startsWith("/geocode") || url.pathname.startsWith("/reverse") ||
      url.pathname.startsWith("/version") || url.pathname.startsWith("/health")) {
    return; // default: straight to network
  }

  // App shell: network-first, cache fallback (so a fresh build always wins online).
  event.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req).then((c) => c || caches.match("/")))
  );
});
