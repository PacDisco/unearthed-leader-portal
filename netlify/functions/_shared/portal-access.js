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

// Every association label `contactId` carries on `portalId`, lowercased.
// Used to decide what a target person IS on the trip (Student / Teacher /
// Parent / Trip Leader) without trusting anything the browser sent.
async function labelsOnPortal(contactId, portalId) {
  const out = new Set();
  if (!contactId || !portalId) return out;
  try {
    const r = await fetch(
      `https://api.hubapi.com/crm/v4/objects/${PORTAL_OBJECT}/${portalId}/associations/contacts`,
      { headers: hsHeaders() }
    );
    if (!r.ok) return out;
    const d = await r.json();
    for (const row of d.results || []) {
      if (String(row.toObjectId) !== String(contactId)) continue;
      for (const t of row.associationTypes || []) {
        const label = String(t?.label || "").trim().toLowerCase();
        if (label) out.add(label);
      }
    }
  } catch (_) { /* fail closed — caller treats an empty set as "no labels" */ }
  return out;
}

// Portal ids where `email` is specifically an EXPEDITION LEADER ("Trip
// Leader"). Narrower than leaderPortalIdsForEmail on purpose: teachers can
// read their trip's roster but cannot edit it.
export async function tripLeaderPortalIdsForEmail(email) {
  try {
    const cid = await contactIdForEmail(email);
    if (!cid) return [];
    const all = await allPortalIdsForContact(cid);
    const checks = await Promise.all(
      all.map(async pid => ((await hasLabelOnPortal(cid, pid, "trip leader")) ? pid : null))
    );
    return checks.filter(Boolean);
  } catch (_) {
    return [];
  }
}

async function hasLabelOnPortal(contactId, portalId, wanted) {
  const labels = await labelsOnPortal(contactId, portalId);
  return labels.has(String(wanted).toLowerCase());
}

// WRITE authorization for the leader portal's roster editing.
//
// Read access (assertEmailAccess) is deliberately wider than write access:
//   read  — self, admin, or ANY staff (Teacher or Trip Leader) on a shared trip
//   write — admin, or an EXPEDITION LEADER ("Trip Leader") on a shared trip
// A teacher who can see a student's medical answers therefore still cannot
// change them.
//
// Returns { response } to return immediately when denied, or, when allowed,
// { contactId, portalId, labels } — the resolved target contact, the trip the
// permission came through, and that person's association labels on it, so the
// caller can decide which contact properties are in scope (the school's
// status/notes fields only make sense on a Student).
export async function resolveRosterEditAccess(session, targetEmail) {
  const want = String(targetEmail || "").toLowerCase().trim();
  if (!want) return { response: deny("Missing email.") };

  try {
    const contactId = await contactIdForEmail(want);
    if (!contactId) return { response: deny("That person could not be found.") };

    const targetPortals = await allPortalIdsForContact(contactId);
    if (targetPortals.length === 0) {
      return { response: deny("That person isn't on any trip.") };
    }

    // Admins may edit anyone; the trip is only needed to read back labels.
    if (isAdmin(session)) {
      const portalId = targetPortals[0];
      return { contactId, portalId, labels: await labelsOnPortal(contactId, portalId) };
    }

    const myPortals = await tripLeaderPortalIdsForEmail(session.email);
    const portalId = myPortals.find(id => targetPortals.includes(id));
    if (!portalId) {
      return { response: deny("Only an expedition leader on this trip can change these details.") };
    }

    return { contactId, portalId, labels: await labelsOnPortal(contactId, portalId) };
  } catch (_) {
    return { response: deny("Could not verify your access to this person.") };
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
