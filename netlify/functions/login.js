// Authenticates a portal user.
//
// Access policy (enforced here, server-side):
//   1. Admins   — any contact with a non-empty `admin_role` property.
//   2. Leaders  — any contact associated to at least one Portal record
//                 (custom object 2-58156993) with an association label of
//                 "Teacher" or "Trip Leader".
//
// Anyone else (e.g. parents/students) is rejected with `not_authorized`
// even if their password matches. The check runs AFTER password
// verification so we don't accidentally leak which emails are
// authorized vs. just don't-have-the-right-role.
//
// Security: issues a signed session token (verified by every private
// endpoint), verifies passwords against a scrypt hash (with transparent
// upgrade of legacy plaintext), uses a generic failure message to avoid
// email enumeration, and throttles repeated failures.
//
// IMPORTANT: the session token's `role` is the admin_role (or null for
// leaders). Leaders are deliberately NOT marked admin in the token, so the
// "assigned-trips only" authorization in _shared/portal-access.js applies to
// them — only true admins bypass trip scoping.

import { createToken } from "./_shared/auth.js";
import { verifyPassword, hashPassword } from "./_shared/password.js";

const PORTAL_OBJECT_ID = "2-58156993";

// Association labels that grant leader-portal access. Compared
// case-insensitively to be resilient to HubSpot label edits.
const LEADER_LABELS = new Set(["teacher", "trip leader"]);

// ----- Brute-force throttle (fail-open) -----
// Locks an account for LOCK_MS after MAX_FAILS consecutive wrong passwords.
// Backed by two HubSpot contact properties (portal_failed_logins,
// portal_lockout_until). If they don't exist, all of this silently no-ops.
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;

function hsHeaders() {
  return {
    Authorization: `Bearer ${process.env.HUBSPOT_API_KEY}`,
    "Content-Type": "application/json"
  };
}

async function readThrottle(contactId) {
  try {
    const r = await fetch(
      `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}?properties=portal_failed_logins,portal_lockout_until`,
      { headers: hsHeaders() }
    );
    if (!r.ok) return { fails: 0, lockedUntil: 0, available: false };
    const d = await r.json();
    return {
      fails: parseInt(d.properties?.portal_failed_logins || "0", 10) || 0,
      lockedUntil: parseInt(d.properties?.portal_lockout_until || "0", 10) || 0,
      available: true
    };
  } catch (_) {
    return { fails: 0, lockedUntil: 0, available: false };
  }
}

async function writeThrottle(contactId, props) {
  try {
    await fetch(`https://api.hubapi.com/crm/v3/objects/contacts/${contactId}`, {
      method: "PATCH",
      headers: hsHeaders(),
      body: JSON.stringify({ properties: props })
    });
  } catch (_) { /* fail-open */ }
}

export async function handler(event) {
  try {
    const { email, password } = JSON.parse(event.body);

    if (!email || !password) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Missing email or password" })
      };
    }

    const cleanEmail = email.toLowerCase().trim();
    const headers = hsHeaders();

    const contactRes = await fetch(
      "https://api.hubapi.com/crm/v3/objects/contacts/search",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          filterGroups: [{
            filters: [{ propertyName: "email", operator: "EQ", value: cleanEmail }]
          }],
          properties: ["email", "portal_password", "admin_role", "firstname"]
        })
      }
    );

    const contactData = await contactRes.json();
    const contact = contactData.results?.[0];

    // Generic message for both "no such email" and "wrong password" so an
    // outsider can't probe which emails have accounts.
    const GENERIC_FAIL = "Incorrect email or password.";

    if (!contact) {
      return {
        statusCode: 200,
        body: JSON.stringify({ success: false, error: GENERIC_FAIL })
      };
    }

    // Reject early if currently locked out. (No-op until properties exist.)
    const throttle = contact.id
      ? await readThrottle(contact.id)
      : { fails: 0, lockedUntil: 0, available: false };
    if (throttle.lockedUntil && Date.now() < throttle.lockedUntil) {
      return {
        statusCode: 429,
        body: JSON.stringify({
          success: false,
          error: "Too many attempts. Please wait a few minutes and try again, or use the magic link."
        })
      };
    }

    const storedPassword = contact.properties?.portal_password;

    if (!storedPassword) {
      return {
        statusCode: 200,
        body: JSON.stringify({ success: false, error: "no_password" })
      };
    }

    const { ok, legacy } = await verifyPassword(password, storedPassword);
    if (!ok) {
      if (throttle.available && contact.id) {
        const fails = throttle.fails + 1;
        if (fails >= MAX_FAILS) {
          await writeThrottle(contact.id, {
            portal_failed_logins: "0",
            portal_lockout_until: String(Date.now() + LOCK_MS)
          });
        } else {
          await writeThrottle(contact.id, { portal_failed_logins: String(fails) });
        }
      }
      return {
        statusCode: 200,
        body: JSON.stringify({ success: false, error: GENERIC_FAIL })
      };
    }

    // Successful password — clear any accumulated failures/lockout.
    if (throttle.available && contact.id && (throttle.fails > 0 || throttle.lockedUntil)) {
      await writeThrottle(contact.id, { portal_failed_logins: "0", portal_lockout_until: "0" });
    }

    // Transparent migration of legacy plaintext passwords to a hash.
    if (legacy && contact.id) {
      try {
        const newHash = await hashPassword(password);
        await fetch(`https://api.hubapi.com/crm/v3/objects/contacts/${contact.id}`, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ properties: { portal_password: newHash } })
        });
      } catch (e) {
        console.warn("[login] password hash upgrade failed (non-fatal):", e?.message || e);
      }
    }

    // ---- Authorization gate ----
    // Password is correct. Now confirm the contact is allowed into the
    // leader portal: either they're an admin, or they have a Teacher /
    // Trip Leader association on at least one Portal.
    const adminRole = contact.properties?.admin_role || null;
    let leaderRole = null;

    if (!adminRole) {
      leaderRole = await resolveLeaderRole(contact.id, headers);
      if (!leaderRole) {
        return {
          statusCode: 200,
          body: JSON.stringify({ success: false, error: "not_authorized" })
        };
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        email: cleanEmail,
        // Signed session token. role = admin_role for admins, null for
        // leaders (so trip-scoping in portal-access.js applies to leaders).
        token: createToken({ email: cleanEmail, role: adminRole }),
        adminRole,
        // "teacher" | "trip_leader" | null (null when the user is an admin).
        leaderRole,
        firstName: contact.properties?.firstname || null
      })
    };

  } catch (err) {
    console.error("[login] error:", err?.message || err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Server error" })
    };
  }
}

// Looks at every Portal this contact is associated to and returns
// "teacher" if any association is labelled Teacher, "trip_leader" if any
// is labelled Trip Leader, or null if neither. Teacher wins ties.
//
// Resolves labels in the PORTAL→CONTACT direction (the same direction
// get-teachers.js reads from), since contact→portal labels can come back null.
async function resolveLeaderRole(contactId, headers) {
  if (!contactId) return null;

  try {
    const portalsRes = await fetch(
      `https://api.hubapi.com/crm/v4/objects/contacts/${contactId}/associations/${PORTAL_OBJECT_ID}`,
      { headers }
    );
    if (!portalsRes.ok) {
      console.warn(`[login] portal list lookup failed for contact ${contactId}: ${portalsRes.status}`);
      return null;
    }
    const portalsData = await portalsRes.json();
    const portalIds = (portalsData.results || [])
      .map(r => r.toObjectId)
      .filter(Boolean);
    if (portalIds.length === 0) return null;

    let isTeacher = false;
    let isTripLeader = false;

    await Promise.all(portalIds.map(async (portalId) => {
      try {
        const res = await fetch(
          `https://api.hubapi.com/crm/v4/objects/${PORTAL_OBJECT_ID}/${portalId}/associations/contacts`,
          { headers }
        );
        if (!res.ok) {
          console.warn(`[login] portal->contact lookup failed for portal ${portalId}: ${res.status}`);
          return;
        }
        const data = await res.json();
        for (const r of data.results || []) {
          if (String(r.toObjectId) !== String(contactId)) continue;
          for (const t of r.associationTypes || []) {
            const label = String(t?.label || "").trim().toLowerCase();
            if (!LEADER_LABELS.has(label)) continue;
            if (label === "teacher") isTeacher = true;
            else if (label === "trip leader") isTripLeader = true;
          }
        }
      } catch (err) {
        console.warn(`[login] portal->contact lookup threw for portal ${portalId}:`, err?.message || err);
      }
    }));

    if (isTeacher) return "teacher";
    if (isTripLeader) return "trip_leader";
    return null;
  } catch (err) {
    console.warn("[login] resolveLeaderRole threw:", err?.message || err);
    return null;
  }
}
