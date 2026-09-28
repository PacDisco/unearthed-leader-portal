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
the rows that agree, and a **USE THIS** button on the rows that don't. Applying
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

## 5. Accuracy

The read is asked for the MRZ when it's legible and the printed page otherwise,
and is instructed to report an uncertain read as unreadable rather than guess.
It's still OCR on a phone photo of a curved page: treat the flag as "someone
should look at this", which is what the ops tick is for.

Applying a name is logged in that person's HubSpot audit note like any other
leader edit — who applied it, when, and what changed.
