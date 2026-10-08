// Returns every payment recorded on the contact's most recent Deal
// (payment_1..15), and — when a portalId is given — how those payments apply
// to that trip's schedule (which rows are paid, part paid or outstanding).
// The parsing and the allocation live in _shared/payment-schedule.js, which
// create-checkout-session.js also uses, so what's shown and what's charged
// always agree.
//
// Query: ?email=<student email>&portalId=<trip id, optional>

import { authenticate, isAdmin } from "./_shared/auth.js";
import { assertEmailAccess } from "./_shared/portal-access.js";
import {
  fetchDealPayments, resolvePortalForEmail, loadSchedule, allocateSchedule
} from "./_shared/payment-schedule.js";

const json = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body)
});

export async function handler(event) {
  try {
    const { email, portalId } = event.queryStringParameters || {};
    if (!email) return json(400, { error: "Missing email" });

    // Auth: signed in, and either this person, an admin, or staff on a trip
    // they belong to.
    const auth = await authenticate(event);
    if (auth.response) return auth.response;
    const access = await assertEmailAccess(auth.session, email);
    if (access) return access;

    const cleanEmail = String(email).toLowerCase().trim();
    const deal = await fetchDealPayments(cleanEmail);

    let allocation = null;
    if (portalId) {
      const tripId = await resolvePortalForEmail({
        email: cleanEmail,
        portalId: String(portalId),
        admin: isAdmin(auth.session)
      });
      const schedule = await loadSchedule(tripId);
      allocation = allocateSchedule(schedule.rows, deal.payments);
    }

    return json(200, { ...deal, allocation });
  } catch (err) {
    if (err && err.statusCode) return json(err.statusCode, { error: err.message, payments: [] });
    console.error("[get-paid-payments] ERROR:", err);
    return json(500, { error: "Server error" });
  }
}
