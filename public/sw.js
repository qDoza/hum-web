// Keeps the app shell available offline / instantly on launch. API calls always go to the network.
const CACHE = "hum-v5";
const SHELL = ["/", "/index.html", "/app.css?v=5", "/app.js?v=5", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/apple-touch-icon.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || url.pathname.startsWith("/api/") || e.request.method !== "GET") return;
  // network first so updates land right away; cache when offline
  e.respondWith(
    fetch(e.request, { cache: "no-store" })
      .then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r; })
      .catch(() => caches.match(e.request).then(r => r || caches.match("/index.html")))
  );
});
