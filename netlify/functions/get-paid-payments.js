// Returns the parsed payment_1..10 fields off the most recently created Deal
// associated with the given contact email, so the portal can mark scheduled
// installments as paid by sequence (deal.payment_N → schedule row N).
//
// Each Deal `payment_N` property is a free-form string roughly of the shape
//   "<amount>, <stripe_payment_intent>, <date>"
// but in practice the format is inconsistent — Stripe PIs are sometimes empty,
// dates appear as "2026-03-12", "27 March 2026", "22.2.26", etc., and commas
// are occasionally misplaced. The parser below pulls out whatever it can.

import { authenticate } from "./_shared/auth.js";
import { assertEmailAccess } from "./_shared/portal-access.js";

export async function handler(event) {
  try {
    const email = event.queryStringParameters?.email;
    if (!email) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Missing email" })
      };
    }

    // Auth: signed in, and either this person, an admin, or staff on a trip
    // they belong to.
    const auth = authenticate(event);
    if (auth.response) return auth.response;
    const access = await assertEmailAccess(auth.session, email);
    if (access) return access;

    const cleanEmail = email.toLowerCase().trim();

    const headers = {
      Authorization: `Bearer ${process.env.HUBSPOT_API_KEY}`,
      "Content-Type": "application/json"
    };

    // 1. Find contact by email
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
          }]
        })
      }
    );

    if (!contactRes.ok) {
      console.error("[get-paid-payments] contact fetch failed:", (await contactRes.text().catch(() => "")).slice(0, 300));
      return {
        statusCode: 500,
        body: JSON.stringify({ error: "Contact fetch failed" })
      };
    }

    const contactData = await contactRes.json();
    const contactId = contactData.results?.[0]?.id;
    if (!contactId) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: "Contact not found" })
      };
    }

    // 2. List all deals associated to the contact
    const assocRes = await fetch(
      `https://api.hubapi.com/crm/v4/objects/contacts/${contactId}/associations/deals`,
      { headers }
    );

    if (!assocRes.ok) {
      return {
        statusCode: 200,
        body: JSON.stringify({ payments: [], reason: "No deal associations" })
      };
    }

    const assocData = await assocRes.json();
    const dealIds = (assocData.results || []).map(r => r.toObjectId).filter(Boolean);

    if (dealIds.length === 0) {
      return {
        statusCode: 200,
        body: JSON.stringify({ payments: [], reason: "Contact has no deals" })
      };
    }

    // 3. Batch-read deals — pulling createdate so we can pick the most recent one
    const PAYMENT_FIELDS = [
      "payment_1", "payment_2", "payment_3", "payment_4", "payment_5",
      "payment_6", "payment_7", "payment_8", "payment_9", "payment_10"
    ];

    const dealsRes = await fetch(
      "https://api.hubapi.com/crm/v3/objects/deals/batch/read",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          inputs: dealIds.map(id => ({ id: String(id) })),
          properties: [
            "dealname", "createdate", "amount", "total_amount_paid",
            ...PAYMENT_FIELDS
          ]
        })
      }
    );

    if (!dealsRes.ok) {
      console.error("[get-paid-payments] deal batch-read failed:", (await dealsRes.text().catch(() => "")).slice(0, 300));
      return {
        statusCode: 500,
        body: JSON.stringify({ error: "Deal batch-read failed" })
      };
    }

    const dealsData = await dealsRes.json();
    const deals = dealsData.results || [];

    if (deals.length === 0) {
      return {
        statusCode: 200,
        body: JSON.stringify({ payments: [], reason: "Deals not readable" })
      };
    }

    // 4. Pick the most recently created deal
    const sorted = deals.slice().sort((a, b) => {
      const ta = new Date(a.properties?.createdate || 0).getTime();
      const tb = new Date(b.properties?.createdate || 0).getTime();
      return tb - ta;
    });
    const deal = sorted[0];

    // 5. Parse payment_1..10 into structured entries
    const payments = [];
    for (let i = 1; i <= 10; i++) {
      const raw = deal.properties?.[`payment_${i}`];
      const parsed = parsePaymentEntry(raw);
      if (parsed) payments.push({ index: i, ...parsed });
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        dealId: deal.id,
        dealName: deal.properties?.dealname || null,
        dealAmount: deal.properties?.amount || null,
        totalAmountPaid: deal.properties?.total_amount_paid || null,
        payments
      })
    };

  } catch (err) {
    console.error("ERROR:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Server error" })
    };
  }
}

// ---------- parser helpers ----------

function parsePaymentEntry(raw) {
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Pull the Stripe Payment Intent (anywhere in the string)
  const piMatch = trimmed.match(/pi_[A-Za-z0-9]+/);
  const stripePaymentIntent = piMatch ? piMatch[0] : null;

  // Strip the PI before splitting on commas, then collapse double-commas
  // left behind by entries like "amount, , date".
  let withoutPi = piMatch ? trimmed.replace(piMatch[0], "") : trimmed;
  withoutPi = withoutPi.replace(/,\s*,/g, ",");

  const tokens = withoutPi.split(",").map(s => s.trim()).filter(Boolean);

  // First non-date numeric token = amount
  let amount = null;
  for (const tok of tokens) {
    if (looksLikeDate(tok)) continue;
    const cleaned = tok.replace(/[^0-9.\-]/g, "");
    if (!cleaned || cleaned === "-" || cleaned === ".") continue;
    const n = parseFloat(cleaned);
    if (isFinite(n) && n > 0) {
      amount = n;
      break;
    }
  }

  // Last token that parses as a date = date
  let dateRaw = null;
  let dateIso = null;
  for (const tok of [...tokens].reverse()) {
    const d = parseFlexibleDate(tok);
    if (d) {
      dateRaw = tok;
      dateIso = d.toISOString().slice(0, 10);
      break;
    }
  }

  return {
    raw: trimmed,
    amount,
    stripePaymentIntent,
    dateRaw,
    dateIso
  };
}

function looksLikeDate(s) {
  if (!s) return false;
  if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(s)) return true;       // 2026-03-12
  if (/^\d{1,2}[\.\/]\d{1,2}[\.\/]\d{2,4}/.test(s)) return true; // 22.2.26 or 22/2/26
  if (/^\d{1,2}\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(s)) return true; // 27 March 2026
  if (/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d/i.test(s)) return true; // March 27 2026
  return false;
}

function parseFlexibleDate(s) {
  if (!s) return null;
  const trimmed = s.trim();
  if (!trimmed) return null;

  // Try native Date first (handles ISO and "27 March 2026" reasonably)
  let d = new Date(trimmed);
  if (!isNaN(d.getTime())) return d;

  // DD.MM.YY[YY] or DD/MM/YY[YY] (NZ-style)
  const m = trimmed.match(/^(\d{1,2})[\.\/](\d{1,2})[\.\/](\d{2,4})$/);
  if (m) {
    let [, day, month, year] = m;
    if (year.length === 2) {
      const yy = parseInt(year, 10);
      year = (yy > 50 ? "19" : "20") + year;
    }
    d = new Date(`${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`);
    if (!isNaN(d.getTime())) return d;
  }

  return null;
}
