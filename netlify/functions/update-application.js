// POST /.netlify/functions/update-application
//
// Applies the user's edits to their OWN application submission. Security model
// mirrors get-application:
//   1. Valid signed session token required (Authorization: Bearer <token>),
//      verified via the portal's shared session auth (_shared/auth.js).
//   2. Email comes from the verified token; the submission ID is resolved
//      server-side from that email. The client CANNOT supply a submission ID.
//   3. Only editable field types are written; sensitive fields left blank are
//      preserved (never overwritten with an empty string).
//
// Request body (JSON):
//   { "changes": { "<qid>": "<new value>", ... } }
// `changes` should contain only fields the user actually edited. Any blank
// sensitive field is dropped server-side as a second line of defence.

import { authenticate } from "./_shared/auth.js";
import { findSubmissionByEmail, buildUpdatePayload, updateSubmission } from "./lib/jotform.js";

function json(statusCode, payload) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) };
}

export async function handler(event) {
  try {
    if (event.httpMethod && event.httpMethod !== "POST") {
      return json(405, { error: "Method not allowed" });
    }

    // 1. Authenticate against the portal's shared session token.
    const { session, response } = await authenticate(event);
    if (response) return response;

    if (!process.env.JOTFORM_API_KEY) {
      return json(500, { error: "Jotform is not configured." });
    }

    // 2. Parse changes.
    let changes;
    try {
      const parsed = JSON.parse(event.body || "{}");
      changes = parsed.changes || {};
    } catch {
      return json(400, { error: "Invalid request body" });
    }
    if (!changes || typeof changes !== "object" || Array.isArray(changes)) {
      return json(400, { error: "`changes` must be an object of qid -> value" });
    }
    if (Object.keys(changes).length === 0) {
      return json(200, { updated: false, message: "No changes submitted." });
    }

    // 3. Resolve the caller's own submission server-side.
    const result = await findSubmissionByEmail(session.email);
    if (!result.found) {
      return json(404, { error: "No application submission found for your account." });
    }

    // 4. Translate changes -> Jotform payload (drops read-only + blank-sensitive).
    const { fields, skipped } = buildUpdatePayload(result.submission, changes);

    if (Object.keys(fields).length === 0) {
      return json(200, { updated: false, message: "Nothing to update.", skipped });
    }

    await updateSubmission(result.submissionId, fields);

    return json(200, {
      updated: true,
      updatedCount: Object.keys(fields).length,
      skipped,
    });

  } catch (err) {
    console.error("[update-application] error:", err?.stack || err?.message || err);
    return json(500, { error: "Could not save your changes." });
  }
}
