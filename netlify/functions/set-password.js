import { createToken } from "./_shared/auth.js";
import { hashPassword } from "./_shared/password.js";
import { leaderPortalIdsForEmail } from "./_shared/portal-access.js";

export async function handler(event) {
  try {
    const { token, email, password } = JSON.parse(event.body);

    if (!token || !email || !password) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Missing fields" })
      };
    }

    // Enforce a minimum length server-side (the set-password page checks this
    // too, but client checks are bypassable). Only applies to NEW/reset
    // passwords — existing shorter passwords keep working at login until the
    // owner next changes them, so no one is locked out.
    if (String(password).length < 8) {
      return {
        statusCode: 400,
        body: JSON.stringify({ success: false, error: "Password must be at least 8 characters." })
      };
    }

    const headers = {
      Authorization: `Bearer ${process.env.HUBSPOT_API_KEY}`,
      "Content-Type": "application/json"
    };

    // Find contact
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
              value: email
            }]
          }],
          properties: ["email", "portal_token", "portal_token_expiry", "admin_role"]
        })
      }
    );

    const contactData = await contactRes.json();
    const contact = contactData.results?.[0];

    if (!contact) {
      return {
        statusCode: 200,
        body: JSON.stringify({ success: false, error: "Contact not found" })
      };
    }

    const storedToken = contact.properties?.portal_token;
    const expiry = parseInt(contact.properties?.portal_token_expiry || "0");

    if (storedToken !== token || Date.now() > expiry) {
      return {
        statusCode: 200,
        body: JSON.stringify({ success: false, error: "Invalid or expired link" })
      };
    }

    // Save password and clear token
    await fetch(
      `https://api.hubapi.com/crm/v3/objects/contacts/${contact.id}`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          properties: {
            portal_password: await hashPassword(password),
            portal_token: "",
            portal_token_expiry: ""
          }
        })
      }
    );

    // The set-password page logs the user straight in, so hand back a
    // signed session token (and their role) just like login.js does.
    const adminRole = contact.properties?.admin_role || null;
    const cleanEmail = String(email).toLowerCase().trim();

    // Leader-portal gate (mirrors login.js): only admins or staff
    // (Teacher/Trip Leader) get a session. The password is saved above
    // regardless, but a non-leader can't get in — this stops the magic-link
    // path from bypassing the access check.
    let leaderRole = null;
    if (!adminRole) {
      const leaderPortals = await leaderPortalIdsForEmail(cleanEmail);
      if (!leaderPortals.length) {
        return {
          statusCode: 200,
          body: JSON.stringify({ success: false, error: "not_authorized" })
        };
      }
      leaderRole = true;
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        token: createToken({ email: cleanEmail, role: adminRole }),
        adminRole,
        leaderRole
      })
    };

  } catch (err) {
    console.error("[set-password] error:", err?.message || err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Server error" })
    };
  }
}
