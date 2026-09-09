# Household document pooling

## The problem

A Jotform submission records only the email the submitter typed. Every
document lookup matched that single address, so what the portal actually
showed was "files submitted under this exact email":

- a parent uploaded the passport → the student's own portal showed nothing,
  and the student uploaded it again
- a student uploaded the passport → the parent's portal showed nothing
- a leader opened **VIEW DOCUMENTS** for a student → only the subset
  the student had sent themselves, so staff chased documents that were
  already on file

## The fix

`netlify/functions/_shared/household.js` resolves the people around a contact
in HubSpot, and an upload from any of them now counts as that student's.

Two sources, unioned, because each misses cases the other catches:

| Source | Catches |
|---|---|
| Contacts associated with the student's **deals** | The paying parent, a second parent added later |
| Contacts linked to the student contact-to-contact with a **label** ("Parent") | A parent who was never associated to the deal |

Only labelled contact-to-contact links widen the audience — an unlabelled link
is too weak a signal on its own. Labels matching
`referee|reference|emergency|doctor|gp|school|teacher|instructor|agent|advisor`
are dropped: one family's emergency contact is another family's parent.

Deal fan-out is capped at 10 deals, and lookups are cached in-process for 60s
so an offline warm run doesn't repeat the same lookups per student.

## Which emails are matched

`submitterEmails(submission)` returns every email field that could belong to
the submitter, in display order, skipping emergency-contact-style fields:

```
next of kin | emergency | referee | reference | doctor | gp
school | teacher | instructor | agent | advisor | insurer | insurance
```

A submission is kept when one of those addresses is in the household, and the
first match is credited as the uploader.

A `Parent/Guardian Email` field is deliberately **not** excluded — on these
forms the parent is usually the person submitting, and skipping those fields
would hide exactly the uploads this change exists to surface.

Without the emergency-contact filter there is a real cross-student leak: if
student B names student A's father as her next of kin, B's passport lands on
A's record. There's a test for it.

## What the endpoint returns

`get-uploaded-documents` adds to each document:

| Field | Meaning |
|---|---|
| `uploadedByName` | Contact's name, or `null` when HubSpot had none |
| `uploadedByRole` | Association label — "Parent", "Student" |
| `uploadedByStudent` | True when the person whose record this is uploaded it |
| `uploadedByMe` | True when the logged-in caller uploaded it |
| `formTitle` | Title of the form it arrived on |

No email addresses are returned. Plus a top-level `household` block: `people`
(name, role, `isAnchor`, `isSelf`) and `degraded`.

## Failure behaviour

Every HubSpot step fails soft. On any error the audience falls back to the one
email — the old behaviour, a thinner list rather than a broken page — and
`household.degraded` is set. The UI then warns "Parent records were
unavailable…" instead of implying the list is complete, and the partial result
is not cached.

`degraded` is also how the UI tells "no parents are linked in HubSpot" apart
from "we couldn't ask".

## Authorisation

**Unchanged.** `?email=` still resolves through `assertEmailAccess`: yourself, an admin, or staff (Teacher / Trip Leader) on a trip the target belongs to.

The household is resolved around the *requested* email, so a viewer sees that
person's family and nobody else's.

## Front end

The per-student VIEW DOCUMENTS modal names whose uploads it covers ("Student uploads, plus Peter Reynolds (Parent)") and each card reads "Uploaded by Peter Reynolds (Parent) · 14 Feb 2026". A leader's own Documents tab gets the same treatment — which matters for a leader who is also a parent on one of these trips: their child's uploads now appear there, each labelled with who sent it.

## Tests

`test/uploaded-documents.test.mjs` — 24 cases, wired into `npm test` (this
repo had no test script before; it now runs this file). Covers the audience
rules, the emergency-contact leak, attribution, the no-email-in-payload
guarantee, and the pre-existing labelling behaviour that had to survive the
refactor.

## Files

| File | Change |
|---|---|
| `netlify/functions/_shared/household.js` | New. Audience resolution + `submitterEmails`. |
| `netlify/functions/get-uploaded-documents.js` | Matches the household; adds uploader fields; `documentsFromSubmission` exported for tests. |
| `public/index.html` | `renderDocumentCard` shows who uploaded each file; the student modal and the leader's own Documents tab state whose uploads the list covers. |
| `test/uploaded-documents.test.mjs` | New. |
| `package.json` | Adds `npm test`. |

Requires `HUBSPOT_API_KEY`, which this site already sets. No new environment
variables.

## Kept in step with the other portals

The same change is deployed on the Pacific Discovery student and instructor
portals. `_shared/household.js` is identical across all of them bar its
comments — port fixes in both directions.
