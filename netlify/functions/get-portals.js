// Returns every Portal (custom object 2-58156993) in HubSpot — used by
// the admin trip picker (/admin.html). For each portal we include a flag
// indicating whether it's associated to the admin's contact, so the
// frontend can group "your trips" above "other trips".
//
// Inputs (querystring):
//   email — admin's email. Required. Used to compute `associated`.
//
// Required env var: HUBSPOT_API_KEY
//
// Notes:
//   - The Portal object id "2-58156993" matches what portal.js already uses.
//   - The "global" defaults record (id 50506535214) is filtered out — it's
//     not a real trip, just shared content. Avoiding it in the picker.
//   - Only contacts with admin_role set should be hitting this endpoint.
//     We don't enforce that here yet (no auth layer); the frontend checks
//     adminRole from sessionStorage before navigating to /admin.html. If
//     this is ever exposed at a stable URL we'll add server-side gating.

import { authenticateAdmin } from "./_shared/auth.js";

const PORTAL_OBJECT_ID = "2-58156993";
const GLOBAL_PORTAL_ID = "50506535214";
const PROPS = "portal_title,unearthed_program,destination,price,program_currency,status,program_start_date,program_end_date,flight_departure_date,return_flight_date,hs_createdate,hs_object_id";

const DAY = 24 * 60 * 60 * 1000;
const isoDay = (v) => {
  if (!v) return null;
  const d = new Date(/^\d+$/.test(String(v)) ? Number(v) : v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

/**
 * Where a trip is in its life, for the admin picker's sort / filter and its
 * Completed folder. Pure (tested).
 *
 * Dates: Program Start / End Date first; where one isn't filled in, the
 * Flight Departure / Return Flight Date stands in for it.
 *
 *   completed  — HubSpot `status` says Completed/Finished/Cancelled, or the
 *                end date has passed (from the day after), or — with no
 *                end date — 30 days after the start, or — with no
 *                dates at all — the year in its name is before this year.
 *   in progress — departed, not yet returned.
 *   upcoming   — departure date ahead.
 *   no dates   — nothing to go on yet (shown with the upcoming trips).
 */
export function describePortal(props = {}, { now = new Date() } = {}) {
  const today = now.toISOString().slice(0, 10);
  const start = isoDay(props.program_start_date) || isoDay(props.flight_departure_date);
  const end = isoDay(props.program_end_date) || isoDay(props.return_flight_date);
  const name = props.unearthed_program || props.portal_title || "";
  const yearM = /\b(20\d\d)\b/.exec(`${name} ${props.destination || ""} ${props.portal_title || ""}`);
  const year = start ? Number(start.slice(0, 4)) : yearM ? Number(yearM[1]) : null;
  const status = String(props.status || "").trim();
  let phase;
  if (/cancel/i.test(status)) phase = "cancelled";
  else if (/complete|finish/i.test(status)) phase = "completed";
  else if (end && end < today) phase = "completed";
  else if (!end && start && new Date(start).getTime() + 30 * DAY < now.getTime()) phase = "completed";
  else if (start && start <= today) phase = "in-progress";
  else if (start) phase = "upcoming";
  else if (year && year < now.getUTCFullYear()) phase = "completed";
  else phase = "no-dates";
  // "Nepal - September 17 - October 9 2026" → "Nepal"; "Cambodia | July 3…" → "Cambodia"
  const country = String(props.destination || "").split(/\s[-–—|,]\s|,|\|/)[0].replace(/\b20\d\d\b/g, "").replace(/\s+/g, " ").trim()
    || (/\s[-–—]\s(.+)$/.exec(name)?.[1] || "").replace(/\b20\d\d\b/g, "").trim();
  return { start, end, year, country, phase, completed: phase === "completed" || phase === "cancelled", status: status || null };
}

export async function handler(event) {
  try {
    // Auth: admin only. This lists EVERY trip, so it must not be reachable by
    // a non-admin (the old version had no server-side check at all). We take
    // the email from the verified session, not the querystring, so the
    // "your trips" decoration can't be spoofed either.
    const auth = await authenticateAdmin(event);
    if (auth.response) return auth.response;
    const email = auth.session.email;

    if (!process.env.HUBSPOT_API_KEY) {
      return jsonResponse(500, { error: "HUBSPOT_API_KEY is not set" });
    }

    const headers = {
      Authorization: `Bearer ${process.env.HUBSPOT_API_KEY}`,
      "Content-Type": "application/json"
    };

    // 1. Resolve the admin's contact ID so we can list their portal
    //    associations. If the contact doesn't exist we still proceed —
    //    the picker just won't have any "Your trips" section.
    let contactId = null;
    try {
      const contactRes = await fetch(
        "https://api.hubapi.com/crm/v3/objects/contacts/search",
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            filterGroups: [{
              filters: [{ propertyName: "email", operator: "EQ", value: email }]
            }],
            properties: ["email", "admin_role"]
          })
        }
      );
      if (contactRes.ok) {
        const contactData = await contactRes.json();
        contactId = contactData.results?.[0]?.id || null;
      }
    } catch (err) {
      console.warn("[get-portals] contact lookup failed:", err?.message || err);
    }

    // 2. Get every portal ID this contact is associated to.
    const associatedIds = new Set();
    if (contactId) {
      try {
        const assocRes = await fetch(
          `https://api.hubapi.com/crm/v4/objects/contacts/${contactId}/associations/${PORTAL_OBJECT_ID}`,
          { headers }
        );
        if (assocRes.ok) {
          const assocData = await assocRes.json();
          for (const r of assocData.results || []) {
            if (r.toObjectId != null) associatedIds.add(String(r.toObjectId));
          }
        }
      } catch (err) {
        console.warn("[get-portals] associations fetch failed:", err?.message || err);
      }
    }

    // 3. Fetch every Portal record. Paginate using HubSpot's `after` cursor
    //    in case there's ever more than one page; capping at 5 pages so a
    //    runaway never burns the function timeout.
    const portals = [];
    let after = undefined;
    for (let page = 0; page < 5; page++) {
      const qs = new URLSearchParams({
        limit: "100",
        properties: PROPS
      });
      if (after) qs.set("after", after);

      const listRes = await fetch(
        `https://api.hubapi.com/crm/v3/objects/${PORTAL_OBJECT_ID}?${qs.toString()}`,
        { headers }
      );
      if (!listRes.ok) {
        const text = await listRes.text().catch(() => "");
        console.error(`[get-portals] portal list ${listRes.status}: ${text.slice(0, 200)}`);
        return jsonResponse(502, {
          error: "Could not list portals",
          details: `HubSpot ${listRes.status}`
        });
      }
      const listData = await listRes.json();
      for (const r of listData.results || []) {
        // Skip the global defaults record — it's not a real trip.
        if (String(r.id) === GLOBAL_PORTAL_ID) continue;
        const p = r.properties || {};
        portals.push({
          id: String(r.id),
          title: p.portal_title || p.unearthed_program || "(untitled trip)",
          program: p.unearthed_program || "",
          destination: p.destination || "",
          price: p.price || null,
          currency: p.program_currency || null,
          createdAt: p.hs_createdate || null,
          associated: associatedIds.has(String(r.id)),
          ...describePortal(p),
        });
      }
      after = listData.paging?.next?.after;
      if (!after) break;
    }

    // Default order (the page re-sorts and filters): associated first, then
    // alphabetical by title.
    portals.sort((a, b) => {
      if (a.associated !== b.associated) return a.associated ? -1 : 1;
      return (a.title || "").localeCompare(b.title || "");
    });

    return jsonResponse(200, { portals });

  } catch (err) {
    console.error("[get-portals] unhandled:", err?.stack || err?.message || err);
    return jsonResponse(500, { error: err?.message || "Server error" });
  }
}

function jsonResponse(statusCode, payload) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  };
}
