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
  };
}

// PATCH body for storing a read result.
export function buildOcrPatch({ status, first, last, hash }) {
  return {
    [PASSPORT_PROPS.ocrStatus]: status,
    [PASSPORT_PROPS.ocrFirst]: first || "",
    [PASSPORT_PROPS.ocrLast]: last || "",
    [PASSPORT_PROPS.ocrName]: formatPassportName(first, last),
    [PASSPORT_PROPS.ocrHash]: hash || "",
    [PASSPORT_PROPS.ocrReadAt]: new Date().toISOString(),
  };
}
