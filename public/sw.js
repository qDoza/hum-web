// Opens the app instantly from the phone's cache and refreshes that cache in the background,
// so a launch never waits for the network. API calls always go to the network.
const CACHE = "hum-v11";
const SHELL = ["/", "/app.css?v=11", "/app.js?v=11", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/apple-touch-icon.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || url.pathname.startsWith("/api/") || e.request.method !== "GET") return;
  const key = e.request.mode === "navigate" ? "/" : e.request;
  const fresh = fetch(e.request, { cache: "no-store" }).then(r => {
    if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(key, copy)); }
    return r;
  });
  e.waitUntil(fresh.catch(() => {}));
  // cached copy right away; the network answer updates the cache for the next launch
  e.respondWith(caches.match(key).then(hit => hit || fresh).catch(() => fresh));
});
