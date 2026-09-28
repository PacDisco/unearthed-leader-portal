// Passport-name verification: shared rules for reading a passport photo,
// comparing what it says against the name on record, and recording that an
// ops person has checked it by hand.
//
// WHY: the name on an airline ticket has to match the passport. Names reach
// the portal from an enquiry form, so they arrive with nicknames, missing
// middle names and married-vs-maiden surnames, and the mismatch is only
// discovered at check-in. Reading the passport gives us something to compare
// against.
//
// WHAT WE DELIBERATELY DON'T STORE: only the NAME from the passport is kept on
// the contact. The passport number, date of birth and the MRZ line itself are
// used for the read and then dropped — the number already lives on the
// application form, and copying it into the CRM widens where it sits for no
// benefit.
//
// The number IS compared — a transposed passport number fails a booking just
// as surely as a wrong name — but only the VERDICT is cached. The number read
// off the image is returned to the leader who triggered the read and then
// forgotten, so a leader looking at a cached mismatch uses RE-READ to see the
// actual number again. One extra API call on the rare mismatch is a fair
// price for keeping passport numbers out of the CRM.

// ---------------------------------------------------------------------------
// HubSpot contact properties this feature needs.
//
// These must exist on the Contact object before any of it does anything —
// see PASSPORT_SETUP.md. Every write is best-effort: if a property is missing,
// HubSpot rejects the patch, we log it and carry on rather than failing the
// leader's save.
// ---------------------------------------------------------------------------
export const PASSPORT_PROPS = {
  // Filled by the automatic read.
  ocrName:    "passport_ocr_name",      // single-line text — "SMITH, John Michael"
  ocrFirst:   "passport_ocr_first",     // single-line text
  ocrLast:    "passport_ocr_last",      // single-line text
  ocrStatus:  "passport_ocr_status",    // single-line text — one of PASSPORT_STATUS
  // VERDICT ONLY — "match" / "mismatch" / "confusable" / "unknown". The
  // passport number itself is deliberately never stored here; see below.
  ocrNumber:  "passport_ocr_number_match",
  ocrDob:     "passport_ocr_dob_match",
  ocrExpiry:  "passport_ocr_expiry_match",
  ocrHash:    "passport_ocr_hash",      // single-line text — which photo was read
  ocrReadAt:  "passport_ocr_read_at",   // single-line text — ISO timestamp
  // Filled by the ops checkbox.
  verified:   "passport_checked",       // single checkbox (bool)
  verifiedBy: "passport_checked_by",    // single-line text — email
  verifiedAt: "passport_checked_at",    // single-line text — ISO timestamp
};

export const ALL_PASSPORT_PROPS = Object.values(PASSPORT_PROPS);

export const PASSPORT_STATUS = {
  OK: "ok",                 // read, name extracted
  NO_PHOTO: "no_photo",     // nothing uploaded to read
  UNREADABLE: "unreadable", // a photo exists but no name could be taken from it
  ERROR: "error",           // the read itself failed (API down, fetch failed)
};

// ---------------------------------------------------------------------------
// Name comparison
// ---------------------------------------------------------------------------

// Normalise for comparison only — never for storage.
//
// Follows how ICAO 9303 transliterates a name into the machine-readable zone,
// so a name typed normally compares equal to the same name off an MRZ:
//   - accents are stripped        (Zoë → ZOE)
//   - apostrophes are REMOVED     (O'Brien → OBRIEN, which is what the MRZ has)
//   - hyphens become a space      (Smith-Jones → SMITH JONES, MRZ SMITH<JONES)
// Getting the apostrophe rule wrong is not cosmetic: it would report every
// O'Brien and D'Souza on the roster as a mismatch.
export function normaliseName(s) {
  return String(s == null ? "" : s)
    .normalize("NFD").replace(/[̀-ͯ]/g, "")  // strip accents
    .toUpperCase()
    .replace(/['’`]/g, "")                             // apostrophes vanish
    .replace(/[^A-Z]+/g, " ")                          // everything else separates
    .replace(/\s+/g, " ")
    .trim();
}

// Do the name on record and the name on the passport agree?
//
// Middle names are compared leniently: a passport carrying a middle name the
// contact record doesn't have is NOT a mismatch, because the contact record
// only holds first + last. What matters is that the first and last names
// agree. A passport first name that merely *contains* the recorded one is
// still a mismatch ("Jon" vs "Jonathan" is exactly the case that breaks a
// booking), so this is a strict comparison on those two parts.
export function compareNames({ recordedFirst, recordedLast, passportFirst, passportLast }) {
  const rf = normaliseName(recordedFirst);
  const rl = normaliseName(recordedLast);
  const pf = normaliseName(passportFirst);
  const pl = normaliseName(passportLast);

  if (!pf && !pl) return { comparable: false, matches: null, reason: "no passport name" };
  if (!rf && !rl) return { comparable: false, matches: null, reason: "no name on record" };

  // The passport's given-name field can carry several names ("John Michael").
  // The recorded first name matching the FIRST of them is agreement.
  const passportGiven = pf.split(" ").filter(Boolean);
  const recordedGiven = rf.split(" ").filter(Boolean);

  const firstMatches = passportGiven.length > 0 && recordedGiven.length > 0
    && passportGiven[0] === recordedGiven[0];
  const lastMatches = pl === rl;

  return {
    comparable: true,
    matches: firstMatches && lastMatches,
    firstMatches,
    lastMatches,
  };
}

// ---------------------------------------------------------------------------
// Passport number comparison
// ---------------------------------------------------------------------------

// Characters OCR routinely swaps on a passport's font. Folded ONLY as a second
// pass, to tell "someone typed the wrong number" apart from "the read is
// probably fine but ambiguous" — never to declare a match.
const CONFUSABLE = { O: "0", Q: "0", D: "0", I: "1", L: "1", S: "5", B: "8", Z: "2", G: "6", A: "4" };

export function normaliseDocNumber(s) {
  return String(s == null ? "" : s).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function foldConfusable(s) {
  return normaliseDocNumber(s).split("").map(c => CONFUSABLE[c] || c).join("");
}

// Compare the passport number typed on the application form against the one
// read off the image.
//
// Three outcomes rather than two, because a straight mismatch and an
// OCR-ambiguity are different problems: the first needs the record fixed, the
// second needs a human to look. Reporting the second as a mismatch would
// train leaders to dismiss the flag.
export function compareDocumentNumbers(formNumber, passportNumber) {
  const a = normaliseDocNumber(formNumber);
  const b = normaliseDocNumber(passportNumber);

  if (!a || !b) return { comparable: false, verdict: NUMBER_VERDICT.UNKNOWN };
  if (a === b) return { comparable: true, verdict: NUMBER_VERDICT.MATCH };
  if (foldConfusable(a) === foldConfusable(b)) {
    return { comparable: true, verdict: NUMBER_VERDICT.CONFUSABLE };
  }
  return { comparable: true, verdict: NUMBER_VERDICT.MISMATCH };
}

export const NUMBER_VERDICT = {
  MATCH: "match",
  MISMATCH: "mismatch",
  CONFUSABLE: "confusable",  // differ only by characters OCR commonly swaps
  UNKNOWN: "unknown",        // one side missing — never treated as a problem
};

export const DATE_VERDICT = {
  MATCH: "match",
  MISMATCH: "mismatch",
  // The form's date is written ambiguously (e.g. 03/04/2008) and only matches
  // the passport under the day-second reading. Not wrong, but somebody should
  // confirm which way round it was meant.
  AMBIGUOUS: "ambiguous",
  UNKNOWN: "unknown",
};

// Verdicts that mean "a person should look at this".
export function verdictNeedsAttention(v) {
  return v === "mismatch" || v === "confusable" || v === "ambiguous";
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const MONTHS = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};

function iso(y, m, d) {
  if (!y || !m || !d) return null;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

// Every date the given text could plausibly mean, most likely first.
//
// The hard case is a numeric date like 03/04/2008: day-first and month-first
// are both defensible and we cannot tell from the string alone. Rather than
// pick one and risk reporting a correct record as wrong (or worse, a wrong one
// as right), both readings are returned and the comparison reports AMBIGUOUS
// when only the second one matches. Day-first leads because that is how the
// form's own audience writes dates.
export function parseDateCandidates(value) {
  const raw = String(value == null ? "" : value).trim();
  if (!raw) return [];

  // Jotform's own datetime answers arrive as YYYY-MM-DD — unambiguous.
  let m = raw.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (m) {
    const v = iso(+m[1], +m[2], +m[3]);
    return v ? [v] : [];
  }

  // "15 Mar 2008" / "15 March 2008" / "Mar 15 2008"
  m = raw.match(/^(\d{1,2})[\s-]*([A-Za-z]{3,})[\s-]*(\d{4})$/);
  if (m) {
    const mo = MONTHS[m[2].slice(0, 3).toUpperCase()];
    const v = iso(+m[3], mo, +m[1]);
    return v ? [v] : [];
  }
  m = raw.match(/^([A-Za-z]{3,})[\s-]*(\d{1,2}),?[\s-]*(\d{4})$/);
  if (m) {
    const mo = MONTHS[m[1].slice(0, 3).toUpperCase()];
    const v = iso(+m[3], mo, +m[2]);
    return v ? [v] : [];
  }

  // Numeric with a 4-digit year last: the ambiguous family.
  m = raw.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (m) {
    const a = +m[1], b = +m[2], y = +m[3];
    const dayFirst = iso(y, b, a);
    const monthFirst = iso(y, a, b);
    if (a > 12 && dayFirst) return [dayFirst];          // only day-first is possible
    if (b > 12 && monthFirst) return [monthFirst];      // only month-first is possible
    const out = [];
    if (dayFirst) out.push(dayFirst);
    if (monthFirst && monthFirst !== dayFirst) out.push(monthFirst);
    return out;
  }

  return [];
}

// Compare a date on the form against the date read off the passport.
// `passportDate` is expected as YYYY-MM-DD — the read asks for it that way, so
// the century is resolved from the printed page rather than guessed from a
// two-digit MRZ year.
export function compareDates(formValue, passportDate) {
  const want = parseDateCandidates(passportDate);
  const got = parseDateCandidates(formValue);

  if (want.length === 0 || got.length === 0) {
    return { comparable: false, verdict: DATE_VERDICT.UNKNOWN };
  }

  const target = want[0];
  if (got[0] === target) return { comparable: true, verdict: DATE_VERDICT.MATCH };
  if (got.includes(target)) return { comparable: true, verdict: DATE_VERDICT.AMBIGUOUS };
  return { comparable: true, verdict: DATE_VERDICT.MISMATCH };
}

// A display name in passport order, for showing next to the recorded name.
export function formatPassportName(first, last) {
  const f = String(first || "").trim();
  const l = String(last || "").trim();
  if (!f && !l) return "";
  return [l.toUpperCase(), f].filter(Boolean).join(", ");
}

// ---------------------------------------------------------------------------
// Shaping for the client
// ---------------------------------------------------------------------------

// Turns the raw contact properties into the object the roster card and the
// modal render. Kept here so get-students, get-person-form and read-passport
// all describe a person's passport state the same way.
export function shapePassportState(props = {}, { recordedFirst, recordedLast } = {}) {
  const status = (props[PASSPORT_PROPS.ocrStatus] || "").trim();
  const passportFirst = (props[PASSPORT_PROPS.ocrFirst] || "").trim();
  const passportLast = (props[PASSPORT_PROPS.ocrLast] || "").trim();

  // HubSpot booleans come back as the strings "true"/"false".
  const verified = String(props[PASSPORT_PROPS.verified] || "").toLowerCase() === "true";

  const comparison = compareNames({ recordedFirst, recordedLast, passportFirst, passportLast });
  const numberVerdict = (props[PASSPORT_PROPS.ocrNumber] || "").trim() || NUMBER_VERDICT.UNKNOWN;
  const dobVerdict = (props[PASSPORT_PROPS.ocrDob] || "").trim() || DATE_VERDICT.UNKNOWN;
  const expiryVerdict = (props[PASSPORT_PROPS.ocrExpiry] || "").trim() || DATE_VERDICT.UNKNOWN;

  return {
    status: status || null,              // null = never read
    read: !!status,
    passportFirst,
    passportLast,
    passportName: formatPassportName(passportFirst, passportLast)
      || (props[PASSPORT_PROPS.ocrName] || ""),
    readAt: props[PASSPORT_PROPS.ocrReadAt] || null,
    verified,
    verifiedBy: props[PASSPORT_PROPS.verifiedBy] || "",
    verifiedAt: props[PASSPORT_PROPS.verifiedAt] || null,
    // A verified person is never shown as mismatched: someone in the office
    // has looked at the document and said the record is right, which outranks
    // anything OCR concluded.
    nameMatches: verified ? true : (comparison.comparable ? comparison.matches : null),
    comparable: comparison.comparable,
    // Same rule as the name: a manual check settles it.
    numberVerdict: verified ? NUMBER_VERDICT.MATCH : numberVerdict,
    numberMatches: verified
      ? true
      : (numberVerdict === NUMBER_VERDICT.UNKNOWN ? null : numberVerdict === NUMBER_VERDICT.MATCH),
    dobVerdict: verified ? DATE_VERDICT.MATCH : dobVerdict,
    expiryVerdict: verified ? DATE_VERDICT.MATCH : expiryVerdict,
  };
}

// True when this person needs someone to look at them — either name or number
// disagrees with the document. Used for the roster badge.
export function needsPassportAttention(state) {
  if (!state || state.verified) return false;
  return state.nameMatches === false
    || verdictNeedsAttention(state.numberVerdict)
    || verdictNeedsAttention(state.dobVerdict)
    || verdictNeedsAttention(state.expiryVerdict);
}

// PATCH body for storing a read result.
export function buildOcrPatch({ status, first, last, hash, numberVerdict, dobVerdict, expiryVerdict }) {
  return {
    [PASSPORT_PROPS.ocrStatus]: status,
    // Verdicts only — never the number or the dates themselves.
    [PASSPORT_PROPS.ocrNumber]: numberVerdict || NUMBER_VERDICT.UNKNOWN,
    [PASSPORT_PROPS.ocrDob]: dobVerdict || DATE_VERDICT.UNKNOWN,
    [PASSPORT_PROPS.ocrExpiry]: expiryVerdict || DATE_VERDICT.UNKNOWN,
    [PASSPORT_PROPS.ocrFirst]: first || "",
    [PASSPORT_PROPS.ocrLast]: last || "",
    [PASSPORT_PROPS.ocrName]: formatPassportName(first, last),
    [PASSPORT_PROPS.ocrHash]: hash || "",
    [PASSPORT_PROPS.ocrReadAt]: new Date().toISOString(),
  };
}
