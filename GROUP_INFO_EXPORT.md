# Group Information PDF export (Expedition Leader tab)

Adds a **"DOWNLOAD GROUP INFORMATION (PDF)"** button to the Expedition Leader
Resources tab. It generates, on demand and per program, a single landscape PDF
with the four group sheets — **Motivations, Emergency Contacts, Medical Details,
and Passenger/Travel Details** — grouped by Expedition Leader → School Leaders →
Students, pulled live from the same HubSpot + Jotform data the portal already uses.

## Files

| File | Change | What it does |
|---|---|---|
| `netlify/functions/get-group-info.js` | **new** | Endpoint. Auth + authorization (staff on this trip / admin), pulls the roster and scans Jotform **once**, returns the four tables as JSON. |
| `netlify/functions/lib/group-info.js` | **new** | Pure assembly + the **field-mapping config** (`FIELD_MAP`). No network. Unit-testable. |
| `public/group-pdf.js` | **new** | Client PDF builder. Lazy-loads pdfmake from jsDelivr (already allowed by CSP), fetches the endpoint, renders + downloads the PDF. |
| `public/index.html` | edited | Loads `group-pdf.js`; renders the download card in `trip_leader_information_content` and wires the click. |

No new server dependencies (pdfmake is loaded client-side from the CDN already
whitelisted in `netlify.toml`). `package.json` is unchanged. The new function is
picked up automatically by your existing Netlify functions setup.

## How it works

1. Instructor opens **Expedition Leader Resources** and clicks the button.
2. `group-pdf.js` calls `GET /.netlify/functions/get-group-info?portalId=<current trip>`
   with the signed session token (via the portal's existing `apiFetch`).
3. The function verifies the caller is a Teacher/Trip Leader on that trip (or an
   admin) — the same guard as `get-students.js` — then assembles the four tables.
4. The browser renders the PDF with pdfmake and downloads
   `Expedition-Leader-Info-<program>.pdf`.

Only staff/admins can reach the endpoint, and the button only renders inside the
already leader-gated `trip_leader_information_content` section.

## ⚠️ Verify before rollout

The plumbing, auth, grouping, and PDF rendering are done and tested. The only
thing that needs your eyes is the **Jotform question labels** — the export maps
each column from a form question label, and this repo can't see your live form.
Everything is centralised in `FIELD_MAP` at the top of
`netlify/functions/lib/group-info.js`; each line to check is marked `// VERIFY`.

Fast way to get the exact strings: call the endpoint once (as a logged-in
leader) and look at `availableLabels` in the JSON response — it lists every
question label seen on that program's submissions. Copy the correct strings into
`FIELD_MAP`.

Specifically confirm:

- **Motivations** — the four question strings match your application form.
- **Travel** — `Gender`, `Date of Birth`, and `Dietary Req.` labels (Passport
  Number / Country of Issue / Expiry Date are already confirmed against the
  trip-leader whitelist in `index.html`).
- **Emergency contacts** — the biggest unknown. Set the two contacts' Name /
  Phone / Relationship labels to your form's actual questions. If your form has
  no emergency-contact questions, the export falls back to each student's HubSpot
  **Parent** contacts (name + phone; role blank), which is why parents show up in
  the sample.
- **Medical** — there is no single "condition" field, so Condition is derived
  from yes/no questions (`yesNoTopics`) and Description from free-text fields
  (`detailFields`). Tune those lists to taste. **Status** comes from the
  `ue_student_status` contact property (Cleared / Discovery / …).
- **Age on Departure** — computed only if the Portal record has a departure-date
  property. Set the real property name in `DEPARTURE_DATE_PROPS` in
  `get-group-info.js`; otherwise the column is left blank (as in the workbook).

## Options / tweaks

- **Four separate PDFs instead of one packet:** the assembled JSON already has
  `motivations`, `emergency`, `medical`, `travel` as separate objects — split the
  `content` array in `buildGroupPdfDocDefinition` (group-pdf.js) into four docs,
  or add a `?page=` switch. Say the word and I'll wire up per-sheet buttons.
- **Also expose to admins** in `/admin.html`: the endpoint already accepts any
  `portalId` for admins — just add the same button there.
- **XLSX instead of/as well as PDF:** the same endpoint JSON can feed a
  SheetJS export if you ever want the editable version back.
