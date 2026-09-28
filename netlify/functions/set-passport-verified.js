// POST /.netlify/functions/set-passport-verified   { "email": "...", "verified": true }
//
// Marks a person's passport details as checked by hand, so nobody else has to
// review them. Ticking it also settles any name mismatch the automatic read
// flagged: a person in the office has looked at the document and confirmed the
// record, which outranks anything OCR concluded.
//
// ADMINS ONLY. This is the one action on the roster an expedition leader
// cannot take — the tick means "the office has verified this", so if leaders
// could set it, it would stop meaning that. Enforced with authenticateAdmin,
// which requires a non-empty admin_role on the caller's contact.
//
// Who ticked it and when are recorded alongside, so the tick is attributable.

import { authenticateAdmin } from "./_shared/auth.js";
import { resolveRosterEditAccess } from "./_shared/portal-access.js";
import { PASSPORT_PROPS, ALL_PASSPORT_PROPS, shapePassportState } from "./_shared/passport.js";

function json(statusCode, payload) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) };
}

function hsHeaders() {
  return {
    Authorization: `Bearer ${process.env.HUBSPOT_API_KEY}`,
    "Content-Type": "application/json",
  };
}

export async function handler(event) {
  try {
    if (event.httpMethod && event.httpMethod !== "POST") {
      return json(405, { error: "Method not allowed" });
    }

    // Admin-only. Returns a ready 403 for a signed-in non-admin.
    const auth = await authenticateAdmin(event);
    if (auth.response) return auth.response;

    let body;
    try { body = JSON.parse(event.body || "{}"); }
    catch { return json(400, { error: "Invalid request body" }); }

    const email = String(body.email || "").toLowerCase().trim();
    if (!email) return json(400, { error: "Missing email" });
    const verified = body.verified === true;

    // Resolves the contact and confirms they're really on a trip. An admin
    // passes the permission half of this automatically.
    const access = await resolveRosterEditAccess(auth.session, email);
    if (access.response) return access.response;

    const properties = {
      [PASSPORT_PROPS.verified]: verified ? "true" : "false",
      // Cleared on un-tick so a stale name isn't left looking like a current
      // sign-off.
      [PASSPORT_PROPS.verifiedBy]: verified ? auth.session.email : "",
      [PASSPORT_PROPS.verifiedAt]: verified ? new Date().toISOString() : "",
    };

    const res = await fetch(
      `https://api.hubapi.com/crm/v3/objects/contacts/${encodeURIComponent(access.contactId)}`,
      { method: "PATCH", headers: hsHeaders(), body: JSON.stringify({ properties }) }
    );

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(`[set-passport-verified] PATCH ${res.status}: ${text.slice(0, 300)}`);
      return json(500, {
        error: "Could not save the check. The passport_checked properties may not exist in HubSpot yet — see PASSPORT_SETUP.md.",
      });
    }

    const fresh = await readContact(access.contactId);
    return json(200, {
      updated: true,
      passport: shapePassportState(fresh, {
        recordedFirst: fresh.firstname || "",
        recordedLast: fresh.lastname || "",
      }),
    });

  } catch (err) {
    console.error("[set-passport-verified] error:", err?.stack || err?.message || err);
    return json(500, { error: "Could not save the check." });
  }
}

async function readContact(contactId) {
  try {
    const props = ["firstname", "lastname", ...ALL_PASSPORT_PROPS];
    const res = await fetch(
      `https://api.hubapi.com/crm/v3/objects/contacts/${encodeURIComponent(contactId)}` +
      `?properties=${encodeURIComponent(props.join(","))}`,
      { headers: hsHeaders() }
    );
    if (!res.ok) return {};
    const data = await res.json();
    return data?.properties || {};
  } catch (_) {
    return {};
  }
}
