// Creates a Stripe Checkout Session on demand so the portal's per-row
// payment amounts can deep-link directly to checkout.stripe.com instead of
// going through the existing intermediate "make payment + history" page.
//
// Uses the merchant's existing Stripe credentials (STRIPE_SECRET_KEY).
// No Stripe SDK dependency — calls the REST API directly with fetch and
// application/x-www-form-urlencoded, matching Stripe's documented format.
//
// Expected POST body (JSON):
//   {
//     email:         "parent@example.com",       // required
//     paymentIndex:  3,                           // 1..10, optional
//     baseAmount:    1000.00,                     // listed installment amount
//     chargeAmount:  1030.00,                     // total to charge for THIS method
//                                                 //   (caller should pass base for direct debit,
//                                                 //    base × 1.03 for card)
//     description:   "Costa Rica Mini Semester — Payment 3", // optional
//     paymentType:   "card" | "direct_debit"      // optional, defaults to "card".
//                                                 //   "card"          → payment_method_types: ["card"]
//                                                 //   "direct_debit"  → payment_method_types from
//                                                 //     STRIPE_DIRECT_DEBIT_METHODS env (comma-separated)
//   }
//
// Returns:  { url, id }   on success
//           { error, details? }   on failure
//
// Currency: driven per-program by the `program_currency` dropdown (ISO 4217,
// e.g. "USD", "NZD") on the Portal record in HubSpot. The amount, the Stripe
// line-item currency, and the bank-debit method are all derived from it. If
// program_currency is blank on both the trip and the global record we fall
// back to the STRIPE_CURRENCY env var, then to NZD.
//
// Env vars worth knowing:
//   STRIPE_SECRET_KEY              required
//   STRIPE_CURRENCY                optional fallback when program_currency is
//                                  unset (default "nzd")
//   STRIPE_DIRECT_DEBIT_METHODS    optional override for the no-fee bank-debit
//                                  path. When unset, the method is chosen
//                                  automatically from program_currency. Bank
//                                  transfer is offered for NZD only
//                                  (nz_bank_account / NZ BECS); all other
//                                  currencies are card-only.

import { authenticate, isAdmin } from "./_shared/auth.js";
import { assertEmailAccess } from "./_shared/portal-access.js";
import {
  normalizeCurrency,
  toStripeMinorUnits,
  directDebitMethodFor
} from "./_shared/currency.js";

const PORTAL_OBJECT = "2-58156993";
const GLOBAL_PORTAL_ID = "50506535214";

export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") {
      return {
        statusCode: 405,
        body: JSON.stringify({ error: "Method not allowed" })
      };
    }

    if (!process.env.STRIPE_SECRET_KEY) {
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: "Stripe is not configured",
          details: "Set STRIPE_SECRET_KEY in Netlify environment variables."
        })
      };
    }

    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch (e) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Invalid JSON body" })
      };
    }

    const {
      email,
      paymentIndex,
      portalId,
      description,
      paymentType: rawPaymentType
      // NOTE: baseAmount / chargeAmount from the client are intentionally
      // ignored now. The amount is derived server-side from HubSpot so a
      // user can't tamper with the price they pay.
    } = body;

    if (!email) {
      return { statusCode: 400, body: JSON.stringify({ error: "Missing email" }) };
    }

    // Auth: signed in, and either this person, an admin, or staff on a trip
    // they belong to.
    const auth = await authenticate(event);
    if (auth.response) return auth.response;
    const session = auth.session;
    const access = await assertEmailAccess(session, email);
    if (access) return access;

    // Normalise paymentType. Anything other than "direct_debit" is treated
    // as a card payment to keep the original behaviour as the safe default.
    const paymentType = rawPaymentType === "direct_debit" ? "direct_debit" : "card";

    // ----- Server-authoritative amount -----
    // We do NOT trust the amount sent by the browser. Instead we read the
    // scheduled installment amount (payment_amount_N) straight off the
    // verified user's Portal record in HubSpot, and apply the 3% card fee
    // here. This closes a price-tampering hole where the client could ask
    // to be charged any amount it liked.
    const idx = parseInt(paymentIndex, 10);
    if (!Number.isInteger(idx) || idx < 1 || idx > 10) {
      return { statusCode: 400, body: JSON.stringify({ error: "Missing or invalid paymentIndex (must be 1–10)" }) };
    }
    if (!process.env.HUBSPOT_API_KEY) {
      return { statusCode: 500, body: JSON.stringify({ error: "HUBSPOT_API_KEY is not set" }) };
    }

    let base;
    let programCurrency;
    try {
      const resolved = await resolveScheduledAmount({
        email: String(email).toLowerCase().trim(),
        portalId: portalId ? String(portalId) : null,
        index: idx,
        admin: isAdmin(session)
      });
      base = resolved.amount;
      // Currency is driven by the program_currency dropdown on the Portal
      // record (falling back to the STRIPE_CURRENCY env, then NZD).
      programCurrency = normalizeCurrency(
        resolved.currency || process.env.STRIPE_CURRENCY || "nzd"
      );
    } catch (err) {
      const status = err.statusCode || 502;
      return { statusCode: status, body: JSON.stringify({ error: err.message || "Could not resolve payment amount" }) };
    }

    // Apply the card processing fee server-side (direct debit pays base).
    const feeRate = paymentType === "card" ? 0.03 : 0;
    const charge = Math.round(base * (1 + feeRate) * 100) / 100;
    if (!isFinite(charge) || charge <= 0) {
      return { statusCode: 400, body: JSON.stringify({ error: "Resolved payment amount is invalid" }) };
    }
    // baseAmount is recomputed server-side for the metadata below.
    const baseAmount = base;

    // Resolve which Stripe payment_method_types we'll offer at checkout.
    // For card it's a single fixed list. For direct debit we read from the
    // STRIPE_DIRECT_DEBIT_METHODS env var so the operator can pick the
    // method(s) that match their Stripe account's currency without a code
    // change. See header comment for the per-method currency requirements.
    let paymentMethodTypes;
    if (paymentType === "card") {
      paymentMethodTypes = ["card"];
    } else {
      // Bank-debit method is driven by the program's currency. Bank transfer
      // is offered for NZD only (nz_bank_account); other currencies are
      // card-only. STRIPE_DIRECT_DEBIT_METHODS can still override if needed.
      const envOverride = (process.env.STRIPE_DIRECT_DEBIT_METHODS || "")
        .split(",")
        .map(s => s.trim())
        .filter(Boolean);

      if (envOverride.length > 0) {
        paymentMethodTypes = envOverride;
      } else {
        const autoMethod = directDebitMethodFor(programCurrency);
        if (!autoMethod) {
          return {
            statusCode: 400,
            body: JSON.stringify({
              error: `Bank transfer isn't available for ${programCurrency}.`,
              details: "Please pay by card, or set STRIPE_DIRECT_DEBIT_METHODS to override."
            })
          };
        }
        paymentMethodTypes = [autoMethod];
      }
    }

    // Where to send the user back to after payment. Pinned to a known base
    // URL (env override allowed for deploy previews) rather than reflecting
    // the request's Origin/Referer header — otherwise a crafted request could
    // make Stripe redirect the payer to an attacker-controlled site.
    const origin = (process.env.PORTAL_BASE_URL || "https://leaders.unearthededucation.org")
      .replace(/\/+$/, "");

    // Stripe wants the currency lower-cased and the amount in minor units
    // (cents for most currencies, whole units for zero-decimal ones like JPY).
    const currency = programCurrency.toLowerCase();
    const unitAmountCents = toStripeMinorUnits(charge, programCurrency);

    const productName = (description && description.trim()) ||
      (paymentIndex ? `Payment ${paymentIndex}` : "Portal payment");

    // Look up (or create) a Stripe Customer for the logged-in email.
    // Passing `customer` (rather than `customer_email`) makes Stripe Checkout
    // render the email as read-only on the payment form, so the parent can't
    // change it mid-flow and break reconciliation against the HubSpot deal.
    let customerId;
    try {
      customerId = await findOrCreateStripeCustomer(email, process.env.STRIPE_SECRET_KEY);
    } catch (err) {
      console.error("Stripe customer lookup/create failed:", err);
      return {
        statusCode: 502,
        body: JSON.stringify({
          error: "Could not resolve a Stripe customer for this email"
        })
      };
    }

    // Build the request body Stripe expects: form-urlencoded with bracket
    // notation for nested fields (e.g. line_items[0][price_data][currency]).
    const params = new URLSearchParams();
    params.append("mode", "payment");
    // Each payment_method_type goes in as its own repeated field — Stripe
    // expects e.g. payment_method_types[]=card&payment_method_types[]=us_bank_account.
    for (const m of paymentMethodTypes) {
      params.append("payment_method_types[]", m);
    }
    params.append("customer", customerId);
    // When `customer` is set, Stripe locks the email field but by default
    // won't update name/address on the customer record. Tell it to merge
    // any new info collected at checkout back onto the saved customer.
    params.append("customer_update[address]", "auto");
    params.append("customer_update[name]", "auto");
    params.append("allow_promotion_codes", "false");

    params.append("line_items[0][quantity]", "1");
    params.append("line_items[0][price_data][currency]", currency);
    params.append("line_items[0][price_data][unit_amount]", String(unitAmountCents));
    params.append("line_items[0][price_data][product_data][name]", productName);

    const successQuery = paymentIndex ? `paid=${encodeURIComponent(paymentIndex)}` : "paid=1";
    params.append("success_url", `${origin}/index.html?${successQuery}&session_id={CHECKOUT_SESSION_ID}`);
    params.append("cancel_url", `${origin}/index.html`);

    // Metadata so the merchant can reconcile the Stripe charge against the
    // portal schedule on the receiving end (webhooks, dashboard, etc.).
    params.append("metadata[contact_email]", email);
    if (paymentIndex != null) params.append("metadata[payment_index]", String(paymentIndex));
    if (baseAmount != null && baseAmount !== "") {
      params.append("metadata[base_amount]", String(baseAmount));
    }
    params.append("metadata[charge_amount]", String(charge));
    params.append("metadata[currency]", programCurrency);
    // Tag whether this session was the card (with fee) or direct-debit
    // (no fee) variant. The processing_fee_rate metadata is only
    // meaningful on card sessions; we keep it on both for consistency
    // and let the receiving system (HubSpot Stripe sync, dashboard
    // filters, etc.) decide what to do with it.
    params.append("metadata[payment_type]", paymentType);
    params.append("metadata[processing_fee_rate]", paymentType === "card" ? "0.03" : "0");
    params.append("metadata[source]", "unearthed-portal-row-click");

    // Mirror metadata onto the PaymentIntent so it shows on the underlying
    // charge as well (useful for HubSpot's Stripe sync if you have one).
    params.append("payment_intent_data[metadata][contact_email]", email);
    if (paymentIndex != null) {
      params.append("payment_intent_data[metadata][payment_index]", String(paymentIndex));
    }
    if (baseAmount != null && baseAmount !== "") {
      params.append("payment_intent_data[metadata][base_amount]", String(baseAmount));
    }
    params.append("payment_intent_data[metadata][charge_amount]", String(charge));
    params.append("payment_intent_data[metadata][payment_type]", paymentType);
    params.append("payment_intent_data[metadata][processing_fee_rate]", paymentType === "card" ? "0.03" : "0");

    const stripeRes = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: params.toString()
    });

    const data = await stripeRes.json();

    if (!stripeRes.ok) {
      console.error("Stripe checkout creation failed:", data);
      return {
        statusCode: 502,
        body: JSON.stringify({
          error: data?.error?.message || "Stripe checkout creation failed",
          stripeErrorType: data?.error?.type || null,
          stripeErrorCode: data?.error?.code || null
        })
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ url: data.url, id: data.id })
    };

  } catch (err) {
    console.error("[create-checkout-session] ERROR:", err?.message || err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Server error" })
    };
  }
}

// Returns a Stripe Customer ID for the given email — reusing an existing one
// where possible, or creating a new one. Using a Customer (rather than just
// `customer_email`) is what locks the email field on the Checkout page.
async function findOrCreateStripeCustomer(email, secretKey) {
  const cleanEmail = String(email).trim().toLowerCase();

  // 1. Look up existing customer(s) with this email.
  const lookupRes = await fetch(
    `https://api.stripe.com/v1/customers?email=${encodeURIComponent(cleanEmail)}&limit=1`,
    { headers: { Authorization: `Bearer ${secretKey}` } }
  );
  const lookupData = await lookupRes.json();

  if (!lookupRes.ok) {
    throw new Error(
      "Stripe customer lookup failed: " +
      (lookupData?.error?.message || `HTTP ${lookupRes.status}`)
    );
  }

  if (Array.isArray(lookupData.data) && lookupData.data.length > 0) {
    return lookupData.data[0].id;
  }

  // 2. None found — create one.
  const createParams = new URLSearchParams();
  createParams.append("email", cleanEmail);
  createParams.append("metadata[source]", "unearthed-portal");

  const createRes = await fetch("https://api.stripe.com/v1/customers", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: createParams.toString()
  });
  const createData = await createRes.json();

  if (!createRes.ok || !createData.id) {
    throw new Error(
      "Stripe customer create failed: " +
      (createData?.error?.message || `HTTP ${createRes.status}`)
    );
  }

  return createData.id;
}

// ----- Server-authoritative payment amount -----
// Resolves the scheduled base amount (before card fee) for payment N from
// HubSpot, after verifying the caller is actually associated with the trip.
// Throws an Error with `.statusCode` on any problem.
async function resolveScheduledAmount({ email, portalId, index, admin }) {
  const headers = {
    Authorization: `Bearer ${process.env.HUBSPOT_API_KEY}`,
    "Content-Type": "application/json"
  };

  // 1. Resolve the contact id.
  const contactRes = await fetch(
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
  if (!contactRes.ok) throw amountError(502, "Could not look up your account.");
  const contactData = await contactRes.json();
  const contactId = contactData.results?.[0]?.id;
  if (!contactId) throw amountError(404, "Account not found.");

  // 2. List the portals this contact is associated with.
  const assocRes = await fetch(
    `https://api.hubapi.com/crm/v4/objects/contacts/${contactId}/associations/${PORTAL_OBJECT}`,
    { headers }
  );
  const assoc = assocRes.ok ? await assocRes.json() : { results: [] };
  const myPortalIds = (assoc.results || []).map(r => String(r.toObjectId)).filter(Boolean);

  // 3. Decide which portal to price against — and make sure the caller is
  //    entitled to it. Admins may price any portal; everyone else must be
  //    associated with the one they're paying for.
  let targetPortalId = portalId;
  if (admin) {
    if (!targetPortalId) throw amountError(400, "Missing portalId.");
  } else if (targetPortalId) {
    if (!myPortalIds.includes(targetPortalId)) {
      throw amountError(403, "That trip isn't associated with your account.");
    }
  } else if (myPortalIds.length === 1) {
    targetPortalId = myPortalIds[0];
  } else {
    throw amountError(400, "Could not determine which trip to pay for. Please reopen the payment from your trip page.");
  }

  // 4. Read payment_amount_<index> AND program_currency, falling back to the
  //    global defaults record for either value if the trip leaves it blank.
  const prop = `payment_amount_${index}`;
  const tripRes = await fetch(
    `https://api.hubapi.com/crm/v3/objects/${PORTAL_OBJECT}/${targetPortalId}?properties=${prop},program_currency`,
    { headers }
  );
  if (!tripRes.ok) throw amountError(502, "Could not read the payment schedule.");
  const tripData = await tripRes.json();
  let raw = tripData.properties?.[prop];
  let currency = tripData.properties?.program_currency;

  if (raw == null || String(raw).trim() === "" ||
      currency == null || String(currency).trim() === "") {
    const gRes = await fetch(
      `https://api.hubapi.com/crm/v3/objects/${PORTAL_OBJECT}/${GLOBAL_PORTAL_ID}?properties=${prop},program_currency`,
      { headers }
    );
    if (gRes.ok) {
      const g = await gRes.json();
      if (raw == null || String(raw).trim() === "") raw = g.properties?.[prop];
      if (currency == null || String(currency).trim() === "") {
        currency = g.properties?.program_currency;
      }
    }
  }

  const num = parseAmount(raw);
  if (num == null || num <= 0) {
    throw amountError(400, `No scheduled amount is set for payment ${index}.`);
  }
  return { amount: num, currency: currency || null };
}

// Parse a HubSpot amount field that may contain currency symbols/commas.
function parseAmount(v) {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/[^0-9.]/g, ""));
  return isFinite(n) ? n : null;
}

function amountError(statusCode, message) {
  const e = new Error(message);
  e.statusCode = statusCode;
  return e;
}
