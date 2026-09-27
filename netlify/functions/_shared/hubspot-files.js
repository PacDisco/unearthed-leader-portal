// Shared helpers for turning a HubSpot *File* property (e.g. a contact's
// `expedition_leader_photo`) into a URL a browser can actually load.
//
// A HubSpot File property stores a numeric File ID, not a URL, so displaying
// one takes two steps:
//   1. collectFileIds(records, propName) — gather every numeric ID across a
//      set of contact records (deduped, so staff sharing a photo cost one
//      fetch).
//   2. resolveFileIds(ids, headers)      — resolve them all in parallel into
//      a Map<fileId, url>.
// Then resolvePhotoUrl(rawPropValue, map) turns an individual property value
// into the final URL (or null).
//
// Extracted from get-teachers.js so get-students.js can reuse the exact same
// resolution path for the school-leader roster on the Expedition Leader tab.
// Behaviour is unchanged from the original implementation.

// Walks every contact record and pulls out any value of `propName` that
// looks like a HubSpot File ID (digits only).
export function collectFileIds(contactRecords, propName) {
  const ids = new Set();
  for (const c of contactRecords || []) {
    const raw = c?.properties?.[propName];
    if (!raw) continue;
    // HubSpot File props sometimes return "12345" and sometimes "12345,67890"
    // when multi-file; treat any digit-only token as a File ID candidate.
    String(raw)
      .split(/[\s,;]+/)
      .map(s => s.trim())
      .filter(s => /^\d+$/.test(s))
      .forEach(s => ids.add(s));
  }
  return ids;
}

// Resolves each File ID against HubSpot's Files API and returns a
// Map<fileId, fileUrl>.
//
// We use the *signed-url* sub-endpoint, NOT the metadata endpoint:
//   GET /files/v3/files/{id}/signed-url  →  { url: "<direct CDN URL>" }
// vs.
//   GET /files/v3/files/{id}            →  { url: "<api-na1.hubspot.com/.../signed-url-redirect>" }
//
// The metadata endpoint hands back a HubSpot API URL that 302-redirects
// to the actual file. Desktop browsers follow that redirect happily,
// but iOS Safari (especially in PWA mode with a service worker
// involved) refuses to render a redirected response in <img>. The
// dedicated signed-url endpoint returns the direct CDN URL the browser
// can use straight away — no redirect, no auth, no SW gymnastics.
export async function resolveFileIds(idSet, headers) {
  const map = new Map();
  if (!idSet || idSet.size === 0) return map;

  await Promise.all(
    [...idSet].map(async (id) => {
      try {
        const res = await fetch(
          `https://api.hubapi.com/files/v3/files/${encodeURIComponent(id)}/signed-url`,
          { headers }
        );
        if (!res.ok) {
          // Fall back to the metadata endpoint — useful if signed-url
          // is gated by scope or the file is configured as fully
          // public (in which case metadata.url already IS the CDN URL).
          const metaRes = await fetch(
            `https://api.hubapi.com/files/v3/files/${encodeURIComponent(id)}`,
            { headers }
          );
          if (!metaRes.ok) {
            console.warn(`[hubspot-files] Files API ${res.status}/${metaRes.status} for fileId ${id}`);
            return;
          }
          const meta = await metaRes.json();
          if (meta && typeof meta.url === "string" && meta.url) {
            map.set(id, meta.url);
          }
          return;
        }
        const data = await res.json();
        if (data && typeof data.url === "string" && data.url) {
          map.set(id, data.url);
        }
      } catch (err) {
        console.warn(`[hubspot-files] Files API fetch failed for fileId ${id}:`, err?.message || err);
      }
    })
  );

  return map;
}

// Returns a browser-loadable URL for a contact's headshot, or null if there
// isn't one. The HubSpot File property stores a numeric File ID — we look
// that up in the resolved fileUrlMap from /files/v3/files/{id}. Older
// records may instead contain a raw URL (someone pasted one into the
// property, or a previous version stored it as a string), so we still
// handle that case as a fallback.
//
// For a Jotform-hosted URL we route through /document-proxy so the API key
// is added server-side; everything else (HubSpot CDN, public images) goes
// through as-is.
export function resolvePhotoUrl(raw, fileUrlMap) {
  if (!raw) return null;
  const first = String(raw)
    .split(/[\s,;]+/)
    .map(s => s.trim())
    .find(Boolean);
  if (!first) return null;

  // Case 1: HubSpot File ID. Look up the resolved URL.
  if (/^\d+$/.test(first) && fileUrlMap && fileUrlMap.has(first)) {
    return wrapIfJotform(fileUrlMap.get(first));
  }

  // Case 2: An actual URL was stored on the property.
  let parsed;
  try {
    parsed = new URL(first);
  } catch (_) {
    return null;
  }
  return wrapIfJotform(parsed.toString());
}

// Decides how to expose the photo URL to the browser. We route Jotform
// URLs through the same-origin /document-proxy edge function (because
// they need the API key appended server-side and would otherwise force
// the parent to log into Jotform). HubSpot CDN URLs and any other
// public URL pass through directly — HubSpot signed URLs are sensitive
// to path/query reserialisation and don't survive a proxy round-trip.
export function wrapIfJotform(url) {
  if (!url) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch (_) {
    return null;
  }
  // Force HTTPS. Mobile browsers (especially iOS Safari in PWA mode)
  // block mixed-content image loads on HTTPS pages, while desktop
  // sometimes silently upgrades. Normalising here prevents one
  // mobile-only failure mode where photos render fine on desktop.
  if (parsed.protocol === "http:") {
    parsed.protocol = "https:";
  }
  const finalUrl = parsed.toString();
  const host = parsed.hostname.toLowerCase();
  const isJotform = (
    host === "jotform.com" || host.endsWith(".jotform.com") ||
    host === "jotfor.ms"   || host.endsWith(".jotfor.ms")
  );
  return isJotform
    ? `/document-proxy?url=${encodeURIComponent(finalUrl)}`
    : finalUrl;
}
