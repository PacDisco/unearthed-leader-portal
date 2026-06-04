// Proxies a Jotform-hosted file through Netlify so portal users can view
// their uploaded documents without needing a Jotform account.
//
// Why: Jotform's submission file URLs (https://www.jotform.com/uploads/...)
// require the viewer to be signed into Jotform unless the form is in a very
// permissive privacy mode. Rather than make every parent log into Jotform,
// this function fetches the file server-side using JOTFORM_API_KEY (which
// stays in Netlify env vars and never reaches the browser), then streams the
// bytes back to the parent.
//
// Input (querystring):
//   url — the full Jotform file URL returned by /form/{id}/submissions
//
// Required env var: JOTFORM_API_KEY
//
// Limits worth knowing about:
//   - Netlify Functions cap responses at ~6MB. Files larger than ~4.5MB
//     (after base64 encoding) will fail. Most uploaded documents are well
//     under that.
//   - 10-second function timeout. Slow upstream fetches will be cut off.

import { authenticate } from "./_shared/auth.js";

export async function handler(event) {
  try {
    // Auth: require a valid session (token via ?token= or Authorization header).
    const auth = await authenticate(event);
    if (auth.response) return auth.response;

    const { url } = event.queryStringParameters || {};
    if (!url) {
      return { statusCode: 400, body: JSON.stringify({ error: "Missing url" }) };
    }
    if (!process.env.JOTFORM_API_KEY) {
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: "Jotform is not configured",
          details: "Set JOTFORM_API_KEY in Netlify environment variables."
        })
      };
    }

    // Refuse to proxy anything that isn't a Jotform URL — this endpoint
    // would otherwise be an open relay for any URL on the internet.
    let target;
    try {
      target = new URL(url);
    } catch (_) {
      return { statusCode: 400, body: JSON.stringify({ error: "Invalid url" }) };
    }
    const host = target.hostname.toLowerCase();
    const isJotform = (
      host === "jotform.com" || host.endsWith(".jotform.com") ||
      host === "jotfor.ms"   || host.endsWith(".jotfor.ms")
    );
    if (!isJotform) {
      return { statusCode: 400, body: JSON.stringify({ error: "Only Jotform URLs are allowed" }) };
    }

    // Append the API key so Jotform releases the file for download. This
    // happens server-side; the parent never sees it.
    target.searchParams.set("apiKey", process.env.JOTFORM_API_KEY);

    const upstream = await fetch(target.toString(), { redirect: "follow" });
    if (!upstream.ok) {
      const text = await upstream.text().catch(() => "");
      // Log to Netlify function logs so we can diagnose why a particular
      // file fetch failed (HIPAA-encrypted form, key scope, regional CDN, etc).
      console.warn(
        `[get-document] upstream non-OK ${upstream.status} for ${target.host}${target.pathname} — ${text.slice(0, 200)}`
      );
      return {
        statusCode: upstream.status,
        body: JSON.stringify({
          error: `Jotform returned ${upstream.status}`,
          host: target.host,
          path: target.pathname,
          details: text.slice(0, 500)
        })
      };
    }

    const contentType =
      upstream.headers.get("content-type") || "application/octet-stream";
    const filename = decodeURIComponent(
      target.pathname.split("/").pop() || "document"
    ).replace(/"/g, "");

    const buf = await upstream.arrayBuffer();
    const base64 = Buffer.from(buf).toString("base64");

    return {
      statusCode: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": `inline; filename="${filename}"`,
        "Cache-Control": "private, max-age=300"
      },
      body: base64,
      isBase64Encoded: true
    };

  } catch (err) {
    console.error("ERROR:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    };
  }
}
