// Offline support. App files always come fresh from the server (bypassing the browser's HTTP cache, which
// GitHub Pages sets to 10 minutes); the saved copy is used only when there is no network.
const VERSION = "18";
const CACHE = "plantlocal-" + VERSION;
const FILES = ["./", "index.html", "manifest.webmanifest", "online.js", "sensor.js", "sync.js", "icon-192.png", "icon-512.png"];
self.addEventListener("install", e => e.waitUntil(
  caches.open(CACHE).then(c => c.addAll(FILES.map(f => new Request(f, { cache: "no-store" })))).then(() => self.skipWaiting())));
self.addEventListener("activate", e => e.waitUntil(
  caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;   // APIs and the CDN go straight to the network
  e.respondWith(fetch(url.href, { cache: "no-store", credentials: "same-origin" })
    .then(r => { if (r.ok) { const c = r.clone(); caches.open(CACHE).then(x => x.put(e.request, c)); } return r; })
    .catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match("index.html"))));
});
