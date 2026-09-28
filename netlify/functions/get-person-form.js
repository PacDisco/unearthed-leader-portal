// GET /.netlify/functions/get-person-form?email=<person>
//
// Backs the expedition leader's EDIT view on the Expedition Leader tab. Returns
// one person's FULL application submission — every field, including the ones
// they left blank, so a leader can fill a gap as well as fix a mistake — plus
// the handful of HubSpot contact properties that are editable from the roster
// card.
//
// How this differs from the neighbouring endpoints:
//   get-application-data — the READ view behind the Medical Information modal.
//                          Answered fields only, no editability information.
//   get-application      — the person's own self-service editor. Withholds
//                          passport/medical values entirely.
//   this one             — the leader editor. Reveals those values, because
//                          the leader already sees them in the modal and
//                          otherwise could only overwrite blind.
//
// SECURITY: gated by resolveRosterEditAccess, which requires the caller to be
// an admin or an EXPEDITION LEADER ("Trip Leader") on a trip the target person
// belongs to. A teacher — who can read the same person through
// get-application-data — is refused here. The submission ID is resolved
// server-side and never returned to the browser.

import { authenticate } from "./_shared/auth.js";
import { resolveRosterEditAccess } from "./_shared/portal-access.js";
import { APPLICATION_FORM_IDS_CSV } from "./_shared/application-forms.js";
import { findSubmissionByEmail, buildClientFields } from "./lib/jotform.js";
import { EDITABLE_CONTACT_PROPERTIES, STUDENT_ONLY_CONTACT_PROPERTIES } from "./_shared/roster-edit.js";

function json(statusCode, payload) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) };
}

export async function handler(event) {
  try {
    if (event.httpMethod && event.httpMethod !== "GET") {
      return json(405, { error: "Method not allowed" });
    }

    const { email } = event.queryStringParameters || {};
    if (!email) return json(400, { error: "Missing email" });

    const auth = await authenticate(event);
    if (auth.response) return auth.response;

    const access = await resolveRosterEditAccess(auth.session, email);
    if (access.response) return access.response;

    if (!process.env.JOTFORM_API_KEY) {
      return json(500, { error: "Jotform is not configured." });
    }

    const isStudent = access.labels.has("student");

    // Contact-side fields, read fresh so the form prefills with what's in
    // HubSpot right now rather than whatever the roster card was rendered
    // with. Non-fatal: the application half of the form still works if this
    // read fails.
    const contact = await readContactProperties(access.contactId, isStudent);

    // Resolve the submission across every application form version, using the
    // SAME list and the same most-recent-wins rule as the save path, so the
    // leader edits the submission they were just looking at.
    const result = await findSubmissionByEmail(email, APPLICATION_FORM_IDS_CSV);

    return json(200, {
      found: !!result.found,
      isStudent,
      submittedAt: result.found ? (result.submission.created_at || null) : null,
      // revealSensitive: the leader is authorized to see these values.
      fields: result.found ? buildClientFields(result.submission, { revealSensitive: true }) : [],
      contact,
      // Which contact properties this caller may write for this person — the
      // form renders exactly these, and the save endpoint enforces the same
      // rule independently.
      editableContactFields: isStudent
        ? EDITABLE_CONTACT_PROPERTIES
        : EDITABLE_CONTACT_PROPERTIES.filter(f => !STUDENT_ONLY_CONTACT_PROPERTIES.includes(f)),
      warning: result.warning || null,
    });

  } catch (err) {
    console.error("[get-person-form] error:", err?.stack || err?.message || err);
    return json(500, { error: "Could not load this person's details." });
  }
}

async function readContactProperties(contactId, isStudent) {
  const empty = { firstname: "", lastname: "", phone: "", ue_student_status: "", notes__c: "" };
  try {
    const props = isStudent
      ? ["firstname", "lastname", "phone", "ue_student_status", "notes__c"]
      : ["firstname", "lastname", "phone"];
    const res = await fetch(
      `https://api.hubapi.com/crm/v3/objects/contacts/${encodeURIComponent(contactId)}` +
      `?properties=${encodeURIComponent(props.join(","))}`,
      { headers: { Authorization: `Bearer ${process.env.HUBSPOT_API_KEY}`, "Content-Type": "application/json" } }
    );
    if (!res.ok) return empty;
    const data = await res.json();
    return {
      firstname: data?.properties?.firstname || "",
      lastname: data?.properties?.lastname || "",
      phone: data?.properties?.phone || "",
      ue_student_status: data?.properties?.ue_student_status || "",
      notes__c: data?.properties?.notes__c || "",
    };
  } catch (_) {
    return empty;
  }
}
