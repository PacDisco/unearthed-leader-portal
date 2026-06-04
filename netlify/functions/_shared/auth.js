// Shared session-token authentication for the portal's Netlify Functions.
//
// WHY THIS EXISTS
//   Until now the data endpoints trusted a caller-supplied `?email=` (or
//   `body.email`) with no verification, so anyone could read another
//   person's private application/payment data, and admin access was gated
//   only in the browser. This module adds a real, server-verified session.
//
// HOW IT WORKS
//   On successful login (login.js) / password set (set-password.js) we mint
//   a stateless HMAC-signed token: base64url(payload).base64url(HMAC-SHA256).
//   The payload is { email, role, ver, exp }. Because it's signed with a
//   secret that never leaves the server, the browser cannot forge or tamper
//   with it — flipping `role` to an admin value, or swapping in someone
//   else's email, invalidates the signature.
//
//   Every private endpoint calls authenticate() / authenticateSelf() /
//   authenticateAdmin() and returns the provided 401/403 response if the
//   token is missing, invalid, expired, revoked, or not authorised.
//
// TOKEN REVOCATION  (logout / "log out everywhere")
//   The token embeds `ver`, a per-user version number stored on the HubSpot
//   contact as `portal_token_version`. authenticate() compares the token's
//   `ver` to the contact's current value; if they differ the token is
//   rejected. logout.js increments the contact's version, which immediately
//   invalidates every token that was issued before it — so a token that was
//   captured before logout no longer works. A short in-memory cache keeps
//   this from adding a HubSpot read to literally every request.
//
//   NOTE: tokens minted before this change have no `ver` and are rejected on
//   sight, forcing a one-time re-login for everyone (appropriate after a
//   token-security fix).
//
// REQUIRED ENV VAR
//   SESSION_SECRET — a long random string (openssl rand -hex 32). If missing,
//                    endpoints fail closed (500) rather than letting anyone in.
//   HUBSPOT_API_KEY — already used across the portal; needed here to read /
//                    write portal_token_version.
//
// REQUIRED HUBSPOT PROPERTY
//   portal_token_version — a Number contact property (default 0). Create it in
//   HubSpot → Settings → Properties → Contact. Without it, login still works
//   but logout cannot invalidate tokens (the version bump silently no-ops and
//   we fall back to the short token lifetime).

import crypto from "crypto";

// How long a session stays valid before re-login is required.
const TOKEN_TTL_MS = 1000 * 60 * 60 * 12; // 12 hours

// How long (ms) a contact's token-version is cached in a warm function
// instance. Bounds how long a just-logged-out token can linger: a logout is
// fully effective everywhere within this window. Small = safer, more reads.
const VERSION_CACHE_MS = 30 * 1000; // 30 seconds

const HS_BASE = "https://api.hubapi.com";

function b64url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function b64urlToJson(str) {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
}

function getSecret() {
  const s = process.env.SESSION_SECRET;
  if (!s || String(s).length < 16) {
    throw new Error(
      "SESSION_SECRET is not set (or is too short). Set a long random value " +
      "in the Netlify environment variables — generate one with `openssl rand -hex 32`."
    );
  }
  return s;
}

function hsHeaders() {
  return {
    Authorization: `Bearer ${process.env.HUBSPOT_API_KEY}`,
    "Content-Type": "application/json"
  };
}

// Mint a signed session token for a verified user. `ver` is the contact's
// current portal_token_version at issue time (default 0).
export function createToken({ email, role, ver = 0 }) {
  const payload = {
    email: String(email || "").toLowerCase().trim(),
    role: role ? String(role).trim() : null,
    ver: Number.isFinite(Number(ver)) ? Number(ver) : 0,
    exp: Date.now() + TOKEN_TTL_MS
  };
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(crypto.createHmac("sha256", getSecret()).update(body).digest());
  return `${body}.${sig}`;
}

// Returns the decoded payload { email, role, ver, exp } if the token's
// signature and expiry are valid, otherwise null. This is the cheap,
// synchronous half of verification (no network). Revocation (ver) is checked
// separately in authenticate(), which is async.
export function verifyToken(token) {
  if (!token || typeof token !== "string") return null;
  const secret = getSecret(); // throws if unset -> callers return 500
  const dot = token.indexOf(".");
  if (dot < 1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const expected = b64url(crypto.createHmac("sha256", secret).update(body).digest());

  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  let payload;
  try {
    payload = b64urlToJson(body);
  } catch (_) {
    return null;
  }
  if (!payload || !payload.exp || Date.now() > payload.exp) return null;
  return payload;
}

// Extract the bearer token from a Netlify Functions event. We accept it in
// the Authorization header (preferred), a `token` query param, or a `token`
// field in a JSON body — so GET, POST, and link/image contexts all work.
export function tokenFromEvent(event) {
  const h = (event && event.headers) || {};
  const auth = h.authorization || h.Authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (m) return m[1].trim();

  const qp = (event && event.queryStringParameters) || {};
  if (qp.token) return String(qp.token);

  if (event && event.body) {
    try {
      const parsed = JSON.parse(event.body);
      if (parsed && parsed.token) return String(parsed.token);
    } catch (_) { /* not JSON / no token — fine */ }
  }
  return null;
}

// ---- token-version (revocation) store -------------------------------------

const _verCache = new Map(); // email -> { ver, ts }

// Read the contact's current portal_token_version (default 0). Cached briefly.
// On any HubSpot error we return null to signal "couldn't determine" so the
// caller can fail OPEN (avoid mass lockout on a transient HubSpot blip) — the
// signature + 12h expiry still apply in that case.
export async function getCurrentTokenVersion(email) {
  const key = String(email || "").toLowerCase().trim();
  if (!key) return 0;

  const cached = _verCache.get(key);
  if (cached && (Date.now() - cached.ts) < VERSION_CACHE_MS) return cached.ver;

  try {
    const res = await fetch(`${HS_BASE}/crm/v3/objects/contacts/search`, {
      method: "POST",
      headers: hsHeaders(),
      body: JSON.stringify({
        filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: key }] }],
        properties: ["email", "portal_token_version"]
      })
    });
    if (!res.ok) return null; // unknown -> fail open
    const data = await res.json();
    const contact = data.results?.[0];
    if (!contact) return null;
    const ver = parseInt(contact.properties?.portal_token_version || "0", 10) || 0;
    _verCache.set(key, { ver, ts: Date.now() });
    return ver;
  } catch (_) {
    return null; // network error -> fail open
  }
}

// Increment the contact's portal_token_version, invalidating every token
// issued before now. Returns the new version, or null if it couldn't be
// written (e.g. the property doesn't exist yet). Best-effort by design.
export async function bumpTokenVersion(email) {
  const key = String(email || "").toLowerCase().trim();
  if (!key) return null;
  try {
    const sres = await fetch(`${HS_BASE}/crm/v3/objects/contacts/search`, {
      method: "POST",
      headers: hsHeaders(),
      body: JSON.stringify({
        filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: key }] }],
        properties: ["email", "portal_token_version"]
      })
    });
    if (!sres.ok) return null;
    const data = await sres.json();
    const contact = data.results?.[0];
    if (!contact?.id) return null;

    const current = parseInt(contact.properties?.portal_token_version || "0", 10) || 0;
    const next = current + 1;

    const pres = await fetch(`${HS_BASE}/crm/v3/objects/contacts/${contact.id}`, {
      method: "PATCH",
      headers: hsHeaders(),
      body: JSON.stringify({ properties: { portal_token_version: String(next) } })
    });
    if (!pres.ok) return null; // property may not exist — caller treats as no-op

    _verCache.set(key, { ver: next, ts: Date.now() }); // reflect immediately
    return next;
  } catch (_) {
    return null;
  }
}

// Any non-empty admin_role counts as admin — this matches the portal's
// existing model where assigning any admin_role (Founder, Director, School
// Support Manager, …) grants admin access. The literal "user" never does.
export function isAdmin(session) {
  if (!session || !session.role) return false;
  const r = String(session.role).trim().toLowerCase();
  return r.length > 0 && r !== "user";
}

function jsonError(statusCode, message) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ error: message })
  };
}

// Require ANY valid logged-in session. ASYNC: also checks token revocation.
//   Returns { session } on success, or { response } to return immediately.
export async function authenticate(event) {
  let payload;
  try {
    payload = verifyToken(tokenFromEvent(event));
  } catch (e) {
    return { response: jsonError(500, "Authentication is not configured on the server: " + e.message) };
  }
  if (!payload) {
    return { response: jsonError(401, "Not signed in, or your session expired. Please sign in again.") };
  }
  // Tokens minted before token-versioning have no `ver` — reject them so the
  // old long-lived tokens can't be replayed.
  if (payload.ver === undefined || payload.ver === null) {
    return { response: jsonError(401, "Your session is no longer valid. Please sign in again.") };
  }
  // Revocation check. null => couldn't read HubSpot; fail open (signature +
  // 12h expiry still gate access). A definite mismatch => token was revoked.
  const current = await getCurrentTokenVersion(payload.email);
  if (current !== null && Number(payload.ver) !== Number(current)) {
    return { response: jsonError(401, "You have been signed out. Please sign in again.") };
  }
  return { session: payload };
}

// Require a valid session whose email matches `email` — i.e. you can only
// read your OWN data. Admins are allowed through for any email so existing
// admin views keep working.
export async function authenticateSelf(event, email) {
  const r = await authenticate(event);
  if (r.response) return r;
  if (isAdmin(r.session)) return r;
  const want = String(email || "").toLowerCase().trim();
  if (!want || r.session.email !== want) {
    return { response: jsonError(403, "You can only access your own information.") };
  }
  return r;
}

// Require a valid session that belongs to an admin.
export async function authenticateAdmin(event) {
  const r = await authenticate(event);
  if (r.response) return r;
  if (!isAdmin(r.session)) {
    return { response: jsonError(403, "Admin access is required for this action.") };
  }
  return r;
}
