// A student's uploaded flight e-tickets: the Drive folder link held on their
// Deal's `ue_airline_tickets` property (written by the flights uploader — the
// same value the student portal's "YOUR TICKETS" card shows).
//
// Used by the Flights, Insurance & Visas tab — for the student an admin has
// picked under VIEW AS STUDENT, or the signed-in person's own tickets.
//
// GET ?email=<student email>
// → { url, dealName } — url is null when no tickets have been uploaded yet.
//
// Auth: that person, an admin, or staff on a trip they belong to
// (assertEmailAccess) — the same rule as their payments and documents.

import { authenticate } from "./_shared/auth.js";
import { assertEmailAccess } from "./_shared/portal-access.js";

const json = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body)
});

function hsHeaders() {
  return {
    Authorization: `Bearer ${process.env.HUBSPOT_API_KEY}`,
    "Content-Type": "application/json"
  };
}

// Only an http(s) link is ever handed to the page as an href.
export function cleanTicketsUrl(v) {
  const s = String(v || "").trim();
  return /^https:\/\/[^\s"'<>]+$/i.test(s) ? s : null;
}

export async function handler(event) {
  try {
    const email = String(event.queryStringParameters?.email || "").toLowerCase().trim();
    if (!email) return json(400, { error: "Missing email" });

    const auth = await authenticate(event);
    if (auth.response) return auth.response;
    const access = await assertEmailAccess(auth.session, email);
    if (access) return access;

    const headers = hsHeaders();

    const cRes = await fetch("https://api.hubapi.com/crm/v3/objects/contacts/search", {
      method: "POST",
      headers,
      body: JSON.stringify({
        filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }],
        properties: ["email"]
      })
    });
    if (!cRes.ok) return json(502, { error: "Could not look up that person." });
    const contactId = (await cRes.json()).results?.[0]?.id;
    if (!contactId) return json(404, { error: "Contact not found", url: null });

    const aRes = await fetch(
      `https://api.hubapi.com/crm/v4/objects/contacts/${contactId}/associations/deals`,
      { headers }
    );
    if (!aRes.ok) return json(200, { url: null });
    const dealIds = ((await aRes.json()).results || []).map(r => String(r.toObjectId)).filter(Boolean);
    if (!dealIds.length) return json(200, { url: null });

    const dRes = await fetch("https://api.hubapi.com/crm/v3/objects/deals/batch/read", {
      method: "POST",
      headers,
      body: JSON.stringify({
        properties: ["ue_airline_tickets", "dealname", "createdate"],
        inputs: dealIds.map(id => ({ id }))
      })
    });
    if (!dRes.ok) return json(502, { error: "Could not read their deal." });

    // Newest deal first, so a returning student sees this trip's tickets.
    const deals = ((await dRes.json()).results || []).slice().sort((a, b) =>
      new Date(b.properties?.createdate || 0).getTime() - new Date(a.properties?.createdate || 0).getTime()
    );
    for (const d of deals) {
      const url = cleanTicketsUrl(d.properties?.ue_airline_tickets);
      if (url) return json(200, { url, dealName: d.properties?.dealname || null });
    }
    return json(200, { url: null });
  } catch (err) {
    console.error("[get-student-tickets] ERROR:", err);
    return json(500, { error: "Server error" });
  }
}
