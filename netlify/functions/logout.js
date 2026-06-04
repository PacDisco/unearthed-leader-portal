// POST /.netlify/functions/logout
//
// Server-side logout / token revocation. The browser also clears its own
// sessionStorage, but that alone does NOT stop a token that was copied before
// logout from being replayed. This endpoint increments the caller's
// portal_token_version in HubSpot, which immediately invalidates EVERY token
// previously issued to them (current device and any others — "log out
// everywhere"). authenticate() rejects any token whose embedded `ver` no
// longer matches.
//
// Auth: we read the caller's identity from their own (signed) token, so a
// caller can only log themselves out. An invalid/absent token is a no-op.
//
// Requires the HubSpot Number property `portal_token_version` to exist for the
// bump to persist; if it doesn't, this safely no-ops and the client-side
// clear + short token lifetime still apply.

import { tokenFromEvent, verifyToken, bumpTokenVersion } from "./_shared/auth.js";

function json(statusCode, payload) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) };
}

export async function handler(event) {
  try {
    if (event.httpMethod && event.httpMethod !== "POST") {
      return json(405, { error: "Method not allowed" });
    }

    // Identify the caller from their signed token. We only need the signature
    // + email here (verifyToken), not the full revocation check — we're about
    // to bump the version anyway.
    let payload = null;
    try { payload = verifyToken(tokenFromEvent(event)); }
    catch (_) { payload = null; } // SESSION_SECRET misconfig -> treat as no-op

    if (payload?.email) {
      const newVer = await bumpTokenVersion(payload.email);
      // newVer === null means the property doesn't exist / HubSpot write
      // failed. We still report success so the client proceeds to clear its
      // own session; the token will lapse on its own at the 12h expiry.
      return json(200, { success: true, revoked: newVer !== null });
    }

    // No / invalid token — nothing to revoke. Still a success from the
    // client's perspective.
    return json(200, { success: true, revoked: false });

  } catch (err) {
    console.error("[logout] error:", err?.message || err);
    // Never block the user from logging out on a server hiccup.
    return json(200, { success: true, revoked: false });
  }
}
