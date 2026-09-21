# Group Information export (Expedition Leader tab)

Adds **"DOWNLOAD GROUP INFORMATION (PDF)"** and **"DOWNLOAD AS CSV (ZIP)"**
buttons to the Expedition Leader Resources tab. Both generate, on demand and per
program, the four group sheets — **Motivations, Emergency Contacts, Medical
Details, and Passenger/Travel Details** — grouped by Expedition Leader → School
Leaders → Students, pulled live from the same HubSpot + Jotform data the portal
already uses. The PDF is one printable landscape document; the CSV option is a
`.zip` holding one spreadsheet-ready CSV per sheet.

## Files

| File | Change | What it does |
|---|---|---|
| `netlify/functions/get-group-info.js` | **new** | Endpoint. Auth + authorization (staff on this trip / admin), pulls the roster and scans Jotform **once**, returns the four tables as JSON. |
| `netlify/functions/lib/group-info.js` | **new** | Pure assembly + the **field-mapping config** (`FIELD_MAP`). No network. Unit-testable. |
| `public/group-pdf.js` | **new** | Client PDF builder. Lazy-loads pdfmake from jsDelivr (already allowed by CSP), fetches the endpoint, renders + downloads the PDF. |
| `public/group-csv.js` | **new** | Client CSV builder. Turns the same JSON into four CSVs and zips them — no dependencies, nothing new loaded from a CDN. |
| `public/index.html` | edited | Loads both modules; renders the download card in `trip_leader_information_content` and wires the two clicks. |
| `test/group-export.test.mjs` | **new** | Unit tests for middle-name resolution, the PDF column layout, CSV escaping and the ZIP structure. Wired into `npm test`. |

No new server dependencies (pdfmake is loaded client-side from the CDN already
whitelisted in `netlify.toml`; the zip writer is ~60 lines of plain JS). The new
function is picked up automatically by your existing Netlify functions setup.

## How it works

1. Instructor opens **Expedition Leader Resources** and clicks either button.
2. `group-pdf.js` / `group-csv.js` calls
   `GET /.netlify/functions/get-group-info?portalId=<current trip>` with the
   signed session token (via the portal's existing `apiFetch`).
3. The function verifies the caller is a Teacher/Trip Leader on that trip (or an
   admin) — the same guard as `get-students.js` — then assembles the four tables.
4. The browser either renders the PDF with pdfmake and downloads
   `Expedition-Leader-Info-<program>.pdf`, or builds
   `Expedition-Leader-Info-<program>-CSV.zip` containing
   `1-motivations.csv`, `2-emergency-contacts.csv`, `3-medical-details.csv` and
   `4-travel-passenger-details.csv`.

Only staff/admins can reach the endpoint, and the buttons only render inside the
already leader-gated `trip_leader_information_content` section.

## Middle names (passenger sheet)

The Passenger Details sheet has a **Middle Name(s)** column between First and
Last, because airline tickets are issued against the full passport name.
It is resolved in this order, first hit wins:

1. The `middle` sub-field of the Jotform passport-name question — on the UE
   application form that is **"Name (as noted in your passport)"**. This is the
   authoritative source: it is what the traveller entered from the document
   itself. Other candidate labels are listed in `FIELD_MAP.travel.passportName`.
2. A standalone "Middle Name" question, if a form has one
   (`FIELD_MAP.travel.middleName` — marked `// VERIFY`).
3. The HubSpot contact fallback — `first_middle_names` ("First & Middle Names")
   or `name_on_passport_last_first_name_middle_name`, with the first name (and
   any repeated surname) stripped off. See `MIDDLE_NAME_PROPS` and
   `middleNameFromProps()` in `get-group-info.js`.

If none of the three has anything, the column is simply blank — which is also
the signal that the student's passport name hasn't been captured yet.

Note that `extractFields()` in `get-group-info.js` now keeps the `first` /
`middle` / `last` sub-fields of full-name answers on each field as `parts`;
previously they were flattened into one string, which lost the middle name.

## CSV specifics

The CSVs are deliberately not a character-for-character copy of the PDF — the
differences all favour the spreadsheet:

- The role grouping (Expedition Leader / School Leaders / Students) becomes a
  plain **Role** column, so rows sort and filter.
- Dates stay **ISO (YYYY-MM-DD)** rather than "02 Dec 1972", so Excel and Sheets
  parse them as dates.
- The emergency sheet carries the **contact relationship** columns, which the
  landscape PDF has no room for.
- Medical answers are one `question: answer` per line inside a single cell, so
  there is still one row per person.
- Each file starts with a UTF-8 BOM so Excel on Windows renders macrons and
  accents correctly, and answers beginning `=` or `@` are prefixed with an
  apostrophe so a spreadsheet can't execute them as formulas. Leading `+`/`-`
  on numeric-looking values (phone numbers) is left alone.

The archive is written store-only (uncompressed), which every OS archiver and
spreadsheet app opens natively.

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
  trip-leader whitelist in `index.html`). Note the UE application form has **no
  Gender question** at the time of writing, so that column will be blank until
  one is added or `FIELD_MAP.travel.gender` is pointed at another field.
- **Middle names** — `Name (as noted in your passport)` is confirmed on the UE
  application form. If another form in `JOTFORM_APPLICATION_FORM_ID` words it
  differently, add that label to `FIELD_MAP.travel.passportName`. The HubSpot
  fallback properties (`MIDDLE_NAME_PROPS`) are worth a sanity check against a
  couple of real contacts.
- **Emergency contacts** — these are filled from each student's HubSpot
  **Parent** contacts (Contact Name + Contact Phone), which is the authoritative
  source. The **role** (Mother/Father/Guardian) comes from the parent's HubSpot
  association label if it names the relationship, else a relationship property on
  the parent contact (`RELATIONSHIP_PROPS` in `get-group-info.js`), else the
  Jotform relationship field. If your parent associations use non-standard labels
  or a different relationship property, adjust `PARENT_LABELS` /
  `RELATIONSHIP_PROPS` in `get-group-info.js`. (Leaders' own emergency contacts
  only appear if they have Parent associations or Jotform emergency fields.)
- **Medical** — the actual medical/health questions & answers are pulled
  straight from each application and listed on the page (question in **bold**,
  their response after it). Which questions are considered is the
  `medical.questions` list in `FIELD_MAP`; by default only questions answered
  with something other than a plain No/None are shown — set
  `medical.includeNegatives = true` for the full checklist including "No"s.
  **Status** comes from the `ue_student_status` contact property (Cleared /
  Discovery / …).
- **Dietary (page 4)** — pulls the applicant's real dietary free-text answer and
  appends any food allergies (`travel.dietary` + `travel.foodAllergies` in
  `FIELD_MAP`). The airline-code legend stays on the page for reference.
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
- **XLSX instead of CSV:** the CSV path already proves the shape; swapping in a
  SheetJS export would give one multi-tab workbook with formatting, at the cost
  of a CDN dependency the CSV route avoids.
