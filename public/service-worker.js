// Bump this string any time you ship a release that should bust the
// install-time cache for previously-installed PWA users. The activate
// handler below deletes any cache whose name doesn't match.
const CACHE_NAME = "unearthed-leader-v12-offline-docs";
const STATIC_FILES = ["/index.html", "/login.html", "/site.webmanifest"];

// ---- Offline data cache (7-day read-only) ---------------------------------
// A separate cache holds JSON responses from the leader's read-only data
// endpoints so the portal is fully viewable offline for up to a week (e.g. on
// a trip with no connectivity). Kept SEPARATE from CACHE_NAME so the app-shell
// cache can be busted on release without wiping a leader's saved trip data.
const API_CACHE = "unearthed-api-v1";

// How long a cached data response stays usable offline. Matches the product
// requirement: the portal can be taken offline for up to 7 days.
const API_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Custom header stamped onto each cached API response so we can age it out.
const CACHED_AT_HEADER = "x-sw-cached-at";

// ONLY these Netlify Functions are read-only data reads that are safe to cache
// and replay offline. Everything else (login, logout, checkout, push
// subscribe, …) must always hit the network and is never cached. Keep this in
// sync with the GET data calls the leader trip view (index.html) makes.
const CACHEABLE_API = [
  "/.netlify/functions/portal",
  "/.netlify/functions/get-application-data",
  "/.netlify/functions/get-students",
  "/.netlify/functions/get-teachers",
  "/.netlify/functions/get-insurance",
  "/.netlify/functions/get-flight-tickets",
  "/.netlify/functions/get-paid-payments",
  "/.netlify/functions/get-uploaded-documents",
  "/.netlify/functions/get-push-config"
];

function isCacheableApi(url) {
  return CACHEABLE_API.some(p => url.includes(p));
}

// A cached response is fresh if it carries our timestamp and is within window.
function isFresh(res) {
  if (!res) return false;
  const stamped = Number(res.headers.get(CACHED_AT_HEADER) || 0);
  if (!stamped) return false;
  return (Date.now() - stamped) < API_MAX_AGE_MS;
}

// Store a copy of a data response with a timestamp header so we can age it out.
async function putApiCache(request, response) {
  try {
    const body = await response.clone().blob();
    const headers = new Headers(response.headers);
    headers.set(CACHED_AT_HEADER, String(Date.now()));
    const stamped = new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers
    });
    const cache = await caches.open(API_CACHE);
    await cache.put(request, stamped);
  } catch (err) {
    console.warn("[sw] api cache.put skipped:", err && err.message);
  }
}

// Delete cached data responses older than the 7-day window so stale trip data
// can't linger indefinitely.
async function purgeExpiredApiCache() {
  try {
    const cache = await caches.open(API_CACHE);
    const reqs = await cache.keys();
    await Promise.all(reqs.map(async (req) => {
      const res = await cache.match(req);
      if (!isFresh(res)) await cache.delete(req);
    }));
  } catch (_) { /* best-effort */ }
}

// Install — cache static files
self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_FILES))
  );
  self.skipWaiting(); // activate immediately
});

// Activate — delete old app-shell caches (but keep the API data cache) and
// purge any saved data responses older than the 7-day window.
self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter(k => k !== CACHE_NAME && k !== API_CACHE)
        .map(k => caches.delete(k))
    );
    await purgeExpiredApiCache();
    await self.clients.claim(); // take control immediately
  })());
});

// Allow the page to clear saved offline data (e.g. on logout, so a shared
// device doesn't retain the previous leader's trip data).
self.addEventListener("message", (e) => {
  if (e.data && e.data.type === "CLEAR_OFFLINE_DATA") {
    e.waitUntil(caches.delete(API_CACHE));
  }
});

// Fetch — network first for same-origin, total bypass for everything else.
self.addEventListener("fetch", e => {
  const url = e.request.url;

  // API calls.
  if (url.includes("/.netlify/functions/") || url.includes("/document-proxy")) {
    // Read-only data GETs the leader view needs — plus streamed documents
    // (/document-proxy: passport scans, medical PDFs, portrait & teacher
    // photos): network-first, but fall back to a saved copy (up to 7 days old)
    // when offline so the portal still renders in the field. Document links
    // carry the stable session token, so a file cached now is found under the
    // same URL when the page re-renders the link offline. Writes and non-GETs
    // always go straight to network.
    if (e.request.method === "GET" && (isCacheableApi(url) || url.includes("/document-proxy"))) {
      e.respondWith((async () => {
        try {
          const res = await fetch(e.request);
          // Cache only genuine successes. A 401/403 (expired/revoked session)
          // is passed straight through so the page can prompt a re-login when
          // it's actually online — we never overwrite good cached data with an
          // auth error, and never serve one from cache.
          if (res && res.ok) {
            await putApiCache(e.request, res);
            return res;
          }
          if (res && (res.status === 401 || res.status === 403)) return res;
          // Other non-OK (5xx, etc.): prefer fresh cache if we have it.
          const cached = await caches.open(API_CACHE).then(c => c.match(e.request));
          if (isFresh(cached)) return cached;
          return res;
        } catch (_) {
          // Offline / network error → serve saved data if still within 7 days.
          const cached = await caches.open(API_CACHE).then(c => c.match(e.request));
          if (isFresh(cached)) return cached;
          return new Response(
            JSON.stringify({ error: "offline", offline: true }),
            { status: 503, headers: { "Content-Type": "application/json" } }
          );
        }
      })());
      return;
    }
    // Everything else under the API paths: always network, never cached.
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
