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
//   They do NOT cover the nationality (which we don't use) or the NAME line,
//   which has no check digit at all. The name is therefore cross-checked
//   against the printed page instead — see printedNameAgrees() below.
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
    const names = namesFromLine1(l1);
    return {
      ok: false,
      // The names are readable; nothing else is. The caller decides what to
      // do with that — see interpretRead in read-passport.js.
      nameOnly: true,
      failures: [l2 ? "the second MRZ line is not a valid MRZ line" : "the second MRZ line is missing (the photo may be cropped)"],
      fields: { ...names, documentNumber: "", nationality: "", sex: "", dateOfBirth: null, expiryDate: null },
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

// Does a name read off the printed page agree with the one in the MRZ?
//
// The MRZ is a transliteration, so three differences are expected and are NOT
// disagreements: accents are stripped (MÜLLER → MULLER), punctuation becomes
// filler, and a long name is truncated to fit 39 characters. Anything else —
// different letters — means one of the two was misread, which is exactly the
// failure this is here to catch.
export function printedNameAgrees(printed, fromMrz) {
  const norm = (s) => String(s == null ? "" : s)
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/['’`]/g, "")
    .replace(/[^A-Z]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const p = norm(printed);
  const m = norm(fromMrz);
  if (!p || !m) return true;           // nothing to compare against
  if (p === m) return true;
  // MRZ truncation: the MRZ version is a prefix of the printed one.
  if (p.startsWith(m) || m.startsWith(p)) return true;
  return false;
}
