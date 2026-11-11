// check-application-source.js
// -----------------------------------------------------------------------------
// Diagnostic for moving the portal's application data off Jotform.
//
// Makes the SAME requests the roster makes (every application form + the
// document-upload form, limit=1000, in parallel) from this portal's server,
// once straight to Jotform and once to the apply site's data source, and
// reports status / time / count / size for each. It does not change where the
// portal reads from — JOTFORM_BASE_URL does that — so it's safe to run while
// the portal is live on Jotform.
//
// Returns counts only, never answers. Locked to the shared service key:
//   /.netlify/functions/check-application-source?key=<APPLY_SERVICE_KEY>
//
// Env: JOTFORM_API_KEY, APPLY_SERVICE_KEY, optional APPLICATION_SOURCE_URL
// (default https://apply.unearthededucation.org/api/jotform).
// -----------------------------------------------------------------------------
import crypto from "node:crypto";
import { APPLICATION_FORM_IDS } from "./_shared/application-forms.js";

const DOCUMENT_FORM_ID = "261220345497052";

function same(a, b) {
  const x = Buffer.from(String(a || "")); const y = Buffer.from(String(b || ""));
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
}

async function probe(base, formId, apiKey) {
  const url = `${base}/form/${encodeURIComponent(formId)}/submissions?apiKey=${encodeURIComponent(apiKey)}&limit=1000&offset=0`;
  const started = Date.now();
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    const text = await res.text();
    const out = { status: res.status, ok: res.ok, ms: Date.now() - started, bytes: text.length, contentType: res.headers.get("content-type") };
    try {
      const data = JSON.parse(text);
      out.count = Array.isArray(data?.content) ? data.content.length : null;
      if (!res.ok || out.count === null) out.message = String(data?.message || "").slice(0, 200);
    } catch {
      out.count = null;
      out.notJson = text.slice(0, 200); // e.g. an HTML error page
    }
    return out;
  } catch (err) {
    return { ok: false, ms: Date.now() - started, error: String(err?.cause?.code || err?.message || err).slice(0, 200) };
  }
}

export async function handler(event) {
  const key = event.queryStringParameters?.key;
  if (!same(key, process.env.APPLY_SERVICE_KEY)) {
    return { statusCode: 403, body: JSON.stringify({ error: "Add ?key=<APPLY_SERVICE_KEY>" }) };
  }
  const apiKey = process.env.JOTFORM_API_KEY || "";
  const source = (process.env.APPLICATION_SOURCE_URL || "https://apply.unearthededucation.org/api/jotform").replace(/\/+$/, "");
  const forms = [...APPLICATION_FORM_IDS, DOCUMENT_FORM_ID];

  const started = Date.now();
  // Same pattern as the roster: all forms at once.
  const [jotform, apply] = await Promise.all([
    Promise.all(forms.map((f) => probe("https://api.jotform.com", f, apiKey))),
    Promise.all(forms.map((f) => probe(source, f, apiKey))),
  ]);
  const report = {
    jotformBaseUrlSetting: process.env.JOTFORM_BASE_URL || "(not set — reading Jotform directly)",
    applicationSource: source,
    jotformKeySet: !!apiKey,
    totalMs: Date.now() - started,
    forms: forms.map((f, i) => ({ form: f, jotform: jotform[i], applySite: apply[i] })),
  };
  return { statusCode: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(report, null, 2) };
}
