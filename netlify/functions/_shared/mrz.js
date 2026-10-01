// ICAO 9303 machine-readable zone parsing, with check-digit validation.
//
// WHY THIS EXISTS
//   Asking a vision model for "the date of birth" means trusting it to pick
//   the right field off a crowded, bilingual, often rotated page. On a real
//   scan that failed twice in a row: a surname came back as JUNE and then
//   KUNZ when the document said JUTZ, and a date of birth came back as the
//   expiry's day and month with the birth year. Both were confident and both
//   were wrong, and a wrong value with a one-click APPLY button next to it is
//   the most expensive thing this system can produce.
//
//   The MRZ removes the judgement. It is a fixed-width string at a fixed
//   place on the page, and — crucially — it carries CHECK DIGITS over the
//   number, the dates and the whole record. So the model's only job becomes
//   transcription: copy two lines of characters. We parse them here, and the
//   check digits tell us whether the transcription was correct. A single
//   misread character fails its check digit about 90% of the time, which
//   turns a silent wrong answer into a visible "couldn't read it".
//
//   WHAT THE CHECK DIGITS DO AND DON'T COVER: they protect the passport
//   number, the date of birth, the expiry and the personal-number field.
//   They do NOT cover the nationality (which we don't use) or the NAME line.
//   A name is therefore only as good as the transcription of line 1 — but a
//   transcription clean enough to pass every check digit in line 2 is strong
//   evidence that line 1 was read with the same care, which is why the whole
//   record is accepted or refused together rather than field by field.
//
// Supported: TD3 (passport booklets, 2 lines of 44). TD1/TD2 are ID cards,
// which is not what gets uploaded here.

const LINE_LENGTH = 44;

// ICAO character values: digits are themselves, A–Z are 10–35, filler is 0.
function charValue(c) {
  if (c >= "0" && c <= "9") return c.charCodeAt(0) - 48;
  if (c >= "A" && c <= "Z") return c.charCodeAt(0) - 55;
  if (c === "<") return 0;
  return -1; // anything else is not valid MRZ
}

// ICAO 9303 check digit: weights cycle 7, 3, 1; sum mod 10.
export function checkDigit(input) {
  const weights = [7, 3, 1];
  let sum = 0;
  for (let i = 0; i < input.length; i++) {
    const v = charValue(input[i]);
    if (v < 0) return null;
    sum += v * weights[i % 3];
  }
  return String(sum % 10);
}

// Normalise a transcribed line: uppercase, strip whitespace the model may
// have inserted between groups, and pad to 44 with filler. Nothing else —
// a substituted character must stay substituted so its check digit fails.
function tidyLine(line) {
  const t = String(line == null ? "" : line).toUpperCase().replace(/\s+/g, "");
  if (t.length === 0) return "";
  return t.length >= LINE_LENGTH ? t.slice(0, LINE_LENGTH) : t.padEnd(LINE_LENGTH, "<");
}

// "<" is a space inside a name, "<<" separates surname from given names.
function decodeNamePart(raw) {
  return raw.replace(/</g, " ").replace(/\s+/g, " ").trim();
}

// YYMMDD → YYYY-MM-DD.
//
// The century is the one thing the MRZ genuinely doesn't carry, so it is
// resolved by rule rather than guess:
//   - a date of birth cannot be in the future, so a two-digit year that would
//     put it there belongs to the previous century
//   - a passport is issued for at most ~10 years, so an expiry is 20xx
// Callers should still confirm against the printed four-digit year when they
// have it.
function expandDate(yymmdd, kind, now = new Date()) {
  if (!/^\d{6}$/.test(yymmdd)) return null;
  const yy = +yymmdd.slice(0, 2);
  const mm = +yymmdd.slice(2, 4);
  const dd = +yymmdd.slice(4, 6);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;

  let year;
  if (kind === "birth") {
    year = 2000 + yy;
    if (year > now.getUTCFullYear()) year -= 100;
  } else {
    year = 2000 + yy;
  }
  return `${year}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}

// Parse and validate a TD3 MRZ.
//
// Returns { ok, fields, failures } — `ok` only when every check digit that
// applies verifies. `failures` names what didn't, so a caller can say why it
// refused rather than just refusing.
export function parseMrz(line1, line2, now = new Date()) {
  const l1 = tidyLine(line1);
  const l2 = tidyLine(line2);
  const failures = [];

  // Line 1 carries the names; line 2 carries the number, the dates and every
  // check digit. They fail independently, and the common real-world case is a
  // photo that crops the bottom line off the page — which leaves the names
  // perfectly readable. Returning nothing in that case throws away the half
  // of the document that WAS captured.
  const line1Usable = !!l1 && /^[A-Z0-9<]+$/.test(l1);
  const line2Usable = !!l2 && /^[A-Z0-9<]+$/.test(l2);

  if (!line1Usable && !line2Usable) {
    return { ok: false, nameOnly: false, failures: ["no MRZ was provided"], fields: null };
  }

  if (line1Usable && !line2Usable) {
    // Line 1 holds the names, but every check digit lives in line 2 — so
    // without it nothing here can be verified, and unverified passport data
    // is not something this portal offers. The names are still parsed so a
    // caller can log what was seen, but `ok` stays false.
    return {
      ok: false,
      nameOnly: true,
      failures: [l2 ? "the second MRZ line is not a valid MRZ line" : "the second MRZ line is missing (the photo may be cropped)"],
      fields: { ...namesFromLine1(l1), documentNumber: "", nationality: "", sex: "", dateOfBirth: null, expiryDate: null },
    };
  }

  if (!line1Usable) {
    return { ok: false, nameOnly: false, failures: ["the first MRZ line is missing or invalid"], fields: null };
  }
  if (l1[0] !== "P") failures.push("the first line does not start with P (not a passport MRZ)");

  // --- line 1: document type, issuing state, names -------------------------
  const { surname, givenNames, issuingState } = namesFromLine1(l1);

  // --- line 2: number, nationality, dates, sex -----------------------------
  const documentNumberRaw = l2.slice(0, 9);
  const documentNumberCd = l2[9];
  const nationality = l2.slice(10, 13).replace(/</g, "");
  const birthRaw = l2.slice(13, 19);
  const birthCd = l2[19];
  const sex = l2[20];
  const expiryRaw = l2.slice(21, 27);
  const expiryCd = l2[27];
  const personalRaw = l2.slice(28, 42);
  const personalCd = l2[42];
  const compositeCd = l2[43];

  // --- check digits --------------------------------------------------------
  if (checkDigit(documentNumberRaw) !== documentNumberCd) failures.push("passport number check digit");
  if (checkDigit(birthRaw) !== birthCd) failures.push("date of birth check digit");
  if (checkDigit(expiryRaw) !== expiryCd) failures.push("expiry date check digit");
  // The personal-number field is optional; its check digit is "<" or "0" when
  // unused, and only meaningful when the field carries something.
  if (personalRaw.replace(/</g, "") !== "" && checkDigit(personalRaw) !== personalCd) {
    failures.push("personal number check digit");
  }
  const composite = documentNumberRaw + documentNumberCd + birthRaw + birthCd +
    expiryRaw + expiryCd + personalRaw + personalCd;
  if (checkDigit(composite) !== compositeCd) failures.push("overall check digit");

  const dateOfBirth = expandDate(birthRaw, "birth", now);
  const expiryDate = expandDate(expiryRaw, "expiry", now);
  if (!dateOfBirth) failures.push("date of birth is not a real date");
  if (!expiryDate) failures.push("expiry date is not a real date");

  return {
    ok: failures.length === 0,
    nameOnly: false,
    failures,
    fields: {
      surname,
      givenNames,
      documentNumber: documentNumberRaw.replace(/</g, ""),
      nationality,
      issuingState,
      sex: sex === "<" ? "" : sex,
      dateOfBirth,
      expiryDate,
    },
  };
}

// Names live in line 1 only. Positions 0-1 are the document type (NZ uses
// both "P<" and "PP" across issues), 2-4 the issuing state, 5+ the names,
// with "<<" between surname and given names.
function namesFromLine1(l1) {
  const nameField = l1.slice(5);
  const split = nameField.indexOf("<<");
  return {
    surname: decodeNamePart(split >= 0 ? nameField.slice(0, split) : nameField),
    givenNames: decodeNamePart(split >= 0 ? nameField.slice(split + 2) : ""),
    issuingState: l1.slice(2, 5).replace(/</g, ""),
  };
}

// ---------------------------------------------------------------------------
// Structural repair of a transcription that failed its check digits.
//
// The common real failures are not misread data — they're miscounted
// FILLERS. Line 2 of most passports ends in a run of ~15 identical "<"
// characters (the empty personal-number field), and a vision model reading a
// sideways scan drops or adds one. That shifts the last two check digits and
// fails a transcription whose every data character was right. The other is a
// letter in a field that can only hold digits (O for 0 in a date).
//
// Only edits that cannot change the information are made:
//   - the personal-number area is re-padded to its fixed 14 characters when
//     it holds nothing but fillers
//   - a passport number shorter than 9 characters gets its trailing filler
//     back when that's the only way the fixed fields line up
//   - look-alike letters in DIGIT-ONLY positions (dates, check digits) become
//     the digit they look like, and look-alike digits in LETTER-ONLY positions
//     (nationality, sex) become letters
// The passport number's own characters are never changed, and the names are
// never touched. A repaired candidate is used only if EVERY check digit,
// including the overall one, passes — the same bar as an untouched read.
// Returns [] when nothing applies.

const TO_DIGIT = { O: "0", D: "0", Q: "0", I: "1", L: "1", Z: "2", S: "5", G: "6", B: "8" };
const TO_LETTER = { "0": "O", "1": "I", "2": "Z", "5": "S", "8": "B" };
const DIGIT_POSITIONS = [9, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 24, 25, 26, 27];
const LETTER_POSITIONS = [10, 11, 12];

function fixLine2Characters(l2) {
  const chars = l2.split("");
  for (const i of DIGIT_POSITIONS) if (TO_DIGIT[chars[i]]) chars[i] = TO_DIGIT[chars[i]];
  for (const i of LETTER_POSITIONS) if (TO_LETTER[chars[i]]) chars[i] = TO_LETTER[chars[i]];
  if (chars[20] === "0") chars[20] = "<"; // sex: M, F, X or filler
  return chars.join("");
}

// Re-pads the tail of line 2 (positions 28–43) when the personal-number area
// is all fillers. `rest` is everything after the expiry check digit.
function refillTail(head28, rest) {
  if (rest.length < 2) return null;
  const last2 = rest.slice(-2);
  const middle = rest.slice(0, -2);
  if (middle.replace(/</g, "") !== "") return null; // a real personal number: leave it
  return head28 + "<".repeat(14) + last2;
}

export function repairMrzCandidates(line1, line2) {
  const raw = String(line2 == null ? "" : line2).toUpperCase().replace(/\s+/g, "");
  if (!raw) return [];
  const out = new Set();

  const heads = [raw];
  // Passport number with its trailing filler dropped: the check digit then
  // sits at index 8 and the nationality starts at 9.
  if (/^[A-Z0-9]{8}[0-9A-Z][A-Z]{3}/.test(raw) && raw[8] !== "<") heads.push(raw.slice(0, 8) + "<" + raw.slice(8));

  for (const h of heads) {
    const fixed = fixLine2Characters(h.padEnd(30, "<"));
    const refilled = refillTail(fixed.slice(0, 28), fixed.slice(28));
    if (refilled) out.add(refilled);
    if (fixed.length === 44) out.add(fixed);
  }
  out.delete(tidyLine(line2));
  return [...out].map(l2 => [line1, l2]);
}

// parseMrz, then — only if that fails — each structural repair in turn.
// `repaired` says which happened, for logging.
export function parseMrzWithRepair(line1, line2, now = new Date()) {
  const direct = parseMrz(line1, line2, now);
  if (direct.ok) return { ...direct, repaired: false };
  for (const [l1, l2] of repairMrzCandidates(line1, line2)) {
    const attempt = parseMrz(l1, l2, now);
    if (attempt.ok) return { ...attempt, repaired: true };
  }
  return { ...direct, repaired: false };
}
