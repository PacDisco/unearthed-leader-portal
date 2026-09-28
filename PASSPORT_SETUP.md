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

A middle name on the passport that the contact record doesn't have is **not** a
mismatch — the contact only holds first and last. A shortened first name
(`Jon` vs `Jonathan`) **is** a mismatch, because that's the case that fails at
check-in.

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

### How the read actually works

The model is asked to **transcribe**, not to interpret. Its job is to copy the
two lines of the machine-readable zone character by character, plus the
printed surname, given names and number as a cross-check. Everything else is
decided in code (`_shared/mrz.js`):

1. The MRZ is parsed and its **check digits verified**. They cover the
   passport number, the date of birth and the expiry, so a sloppy
   transcription is detected rather than believed — one wrong character fails
   a check digit about nine times in ten.
2. When the MRZ verifies, it supplies the number and both dates. The name
   comes from the printed page (which keeps accents and capitalisation the
   MRZ strips) **but only if it agrees with the MRZ name**. Accent
   differences and MRZ truncation are expected; different letters mean one
   reading was wrong, and then nothing is offered at all.
3. When the MRZ can't be read or fails its check digits, a **name** is still
   offered from the printed page — a leader can judge a name against the
   photo — but the number and dates are left blank and the panel says why.
   Those are the values that were being misread, nothing can verify them, and
   a wrong one is invisible once applied.

This replaced asking the model directly for "the date of birth", which failed
badly on a real rotated scan: a surname came back as KUNZ and then JUNE when
the document said JUTZ, and a date of birth came back as the *expiry's* day
and month with the birth year. Both were confident and wrong. The check
digits make that class of error visible.

What the check digits do NOT cover: the nationality (unused) and the name
line, which has none — hence the printed cross-check.

### Reading a rotated or bilingual scan

The read is told the scan may be sideways or upside down, may be one page of
several, and may show two pages at once. It is also told that passports are
often bilingual — a New Zealand passport labels every field twice
("Rā mutunga / Date of expiry") — and to identify fields by the English label,
taking care not to read **Date of issue** as the expiry.

Names come from the printed fields and are then checked against the
machine-readable zone. Accent differences (MÜLLER vs MULLER) and MRZ
truncation are expected and ignored, but if the letters genuinely disagree the
read reports itself unreadable rather than picking one — a misread surname is
the single most expensive thing this can get wrong.

Dates and the passport number come from the MRZ, where the positions are
fixed, with the century confirmed against the printed four-digit year. The
printed fields are the fallback when the MRZ is illegible.

### When the cache is not used

A cached result is only served when it holds **every** verdict currently
reported. A record read before the date checks shipped has no dob or expiry
verdict, so it is re-read rather than served with those two checks blank
forever. Uploading a new photo, or pressing RE-READ, also forces a fresh read.

### What a cached view can and cannot say

A cached response carries verdicts, not values — the values were never stored.
So the "on passport" column shows the verdict ("differs — re-read to see it"),
and RE-READ reveals the actual value.

A verdict of `unknown` means nothing was *compared*, which happens either
because the form has no value or because the field wasn't read. From a cached
view the two are indistinguishable, so the cell says **"not compared — re-read
to check"**. It previously said "not on the passport", which was a claim the
data didn't support.

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
