/* Vitalyn service worker.
   Precaches the app shell so Vitalyn opens instantly and keeps working with
   no connection — the behaviour that makes it feel installed rather than
   browsed. Bump CACHE when you ship new files. */
const CACHE = "vitalyn-v4";

const SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./css/style.css",
  "./css/vitalyn-care.css",
  "./js/app.js",
  "./js/vendor-qrcode.js",
  "./js/vitalyn-care.js",
  "./js/vitalyn-ble.js",
  "./assets/vitalyn-mark.png",
  "./assets/favicon.png",
  "./assets/icon-192.png",
  "./assets/icon-512.png",
  "./assets/icon-maskable-512.png",
  "./assets/apple-touch-icon.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      // addAll is atomic: one 404 discards everything, so add individually
      .then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Navigations: network first so updates land, cache as the offline fallback.
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put("./index.html", copy));
          return res;
        })
        .catch(() => caches.match("./index.html").then((r) => r || caches.match("./")))
    );
    return;
  }

  // Everything else: cache first, refresh in the background.
  e.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req)
        .then((res) => {
          if (res && res.status === 200 && res.type === "basic") {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => hit);
      return hit || net;
    })
  );
});

/* Medication reminders scheduled by the page while it is open. A service
   worker can post a notification even when the tab is backgrounded, which a
   plain page cannot — this is the first real gain from installing. */
self.addEventListener("message", (e) => {
  const d = e.data || {};
  if (d.type !== "vitalyn-remind") return;
  const delay = Math.max(0, Number(d.at) - Date.now());
  e.waitUntil(
    new Promise((res) => setTimeout(res, Math.min(delay, 2147483647))).then(() =>
      self.registration.showNotification(d.title || "Medication due", {
        body: d.body || "",
        tag: d.tag,
        icon: "./assets/icon-192.png",
        badge: "./assets/icon-192.png",
        vibrate: [400, 150, 400],
        requireInteraction: true,
      })
    )
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) if ("focus" in c) return c.focus();
      return self.clients.openWindow ? self.clients.openWindow("./index.html") : null;
    })
  );
});

/* Push, for when a server is added later. */
self.addEventListener("push", (e) => {
  let d = { title: "Vitalyn alert", body: "Open Vitalyn for details." };
  try { if (e.data) d = Object.assign(d, e.data.json()); } catch (err) { /* plain text */ }
  e.waitUntil(
    self.registration.showNotification(d.title, {
      body: d.body,
      icon: "./assets/icon-192.png",
      badge: "./assets/icon-192.png",
      vibrate: [400, 150, 400],
      requireInteraction: true,
    })
  );
});
