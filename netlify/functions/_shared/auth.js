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
//   The payload is { email, role, exp }. Because it's signed with a secret
//   that never leaves the server, the browser cannot forge or tamper with
//   it — flipping `role` to an admin value, or swapping in someone else's
//   email, invalidates the signature.
//
//   Every private endpoint calls authenticate() / authenticateSelf() /
//   authenticateAdmin() and returns the provided 401/403 response if the
//   token is missing, invalid, expired, or not authorised for the target.
//
// REQUIRED ENV VAR
//   SESSION_SECRET — a long random string. Generate one with:
//                      openssl rand -hex 32
//                    Set it in Netlify → Site settings → Environment
//                    variables. If it is missing the endpoints fail closed
//                    (500) rather than letting anyone through.

import crypto from "crypto";

// How long a session stays valid. Re-login required after this.
const TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14 days

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

// Mint a signed session token for a verified user.
export function createToken({ email, role }) {
  const payload = {
    email: String(email || "").toLowerCase().trim(),
    role: role ? String(role).trim() : null,
    exp: Date.now() + TOKEN_TTL_MS
  };
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(crypto.createHmac("sha256", getSecret()).update(body).digest());
  return `${body}.${sig}`;
}

// Returns the decoded payload { email, role, exp } if the token is valid,
// otherwise null. Verifies the signature (timing-safe) and the expiry.
export function verifyToken(token) {
  if (!token || typeof token !== "string") return null;
  // getSecret() throws if SESSION_SECRET is unset — we deliberately let that
  // propagate so callers (authenticate*) return a 500 "not configured"
  // rather than silently looking like every session is just invalid.
  const secret = getSecret();
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

// Require ANY valid logged-in session.
//   Returns { session } on success, or { response } to return immediately.
export function authenticate(event) {
  let session;
  try {
    session = verifyToken(tokenFromEvent(event));
  } catch (e) {
    return { response: jsonError(500, "Authentication is not configured on the server: " + e.message) };
  }
  if (!session) {
    return { response: jsonError(401, "Not signed in, or your session expired. Please sign in again.") };
  }
  return { session };
}

// Require a valid session whose email matches `email` — i.e. you can only
// read your OWN data. Admins are allowed through for any email so existing
// admin views keep working.
export function authenticateSelf(event, email) {
  const r = authenticate(event);
  if (r.response) return r;
  if (isAdmin(r.session)) return r;
  const want = String(email || "").toLowerCase().trim();
  if (!want || r.session.email !== want) {
    return { response: jsonError(403, "You can only access your own information.") };
  }
  return r;
}

// Require a valid session that belongs to an admin.
export function authenticateAdmin(event) {
  const r = authenticate(event);
  if (r.response) return r;
  if (!isAdmin(r.session)) {
    return { response: jsonError(403, "Admin access is required for this action.") };
  }
  return r;
}
