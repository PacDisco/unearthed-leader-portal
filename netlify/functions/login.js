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

const PORTAL_OBJECT_ID = "2-58156993";

// Association labels that grant leader-portal access. Compared
// case-insensitively to be resilient to HubSpot label edits.
const LEADER_LABELS = new Set(["teacher", "trip leader"]);

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

    const headers = {
      Authorization: `Bearer ${process.env.HUBSPOT_API_KEY}`,
      "Content-Type": "application/json"
    };

    const contactRes = await fetch(
      "https://api.hubapi.com/crm/v3/objects/contacts/search",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          filterGroups: [{
            filters: [{
              propertyName: "email",
              operator: "EQ",
              value: cleanEmail
            }]
          }],
          // admin_role + firstname are returned to the browser so the
          // login page can route admins straight to /admin.html and
          // greet by name. portal_password is what we authenticate against.
          properties: ["email", "portal_password", "admin_role", "firstname"]
        })
      }
    );

    const contactData = await contactRes.json();
    const contact = contactData.results?.[0];

    if (!contact) {
      return {
        statusCode: 200,
        body: JSON.stringify({ success: false, error: "Email not found" })
      };
    }

    const storedPassword = contact.properties?.portal_password;

    if (!storedPassword) {
      return {
        statusCode: 200,
        body: JSON.stringify({ success: false, error: "no_password" })
      };
    }

    if (storedPassword !== password) {
      return {
        statusCode: 200,
        body: JSON.stringify({ success: false, error: "Incorrect password" })
      };
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
          body: JSON.stringify({
            success: false,
            error: "not_authorized"
          })
        };
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        email: cleanEmail,
        // Optional fields. The login page checks adminRole to decide
        // whether to land the user on /admin.html or the regular portal.
        adminRole,
        // "teacher" | "trip_leader" | null (null when the user is an admin).
        // Surface this so the frontend can render role-aware UI without a
        // second round-trip to HubSpot.
        leaderRole,
        firstName: contact.properties?.firstname || null
      })
    };

  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    };
  }
}

// Looks at every Portal this contact is associated to and returns
// "teacher" if any association is labelled Teacher, "trip_leader" if any
// is labelled Trip Leader, or null if neither. Teacher wins ties (it's
// the more general role for showing up in the leader portal).
//
// Uses CRM v4 because v3 doesn't expose association *labels*, only types.
// `associationTypes` is an array per result; a single contact↔portal pair
// can carry multiple labels, so we have to scan them all.
async function resolveLeaderRole(contactId, headers) {
  if (!contactId) return null;

  try {
    const res = await fetch(
      `https://api.hubapi.com/crm/v4/objects/contacts/${contactId}/associations/${PORTAL_OBJECT_ID}`,
      { headers }
    );

    if (!res.ok) {
      // Fail closed: a HubSpot outage shouldn't accidentally let a
      // parent in. The frontend will show the generic "not authorized"
      // message; the function logs include the status for debugging.
      console.warn(
        `[login] portal-associations lookup failed for contact ${contactId}: ${res.status}`
      );
      return null;
    }

    const data = await res.json();
    const results = data.results || [];

    let isTeacher = false;
    let isTripLeader = false;

    for (const r of results) {
      for (const t of r.associationTypes || []) {
        const label = String(t?.label || "").trim().toLowerCase();
        if (!LEADER_LABELS.has(label)) continue;
        if (label === "teacher") isTeacher = true;
        else if (label === "trip leader") isTripLeader = true;
      }
    }

    if (isTeacher) return "teacher";
    if (isTripLeader) return "trip_leader";
    return null;
  } catch (err) {
    console.warn("[login] portal-associations lookup threw:", err?.message || err);
    return null;
  }
}
