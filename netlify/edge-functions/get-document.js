// Streams a Jotform-hosted file through Netlify so portal users can view
// their uploaded documents without needing a Jotform account.
//
// This is the EDGE-FUNCTION version of get-document. It exists because the
// regular serverless function caps responses at ~6MB (after base64 encoding),
// and a single iPhone portrait photo is often 4–8MB raw — which became
// "Function.ResponseSizeTooLarge" once base64'd. Edge functions stream the
// upstream response body straight through with no buffering, lifting that
// cap to ~20MB and eliminating the base64 overhead entirely.
//
// Inputs (querystring):
//   url — the full Jotform file URL returned by /form/{id}/submissions
//
// Required env var (Netlify): JOTFORM_API_KEY
//
// Frontend integration:
//   Build URLs like `/document-proxy?url=<encoded jotform URL>` from
//   get-students.js (portrait photos) and get-uploaded-documents.js
//   (document uploads). Both have been updated.

export default async (request, context) => {
  const url = new URL(request.url);
  const target = url.searchParams.get("url");

  // Auth: require a valid portal session token. Files are referenced from
  // <img>/<a> tags that can't send an Authorization header, so the token
  // rides in the query string (?token=…). The URL builders in
  // get-uploaded-documents.js and get-teachers.js append it. We verify the
  // same HMAC-signed token the Node functions issue, but using Web Crypto
  // because edge functions run on Deno (no Node `crypto` module).
  const session = await verifySessionToken(url.searchParams.get("token"));
  if (!session) {
    return jsonResponse({ error: "Not authenticated." }, 401);
  }

  if (!target) {
    return jsonResponse({ error: "Missing url" }, 400);
  }

  // Validate the upstream URL.
  let parsed;
  try {
    parsed = new URL(target);
  } catch (_) {
    return jsonResponse({ error: "Invalid url" }, 400);
  }

  const host = parsed.hostname.toLowerCase();
  const isJotform = (
    host === "jotform.com" || host.endsWith(".jotform.com") ||
    host === "jotfor.ms"   || host.endsWith(".jotfor.ms")
  );
  // HubSpot file CDN hosts. We allow these so that leader-card photos
  // (cross-origin HubSpot images that iOS Safari sometimes refuses to
  // render in <img> when fetched through a service worker) can be
  // proxied as same-origin and rendered reliably on every device.
  const isHubSpotCdn = (
    /\.hubspotusercontent\b/i.test(host) ||  // *.fs1.hubspotusercontent-na1.net etc.
    host.endsWith(".hubspot.com") ||
    host === "hubspot.com" ||
    /\.hubapi\.com$/i.test(host)
  );
  if (!isJotform && !isHubSpotCdn) {
    return jsonResponse({
      error: "Only Jotform or HubSpot URLs are allowed",
      host
    }, 400);
  }

  // Per-host upstream config. Jotform requires the API key in the URL;
  // HubSpot CDN URLs are public and sometimes already signed.
  if (isJotform) {
    const apiKey = Netlify.env.get("JOTFORM_API_KEY");
    if (!apiKey) {
      return jsonResponse({
        error: "Jotform is not configured",
        details: "Set JOTFORM_API_KEY in Netlify environment variables."
      }, 500);
    }
    parsed.searchParams.set("apiKey", apiKey);
  }

  let upstream;
  try {
    upstream = await fetch(parsed.toString(), { redirect: "follow" });
  } catch (err) {
    console.error(`[document-proxy] fetch threw for ${parsed.host}${parsed.pathname}:`, err?.message || err);
    return jsonResponse({ error: "Upstream fetch failed", details: String(err?.message || err) }, 502);
  }

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "");
    console.warn(
      `[document-proxy] upstream non-OK ${upstream.status} for ${parsed.host}${parsed.pathname} — ${text.slice(0, 200)}`
    );
    return jsonResponse({
      error: `Jotform returned ${upstream.status}`,
      host: parsed.host,
      path: parsed.pathname,
      details: text.slice(0, 500)
    }, upstream.status);
  }

  const filename = decodeURIComponent(
    parsed.pathname.split("/").pop() || "document"
  ).replace(/"/g, "");

  // Decide the Content-Type the browser will see. We want files to VIEW
  // inline (passport scans, medical PDFs, photos) rather than download.
  // Jotform frequently serves these as "application/octet-stream", and
  // because the site sends `X-Content-Type-Options: nosniff` the browser
  // won't guess — a generic type forces a download even with
  // `Content-Disposition: inline`. So when the upstream type is missing or
  // generic, derive a real type from the file extension.
  const upstreamType = (upstream.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const contentType =
    (!upstreamType || upstreamType === "application/octet-stream")
      ? guessContentType(filename)
      : upstreamType;

  // Pass the upstream body straight through. ReadableStream → ReadableStream,
  // no .arrayBuffer(), no base64. This is the whole reason we're an edge fn.
  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": contentDisposition(filename),
      "Cache-Control": "private, max-age=300"
    }
  });
};

// Build an RFC 6266-safe Content-Disposition header.
//
// HTTP header values must be valid ByteStrings (Latin-1, bytes 0-255). Jotform
// filenames and iPhone photo names routinely contain non-ASCII characters
// (accents, non-Latin scripts, emoji), and after decodeURIComponent those land
// outside that range - so putting the raw name in `filename="..."` makes
// `new Response()` throw `Value is not a valid ByteString` and crashes the whole
// edge function. We emit an ASCII-only `filename=` fallback for old clients plus
// a percent-encoded UTF-8 `filename*=` that modern browsers use to recover the
// real name.
function contentDisposition(filename) {
  // ASCII fallback: replace any non-printable-ASCII char, plus quotes and
  // backslashes that would break the quoted-string, with an underscore.
  const asciiFallback =
    (filename || "document").replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") ||
    "document";
  // RFC 5987 encoding for the real, UTF-8 name.
  const encoded = encodeURIComponent(filename || "document");
  return `inline; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

// Best-effort MIME type from a filename extension. Covers the formats people
// actually upload to the portal (passport/visa scans, medical docs, photos).
// Falls back to octet-stream for anything unknown (which will download — the
// safe default for file types the browser can't render anyway).
function guessContentType(filename) {
  const ext = (filename.split(".").pop() || "").toLowerCase();
  const map = {
    pdf: "application/pdf",
    jpg: "image/jpeg", jpeg: "image/jpeg", jpe: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    bmp: "image/bmp",
    svg: "image/svg+xml",
    tif: "image/tiff", tiff: "image/tiff",
    heic: "image/heic", heif: "image/heif",
    txt: "text/plain; charset=utf-8"
  };
  return map[ext] || "application/octet-stream";
}

function jsonResponse(payload, status) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

// ----- Session token verification (Web Crypto / Deno) -----
// Mirrors netlify/functions/_shared/auth.js, which signs tokens as
//   base64url(JSON{email,role,exp}) + "." + base64url(HMAC_SHA256(payload))
// We can't import that Node module here (different runtime), so we
// re-implement verification with the Web Crypto API. Returns the decoded
// payload on success, or null on any failure (missing/invalid/expired token,
// or missing SESSION_SECRET — fail closed).
function b64urlToBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64url(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function verifySessionToken(token) {
  try {
    if (!token || typeof token !== "string") return null;
    const secret = Netlify.env.get("SESSION_SECRET");
    if (!secret || secret.length < 16) return null; // fail closed

    const dot = token.indexOf(".");
    if (dot < 1) return null;
    const body = token.slice(0, dot);
    const sig = token.slice(dot + 1);

    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
    const expected = bytesToB64url(new Uint8Array(mac));

    // Constant-time-ish compare.
    if (sig.length !== expected.length) return null;
    let diff = 0;
    for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
    if (diff !== 0) return null;

    const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(body)));
    if (!payload || !payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch (_) {
    return null;
  }
}

// Bind this edge function to /document-proxy. The frontend (and the URL
// builders inside get-students.js / get-uploaded-documents.js) all hit this
// path now instead of /.netlify/functions/get-document.
export const config = {
  path: "/document-proxy"
};
