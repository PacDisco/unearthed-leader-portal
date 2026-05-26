// Bump this string any time you ship a release that should bust the
// install-time cache for previously-installed PWA users. The activate
// handler below deletes any cache whose name doesn't match.
const CACHE_NAME = "unearthed-v7-photos";
const STATIC_FILES = ["/index.html", "/login.html", "/site.webmanifest"];

// Install — cache static files
self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_FILES))
  );
  self.skipWaiting(); // activate immediately
});

// Activate — delete old caches
self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim(); // take control immediately
});

// Fetch — network first for same-origin, total bypass for everything else.
self.addEventListener("fetch", e => {
  const url = e.request.url;

  // Always go to network for API calls.
  if (url.includes("/.netlify/functions/") || url.includes("/document-proxy")) {
    e.respondWith(fetch(e.request));
    return;
  }

  // Don't try to handle non-http(s) schemes (chrome-extension://, data:,
  // blob:, etc.) — Cache.put() throws on them, and the browser already
  // handles them natively.
  if (!/^https?:/i.test(url)) return;

  // Cross-origin requests bypass the SW entirely. The browser fetches
  // them natively without our mediation. This avoids a long-standing
  // iOS Safari quirk where opaque (cross-origin) responses returned via
  // a service worker sometimes fail to render in <img> tags, even when
  // the same URL loads fine without an SW. HubSpot/CDN-hosted leader
  // photos hit this path. Same images work on desktop because Chromium
  // handles SW-mediated opaque responses differently.
  let sameOrigin = false;
  try { sameOrigin = new URL(url).origin === self.location.origin; }
  catch (_) { /* malformed URL — let the browser deal */ return; }
  if (!sameOrigin) return;

  // Same-origin GETs only past this point.
  if (e.request.method !== "GET") return;

  e.respondWith(
    fetch(e.request)
      .then(res => {
        // Only cache successful basic (same-origin) responses.
        if (res && res.ok && res.type === "basic") {
          const resClone = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, resClone))
            .catch(err => console.warn("[sw] cache.put skipped:", err && err.message));
        }
        return res;
      })
      .catch(() => caches.match(e.request)) // fall back to cache if offline
  );
});

// ---- Web Push ----
// Triggered by /.netlify/functions/send-message-board-push when an
// admin updates the message board. Payload is a JSON blob like:
//   { title: "...", body: "...", url: "/?..." }
// We show a system notification; clicking it focuses an existing portal
// tab if one is open, otherwise opens a new one.
self.addEventListener("push", (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; }
  catch (_) {
    try { data = { body: e.data ? e.data.text() : "" }; } catch (_) { /* ignore */ }
  }
  const title = data.title || "Unearthed Portal";
  const options = {
    body: data.body || "There's a new message on your trip's Message Board.",
    icon: data.icon || "/web-app-manifest-192x192.png",
    badge: data.badge || "/favicon-96x96.png",
    tag: data.tag || "unearthed-message-board", // dedupe consecutive pushes
    renotify: true,
    data: { url: data.url || "/index.html" }
  };

  // Bump the app-icon badge alongside showing the notification. The
  // Badging API isn't a hard dependency — older browsers / Android
  // sometimes don't have it — so we feature-detect and never let a
  // badge failure kill the notification itself.
  const badgeBump = (async () => {
    try {
      if (self.navigator && typeof self.navigator.setAppBadge === "function") {
        await self.navigator.setAppBadge(1);
      }
    } catch (err) {
      console.warn("[sw] setAppBadge failed:", err && err.message);
    }
  })();

  e.waitUntil(Promise.all([
    self.registration.showNotification(title, options),
    badgeBump
  ]));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "/";
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true })
      .then((wins) => {
        // Focus the first existing portal tab on this origin if there
        // is one; otherwise open a new one at `url`.
        const here = new URL(self.location.origin).origin;
        for (const w of wins) {
          try {
            if (new URL(w.url).origin === here) {
              w.focus();
              if ("navigate" in w) w.navigate(url);
              return;
            }
          } catch (_) { /* skip */ }
        }
        return self.clients.openWindow(url);
      })
  );
});
