// Saves the browser's PushSubscription to the user's HubSpot contact so
// the server-side sender (send-message-board-push) can target them when
// the message board updates.
//
// Expected POST body (JSON):
//   {
//     email:        "parent@example.com",
//     subscription: { endpoint, keys: { p256dh, auth }, ... }   // raw PushSubscription.toJSON()
//   }
//
// Stores the entire JSON-serialised subscription on the contact's
// `push_subscription` property (a single-line text or multi-line text
// property in HubSpot — the JSON is short, ~400 bytes, so either works).
//
// Required env var: HUBSPOT_API_KEY (write access to contacts).

import { authenticateSelf } from "./_shared/auth.js";

export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") {
      return jsonResponse(405, { error: "Method not allowed" });
    }
    if (!process.env.HUBSPOT_API_KEY) {
      return jsonResponse(500, { error: "HUBSPOT_API_KEY is not set" });
    }

    let body;
    try { body = JSON.parse(event.body || "{}"); }
    catch (_) { return jsonResponse(400, { error: "Invalid JSON body" }); }

    const email = (body.email || "").toLowerCase().trim();
    const subscription = body.subscription;
    if (!email || !subscription || !subscription.endpoint) {
      return jsonResponse(400, { error: "Missing email or subscription.endpoint" });
    }

    // Auth: you may only save a push subscription against your own contact.
    const auth = await authenticateSelf(event, email);
    if (auth.response) return auth.response;

    const headers = {
      Authorization: `Bearer ${process.env.HUBSPOT_API_KEY}`,
      "Content-Type": "application/json"
    };

    // Look up the contact.
    const lookupRes = await fetch(
      "https://api.hubapi.com/crm/v3/objects/contacts/search",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }],
          properties: ["email"]
        })
      }
    );
    if (!lookupRes.ok) {
      const text = await lookupRes.text().catch(() => "");
      console.error(`[save-push-subscription] lookup ${lookupRes.status}: ${text.slice(0, 200)}`);
      return jsonResponse(502, { error: "Could not look up contact." });
    }
    const lookup = await lookupRes.json();
    const contactId = lookup.results?.[0]?.id;
    if (!contactId) {
      return jsonResponse(404, { error: "Contact not found" });
    }

    // Patch push_subscription with the JSON-serialised subscription.
    const patchRes = await fetch(
      `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          properties: {
            push_subscription: JSON.stringify(subscription)
          }
        })
      }
    );
    if (!patchRes.ok) {
      const text = await patchRes.text().catch(() => "");
      console.error(`[save-push-subscription] patch ${patchRes.status}: ${text.slice(0, 200)}`);
      return jsonResponse(502, { error: "Could not save subscription.", details: `HubSpot ${patchRes.status}` });
    }

    console.log(`[save-push-subscription] Saved for ${email}`);
    return jsonResponse(200, { success: true });

  } catch (err) {
    console.error("[save-push-subscription] Unhandled:", err?.stack || err?.message || err);
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
