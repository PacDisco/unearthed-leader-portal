// Shared rules and HubSpot writes for expedition-leader roster editing.
//
// Two endpoints use this: get-person-form.js (renders the editor) and
// update-person.js (saves it). Keeping the whitelist here means the form can
// never offer a field the save would reject, and — more importantly — the save
// never trusts the form about which fields were in scope.

// The ONLY HubSpot contact properties a leader may write. Everything else on
// the contact (email, name, owner, lifecycle stage, association labels…) is
// out of reach: email in particular is the key submissions are matched on, so
// letting it be edited here would silently orphan someone's application.
export const EDITABLE_CONTACT_PROPERTIES = ["phone", "ue_student_status", "notes__c"];

// Of those, the ones that only make sense on a student. `ue_student_status`
// and `notes__c` are the school's per-student tracking fields shown on the
// Teachers tab; writing them onto a staff contact would put data somewhere
// nothing reads it.
export const STUDENT_ONLY_CONTACT_PROPERTIES = ["ue_student_status", "notes__c"];

// Human-readable names for the audit note.
export const CONTACT_PROPERTY_LABELS = {
  phone: "Phone",
  ue_student_status: "Student status",
  notes__c: "Notes",
};

function hsHeaders() {
  return {
    Authorization: `Bearer ${process.env.HUBSPOT_API_KEY}`,
    "Content-Type": "application/json",
  };
}

// Filters an incoming { property: value } object down to what this person is
// allowed to have written. Returns { properties, skipped } — `skipped` is
// reported back to the client so a silently-dropped field is visible rather
// than looking like a successful save.
export function filterContactChanges(changes, { isStudent }) {
  const properties = {};
  const skipped = [];

  for (const [key, rawValue] of Object.entries(changes || {})) {
    if (!EDITABLE_CONTACT_PROPERTIES.includes(key)) {
      skipped.push({ field: key, reason: "not editable from the portal" });
      continue;
    }
    if (!isStudent && STUDENT_ONLY_CONTACT_PROPERTIES.includes(key)) {
      skipped.push({ field: key, reason: "only applies to students" });
      continue;
    }
    properties[key] = rawValue == null ? "" : String(rawValue);
  }

  return { properties, skipped };
}

// PATCH the contact. Throws on failure so the caller can report a partial
// save honestly rather than claiming success.
export async function updateContactProperties(contactId, properties) {
  const entries = Object.entries(properties || {});
  if (entries.length === 0) return { updated: false };

  const res = await fetch(
    `https://api.hubapi.com/crm/v3/objects/contacts/${encodeURIComponent(contactId)}`,
    { method: "PATCH", headers: hsHeaders(), body: JSON.stringify({ properties }) }
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HubSpot contact PATCH ${res.status}: ${text.slice(0, 300)}`);
  }
  return { updated: true, count: entries.length };
}

// Builds the audit-note body. Plain text with <br> line breaks — HubSpot note
// bodies render as HTML.
//
// NOTE ON CONTENT: this records the new value of every changed field, which
// for an application edit can include medical and passport answers. That means
// those values come to rest in HubSpot as well as Jotform. If that's not
// wanted, drop the `: ${value}` below and the note still answers who changed
// what and when.
export function buildAuditNoteBody({ editorEmail, personName, changes, when = new Date() }) {
  const esc = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const stamp = when.toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const lines = changes.map(c => {
    const value = String(c.value || "").trim();
    return `• ${esc(c.label)}: ${esc(value === "" ? "(cleared)" : value)}`;
  });

  return [
    `<b>Details updated in the leader portal</b>`,
    `Edited by ${esc(editorEmail)} on ${esc(stamp)}`,
    personName ? `Person: ${esc(personName)}` : null,
    "",
    ...lines,
  ].filter(v => v !== null).join("<br>");
}

// Writes the note and associates it to the contact. Association type 202 is
// HubSpot's built-in note → contact.
//
// Best-effort by design: the caller logs a failure and still reports the save
// as successful, because losing the audit note is not a reason to tell a
// leader their medical correction didn't save.
export async function writeAuditNote(contactId, body) {
  const res = await fetch("https://api.hubapi.com/crm/v3/objects/notes", {
    method: "POST",
    headers: hsHeaders(),
    body: JSON.stringify({
      properties: { hs_note_body: body, hs_timestamp: new Date().toISOString() },
      associations: [{
        to: { id: String(contactId) },
        types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 202 }],
      }],
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HubSpot note POST ${res.status}: ${text.slice(0, 300)}`);
  }
  return { written: true };
}
