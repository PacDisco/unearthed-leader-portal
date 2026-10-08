// Payment schedule ↔ deal payments, in one place.
//
// THE PROBLEM THIS SOLVES
//   Payments are recorded on the student's Deal as free-text fields
//   payment_1..payment_15 ("805, pi_xxx, 31/05/2026", "214, Lions Donation,
//   2026 Aug 11", or just "805"). The trip's schedule lives on the Portal
//   record as payment_date_N / payment_amount_N. These used to be matched BY
//   NUMBER (deal payment_N → schedule row N), which breaks as soon as a family
//   pays in a different number of chunks than the schedule has rows: extra
//   payments vanished, and a $214 donation in slot 9 marked an $805 row PAID.
//
// HOW IT WORKS NOW
//   Everything received is added up and applied to the schedule in order
//   (deposit first). A row is PAID once it's fully covered, PART PAID when
//   only some of it is, and the leftover becomes a balance the family can pay.
//   Anything beyond the whole schedule is shown as credit.
//
//   This module is the single source of truth for that maths. It's used by:
//     - get-paid-payments.js    → the Payments tab display
//     - create-checkout-session → what Stripe actually charges for row N
//   so the amount on the button and the amount charged can't disagree.
//
// KEEP IN SYNC: this file is identical in the student portal
// (Unearthed-Portal) and the leader portal (unearthed-leader-portal).

export const PORTAL_OBJECT = "2-58156993";
export const GLOBAL_PORTAL_ID = "50506535214";
export const MAX_PAYMENTS = 15;

const PAYMENT_FIELDS = Array.from({ length: MAX_PAYMENTS }, (_, i) => `payment_${i + 1}`);
const SCHEDULE_AMOUNT_FIELDS = Array.from({ length: MAX_PAYMENTS }, (_, i) => `payment_amount_${i + 1}`);

const EPS = 0.005; // half a cent — absorbs float noise when comparing money

function round2(n) {
  return Math.round(n * 100) / 100;
}

function hsHeaders() {
  return {
    Authorization: `Bearer ${process.env.HUBSPOT_API_KEY}`,
    "Content-Type": "application/json"
  };
}

export function scheduleError(statusCode, message) {
  const e = new Error(message);
  e.statusCode = statusCode;
  return e;
}

// ---------------------------------------------------------------------------
// Parsing one deal payment_N string
// ---------------------------------------------------------------------------

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12
};

function monthFromName(s) {
  const k = String(s || "").toLowerCase().replace(/\.$/, "");
  if (MONTHS[k]) return MONTHS[k];
  return MONTHS[k.slice(0, 3)] || null;
}

function isoIfValid(y, m, d) {
  y = Number(y); m = Number(m); d = Number(d);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1) return null;
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (d > daysInMonth) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function fullYear(y) {
  const s = String(y);
  return s.length === 2 ? 2000 + Number(s) : Number(s);
}

// Parses the date formats that turn up in the deal fields and returns
// "YYYY-MM-DD", or null when the token isn't recognisably a date.
// Slash/dot dates are read NZ-style (day first): "09/01/2026" is 9 January.
// A bare number like "805" is never a date.
export function parsePaymentDate(token) {
  const s = String(token || "").trim().replace(/,$/, "");
  if (!s) return null;
  let m;

  // 2026-03-12 or 2026/03/12
  if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/))) {
    return isoIfValid(m[1], m[2], m[3]);
  }
  // 22.2.26, 22/2/26, 09/01/2026  (day first)
  if ((m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2}|\d{4})$/))) {
    return isoIfValid(fullYear(m[3]), m[2], m[1]);
  }
  // 27 March 2026, 1 Sept 2026, 27 Mar 26
  if ((m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9}\.?)\s+(\d{2}|\d{4})$/))) {
    const mo = monthFromName(m[2]);
    return mo ? isoIfValid(fullYear(m[3]), mo, m[1]) : null;
  }
  // March 27 2026, Mar 27, 2026
  if ((m = s.match(/^([A-Za-z]{3,9}\.?)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/))) {
    const mo = monthFromName(m[1]);
    return mo ? isoIfValid(m[3], mo, m[2]) : null;
  }
  // 2026 Aug 11
  if ((m = s.match(/^(\d{4})\s+([A-Za-z]{3,9}\.?)\s+(\d{1,2})$/))) {
    const mo = monthFromName(m[2]);
    return mo ? isoIfValid(m[1], mo, m[3]) : null;
  }
  return null;
}

// Parses a money token: "805", "$1,750.00", "-200", "(200)". Returns a number
// (negative for refunds) or null when the token isn't an amount.
function parseMoneyToken(tok) {
  const t = String(tok || "").trim();
  if (!/^[^A-Za-z]*$/.test(t.replace(/^(nzd?|usd?|aud?|us|au|gbp|eur|cad)\s*/i, ""))) return null;
  if (!/\d/.test(t)) return null;
  const negative = /^\s*-/.test(t) || /^\s*[^\d]*\(.*\)\s*$/.test(t);
  const cleaned = t.replace(/[^0-9.]/g, "");
  if (!cleaned || cleaned === ".") return null;
  const n = parseFloat(cleaned);
  if (!isFinite(n) || n === 0) return null;
  return negative ? -n : n;
}

// One deal payment_N string → { raw, amount, stripePaymentIntent, note,
// dateRaw, dateIso }, or null when the field is empty.
//   amount  — first money-looking token (negative = refund)
//   dateIso — last date-looking token, NZ day-first
//   note    — anything else left over ("Lions Donation", a staff initial…)
export function parsePaymentEntry(raw) {
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;

  const piMatch = trimmed.match(/pi_[A-Za-z0-9]+/);
  const stripePaymentIntent = piMatch ? piMatch[0] : null;
  const withoutPi = piMatch ? trimmed.replace(piMatch[0], "") : trimmed;

  // Money like "1,750" uses a comma too, so join thousands groups back up
  // before splitting fields on commas.
  const protectedText = withoutPi.replace(/(\d),(\d{3})(?!\d)/g, "$1$2");
  const tokens = protectedText.split(",").map(s => s.trim()).filter(Boolean);

  let amount = null;
  let amountAt = -1;
  for (let i = 0; i < tokens.length; i++) {
    if (parsePaymentDate(tokens[i])) continue;
    const n = parseMoneyToken(tokens[i]);
    if (n != null) { amount = n; amountAt = i; break; }
  }

  let dateRaw = null;
  let dateIso = null;
  let dateAt = -1;
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (i === amountAt) continue;
    const d = parsePaymentDate(tokens[i]);
    if (d) { dateRaw = tokens[i]; dateIso = d; dateAt = i; break; }
  }

  const note = tokens
    .filter((_, i) => i !== amountAt && i !== dateAt)
    .join(", ")
    .trim() || null;

  return { raw: trimmed, amount, stripePaymentIntent, note, dateRaw, dateIso };
}

// ---------------------------------------------------------------------------
// Applying payments to the schedule
// ---------------------------------------------------------------------------

// scheduleRows: [{ index, amount }]  (rows without a positive amount are TBC
//               and absorb nothing)
// entries:      [{ index, amount, dateIso }] from parsePaymentEntry
//
// Returns {
//   totalPaid,            net of refunds
//   totalDue,             sum of scheduled amounts
//   credit,               paid beyond the whole schedule
//   rows: [{ index, due, applied, remaining,
//            status: "paid" | "partial" | "unpaid",
//            settledOn }]  date of the payment that completed the row
//                          (null if that payment had no date, or not settled)
// }
export function allocateSchedule(scheduleRows, entries) {
  const rows = (scheduleRows || [])
    .map(r => ({ index: Number(r.index), due: Number(r.amount) }))
    .filter(r => Number.isInteger(r.index) && isFinite(r.due) && r.due > 0)
    .sort((a, b) => a.index - b.index);

  const paid = (entries || [])
    .filter(e => e && isFinite(Number(e.amount)) && Number(e.amount) !== 0)
    .slice()
    .sort((a, b) => (a.index || 0) - (b.index || 0));

  const totalPaid = round2(paid.reduce((s, e) => s + Number(e.amount), 0));
  const totalDue = round2(rows.reduce((s, r) => s + r.due, 0));

  // Running total in the order payments were recorded, so we can say which
  // payment finished off each row.
  const running = [];
  let run = 0;
  for (const e of paid) {
    run = round2(run + Number(e.amount));
    running.push({ total: run, dateIso: e.dateIso || null });
  }

  let pool = Math.max(totalPaid, 0);
  let cumulativeDue = 0;
  const out = rows.map(r => {
    const applied = round2(Math.min(r.due, pool));
    pool = round2(pool - applied);
    const remaining = round2(r.due - applied);
    cumulativeDue = round2(cumulativeDue + r.due);

    let status = "unpaid";
    if (remaining <= EPS) status = "paid";
    else if (applied > EPS) status = "partial";

    let settledOn = null;
    if (status === "paid") {
      const hit = running.find(x => x.total >= cumulativeDue - EPS);
      settledOn = hit ? hit.dateIso : null;
    }
    return { index: r.index, due: r.due, applied, remaining: Math.max(remaining, 0), status, settledOn };
  });

  return { totalPaid, totalDue, credit: round2(pool), rows: out };
}

// ---------------------------------------------------------------------------
// HubSpot reads
// ---------------------------------------------------------------------------

async function contactIdForEmail(email) {
  const res = await fetch("https://api.hubapi.com/crm/v3/objects/contacts/search", {
    method: "POST",
    headers: hsHeaders(),
    body: JSON.stringify({
      filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: String(email).toLowerCase().trim() }] }],
      properties: ["email"]
    })
  });
  if (!res.ok) throw scheduleError(502, "Could not look up the account.");
  const data = await res.json();
  return data.results?.[0]?.id || null;
}

// The payment entries on the contact's most recently created Deal.
// Returns { dealId, dealName, dealAmount, totalAmountPaid, payments } where
// payments is [{ index, raw, amount, stripePaymentIntent, note, dateRaw, dateIso }].
// `reason` is set (and payments is empty) when there's nothing to read.
export async function fetchDealPayments(email) {
  const empty = (reason) => ({ dealId: null, dealName: null, dealAmount: null, totalAmountPaid: null, payments: [], reason });
  const headers = hsHeaders();

  const contactId = await contactIdForEmail(email);
  if (!contactId) throw scheduleError(404, "Contact not found");

  const assocRes = await fetch(
    `https://api.hubapi.com/crm/v4/objects/contacts/${contactId}/associations/deals`,
    { headers }
  );
  if (!assocRes.ok) return empty("No deal associations");
  const assocData = await assocRes.json();
  const dealIds = (assocData.results || []).map(r => r.toObjectId).filter(Boolean);
  if (dealIds.length === 0) return empty("Contact has no deals");

  const dealsRes = await fetch("https://api.hubapi.com/crm/v3/objects/deals/batch/read", {
    method: "POST",
    headers,
    body: JSON.stringify({
      inputs: dealIds.map(id => ({ id: String(id) })),
      properties: ["dealname", "createdate", "amount", "total_amount_paid", ...PAYMENT_FIELDS]
    })
  });
  if (!dealsRes.ok) throw scheduleError(502, "Deal batch-read failed");
  const deals = (await dealsRes.json()).results || [];
  if (deals.length === 0) return empty("Deals not readable");

  const deal = deals.slice().sort((a, b) =>
    new Date(b.properties?.createdate || 0).getTime() - new Date(a.properties?.createdate || 0).getTime()
  )[0];

  const payments = [];
  for (let i = 1; i <= MAX_PAYMENTS; i++) {
    const parsed = parsePaymentEntry(deal.properties?.[`payment_${i}`]);
    if (parsed) payments.push({ index: i, ...parsed });
  }

  return {
    dealId: deal.id,
    dealName: deal.properties?.dealname || null,
    dealAmount: deal.properties?.amount || null,
    totalAmountPaid: deal.properties?.total_amount_paid || null,
    payments
  };
}

// Works out which trip a payment schedule should come from, and checks the
// person is actually on it. Admins may name any trip. Everyone else must be
// associated with the trip they name; with no trip named, it's their only one.
export async function resolvePortalForEmail({ email, portalId, admin }) {
  if (admin) {
    if (!portalId) throw scheduleError(400, "Missing portalId.");
    return String(portalId);
  }
  const contactId = await contactIdForEmail(email);
  if (!contactId) throw scheduleError(404, "Account not found.");
  const assocRes = await fetch(
    `https://api.hubapi.com/crm/v4/objects/contacts/${contactId}/associations/${PORTAL_OBJECT}`,
    { headers: hsHeaders() }
  );
  const assoc = assocRes.ok ? await assocRes.json() : { results: [] };
  const mine = (assoc.results || []).map(r => String(r.toObjectId)).filter(Boolean);

  if (portalId) {
    if (!mine.includes(String(portalId))) {
      throw scheduleError(403, "That trip isn't associated with this account.");
    }
    return String(portalId);
  }
  if (mine.length === 1) return mine[0];
  throw scheduleError(400, "Could not determine which trip to use. Please reopen the payment from your trip page.");
}

function parseScheduleAmount(v) {
  if (v == null || String(v).trim() === "") return null;
  const n = parseFloat(String(v).replace(/[^0-9.]/g, ""));
  return isFinite(n) && n > 0 ? n : null;
}

// The trip's schedule amounts (rows 1..15) and currency. Each row and the
// currency fall back to the global defaults record when the trip leaves them
// blank — the same per-property merge portal.js does for the display.
export async function loadSchedule(portalId) {
  const props = [...SCHEDULE_AMOUNT_FIELDS, "program_currency"].join(",");
  const read = async (id) => {
    const r = await fetch(
      `https://api.hubapi.com/crm/v3/objects/${PORTAL_OBJECT}/${id}?properties=${props}`,
      { headers: hsHeaders() }
    );
    if (!r.ok) return null;
    return (await r.json()).properties || {};
  };

  const trip = await read(portalId);
  if (!trip) throw scheduleError(502, "Could not read the payment schedule.");
  const needsGlobal = SCHEDULE_AMOUNT_FIELDS.some(f => parseScheduleAmount(trip[f]) == null) ||
    !String(trip.program_currency || "").trim();
  const global = needsGlobal ? (await read(GLOBAL_PORTAL_ID)) || {} : {};

  const rows = [];
  for (let i = 1; i <= MAX_PAYMENTS; i++) {
    const f = `payment_amount_${i}`;
    const amount = parseScheduleAmount(trip[f]) ?? parseScheduleAmount(global[f]);
    if (amount != null) rows.push({ index: i, amount });
  }
  const currency = String(trip.program_currency || "").trim() || String(global.program_currency || "").trim() || null;
  return { rows, currency };
}
