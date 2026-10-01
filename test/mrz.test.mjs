// Tests for machine-readable-zone parsing and for how a read is interpreted.
//
// Run with:  node test/mrz.test.mjs   (or npm test)
//
// These exist because asking a vision model for "the date of birth" failed
// twice on one real scan: a surname came back as KUNZ and then JUNE when the
// document said JUTZ, and a date of birth came back as the EXPIRY's day and
// month with the birth year. Both were confident, both were wrong, and both
// had a one-click APPLY next to them.
//
// The MRZ carries check digits, so transcription can be verified instead of
// trusted. The fixtures below are the real MRZ from that passport.

import assert from "node:assert/strict";

process.env.SESSION_SECRET = "test-secret-value-that-is-long-enough";
process.env.HUBSPOT_API_KEY = "hs";
process.env.JOTFORM_API_KEY = "jf";
process.env.ANTHROPIC_API_KEY = "sk";

const { parseMrz, checkDigit } =
  await import("../netlify/functions/_shared/mrz.js");
const { interpretRead } = await import("../netlify/functions/read-passport.js");

let passed = 0;
const cases = [];
function test(name, fn) { cases.push({ name, fn }); }
function run() {
  for (const { name, fn } of cases) {
    try { fn(); passed++; }
    catch (err) {
      console.error(`FAIL  ${name}\n      ${err.message}`);
      process.exitCode = 1;
    }
  }
}

// The real thing, from the scan that was being misread.
const L1 = "P<NZLSHELTON<<LUISA<CHARLOTTE<JUTZ<<<<<<<<<<<";
const L2 = "RB013901<0NZL0911278F2902212<<<<<<<<<<<<<<00";
const NOW = new Date("2026-09-29T00:00:00Z");

// --- check digits -----------------------------------------------------------

test("check digit follows the 7-3-1 weighting", () => {
  assert.equal(checkDigit("RB013901<"), "0");
  assert.equal(checkDigit("091127"), "8");
  assert.equal(checkDigit("290221"), "2");
});

// --- parsing ----------------------------------------------------------------

test("a real passport MRZ parses to the right values", () => {
  const r = parseMrz(L1, L2, NOW);
  assert.equal(r.ok, true, `failures: ${r.failures.join(", ")}`);
  assert.equal(r.fields.surname, "SHELTON");
  // The name the model kept getting wrong.
  assert.equal(r.fields.givenNames, "LUISA CHARLOTTE JUTZ");
  assert.equal(r.fields.documentNumber, "RB013901");
  // The date the model reported as 21 February 2009 — the expiry's day and
  // month with the birth year.
  assert.equal(r.fields.dateOfBirth, "2009-11-27");
  assert.equal(r.fields.expiryDate, "2029-02-21");
  assert.equal(r.fields.nationality, "NZL");
});

test("one wrong character anywhere fails a check digit", () => {
  // The property the whole design rests on: a sloppy transcription is
  // detectable rather than silently wrong.
  const badDob = L2.slice(0, 13) + "091227" + L2.slice(19);
  assert.equal(parseMrz(L1, badDob, NOW).ok, false);

  const badNum = "RB013902<" + L2.slice(9);
  assert.equal(parseMrz(L1, badNum, NOW).ok, false);

  const badExpiry = L2.slice(0, 21) + "290321" + L2.slice(27);
  assert.equal(parseMrz(L1, badExpiry, NOW).ok, false);
});

test("whitespace the model inserted is tolerated", () => {
  const spaced = L2.replace(/(.{10})/g, "$1 ");
  assert.equal(parseMrz(L1, spaced, NOW).ok, true);
});

test("check digits cover the number and dates — not the nationality or names", () => {
  // Worth pinning, because it bounds what verification actually buys.
  // ICAO's check digits protect the passport number, the two dates and the
  // personal-number field. Nationality is unprotected (we don't use it), and
  // the name line has no check digit at all — which is why the name is
  // cross-checked against the printed page instead.
  assert.equal(parseMrz(L1, L2.replace("NZL", "N2L"), NOW).ok, true);
  assert.equal(parseMrz(L1.replace("SHELTON", "SHELTQN"), L2, NOW).ok, true);
  assert.equal(parseMrz(L1, "RB013902<" + L2.slice(9), NOW).ok, false);
});

test("a date of birth is never placed in the future", () => {
  // A two-digit year that would put a birth after today belongs to the
  // previous century.
  const l2 = L2.slice(0, 13) + "991127" + checkDigit("991127") + L2.slice(20);
  const r = parseMrz(L1, l2, NOW);
  assert.equal(r.fields.dateOfBirth, "1999-11-27");
});

test("junk is refused rather than half-parsed", () => {
  assert.equal(parseMrz("", "", NOW).ok, false);
  assert.equal(parseMrz("not an mrz at all!", L2, NOW).ok, false);
  assert.equal(parseMrz(L1, null, NOW).ok, false);
});

// --- interpreting a read ----------------------------------------------------

function read(overrides = {}) {
  return interpretRead({
    mrz_line1: L1, mrz_line2: L2, found: true, reason: "",
    ...overrides,
  });
}

test("a verified MRZ supplies the name, number and both dates", () => {
  const r = read();
  assert.equal(r.last, "SHELTON");
  assert.equal(r.first, "LUISA CHARLOTTE JUTZ");
  assert.equal(r.number, "RB013901");
  assert.equal(r.dob, "2009-11-27");
  assert.equal(r.expiry, "2029-02-21");
  assert.equal(r.verified, true);
});

test("a failed check digit yields NOTHING, not a partial answer", () => {
  // The whole record is accepted or refused together. A transcription clean
  // enough to pass every check digit is evidence the name line was read with
  // the same care; one that fails is evidence it wasn't.
  const r = read({ mrz_line2: L2.slice(0, 13) + "091227" + L2.slice(19) });
  assert.equal(r.first, "");
  assert.equal(r.last, "");
  assert.equal(r.number, "");
  assert.equal(r.dob, "");
  assert.equal(r.verified, false);
  assert.match(r.reason, /check digits failed/i);
  assert.match(r.reason, /BOTH lines/i);
});

test("a cropped photo asks for a better one", () => {
  const r = read({ mrz_line2: "" });
  assert.equal(r.first, "");
  assert.match(r.reason, /top line/i);
  assert.match(r.reason, /BOTH lines/i);
});

test("the model reporting it couldn't see the zone is passed through", () => {
  const r = read({ mrz_line1: "", mrz_line2: "", found: false, reason: "the page is cut off" });
  assert.equal(r.first, "");
  assert.match(r.reason, /cut off/);
  assert.match(r.reason, /BOTH lines/i);
});

test("nothing at all returns nothing", () => {
  assert.equal(interpretRead(null).first, "");
});

run();
console.log(`\n${passed} passed`);
