// Scoped, single-file tokens for /document-proxy.
//
// WHY THIS EXISTS
//   Files are shown in <img> and <a target="_blank">, neither of which can
//   send an Authorization header, so the credential has to ride in the query
//   string. Until now that credential was the SESSION token — the same one
//   that authorises every API call. Two consequences:
//
//     1. Anyone who got hold of a document URL (browser history, a pasted
//        link, a referrer header, a screenshot) held a working session for
//        that user until it expired — including an admin's.
//     2. Any signed-in user could proxy ANY Jotform or HubSpot URL, because
//        the proxy only checked "is this a valid session", not "were you
//        given this file". Guessing or reusing another student's file URL
//        worked.
//
//   A doc token fixes both. It is bound to ONE file URL, it is useless
//   anywhere else, and it cannot be replayed as a session token because it is
//   signed in a different domain (see DOMAIN below) and carries a different
//   prefix.
//
// STABILITY (don't make these random)
//   The offline cache keys on the full URL, so a token that changed between
//   renders would leave every previously-cached file unreachable. A doc token
//   is therefore deterministic: same viewer + same file + same session expiry
//   produces byte-identical output, so URLs stay stable for the life of the
//   session and the service worker keeps finding its cached copies.

import crypto from "crypto";

// Domain separation. A doc token is an HMAC over this prefix plus the body,
// so feeding one to the session verifier (which signs the bare body) can
// never validate — and vice versa.
const DOMAIN = "document-proxy.v1:";

// Marks the token as a doc token at a glance, and makes the session
// verifier's parse fail immediately rather than by signature.
const PREFIX = "d1";

function getSecret() {
  const s = process.env.SESSION_SECRET;
  if (!s || String(s).length < 16) {
    throw new Error("SESSION_SECRET is not set (or is too short).");
  }
  return s;
}

function b64url(buf) {
  return Buffer.from(buf).toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Which file this token is for. Hashed rather than embedded so the token
// stays short and doesn't restate the URL it travels beside.
export function hashUrl(url) {
  return crypto.createHash("sha256").update(String(url || "")).digest("hex").slice(0, 32);
}

// Mint a token for one viewer and one file.
//
// `exp` should be the SESSION's expiry, so the file link dies with the
// session that produced it and stays byte-stable while that session lives.
export function mintDocToken({ email, url, exp }) {
  const payload = {
    e: String(email || "").toLowerCase().trim(),
    u: hashUrl(url),
    exp: Number(exp) || 0,
  };
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(crypto.createHmac("sha256", getSecret()).update(DOMAIN + body).digest());
  return `${PREFIX}.${body}.${sig}`;
}

// Verify a token against the file being requested. Returns the payload, or
// null for anything wrong — wrong signature, expired, or (the point of all
// this) a valid token for a DIFFERENT file.
export function verifyDocToken(token, url) {
  try {
    if (!token || typeof token !== "string") return null;
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== PREFIX) return null;

    const [, body, sig] = parts;
    const expected = b64url(crypto.createHmac("sha256", getSecret()).update(DOMAIN + body).digest());
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

    const payload = JSON.parse(
      Buffer.from(body.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")
    );
    if (!payload || !payload.exp || Date.now() > payload.exp) return null;
    if (payload.u !== hashUrl(url)) return null;
    return payload;
  } catch (_) {
    return null;
  }
}

// Wraps a file URL as a proxied, token-bound link. Returns null when there's
// no URL, and an untokened proxy URL when there's no session to bind to (the
// proxy will then refuse it, which is the safe direction).
export function proxyUrl(fileUrl, session) {
  if (!fileUrl) return null;
  const base = `/document-proxy?url=${encodeURIComponent(fileUrl)}`;
  if (!session || !session.email || !session.exp) return base;
  return `${base}&token=${encodeURIComponent(mintDocToken({
    email: session.email, url: fileUrl, exp: session.exp,
  }))}`;
}
