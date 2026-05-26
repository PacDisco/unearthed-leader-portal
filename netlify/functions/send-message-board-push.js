// Webhook receiver: HubSpot calls this when a Portal record's
// message_board_posted_at changes. We fan the notice out as a Web Push
// to every contact associated with that portal whose
// `push_subscription` property is non-empty.
//
// Expected POST body (HubSpot workflow webhook):
//   {
//     portalId:    "48837354252",         // required — Portal record id
//     title:       "...",                 // optional — defaults to "<trip> · New message"
//     body:        "...",                 // optional — defaults to a generic copy
//     url:         "/index.html",         // optional — landing URL for click
//     // OR HubSpot's built-in webhook shape:
//     objectId:    "48837354252"          // some workflows send objectId instead
//   }
//
// HubSpot can also send a verification GET when you set up the webhook
// in the workflow UI — we 200-OK any GET so that handshake works.
//
// Optional shared secret: set WEBHOOK_SHARED_SECRET as a Netlify env
// var, and add it as an `X-Webhook-Secret` header in the HubSpot
// workflow's HTTP-action config. We refuse if it doesn't match. Leaving
// it unset accepts any caller (fine for testing; tighten before prod).
//
// Required env vars:
//   HUBSPOT_API_KEY        read+write contacts
//   VAPID_PUBLIC_KEY       generated locally (npx web-push generate-vapid-keys)
//   VAPID_PRIVATE_KEY      "
//   VAPID_SUBJECT          mailto:info@unearthededucation.org
//
// Optional:
//   WEBHOOK_SHARED_SECRET  shared secret to validate webhook origin

import webpush from "web-push";

const PORTAL_OBJECT_ID = "2-58156993";

export async function handler(event) {
  try {
    // Accept the verification handshake some webhook setups make.
    if (event.httpMethod === "GET") {
      return jsonResponse(200, { ok: true, message: "send-message-board-push listening" });
    }
    if (event.httpMethod !== "POST") {
      return jsonResponse(405, { error: "Method not allowed" });
    }

    // Optional shared-secret check.
    if (process.env.WEBHOOK_SHARED_SECRET) {
      const got = event.headers["x-webhook-secret"] || event.headers["X-Webhook-Secret"];
      if (got !== process.env.WEBHOOK_SHARED_SECRET) {
        console.warn("[send-message-board-push] Refused — bad/no shared secret");
        return jsonResponse(403, { error: "Forbidden" });
      }
    }

    // Env validation.
    const missing = [];
    if (!process.env.HUBSPOT_API_KEY)   missing.push("HUBSPOT_API_KEY");
    if (!process.env.VAPID_PUBLIC_KEY)  missing.push("VAPID_PUBLIC_KEY");
    if (!process.env.VAPID_PRIVATE_KEY) missing.push("VAPID_PRIVATE_KEY");
    if (!process.env.VAPID_SUBJECT)     missing.push("VAPID_SUBJECT");
    if (missing.length) {
      console.error("[send-message-board-push] Missing env:", missing);
      return jsonResponse(500, { error: `Server is not configured (${missing.join(", ")}).` });
    }

    webpush.setVapidDetails(
      process.env.VAPID_SUBJECT,
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY
    );

    let body;
    try { body = JSON.parse(event.body || "{}"); }
    catch (_) { return jsonResponse(400, { error: "Invalid JSON body" }); }

    // HubSpot's Send-a-webhook action sends the body in different
    // shapes depending on how it's configured. We accept all of them:
    //   { "portalId": "48837354252" }                    (custom mapping)
    //   { "objectId": 48837354252, ... }                 (default object payload)
    //   { "hs_object_id": "48837354252" }                ("Add static value" mapping)
    //   { "properties": { "hs_object_id": "..." } }      ("Include all properties" toggle)
    const portalId = String(
      body.portalId ||
      body.objectId ||
      body.hs_object_id ||
      body?.properties?.hs_object_id ||
      ""
    ).trim();
    if (!portalId) {
      console.error("[send-message-board-push] no portalId in body:", JSON.stringify(body).slice(0, 400));
      return jsonResponse(400, { error: "Missing portalId / objectId / hs_object_id in webhook body" });
    }

    const headers = {
      Authorization: `Bearer ${process.env.HUBSPOT_API_KEY}`,
      "Content-Type": "application/json"
    };

    // Look up the trip's portal_title so the notification can read
    // "Lincoln High School 2026" rather than the generic default.
    let tripTitle = "your expedition";
    try {
      const portalRes = await fetch(
        `https://api.hubapi.com/crm/v3/objects/${PORTAL_OBJECT_ID}/${encodeURIComponent(portalId)}?properties=portal_title,destination`,
        { headers }
      );
      if (portalRes.ok) {
        const portal = await portalRes.json();
        tripTitle = portal.properties?.portal_title || portal.properties?.destination || tripTitle;
      }
    } catch (_) { /* non-fatal */ }

    // 1. Get every contact associated to this portal.
    const assocRes = await fetch(
      `https://api.hubapi.com/crm/v4/objects/${PORTAL_OBJECT_ID}/${encodeURIComponent(portalId)}/associations/contacts`,
      { headers }
    );
    if (!assocRes.ok) {
      const text = await assocRes.text().catch(() => "");
      console.error(`[send-message-board-push] association ${assocRes.status}: ${text.slice(0, 200)}`);
      return jsonResponse(502, { error: "Could not list associated contacts." });
    }
    const assocData = await assocRes.json();
    const contactIds = (assocData.results || []).map(r => r.toObjectId).filter(Boolean);
    if (contactIds.length === 0) {
      console.log(`[send-message-board-push] No contacts associated to portal ${portalId}`);
      return jsonResponse(200, { sent: 0, attempted: 0 });
    }

    // 2. Batch-read each contact's push_subscription.
    const readRes = await fetch(
      "https://api.hubapi.com/crm/v3/objects/contacts/batch/read",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          inputs: contactIds.map(id => ({ id: String(id) })),
          properties: ["email", "push_subscription"]
        })
      }
    );
    if (!readRes.ok) {
      const text = await readRes.text().catch(() => "");
      console.error(`[send-message-board-push] batch read ${readRes.status}: ${text.slice(0, 200)}`);
      return jsonResponse(502, { error: "Could not read contact details." });
    }
    const readData = await readRes.json();
    const subscribers = (readData.results || [])
      .map(c => ({
        id: c.id,
        email: c.properties?.email || "",
        sub: parseSubscription(c.properties?.push_subscription)
      }))
      .filter(c => c.sub);

    if (subscribers.length === 0) {
      console.log(`[send-message-board-push] No subscribers among ${contactIds.length} contacts`);
      return jsonResponse(200, { sent: 0, attempted: 0 });
    }

    // 3. Build the push payload + send to each subscriber.
    const payload = JSON.stringify({
      title: body.title || `${tripTitle} · New message`,
      body: body.body || "There's a new update on your trip's Message Board.",
      url: body.url || "/index.html"
    });

    const results = await Promise.allSettled(
      subscribers.map(s => webpush.sendNotification(s.sub, payload))
    );

    // 4. Clean up dead subscriptions. 404/410 = browser revoked; we
    //    blank push_subscription on those contacts so we don't keep
    //    trying. Other errors stay (could be transient).
    let sent = 0, failed = 0, dead = 0;
    await Promise.all(results.map(async (r, i) => {
      if (r.status === "fulfilled") { sent++; return; }
      const err = r.reason || {};
      const status = err.statusCode || 0;
      if (status === 404 || status === 410) {
        dead++;
        try {
          await fetch(
            `https://api.hubapi.com/crm/v3/objects/contacts/${subscribers[i].id}`,
            {
              method: "PATCH",
              headers,
              body: JSON.stringify({ properties: { push_subscription: "" } })
            }
          );
        } catch (_) { /* swallow */ }
        console.log(`[send-message-board-push] Removed dead subscription for ${subscribers[i].email}`);
      } else {
        failed++;
        console.warn(`[send-message-board-push] Push failed for ${subscribers[i].email} status=${status}: ${err.body || err.message || ""}`);
      }
    }));

    console.log(`[send-message-board-push] portal=${portalId} sent=${sent} failed=${failed} dead=${dead}`);
    return jsonResponse(200, { sent, failed, dead, attempted: subscribers.length });

  } catch (err) {
    console.error("[send-message-board-push] Unhandled:", err?.stack || err?.message || err);
    return jsonResponse(500, { error: err?.message || "Server error" });
  }
}

function parseSubscription(raw) {
  if (!raw) return null;
  try {
    const sub = JSON.parse(String(raw));
    return sub && sub.endpoint ? sub : null;
  } catch (_) {
    return null;
  }
}

function jsonResponse(statusCode, payload) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  };
}
