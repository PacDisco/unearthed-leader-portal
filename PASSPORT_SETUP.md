# Passport name checking — setup

The portal reads the name, passport number, date of birth and expiry date off
each person's uploaded passport photo, compares them to what's on record, and
flags the ones that disagree. **It never changes
a name on its own** — a leader applies the passport name with one click, and
ops can mark a passport as checked by hand.

Nothing below breaks the portal if it's missing. Without the environment
variable the read reports that it isn't configured; without the contact
properties the read still works but can't be cached, and the ops tick can't be
saved. Both say so plainly rather than failing silently.

## 1. Environment variable (Netlify)

| Variable | Required | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes | Reads the passport image. From console.anthropic.com. |
| `PASSPORT_OCR_MODEL` | no | Defaults to `claude-sonnet-4-5`. |
| `ANTHROPIC_API_BASE` | no | Defaults to `https://api.anthropic.com`. |

Each passport is read **once** and the result cached against a hash of the
photo, so cost is per passport, not per viewing. Uploading a new photo triggers
a re-read; the RE-READ button forces one.

## 2. HubSpot contact properties

Create these on the **Contact** object (Settings → Properties → Contact
properties → Create property). Internal names must match exactly.

| Internal name | Field type | Set by |
|---|---|---|
| `passport_ocr_name` | Single-line text | the read |
| `passport_ocr_first` | Single-line text | the read |
| `passport_ocr_last` | Single-line text | the read |
| `passport_ocr_status` | Single-line text | the read — `ok` / `no_photo` / `unreadable` / `error` |
| `passport_ocr_number_match` | Single-line text | the read — `match` / `mismatch` / `confusable` / `unknown` |
| `passport_ocr_dob_match` | Single-line text | the read — `match` / `mismatch` / `ambiguous` / `unknown` |
| `passport_ocr_expiry_match` | Single-line text | the read — as above |
| `passport_ocr_hash` | Single-line text | the read — which photo it read |
| `passport_ocr_read_at` | Single-line text | the read — ISO timestamp |
| `passport_checked` | Single checkbox | ops |
| `passport_checked_by` | Single-line text | ops — who ticked it |
| `passport_checked_at` | Single-line text | ops — ISO timestamp |
| `passport_upload` | File (or single-line text) | a leader's UPLOAD PASSPORT — the HubSpot file id |

The HubSpot private app also needs the **`files`** scope for UPLOAD PASSPORT
(Settings → Integrations → Private apps → the portal's app → Scopes).

Text rather than date/datetime for the timestamps on purpose: HubSpot date
properties reject anything that isn't midnight UTC, which loses the time of day
and makes an ordinary ISO write fail.

### What is deliberately NOT stored

Only the **name** is kept. The date of birth and the MRZ line are used during
the read and dropped.

The passport **number**, **date of birth** and **expiry date** are compared —
any of the three fails a booking just as surely as a wrong name — but only the
*verdicts* are cached, never the values. What was read off the image is
returned to the leader who triggered that read and then forgotten. So a leader
looking at a cached problem sees "differs — re-read to see it", and RE-READ
shows both values again. One extra API call on the rare mismatch is the price
of keeping passport numbers and dates of birth out of the CRM.

## 3. What each person sees

**Expedition leader** — a badge on each roster card: *name doesn't match
passport* (with the passport spelling), *passport number doesn't match*, *name
and passport number don't match*, *passport number needs a look*, *no passport
photo*, *needs a manual check*, or *passport checked*. Opening a card shows the
names and the numbers side by side, with:

Opening a card shows a four-row comparison — name, passport number, date of
birth, expiry — with what's on record beside what the document says, a tick on
the rows that agree, and a **USE THIS** button on the rows that don't.

All four rows are always shown, even when neither side has a value — a row
that quietly disappeared would leave you unable to tell "checked and fine"
from "never checked". An empty cell says which side is missing: *not on the
form* / *not on the passport*.

A row whose record side is **empty** but which the passport can fill offers
USE THIS, and reads *missing*. Filling a gap matters as much as fixing a mistake — a missing
passport number or date of birth stops a booking outright — and an empty field
is never a "mismatch", so it would otherwise never offer the button. Applying
writes to the right place automatically: the name goes to both the HubSpot
contact and the form's name question; the number and the dates go to the form.
When more than one row can be applied there is also a **USE ALL n FROM
PASSPORT** button, which sends them as a single write — one save, one audit
note — rather than repeating the round trip per field.
Dates are written day / month / year rather than as one string, so the stored
shape survives. Each apply re-reads afterwards so the cached verdicts catch up: the
cache is keyed on the photo, so without a forced re-read the panel would
redraw the verdicts that were just corrected. Apply is only offered on a fresh read, since the values aren't stored.

**Ops / admin** — everything above, plus the **Passport details checked
manually** tick. Ticking it records who and when, and settles the mismatch flag
for everyone else: a person in the office has looked at the document, which
outranks anything the automatic read concluded. Leaders see the tick and who
set it but can't set it themselves — enforced server-side, not just hidden in
the UI.

### Which form questions are read

Matched by label, and for the date of birth by field type as well:

| Check | Labels matched | Types matched |
|---|---|---|
| Passport number | contains "passport" and "number" / "no" / "#" | — |
| Date of birth | "date of birth", "DOB", "birth date", "birthday", "born" | `control_birthdate` |
| Expiry | "expiry", "expiration", "expires", "valid until" | — |

The type fallback matters: Jotform's dedicated **Birth Date** field is
`control_birthdate`, a different type string from `control_datetime`. Any form
built with it — whatever the school labelled the question — is matched on type
even if the label isn't recognised.

If a check shows *not on the form*, the question exists under wording none of
the above catch. Add the pattern to `DOB_LABELS` / `EXPIRY_LABELS` in
`read-passport.js`.

## 3b. Verbatim, not interpreted

*(This section is about how the passport is read. For the verbatim rule on
the name **on record**, see section 4.)*

What the read returns is a **transcription**. The prompt asks for the printed
fields — which carry accents, full spellings and the holder's own
capitalisation — and uses the machine-readable zone only when the print is
illegible, because the MRZ is a transliteration (accents stripped, long names
truncated). The source used is reported per read.

Nothing is tidied on the way through. Only two transformations are applied,
both provably not part of the value: MRZ `<` padding is decoded back to
spaces, and runs of whitespace are collapsed. `ST. JOHN-MÜLLER` stays
`ST. JOHN-MÜLLER`; a passport number keeps its own case and punctuation.
(Comparison is separately case- and separator-insensitive, so none of this
affects whether something matches.)

**Given names are never split.** A passport has two name fields, Surname and
Given names, and says nothing about which given name is a "first" and which is
a "middle". So applying a name maps the passport's two fields onto the
record's two: every given name goes into the first-name field as printed, the
surname into the last-name field, and the form's middle-name subfield is
cleared rather than guessed at. A ticket carries the given names as printed,
which is the point of the exercise.

A field that can't be read confidently comes back empty, and a date that
isn't returned in the exact requested form is dropped rather than coerced. A
blank is always better than a guess here: everything on this panel is copied
onto a booking, and a plausible-looking wrong value is worse than a missing
one because nobody checks it again.

## 4. How names are compared

Comparison follows ICAO 9303, the rules a passport's machine-readable zone is
written with, so a name typed normally compares equal to the same name off an
MRZ:

- accents stripped — `Zoë` = `ZOE`
- apostrophes removed — `O'Brien` = `OBRIEN`
- hyphens become a space — `Smith-Jones` = `SMITH<JONES`

Names are compared as a **set of name parts**, using the PASSPORT's split as
authoritative — because the CRM's split isn't. Comparing field against field
failed in both directions on real records:

- "Samuel James Cottle" was flagged as *differing* from a passport reading
  COTTLE, SAMUEL JAMES, because the contact happened to be stored as
  firstname "Samuel", lastname "James Cottle".
- "Luisa Charlotte Jutz" was reported as *matching* a passport reading
  LUISA CHARLOTTE KUNZ, because only the first given name and the surname
  were compared and the wrong third name fell in the gap. A green tick on a
  name that would fail at check-in is the worst outcome this can produce.

The rule now:

- every part of the passport **surname** must appear on the record —
  "Reynolds" against a passport reading REYNOLDS-CRUZ is a mismatch, because
  a ticket has to carry the whole family name
- everything else on the record must be a **given name on the passport** —
  an extra part that isn't is the Jutz/Kunz case

That set-of-parts test now only decides the *wording*. **The verdict is
verbatim** (October 2026): the record's first-name field must hold every given
name on the passport, and the last-name field the whole surname. So a missing
middle name, or "Samuel" / "James Cottle" against SAMUEL JAMES / COTTLE, is
flagged — as *not exactly as on the passport* rather than as a different name
— and the panel offers USE THIS (and USE ALL) to write the passport version.
Case and accents are still ignored: the MRZ is upper case with accents
stripped, so it can't tell `Zoë` from `ZOE`.

An unread passport is never shown as a mismatch, only as unchecked.

### Dates

Compared after parsing both sides. The trap is a numeric date like
`03/04/2008`, which is 3 April or 4 March depending on who typed it. Rather
than guess — and risk clearing a wrong record or flagging a right one — both
readings are kept:

- **match** — the day-first reading agrees with the passport
- **ambiguous** — only the month-first reading agrees; somebody should confirm
  which was meant
- **mismatch** — neither reading agrees

A date written unambiguously (`2008-03-15`, `15/03/2008`, `15 Mar 2008`) has
only one reading and compares directly. Anything unparseable is `unknown`, not
a mismatch.

Dates are **displayed** as `15 March 2008` — a spelled-out month cannot be
read the wrong way round, which is the whole problem with dates on passports.
A value that could be read two ways is shown *both* ways
(`3 April 2030 or 4 March 2030`) rather than silently picking one: printing a
single reading for an ambiguous entry would hide the exact mistake this screen
exists to surface. Storage and comparison stay ISO; this is display only, and
it applies to the dates in the medical detail below the panel as well.

Note the small duplication: `formatDateDisplay()` in `public/index.html`
mirrors `parseDateCandidates()` in `_shared/passport.js`, because the page is
a classic script with no build step and can't import the server module. The
copy only decides how a value is *printed* — all comparison stays server-side,
so a drift between them cannot produce a wrong verdict.

The read is asked for dates as `YYYY-MM-DD` and takes the century from the
printed page's four-digit year, rather than guessing it from the MRZ's
two-digit one. A date that doesn't come back in exactly that form is discarded
rather than interpreted.

### Numbers

Compared after stripping case, spaces and hyphens. Three outcomes rather than
two:

- **match** — identical
- **mismatch** — genuinely different; the record needs fixing
- **confusable** — differ only by characters OCR routinely swaps on a passport
  font (`0`/`O`, `1`/`I`, `5`/`S`, `8`/`B`). Shown as *needs a look* rather
  than *wrong*, because calling an OCR ambiguity a mismatch trains people to
  dismiss the flag, and calling it a match would hide a real error.

A number missing from either side is `unknown`, never a mismatch.

### How the read works

**The machine-readable zone, or nothing.** The model's entire job is to copy
the two lines of monospaced characters across the bottom of the data page. It
is not asked to find the date of birth, decide which date is the expiry, or
read the printed fields at all. Everything else happens in code
(`_shared/mrz.js`):

1. The two lines are parsed and their **check digits verified**. They cover
   the passport number, the date of birth and the expiry, so a sloppy
   transcription is detected rather than believed — one wrong character fails
   a check digit about nine times in ten.
2. If they verify, the name, number and both dates all come from the MRZ.
3. If they don't, **nothing is shown** — no name, no number, no dates — only
   an instruction to upload a photo with both lines in frame.

The whole record is accepted or refused together. The name line carries no
check digit of its own, but a transcription clean enough to pass every check
digit in line 2 is strong evidence that line 1 was read with the same care.

This replaced asking the model for the fields directly, which failed badly on
real scans: a surname came back as KUNZ, then JUNE, then JULZ when the
document said JUTZ, and a date of birth came back as the *expiry's* day and
month with the birth year. Every one was confident and wrong. It also
replaced a set of printed-page fallbacks, which could only ever produce
answers nothing had verified.

**Names come out as the MRZ writes them**: upper case, accents stripped
(`MÜLLER` → `MULLER`), and truncated past 39 characters. That is the form an
airline matches against, so it is the right form for a booking — but it does
mean applying a name writes the upper-case version to HubSpot.

**A failed read is retried once**, told which characters are commonly
confused. Transcription slips are stochastic, so a second attempt often lands
clean, and the check digits still gate acceptance.

### Reading a rotated or bilingual scan

The read is told the scan may be sideways or upside down, may be one page of
several, and may show two pages at once — it has to find those two lines
whatever the orientation. It is explicitly told not to reconstruct a missing
line from the printed fields: a missing line is a fact worth reporting, and an
invented one is worse than useless.

### What to ask people to upload

Everything depends on the machine-readable zone being in the photo, so the
upload instruction matters more than anything in this code:

> A straight-on photo of the page with your photo on it, including the two
> lines of letters and chevrons at the very bottom — all of it in frame, not
> at an angle.

A photo cropped above those lines yields nothing at all, by design.

### When the cache is not used### When the cache is not used

A cached result is only served when it holds **every** verdict currently
reported. A record read before the date checks shipped has no dob or expiry
verdict, so it is re-read rather than served with those two checks blank
forever. Uploading a new photo, or pressing RE-READ, also forces a fresh read.

### A verdict needs something behind it

On a fresh read with no value for a field, nothing was compared, so any
verdict carried over from an earlier read is stale and is shown as *not
found on the passport* rather than as a verdict. Without that guard the panel
displayed green ticks and "matches" on the number, date of birth and expiry
while simultaneously reporting that nothing had been verified.

### What a cached view can and cannot say

A cached response carries verdicts, not values — the values were never stored.
So the "on passport" column shows the verdict ("differs — re-read to see it"),
and RE-READ reveals the actual value.

A verdict of `unknown` means nothing was *compared*, which happens either
because the form has no value or because the field wasn't read. From a cached
view the two are indistinguishable, so the cell says **"not compared — re-read
to check"**. It previously said "not on the passport", which was a claim the
data didn't support.

## 4b. Uploading a passport from the portal

When there's no passport to check, or the one on file can't be read, the
panel shows **UPLOAD PASSPORT** (or *UPLOAD A NEW PASSPORT PHOTO*). Only people
who can edit the roster see the panel — admins and expedition leaders — and
`upload-passport.js` checks that again server-side.

The file (JPEG, PNG, WebP, GIF or PDF, up to 4MB; large phone photos are
shrunk in the browser first) is:

1. saved **privately** in HubSpot Files, folder `/portal-passports`,
2. recorded on the contact's `passport_upload` property, and
3. attached to the contact as a note, so it shows under the contact's
   Attachments in HubSpot.

The passport check then reads it straight away. A portal-uploaded passport
**wins over the application form's**, since it's newer and usually uploaded
because the form's was missing or unreadable. It isn't written back into the
Jotform submission, so the Document Uploads list and the group export still
show only what came through the form.

The type is checked from the file's contents, not its name — an iPhone HEIC
renamed to `.jpg` is refused with a message saying to export it as JPEG.

## 5. File types

Passport uploads are read as **JPEG, PNG, GIF, WebP or PDF**. PDFs matter:
TapScanner, Adobe Scan and iOS Files all export PDFs by default, so a large
share of real uploads are scans rather than photos. A multi-page scan is fine —
the read is told to use the page showing the passport data and ignore the rest,
though every page counts toward the API cost.

Anything else — an iPhone HEIC, a Word document — is reported as
**PASSPORT FILE CAN'T BE READ — RE-UPLOAD NEEDED**, with a message naming the
format and what to ask for instead. That verdict is cached (it's a settled
fact about that upload); a failed *download* is not cached, since it's
transient.

Size limits: 5MB for an image, 10MB for a PDF. Over that, the card says so
rather than failing quietly.

## 6. Accuracy

The read is asked for the MRZ when it's legible and the printed page otherwise,
and is instructed to report an uncertain read as unreadable rather than guess.
It's still OCR on a phone photo of a curved page: treat the flag as "someone
should look at this", which is what the ops tick is for.

Applying a name is logged in that person's HubSpot audit note like any other
leader edit — who applied it, when, and what changed.

## Passport photo widget (October 2026)

The application form (251396787451873) now collects the passport through the
**"Passport bio page upload"** custom widget — field `passportPhoto`, qid 133,
labelled "Passport photo page". It checks the photo is a passport bio page
before the form can be submitted, saves it to the *Jotform uploads* folder in
the Passports Shared Drive, and stores the Drive link as the answer. The old
**"Passport Cover Page Photo"** upload (qid 89) is hidden but still holds the
files for every earlier submission.

How the portal handles it (`netlify/functions/_shared/passport-widget.js`):

- Every submission fetch normalises a widget answer holding a Drive link into a
  one-file `control_fileupload`, so the passport check, the documents list, the
  leader view and the group export all read it without special cases.
- The passport check prefers the widget's photo when both fields are answered,
  and falls back to the old upload for older submissions.
- Drive files are private, so they're downloaded through the passport-check
  Worker's `/file/<id>` endpoint — by `read-passport` for the check, and by the
  `/document-proxy` edge function for VIEW links. The Worker only serves files
  in the uploads folder, and only with the shared key.

Setup — the same random value in both places:

| Where | Name | Value |
|---|---|---|
| Cloudflare Worker (`npx wrangler secret put PORTAL_FILE_KEY`) | `PORTAL_FILE_KEY` | a long random string |
| Netlify env | `PASSPORT_FILES_KEY` | the same string |
| Netlify env | `PASSPORT_FILES_URL` | `https://passport-check.unearthededucation.workers.dev` |

Without these, widget passports show as "needs a manual check" and their VIEW
links return a configuration error; Jotform-hosted passports are unaffected.
