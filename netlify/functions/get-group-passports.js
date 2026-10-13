// get-group-passports.js
// -----------------------------------------------------------------------------
// Manifest for the Expedition Leader tab's "DOWNLOAD ALL PASSPORTS (ZIP)"
// button: one entry per person on the trip (Expedition Leaders → School
// Leaders → Students, same order and numbering as the group sheets) with a
// short-lived, file-bound /document-proxy link to their passport photo.
//
// WHY A MANIFEST, NOT THE ZIP ITSELF: a serverless response is capped at ~6MB
// and a single phone photo of a passport is often 3–5MB, so a whole trip's
// passports can't come back from a function. The browser fetches each file
// through the streaming /document-proxy edge function (no size cap issue) and
// zips them client-side — see public/group-passports.js.
//
// Which file: the same one the passport check reads (read-passport.js) —
//   1. a passport a leader uploaded from the portal (`passport_upload`
//      HubSpot file id), else
//   2. the application form's passport upload (checking widget first, legacy
//      "Passport Cover Page Photo" second — passportPhotoUrl()).
//
// Auth: signed in AND (Teacher/Trip Leader on this trip, or admin) — the same
// guard as get-group-info.js. Each returned link is a doc token bound to that
// one file and to the caller's session, so it can't be reused for anything
// else and dies with the session.
//
// Inputs (querystring): portalId — Portal (trip) record id. Required.
// -----------------------------------------------------------------------------

import { authenticate } from "./_shared/auth.js";
import { assertPortalAccess } from "./_shared/portal-access.js";
import { proxyUrl } from "./_shared/doc-token.js";
import { passportPhotoUrl } from "./_shared/passport-widget.js";
import { PASSPORT_PROPS } from "./_shared/passport.js";
import { APPLICATION_FORM_IDS } from "./_shared/application-forms.js";
import { loadRoster, fetchProgram, fetchAllSubmissions, submissionEmail } from "./get-group-info.js";

export async function handler(event) {
  try {
    const auth = await authenticate(event);
    if (auth.response) return auth.response;

    const { portalId } = event.queryStringParameters || {};
    if (!portalId) return json(400, { error: "Missing portalId" });

    const access = await assertPortalAccess(auth.session, portalId);
    if (access) return access;

    if (!process.env.HUBSPOT_API_KEY) return json(500, { error: "HUBSPOT_API_KEY is not set" });

    const headers = {
      Authorization: `Bearer ${process.env.HUBSPOT_API_KEY}`,
      "Content-Type": "application/json",
    };

    const [program, roster, submissionsByEmail] = await Promise.all([
      fetchProgram(portalId, headers),
      loadRoster(portalId, headers, { extraProps: [PASSPORT_PROPS.upload], withParents: false }),
      latestSubmissionsByEmail(),
    ]);
    if (roster.error) return json(500, { error: roster.error });

    const groups = [
      { role: "Expedition Leader", people: roster.expeditionLeaders },
      { role: "School Leaders", people: roster.schoolLeaders },
      { role: "Students", people: roster.students },
    ];

    let idx = 0;
    const jobs = [];
    for (const g of groups) {
      for (const person of g.people) {
        idx += 1;
        const index = idx;
        jobs.push(resolvePassport(person, submissionsByEmail, headers).then(file => ({
          index,
          role: g.role,
          first: person.firstName || "",
          last: person.lastName || "",
          name: person.name || "",
          source: file ? file.source : null,
          url: file ? proxyUrl(file.url, auth.session) : null,
        })));
      }
    }
    const people = await Promise.all(jobs);

    return json(200, {
      program: { name: program.name || "", id: portalId },
      generatedAt: new Date().toISOString(),
      people,
    });
  } catch (err) {
    console.error("[get-group-passports] ERROR:", err?.message || err);
    return json(500, { error: "Server error" });
  }
}

function json(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

// Map<email, most recent application submission> across every application form.
async function latestSubmissionsByEmail() {
  const out = new Map();
  if (!process.env.JOTFORM_API_KEY) return out;
  const apiKey = process.env.JOTFORM_API_KEY;
  const baseUrl = (process.env.JOTFORM_BASE_URL || "https://api.jotform.com").replace(/\/+$/, "");
  let all = [];
  try {
    const perForm = await Promise.all(APPLICATION_FORM_IDS.map(id => fetchAllSubmissions(id, apiKey, baseUrl)));
    all = perForm.flat();
  } catch (_) {
    return out;
  }
  all.sort((a, b) => new Date(a?.created_at || 0) - new Date(b?.created_at || 0));
  for (const s of all) {
    const email = submissionEmail(s);
    if (email) out.set(email, s);
  }
  return out;
}

// { url, source } for one person's passport file, or null.
async function resolvePassport(person, submissionsByEmail, headers) {
  const fileId = String(person.props?.[PASSPORT_PROPS.upload] || "")
    .split(/[\s,;]+/).find(t => /^\d+$/.test(t));
  if (fileId) {
    const url = await hubspotSignedUrl(fileId, headers);
    if (url) return { url, source: "portal-upload" };
  }
  const email = String(person.email || "").toLowerCase().trim();
  const submission = email ? submissionsByEmail.get(email) : null;
  const url = submission ? passportPhotoUrl(submission) : null;
  return url ? { url, source: "application" } : null;
}

async function hubspotSignedUrl(fileId, headers) {
  try {
    const res = await fetch(`https://api.hubapi.com/files/v3/files/${fileId}/signed-url`, { headers });
    if (!res.ok) {
      console.warn("[get-group-passports] signed-url failed for", fileId, res.status);
      return null;
    }
    const data = await res.json();
    return data?.url || null;
  } catch (err) {
    console.warn("[get-group-passports] signed-url threw:", err?.message || err);
    return null;
  }
}
