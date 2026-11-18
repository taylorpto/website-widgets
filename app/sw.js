// Offline support for the Taylor PTO app.
// Bump VERSION whenever app.js / app.css / index.html change, so phones pick up the new copy.
const VERSION = "taylor-pto-v1";
const SHELL = [
  "./", "index.html", "app.css?v=1", "app.js?v=1", "manifest.webmanifest",
  "icons/icon.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Live data: try the network first, fall back to the last copy.
  const isData = url.pathname.endsWith("/data/events.json") || url.hostname === "docs.google.com";
  // App shell and fonts: serve from cache, refresh in the background.
  const isShell = url.origin === location.origin || /fonts\.(googleapis|gstatic)\.com$/.test(url.hostname);
  if (!isData && !isShell) return;

  if (isData) {
    e.respondWith(
      fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
        return res;
      }).catch(() => caches.match(req))
    );
    return;
  }

  e.respondWith(
    caches.match(req, { ignoreSearch: req.mode === "navigate" }).then((hit) => {
      const net = fetch(req).then((res) => {
        if (res.ok || res.type === "opaque") { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
        return res;
      }).catch(() => hit || (req.mode === "navigate" ? caches.match("index.html") : undefined));
      return hit || net;
    })
  );
});
