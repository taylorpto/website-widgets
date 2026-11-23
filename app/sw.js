// Offline support for the Taylor PTO app.
// Bump VERSION whenever app.js / app.css / index.html change, so phones pick up the new copy.
const VERSION = "taylor-pto-v16";
const SHELL = [
  "./", "index.html", "app.css?v=16", "app.js?v=16", "chat.js?v=16", "manifest.webmanifest",
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js",
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
  const isData = url.pathname.endsWith("/data/events.json");
  // App shell and fonts: serve from cache, refresh in the background.
  const isShell = (url.origin === location.origin && !url.search.includes("code=")) || /fonts\.(googleapis|gstatic)\.com$/.test(url.hostname) || url.href.startsWith("https://cdn.jsdelivr.net/npm/@supabase/");
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

// ---------- push notifications ----------
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || "Taylor PTO", {
    body: d.body || "",
    icon: "icons/icon.png",
    badge: "icons/icon.png",
    tag: d.tag,
    renotify: !!d.tag,
    data: { url: d.url || "./#chat" },
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const target = new URL(e.notification.data?.url || "./#chat", self.registration.scope).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of wins) {
      if (w.url.startsWith(self.registration.scope)) { await w.focus(); return w.navigate(target); }
    }
    return self.clients.openWindow(target);
  })());
});
