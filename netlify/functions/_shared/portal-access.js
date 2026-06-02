// Leader-portal authorization helpers — "assigned trips only".
//
// These build on the session-token checks in _shared/auth.js. The token tells
// us WHO the caller is (verified email + whether they're an admin); these
// helpers answer WHETHER that caller may see a given trip or person.
//
// IMPORTANT: access is scoped to trips where the caller is STAFF — i.e. has a
// "Teacher" or "Trip Leader" association label on the Portal. A plain
// association is not enough, because parents/students are also associated with
// their trip; without the label check a parent could pull their trip's whole
// student roster through the leader portal.
//
//   - assertPortalAccess(session, portalId): caller must be Teacher/Trip
//     Leader on that Portal, unless admin.
//   - assertEmailAccess(session, targetEmail): caller may see a person's data
//     if they are that person, an admin, or are staff on a trip the target
//     belongs to.
//
// Return null when allowed, or a ready-to-return 403 response when denied.
// Fail CLOSED: if HubSpot lookups error, access is denied.

import { isAdmin } from "./auth.js";

const PORTAL_OBJECT = "2-58156993";
const LEADER_LABELS = new Set(["teacher", "trip leader"]);

function hsHeaders() {
  return {
    Authorization: `Bearer ${process.env.HUBSPOT_API_KEY}`,
    "Content-Type": "application/json"
  };
}

function deny(message) {
  return {
    statusCode: 403,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ error: message })
  };
}

async function contactIdForEmail(email) {
  const clean = String(email || "").toLowerCase().trim();
  if (!clean) return null;
  const r = await fetch("https://api.hubapi.com/crm/v3/objects/contacts/search", {
    method: "POST",
    headers: hsHeaders(),
    body: JSON.stringify({
      filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: clean }] }],
      properties: ["email"]
    })
  });
  if (!r.ok) return null;
  const d = await r.json();
  return d.results?.[0]?.id || null;
}

// Every Portal (trip) id a contact is associated with, ANY label. Used for the
// target side of assertEmailAccess (a student is associated as "Student").
async function allPortalIdsForContact(contactId) {
  if (!contactId) return [];
  const r = await fetch(
    `https://api.hubapi.com/crm/v4/objects/contacts/${contactId}/associations/${PORTAL_OBJECT}`,
    { headers: hsHeaders() }
  );
  if (!r.ok) return [];
  const d = await r.json();
  return (d.results || []).map(x => String(x.toObjectId)).filter(Boolean);
}

// Does `contactId` carry a Teacher / Trip Leader label on this specific
// portal? Resolved in the portal→contact direction (the reliable direction,
// matching login.js / get-teachers.js).
async function isLeaderOnPortal(contactId, portalId) {
  try {
    const r = await fetch(
      `https://api.hubapi.com/crm/v4/objects/${PORTAL_OBJECT}/${portalId}/associations/contacts`,
      { headers: hsHeaders() }
    );
    if (!r.ok) return false;
    const d = await r.json();
    for (const row of d.results || []) {
      if (String(row.toObjectId) !== String(contactId)) continue;
      for (const t of row.associationTypes || []) {
        if (LEADER_LABELS.has(String(t?.label || "").trim().toLowerCase())) return true;
      }
    }
    return false;
  } catch (_) {
    return false;
  }
}

// Portal ids where `email` is staff (Teacher/Trip Leader).
export async function leaderPortalIdsForEmail(email) {
  try {
    const cid = await contactIdForEmail(email);
    if (!cid) return [];
    const all = await allPortalIdsForContact(cid);
    const checks = await Promise.all(
      all.map(async pid => ((await isLeaderOnPortal(cid, pid)) ? pid : null))
    );
    return checks.filter(Boolean);
  } catch (_) {
    return [];
  }
}

// Caller must be Teacher/Trip Leader on `portalId` (or admin).
export async function assertPortalAccess(session, portalId) {
  if (isAdmin(session)) return null;
  if (!portalId) return deny("Missing trip id.");
  try {
    const cid = await contactIdForEmail(session.email);
    if (cid && (await isLeaderOnPortal(cid, portalId))) return null;
  } catch (_) { /* fall through to deny */ }
  return deny("You don't have access to this trip.");
}

// Caller may see `targetEmail`'s data if self, admin, or staff on a trip the
// target belongs to.
export async function assertEmailAccess(session, targetEmail) {
  if (isAdmin(session)) return null;
  const want = String(targetEmail || "").toLowerCase().trim();
  if (!want) return deny("Missing email.");
  if (session.email === want) return null;
  try {
    const myLeaderPortals = await leaderPortalIdsForEmail(session.email);
    if (myLeaderPortals.length) {
      const targetCid = await contactIdForEmail(want);
      const targetPortals = await allPortalIdsForContact(targetCid);
      if (myLeaderPortals.some(id => targetPortals.includes(id))) return null;
    }
  } catch (_) { /* fall through to deny */ }
  return deny("You don't have access to this person's information.");
}
