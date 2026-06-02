// Returns the contacts associated to a portal, split into:
//   - teachers     — contacts with the "Teacher" association label, with
//                    full contact details (name/email/phone).
//   - tripLeaders  — contacts with the "Trip Leader" association label,
//                    with name + trip_leader_bio (custom contact property).
//
// Both lists feed the "SCHOOL CONTACTS" section on the portal so parents
// see who's accompanying the trip and a short bio of each trip leader.

import { authenticate, tokenFromEvent } from "./_shared/auth.js";
import { assertPortalAccess } from "./_shared/portal-access.js";

export async function handler(event) {
  try {
    // Auth: signed in.
    const auth = authenticate(event);
    if (auth.response) return auth.response;

    const { portalId } = event.queryStringParameters || {};

    if (!portalId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Missing portalId" })
      };
    }

    // Authorization: caller must be staff on this trip (or an admin).
    const access = await assertPortalAccess(auth.session, portalId);
    if (access) return access;

    const OBJECT = "2-58156993";
    const headers = {
      Authorization: `Bearer ${process.env.HUBSPOT_API_KEY}`,
      "Content-Type": "application/json"
    };

    // 1. Get every contact associated to this portal
    const assocRes = await fetch(
      `https://api.hubapi.com/crm/v4/objects/${OBJECT}/${portalId}/associations/contacts`,
      { headers }
    );

    if (!assocRes.ok) {
      console.error("[get-teachers] associations fetch failed:", (await assocRes.text().catch(() => "")).slice(0, 300));
      return {
        statusCode: 500,
        body: JSON.stringify({ error: "Portal contact associations fetch failed" })
      };
    }

    const assocData = await assocRes.json();
    const results = assocData.results || [];

    // 2. Bucket by association label
    const teacherIds = results
      .filter(r => r.associationTypes?.some(t => t.label === "Teacher"))
      .map(r => r.toObjectId);

    const tripLeaderIds = results
      .filter(r => r.associationTypes?.some(t => t.label === "Trip Leader"))
      .map(r => r.toObjectId);

    // 3. Fetch contact records for each bucket in parallel.
    //    Both buckets pull `expedition_leader_photo` (the staff headshot stored
    //    as a HubSpot *File* property — meaning the property value is a
    //    numeric File ID, not a URL). Trip leaders also pull trip_leader_bio
    //    for the blurb under their photo on the first tab.
    const [teachersRaw, tripLeadersRaw] = await Promise.all([
      fetchContactRecords(
        teacherIds,
        headers,
        ["firstname", "lastname", "email", "phone", "expedition_leader_photo"]
      ),
      fetchContactRecords(
        tripLeaderIds,
        headers,
        ["firstname", "lastname", "trip_leader_bio", "expedition_leader_photo"]
      )
    ]);

    // 3b. Admins (School Support Manager, Expedition Planning Manager) are looked up
    //     globally — they're not associated to any specific portal. Showing
    //     them on every trip's Expedition Overview is the whole point of
    //     the admin role. We search by the admin_role contact property and
    //     fold the results in alongside teachers + trip leaders.
    const adminsRaw = await fetchAdminContacts(headers);

    // 3c. Collect every numeric File ID we just got from any contact's
    //     expedition_leader_photo (across all three buckets), and resolve
    //     them all in parallel against HubSpot's Files API. The result is
    //     a Map<fileId, url> we can use during shaping. Non-numeric values
    //     (someone pasted a URL into a File property by mistake, etc.)
    //     are passed through downstream.
    const fileUrlMap = await resolveFileIds(
      collectFileIds(
        [...teachersRaw, ...tripLeadersRaw, ...adminsRaw],
        "expedition_leader_photo"
      ),
      headers
    );

    const teachers    = teachersRaw.map(c    => shapeTeacher(c, fileUrlMap));
    const tripLeaders = tripLeadersRaw.map(l => shapeTripLeader(l, fileUrlMap));
    const admins      = adminsRaw.map(a      => shapeAdmin(a, fileUrlMap));

    // Sort each list alphabetically by name
    teachers.sort((a, b) => a.name.localeCompare(b.name));
    tripLeaders.sort((a, b) => a.name.localeCompare(b.name));
    admins.sort((a, b) => a.name.localeCompare(b.name));

    // Append the caller's session token to any /document-proxy photo URLs so
    // the (now auth-gated) proxy can verify the viewer — <img> tags can't
    // send an Authorization header.
    const callerToken = tokenFromEvent(event);
    if (callerToken) {
      for (const c of [...teachers, ...tripLeaders, ...admins]) {
        if (c.photoUrl && c.photoUrl.startsWith("/document-proxy?")) {
          c.photoUrl += `&token=${encodeURIComponent(callerToken)}`;
        }
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ teachers, tripLeaders, admins })
    };

  } catch (err) {
    console.error("ERROR:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Server error" })
    };
  }
}

// ---------- helpers ----------

// Reads a batch of contacts and returns the raw HubSpot result objects
// (i.e. each item's `properties` is the keyed map of property values).
// Used in place of the old fetchContacts/shape combo so we can take an
// extra pass to resolve File IDs across the *combined* set of contacts.
async function fetchContactRecords(ids, headers, properties) {
  if (!ids || ids.length === 0) return [];

  const res = await fetch(
    "https://api.hubapi.com/crm/v3/objects/contacts/batch/read",
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        inputs: ids.map(id => ({ id: String(id) })),
        properties
      })
    }
  );

  if (!res.ok) return [];

  const data = await res.json();
  return data.results || [];
}

function shapeTeacher(c, fileUrlMap) {
  return {
    name:     `${c.properties.firstname || ""} ${c.properties.lastname || ""}`.trim(),
    email:    c.properties.email || "",
    phone:    c.properties.phone || "",
    photoUrl: resolvePhotoUrl(c.properties.expedition_leader_photo, fileUrlMap)
  };
}

function shapeTripLeader(c, fileUrlMap) {
  return {
    name:     `${c.properties.firstname || ""} ${c.properties.lastname || ""}`.trim(),
    bio:      c.properties.trip_leader_bio || "",
    photoUrl: resolvePhotoUrl(c.properties.expedition_leader_photo, fileUrlMap)
  };
}

// Looks up every contact whose admin_role is set to one of the recognised
// admin roles. These don't need to be associated to the trip — having a
// non-empty admin_role IS the access mechanism. Returns the raw HubSpot
// contact records (same shape as fetchContactRecords) so they can be
// folded into the same File-ID resolution pass as the other buckets.
async function fetchAdminContacts(headers) {
  const ROLES = ["School Support Manager", "Expedition Planning Manager"];

  const res = await fetch(
    "https://api.hubapi.com/crm/v3/objects/contacts/search",
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        // OR group: admin_role equals any one of the recognised roles.
        filterGroups: ROLES.map(role => ({
          filters: [{
            propertyName: "admin_role",
            operator: "EQ",
            value: role
          }]
        })),
        properties: [
          "firstname", "lastname", "email", "phone",
          "admin_role", "expedition_leader_photo",
          // Reuse the same bio field as trip leaders so admins can have a
          // bio shown under their card on the Overview without us inventing
          // a new property.
          "trip_leader_bio"
        ],
        limit: 100
      })
    }
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.warn(`[get-teachers] admin search failed ${res.status}: ${text.slice(0, 200)}`);
    return [];
  }

  const data = await res.json();
  return data.results || [];
}

function shapeAdmin(c, fileUrlMap) {
  return {
    name:     `${c.properties.firstname || ""} ${c.properties.lastname || ""}`.trim(),
    email:    c.properties.email || "",
    phone:    c.properties.phone || "",
    bio:      c.properties.trip_leader_bio || "",
    role:     c.properties.admin_role || "",
    photoUrl: resolvePhotoUrl(c.properties.expedition_leader_photo, fileUrlMap)
  };
}

// Walks every contact record and pulls out any value of `propName` that
// looks like a HubSpot File ID (digits only). Used to build a deduped
// list before the Files API resolution pass — multiple staff sharing the
// same photo end up as one fetch.
function collectFileIds(contactRecords, propName) {
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
async function resolveFileIds(idSet, headers) {
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
            console.warn(`[get-teachers] Files API ${res.status}/${metaRes.status} for fileId ${id}`);
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
        console.warn(`[get-teachers] Files API fetch failed for fileId ${id}:`, err?.message || err);
      }
    })
  );

  return map;
}

// Returns a browser-loadable URL for a leader's headshot, or null if there
// isn't one. The HubSpot File property stores a numeric File ID — we look
// that up in the resolved fileUrlMap from /files/v3/files/{id}. Older
// records may instead contain a raw URL (someone pasted one into the
// property, or a previous version stored it as a string), so we still
// handle that case as a fallback.
//
// For a Jotform-hosted URL we route through /document-proxy so the API key
// is added server-side; everything else (HubSpot CDN, public images) goes
// through as-is.
function resolvePhotoUrl(raw, fileUrlMap) {
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
function wrapIfJotform(url) {
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
