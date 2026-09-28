# Expedition leader roster editing

Expedition leaders can correct a student's or school leader's details from the
Expedition Leader tab, and the correction is written back to the sources the
tab reads from — it isn't a portal-only overlay.

## Who can edit

| Role | Sees the roster | Can edit |
|---|---|---|
| Expedition leader (`Trip Leader` on that trip) | yes | **yes** |
| Admin (any non-empty `admin_role`) | yes | **yes** |
| Teacher / school leader | yes (their own tab) | no |
| Student / parent | no | no |

Read access and write access are deliberately different widths. A teacher can
open a student's Medical Information and must not be able to change it, so the
existing `assertEmailAccess` (which admits both staff labels) is not reused for
writes. Writes go through `resolveRosterEditAccess` in
`_shared/portal-access.js`, which requires an admin or a **Trip Leader** on a
trip the target belongs to.

The EDIT button in the modal is a UI convenience only. Every request is
authorized again server-side, so revealing the button from the console gets a
403 rather than an edit.

## What can be edited

**The application form** — every field on the person's Jotform submission,
including ones they left blank, so a leader can fill a gap as well as fix a
mistake.

Read-only by design, because a flat write corrupts the stored shape or breaks
the record's identity:

- `control_email` — the key submissions are matched on
- `control_datetime` — structured value
- `control_fileupload` — passport scans and portraits

Name questions (`control_fullname`) ARE editable, one subfield at a time, the
same way addresses are — a booking has to match the passport, so the name has
to be correctable. See PASSPORT_SETUP.md.

These render in the form greyed out with a READ-ONLY note. `lib/jotform.js`
refuses them independently of the UI.

**HubSpot contact properties** — the whitelist lives in `_shared/roster-edit.js`:

- `firstname`, `lastname` — anyone on the trip (the passport-matching problem)
- `phone` — anyone on the trip
- `ue_student_status`, `notes__c` — students only (they're the school's
  per-student tracking fields; on a staff contact nothing would read them)

Everything else on the contact is out of reach. `email` especially: editing it
would orphan the person's application submission.

## Blank values

The student's own editor (`edit-application.html`) never receives a
passport/medical value, so a blank there means "didn't retype it" and the
existing value is preserved. The leader editor *does* show the current value,
so a blank there is a deliberate clear and is written through. That's the
`allowSensitiveBlank` option on `buildUpdatePayload`, and `revealSensitive` on
`buildClientFields`.

The form only sends fields whose value actually changed, so an untouched answer
is never rewritten.

## Audit trail

Every save writes a note on the person's HubSpot contact record: who edited,
when (UTC), and each changed field with its new value. A cleared field reads as
`(cleared)`.

**Note the privacy trade-off:** because the note records new values, an edit to
a medical or passport answer puts that value into HubSpot as well as Jotform.
To log only *which* fields changed, drop the `: ${value}` from
`buildAuditNoteBody` in `_shared/roster-edit.js` — the note still answers who
changed what and when.

A failed note never fails the save; it comes back as a warning on the response,
because losing the audit entry is not a reason to tell a leader their medical
correction didn't save.

## Endpoints

| Endpoint | Purpose |
|---|---|
| `get-person-form` | Loads the editor: full submission with sensitive values revealed, plus the editable contact properties. |
| `update-person` | Saves. Writes Jotform, then HubSpot, then the audit note. |

Both resolve the submission ID server-side from the person's email. The browser
never sees or sends one.

## Form IDs

`_shared/application-forms.js` is the single source of truth for which Jotform
forms hold applications. Read and write paths both import it, so the submission
a leader edits is always the one the modal displayed. Add new application-form
versions there (or via `JOTFORM_APPLICATION_FORM_ID`) — **not** the
document-upload form, which also carries an email answer and would win the
most-recent match.

## Tests

`test/roster-edit.test.mjs` — the whitelist, the blank/reveal rules, the audit
note body, and both endpoints end to end with HubSpot and Jotform stubbed. The
authorization cases (a teacher refused on both endpoints, a leader from another
trip refused, nothing written on a refusal) are the ones worth keeping green.
