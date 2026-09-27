// POST /.netlify/functions/update-person
//
// Saves an expedition leader's edits to another person on their trip — a
// student or a school leader (teacher), both of whom complete the same
// application form.
//
// Request body (JSON):
//   {
//     "email":       "<the person being edited>",
//     "name":        "<display name, for the audit note only>",
//     "application": { "<qid>": "<new value>", ... },   // Jotform answers
//     "contact":     { "phone": "...", "ue_student_status": "...", "notes__c": "..." }
//   }
// Send only fields that actually changed. A blank value is a deliberate clear.
//
// SECURITY MODEL
//   1. Valid signed session token (Authorization: Bearer <token>).
//   2. resolveRosterEditAccess: the caller must be an admin, or an EXPEDITION
//      LEADER ("Trip Leader") on a trip the target belongs to. Teachers are
//      refused — they can read the roster but not change it.
//   3. The target's submission ID is resolved SERVER-SIDE from their email.
//      The browser never sends or sees one.
//   4. Contact properties are whitelisted server-side (roster-edit.js); the
//      school's status/notes fields are accepted only for an actual Student.
//
// Writes go to BOTH sources behind the tab: the Jotform submission (the source
// for everything in the application/medical view) and the HubSpot contact
// (phone, and for students the school's status + notes). Every save also logs
// an audit note on the HubSpot contact recording who changed what.

import { authenticate } from "./_shared/auth.js";
import { resolveRosterEditAccess } from "./_shared/portal-access.js";
import { APPLICATION_FORM_IDS_CSV } from "./_shared/application-forms.js";
import { findSubmissionByEmail, buildUpdatePayload, updateSubmission, describeFields } from "./lib/jotform.js";
import {
  filterContactChanges,
  updateContactProperties,
  buildAuditNoteBody,
  writeAuditNote,
  CONTACT_PROPERTY_LABELS,
} from "./_shared/roster-edit.js";

function json(statusCode, payload) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) };
}

export async function handler(event) {
  try {
    if (event.httpMethod && event.httpMethod !== "POST") {
      return json(405, { error: "Method not allowed" });
    }

    const auth = await authenticate(event);
    if (auth.response) return auth.response;

    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { error: "Invalid request body" });
    }

    const email = String(body.email || "").toLowerCase().trim();
    if (!email) return json(400, { error: "Missing email" });

    const applicationChanges = isPlainObject(body.application) ? body.application : {};
    const contactChanges = isPlainObject(body.contact) ? body.contact : {};

    if (Object.keys(applicationChanges).length === 0 && Object.keys(contactChanges).length === 0) {
      return json(200, { updated: false, message: "No changes submitted." });
    }

    // Authorization + who this person is on the trip.
    const access = await resolveRosterEditAccess(auth.session, email);
    if (access.response) return access.response;
    const isStudent = access.labels.has("student");

    const skipped = [];
    const warnings = [];
    const auditEntries = [];
    let applicationCount = 0;
    let contactCount = 0;

    // ---- 1. Jotform application answers -----------------------------------
    if (Object.keys(applicationChanges).length) {
      if (!process.env.JOTFORM_API_KEY) return json(500, { error: "Jotform is not configured." });

      const result = await findSubmissionByEmail(email, APPLICATION_FORM_IDS_CSV);
      if (!result.found) {
        // Not fatal on its own — the contact-side edits below may still apply.
        warnings.push("No application submission found for this person, so the form answers weren't saved.");
      } else {
        // allowSensitiveBlank: unlike the self-service editor, the leader can
        // see the current value, so a blank is a deliberate clear.
        const { fields, skipped: jfSkipped } = buildUpdatePayload(
          result.submission, applicationChanges, { allowSensitiveBlank: true }
        );
        skipped.push(...jfSkipped.map(s => ({ field: s.qid, reason: s.reason })));

        if (Object.keys(fields).length) {
          await updateSubmission(result.submissionId, fields);
          applicationCount = Object.keys(fields).length;
          auditEntries.push(...describeFields(result.submission, fields));
        }
      }
    }

    // ---- 2. HubSpot contact properties ------------------------------------
    if (Object.keys(contactChanges).length) {
      const { properties, skipped: hsSkipped } = filterContactChanges(contactChanges, { isStudent });
      skipped.push(...hsSkipped);

      if (Object.keys(properties).length) {
        await updateContactProperties(access.contactId, properties);
        contactCount = Object.keys(properties).length;
        auditEntries.push(...Object.entries(properties).map(([key, value]) => ({
          key,
          label: CONTACT_PROPERTY_LABELS[key] || key,
          value: String(value),
        })));
      }
    }

    // ---- 3. Audit note (best-effort) --------------------------------------
    // A failed note must not make a successful save look failed, so this is
    // reported as a warning rather than thrown.
    if (auditEntries.length) {
      try {
        await writeAuditNote(access.contactId, buildAuditNoteBody({
          editorEmail: auth.session.email,
          personName: String(body.name || "").trim(),
          changes: auditEntries,
        }));
      } catch (noteErr) {
        console.warn("[update-person] audit note failed:", noteErr?.message || noteErr);
        warnings.push("Saved, but the change couldn't be logged to HubSpot.");
      }
    }

    const updatedCount = applicationCount + contactCount;
    return json(200, {
      updated: updatedCount > 0,
      updatedCount,
      applicationCount,
      contactCount,
      skipped,
      warnings,
    });

  } catch (err) {
    console.error("[update-person] error:", err?.stack || err?.message || err);
    return json(500, { error: "Could not save these changes." });
  }
}

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
