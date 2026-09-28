// Tests for passport-name checking — reading the name off a passport photo,
// comparing it to the name on record, and the ops "checked by hand" tick.
//
// Run with:  node test/passport-check.test.mjs   (or npm test)
//
// The comparison rules carry the most risk here: a false "matches" hides a
// name that will fail at check-in, and a false "mismatch" sends leaders
// chasing names that are already right.

import assert from "node:assert/strict";

process.env.SESSION_SECRET = "test-secret-value-that-is-long-enough";
process.env.HUBSPOT_API_KEY = "hs-test-key";
process.env.JOTFORM_API_KEY = "jf-test-key";
process.env.ANTHROPIC_API_KEY = "sk-test";
process.env.JOTFORM_APPLICATION_FORM_ID = "111111";

const { createToken } = await import("../netlify/functions/_shared/auth.js");
const {
  normaliseName, compareNames, formatPassportName, shapePassportState, PASSPORT_PROPS,
  normaliseDocNumber, compareDocumentNumbers, needsPassportAttention, NUMBER_VERDICT,
  parseDateCandidates, compareDates, DATE_VERDICT,
} = await import("../netlify/functions/_shared/passport.js");
const { handler: readPassport } = await import("../netlify/functions/read-passport.js");
const { handler: setVerified } = await import("../netlify/functions/set-passport-verified.js");

let passed = 0;
const cases = [];
function test(name, fn) { cases.push({ name, fn }); }
async function run() {
  for (const { name, fn } of cases) {
    try { await fn(); passed++; }
    catch (err) {
      console.error(`FAIL  ${name}\n      ${err.message}`);
      process.exitCode = 1;
    }
  }
}

// --- 1. name comparison -----------------------------------------------------

test("normalising follows how a passport MRZ writes a name", () => {
  // Apostrophes are dropped by the MRZ, hyphens become a filler space.
  // Get either wrong and every O'Brien on the roster reads as a mismatch.
  assert.equal(normaliseName("O'Brien"), "OBRIEN");
  assert.equal(normaliseName("D\u2019Souza"), "DSOUZA");
  assert.equal(normaliseName("Smith-Jones"), "SMITH JONES");
  assert.equal(normaliseName("  de la  Cruz "), "DE LA CRUZ");
  assert.equal(normaliseName("Zo\u00eb"), "ZOE");
});

test("an apostrophe surname is not flagged against its MRZ spelling", () => {
  const r = compareNames({
    recordedFirst: "Sean", recordedLast: "O'Brien",
    passportFirst: "SEAN", passportLast: "OBRIEN",
  });
  assert.equal(r.matches, true);
});

test("a hyphenated surname matches its MRZ spacing", () => {
  const r = compareNames({
    recordedFirst: "Ana", recordedLast: "Smith-Jones",
    passportFirst: "ANA", passportLast: "SMITH JONES",
  });
  assert.equal(r.matches, true);
});

test("a passport middle name the record lacks is not a mismatch", () => {
  const r = compareNames({
    recordedFirst: "John", recordedLast: "Smith",
    passportFirst: "John Michael", passportLast: "Smith",
  });
  assert.equal(r.matches, true);
});

test("a shortened first name IS a mismatch — this is the case that breaks bookings", () => {
  const r = compareNames({
    recordedFirst: "Jon", recordedLast: "Smith",
    passportFirst: "Jonathan", passportLast: "Smith",
  });
  assert.equal(r.matches, false);
  assert.equal(r.firstMatches, false);
  assert.equal(r.lastMatches, true);
});

test("a different surname is a mismatch", () => {
  const r = compareNames({
    recordedFirst: "Ana", recordedLast: "Reynolds",
    passportFirst: "Ana", passportLast: "Reynolds-Cruz",
  });
  assert.equal(r.matches, false);
});

test("nothing to compare is reported as not comparable, never as a match", () => {
  assert.equal(compareNames({ recordedFirst: "A", recordedLast: "B" }).comparable, false);
  assert.equal(compareNames({ passportFirst: "A", passportLast: "B" }).comparable, false);
  // Critically: `matches` must be null, not false — an unread passport is not
  // a mismatch, and must not light up a warning on every card.
  assert.equal(compareNames({ recordedFirst: "A", recordedLast: "B" }).matches, null);
});

test("passport display name is surname-first", () => {
  assert.equal(formatPassportName("John Michael", "Smith"), "SMITH, John Michael");
  assert.equal(formatPassportName("", ""), "");
});

// --- 2. shaping for the card ------------------------------------------------

test("an unread passport shows as not read, with no verdict", () => {
  const s = shapePassportState({}, { recordedFirst: "John", recordedLast: "Smith" });
  assert.equal(s.read, false);
  assert.equal(s.status, null);
  assert.equal(s.nameMatches, null);
  assert.equal(s.verified, false);
});

test("a manual check outranks an OCR mismatch", () => {
  const props = {
    [PASSPORT_PROPS.ocrStatus]: "ok",
    [PASSPORT_PROPS.ocrFirst]: "Jonathan",
    [PASSPORT_PROPS.ocrLast]: "Smith",
    [PASSPORT_PROPS.verified]: "true",
    [PASSPORT_PROPS.verifiedBy]: "ops@unearthed.example",
  };
  const s = shapePassportState(props, { recordedFirst: "Jon", recordedLast: "Smith" });
  // The office has looked at the document and said the record is right.
  assert.equal(s.nameMatches, true);
  assert.equal(s.verified, true);
  assert.equal(s.verifiedBy, "ops@unearthed.example");
});

test("an OCR mismatch with no manual check is flagged", () => {
  const s = shapePassportState({
    [PASSPORT_PROPS.ocrStatus]: "ok",
    [PASSPORT_PROPS.ocrFirst]: "Jonathan",
    [PASSPORT_PROPS.ocrLast]: "Smith",
  }, { recordedFirst: "Jon", recordedLast: "Smith" });
  assert.equal(s.nameMatches, false);
  assert.equal(s.passportName, "SMITH, Jonathan");
});

// --- 3. read-passport, end to end ------------------------------------------

const PORTAL_OBJECT = "2-58156993";
const PORTAL_ID = "9001";
const CONTACT_IDS = {
  "leader@trip.example": "100",
  "teacher@school.example": "20",
  "mia@example.com": "10",
  "ops@unearthed.example": "1",
};
const PORTAL_MEMBERS = [
  { toObjectId: "100", associationTypes: [{ label: "Trip Leader" }] },
  { toObjectId: "20",  associationTypes: [{ label: "Teacher" }] },
  { toObjectId: "10",  associationTypes: [{ label: "Student" }] },
];

function jsonRes(body, ok = true, status = 200) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) };
}

let sent;
function stubFetch(opts = {}) {
  sent = { patch: null, visionCalls: 0, imageFetches: 0 };
  const contactProps = opts.contactProps || {};

  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const body = init.body ? String(init.body) : "";

    if (u.includes("/crm/v3/objects/contacts/search")) {
      const parsed = JSON.parse(body || "{}");
      const wanted = parsed.filterGroups?.[0]?.filters?.[0]?.value;
      if ((parsed.properties || []).includes("portal_token_version")) {
        return jsonRes({ results: [{ id: CONTACT_IDS[wanted] || "0", properties: { portal_token_version: "0" } }] });
      }
      const id = CONTACT_IDS[wanted];
      return jsonRes({ results: id ? [{ id, properties: { email: wanted } }] : [] });
    }

    let m = u.match(/\/crm\/v4\/objects\/contacts\/(\d+)\/associations\/2-58156993/);
    if (m) return jsonRes({ results: m[1] === "1" ? [] : [{ toObjectId: PORTAL_ID }] });

    if (u.includes(`/objects/${PORTAL_OBJECT}/${PORTAL_ID}/associations/contacts`)) {
      return jsonRes({ results: PORTAL_MEMBERS });
    }

    if (u.match(/\/crm\/v3\/objects\/contacts\/\d+\?properties=/)) {
      return jsonRes({ id: "10", properties: { firstname: "Jon", lastname: "Smith", ...contactProps } });
    }

    if (u.match(/\/crm\/v3\/objects\/contacts\/\d+$/) && init.method === "PATCH") {
      if (opts.patchFails) return jsonRes({ error: "property missing" }, false, 400);
      sent.patch = JSON.parse(body || "{}").properties;
      return jsonRes({ id: "10" });
    }

    if (u.includes("api.jotform.com/form/111111/submissions")) {
      return jsonRes({ content: [{
        id: "sub-1", created_at: "2026-03-01 10:00:00",
        answers: {
          "1": { type: "control_email", text: "Email", order: "1", answer: "mia@example.com" },
          "7": { type: "control_textbox", text: "Passport Number", order: "7",
                 answer: opts.formNumber === undefined ? "LA123456" : opts.formNumber },
          "5": { type: "control_datetime", text: "Date of Birth", order: "5",
                 answer: opts.formDob === undefined ? { day: "15", month: "03", year: "2008" } : opts.formDob },
          "6": { type: "control_datetime", text: "Expiry Date", order: "6",
                 answer: opts.formExpiry === undefined ? { day: "01", month: "06", year: "2030" } : opts.formExpiry },
          ...(opts.noPhoto ? {} : {
            "9": { type: "control_fileupload", text: "Passport Cover Page Photo", order: "9",
                   answer: [opts.fileUrl || "https://www.jotform.com/uploads/passport.jpg"] }
          }),
        },
      }] });
    }
    if (u.includes("api.jotform.com/form/")) return jsonRes({ content: [] });

    if (u.includes("jotform.com/uploads/")) {
      sent.imageFetches++;
      if (opts.fileDownloadFails) return jsonRes({}, false, 502);
      const type = opts.fileType || "image/jpeg";
      const size = opts.fileBytes || 7;
      return {
        ok: true, status: 200,
        headers: { get: () => type },
        arrayBuffer: async () => new Uint8Array(size).buffer,
      };
    }

    if (u.includes("api.anthropic.com/v1/messages")) {
      sent.visionCalls++;
      try { sent.visionBlocks = JSON.parse(body).messages[0].content.map(c => c.type); } catch (_) {}
      if (opts.visionFails) return jsonRes({ error: "boom" }, false, 500);
      const payload = opts.visionReply || {
        readable: true, surname: "SMITH", given_names: "JONATHAN MICHAEL",
        document_number: opts.docNumber === undefined ? "LA123456" : opts.docNumber,
        date_of_birth: opts.docDob === undefined ? "2008-03-15" : opts.docDob,
        expiry_date: opts.docExpiry === undefined ? "2030-06-01" : opts.docExpiry,
        source: "mrz", reason: "",
      };
      return jsonRes({ content: [{ type: "text", text: JSON.stringify(payload) }] });
    }

    throw new Error(`unstubbed fetch: ${init.method || "GET"} ${u}`);
  };
}

function callRead(email, payload) {
  return readPassport({
    httpMethod: "POST",
    headers: { authorization: `Bearer ${createToken({ email, role: email.includes("ops") ? "Director" : "user", ver: 0 })}` },
    body: JSON.stringify(payload),
  }).then(r => ({ statusCode: r.statusCode, body: JSON.parse(r.body) }));
}

test("reading a passport returns the name and caches it, without writing the record", async () => {
  stubFetch();
  const { statusCode, body } = await callRead("leader@trip.example", { email: "mia@example.com" });
  assert.equal(statusCode, 200);
  assert.equal(body.passportFirst, "JONATHAN MICHAEL");
  assert.equal(body.passportLast, "SMITH");
  assert.equal(body.nameMatches, false, "Jon vs Jonathan must be flagged");

  // Cached on the contact...
  assert.equal(sent.patch[PASSPORT_PROPS.ocrStatus], "ok");
  assert.ok(sent.patch[PASSPORT_PROPS.ocrHash]);
  // ...but the name on the record is untouched. Applying is a separate,
  // deliberate action.
  assert.equal(sent.patch.firstname, undefined);
  assert.equal(sent.patch.lastname, undefined);
});

test("the passport number is never copied into the CRM", async () => {
  stubFetch({ visionReply: { readable: true, surname: "SMITH", given_names: "JONATHAN", source: "mrz", reason: "" } });
  await callRead("leader@trip.example", { email: "mia@example.com" });
  const written = JSON.stringify(sent.patch).toLowerCase();
  assert.ok(!written.includes("passport_number"));
  assert.ok(!written.includes("document_number"));
});

test("a second look uses the cache instead of the vision API", async () => {
  stubFetch({ contactProps: {
    [PASSPORT_PROPS.ocrStatus]: "ok",
    [PASSPORT_PROPS.ocrFirst]: "JONATHAN",
    [PASSPORT_PROPS.ocrLast]: "SMITH",
    [PASSPORT_PROPS.ocrNumber]: "match",
    [PASSPORT_PROPS.ocrDob]: "match",
    [PASSPORT_PROPS.ocrExpiry]: "match",
    // sha256 of the photo URL, first 32 chars — same as the handler computes.
    [PASSPORT_PROPS.ocrHash]: (await import("node:crypto")).createHash("sha256")
      .update("https://www.jotform.com/uploads/passport.jpg").digest("hex").slice(0, 32),
  } });
  const { body } = await callRead("leader@trip.example", { email: "mia@example.com" });
  assert.equal(body.cached, true);
  assert.equal(sent.visionCalls, 0, "a cached read must not call the API");
  assert.equal(sent.imageFetches, 0, "nor re-download the image");
});

test("force re-reads even when cached", async () => {
  stubFetch({ contactProps: {
    [PASSPORT_PROPS.ocrStatus]: "ok",
    [PASSPORT_PROPS.ocrNumber]: "match",
    [PASSPORT_PROPS.ocrDob]: "match",
    [PASSPORT_PROPS.ocrExpiry]: "match",
    [PASSPORT_PROPS.ocrHash]: (await import("node:crypto")).createHash("sha256")
      .update("https://www.jotform.com/uploads/passport.jpg").digest("hex").slice(0, 32),
  } });
  await callRead("leader@trip.example", { email: "mia@example.com", force: true });
  assert.equal(sent.visionCalls, 1);
});

test("no passport photo is reported, not treated as a mismatch", async () => {
  stubFetch({ noPhoto: true });
  const { body } = await callRead("leader@trip.example", { email: "mia@example.com" });
  assert.equal(body.status, "no_photo");
  assert.equal(body.nameMatches, null);
  assert.equal(sent.visionCalls, 0);
});

test("an uncertain read is unreadable, never a guessed name", async () => {
  stubFetch({ visionReply: { readable: false, surname: "", given_names: "", source: "", reason: "photo too blurred" } });
  const { body } = await callRead("leader@trip.example", { email: "mia@example.com" });
  assert.equal(body.status, "unreadable");
  assert.equal(body.passportFirst, "");
  assert.match(body.message, /blurred/);
});

test("a vision API failure degrades to a manual check", async () => {
  stubFetch({ visionFails: true });
  const { statusCode, body } = await callRead("leader@trip.example", { email: "mia@example.com" });
  assert.equal(statusCode, 200);
  assert.equal(body.status, "error");
  assert.match(body.message, /check it by hand/i);
});

test("missing HubSpot properties warn instead of failing the read", async () => {
  stubFetch({ patchFails: true });
  const { statusCode, body } = await callRead("leader@trip.example", { email: "mia@example.com" });
  assert.equal(statusCode, 200);
  assert.equal(body.passportLast, "SMITH");
  assert.match(body.warning, /PASSPORT_SETUP/);
});

test("a teacher cannot trigger a passport read", async () => {
  stubFetch();
  const { statusCode } = await callRead("teacher@school.example", { email: "mia@example.com" });
  assert.equal(statusCode, 403);
  assert.equal(sent.visionCalls, 0);
});

// --- 3b. passport number comparison ----------------------------------------

test("number normalising ignores case and separators", () => {
  assert.equal(normaliseDocNumber("la 123-456"), "LA123456");
  assert.equal(normaliseDocNumber(""), "");
});

test("an identical number matches", () => {
  assert.equal(compareDocumentNumbers("LA123456", "la123456").verdict, NUMBER_VERDICT.MATCH);
});

test("a transposed number is a mismatch", () => {
  assert.equal(compareDocumentNumbers("LA123456", "LA123465").verdict, NUMBER_VERDICT.MISMATCH);
});

test("characters OCR swaps are reported separately, not as a mismatch", () => {
  // 0/O and 1/I on a passport font. Calling this a mismatch would train
  // leaders to dismiss the flag; calling it a match would hide a real error.
  assert.equal(compareDocumentNumbers("LA012345", "LAO12345").verdict, NUMBER_VERDICT.CONFUSABLE);
  assert.equal(compareDocumentNumbers("N1234567", "NI234567").verdict, NUMBER_VERDICT.CONFUSABLE);
});

test("a missing number on either side is unknown, never a mismatch", () => {
  assert.equal(compareDocumentNumbers("", "LA123456").verdict, NUMBER_VERDICT.UNKNOWN);
  assert.equal(compareDocumentNumbers("LA123456", "").verdict, NUMBER_VERDICT.UNKNOWN);
});

test("the roster flags a number mismatch even when the name is right", () => {
  const state = shapePassportState({
    [PASSPORT_PROPS.ocrStatus]: "ok",
    [PASSPORT_PROPS.ocrFirst]: "Jon",
    [PASSPORT_PROPS.ocrLast]: "Smith",
    [PASSPORT_PROPS.ocrNumber]: NUMBER_VERDICT.MISMATCH,
  }, { recordedFirst: "Jon", recordedLast: "Smith" });
  assert.equal(state.nameMatches, true);
  assert.equal(state.numberMatches, false);
  assert.equal(needsPassportAttention(state), true);
});

test("a manual check settles the number too", () => {
  const state = shapePassportState({
    [PASSPORT_PROPS.ocrStatus]: "ok",
    [PASSPORT_PROPS.ocrNumber]: NUMBER_VERDICT.MISMATCH,
    [PASSPORT_PROPS.verified]: "true",
  }, { recordedFirst: "Jon", recordedLast: "Smith" });
  assert.equal(state.numberMatches, true);
  assert.equal(needsPassportAttention(state), false);
});

test("reading compares the form's number against the image", async () => {
  stubFetch({ docNumber: "LA999999" });
  const { body } = await callRead("leader@trip.example", { email: "mia@example.com" });
  assert.equal(body.formNumber, "LA123456");
  assert.equal(body.passportNumber, "LA999999");
  assert.equal(body.numberVerdict, NUMBER_VERDICT.MISMATCH);
  // Only the verdict is cached.
  assert.equal(sent.patch[PASSPORT_PROPS.ocrNumber], NUMBER_VERDICT.MISMATCH);
});

test("a matching number is recorded as a match", async () => {
  stubFetch();
  const { body } = await callRead("leader@trip.example", { email: "mia@example.com" });
  assert.equal(body.numberVerdict, NUMBER_VERDICT.MATCH);
});

test("no number on the form is unknown, not a mismatch", async () => {
  stubFetch({ formNumber: "" });
  const { body } = await callRead("leader@trip.example", { email: "mia@example.com" });
  assert.equal(body.numberVerdict, NUMBER_VERDICT.UNKNOWN);
  assert.equal(body.numberMatches, null);
});

test("the number read off the image is never written to HubSpot", async () => {
  stubFetch({ docNumber: "LA999999" });
  await callRead("leader@trip.example", { email: "mia@example.com" });
  const written = JSON.stringify(sent.patch);
  assert.ok(!written.includes("LA999999"), "the passport number reached the CRM");
  assert.ok(!written.includes("LA123456"), "the form's number reached the CRM");
});

// --- 3c. dates ---------------------------------------------------------------

test("an ISO date parses to exactly one reading", () => {
  assert.deepEqual(parseDateCandidates("2008-03-15"), ["2008-03-15"]);
});

test("a day over 12 is unambiguous", () => {
  assert.deepEqual(parseDateCandidates("15/03/2008"), ["2008-03-15"]);
  assert.deepEqual(parseDateCandidates("03/15/2008"), ["2008-03-15"]);
});

test("a date that could be read either way keeps both readings", () => {
  // 03/04/2008 is 3 April or 4 March depending on who typed it. Guessing
  // would either clear a wrong record or flag a right one.
  assert.deepEqual(parseDateCandidates("03/04/2008"), ["2008-04-03", "2008-03-04"]);
});

test("written-out months parse", () => {
  assert.deepEqual(parseDateCandidates("15 Mar 2008"), ["2008-03-15"]);
  assert.deepEqual(parseDateCandidates("March 15, 2008"), ["2008-03-15"]);
});

test("nonsense parses to nothing rather than a wrong date", () => {
  assert.deepEqual(parseDateCandidates("sometime in 2008"), []);
  assert.deepEqual(parseDateCandidates("32/01/2008"), []);
  assert.deepEqual(parseDateCandidates(""), []);
});

test("dates that agree are a match", () => {
  assert.equal(compareDates("2008-03-15", "2008-03-15").verdict, DATE_VERDICT.MATCH);
  assert.equal(compareDates("15/03/2008", "2008-03-15").verdict, DATE_VERDICT.MATCH);
});

test("a date matching only on the second reading is flagged ambiguous, not matched", () => {
  // Form says 03/04/2008, passport says 4 March. Day-first reading (3 April)
  // doesn't match, month-first does — somebody should confirm which was meant.
  assert.equal(compareDates("03/04/2008", "2008-03-04").verdict, DATE_VERDICT.AMBIGUOUS);
  // And the other way round it is a plain match, since day-first leads.
  assert.equal(compareDates("03/04/2008", "2008-04-03").verdict, DATE_VERDICT.MATCH);
});

test("a genuinely different date is a mismatch", () => {
  assert.equal(compareDates("2008-03-15", "2008-03-16").verdict, DATE_VERDICT.MISMATCH);
  assert.equal(compareDates("03/04/2008", "2009-12-25").verdict, DATE_VERDICT.MISMATCH);
});

test("a missing date on either side is unknown", () => {
  assert.equal(compareDates("", "2008-03-15").verdict, DATE_VERDICT.UNKNOWN);
  assert.equal(compareDates("2008-03-15", "").verdict, DATE_VERDICT.UNKNOWN);
});

test("reading compares both dates against the form", async () => {
  stubFetch({ docDob: "2008-03-16", docExpiry: "2030-06-01" });
  const { body } = await callRead("leader@trip.example", { email: "mia@example.com" });
  assert.equal(body.formDob, "2008-03-15");
  assert.equal(body.passportDob, "2008-03-16");
  assert.equal(body.dobVerdict, DATE_VERDICT.MISMATCH);
  assert.equal(body.expiryVerdict, DATE_VERDICT.MATCH);
  assert.equal(sent.patch[PASSPORT_PROPS.ocrDob], DATE_VERDICT.MISMATCH);
  assert.equal(sent.patch[PASSPORT_PROPS.ocrExpiry], DATE_VERDICT.MATCH);
});

test("a date the model couldn't read confidently is dropped, not guessed", async () => {
  stubFetch({ docDob: "15 March 2008" });   // not the ISO form we asked for
  const { body } = await callRead("leader@trip.example", { email: "mia@example.com" });
  assert.equal(body.passportDob, "");
  assert.equal(body.dobVerdict, DATE_VERDICT.UNKNOWN);
});

test("the dates read off the image are never written to HubSpot", async () => {
  stubFetch({ docDob: "2008-03-16", docExpiry: "2031-12-25" });
  await callRead("leader@trip.example", { email: "mia@example.com" });
  const written = JSON.stringify(sent.patch);
  assert.ok(!written.includes("2008-03-16"), "a date of birth reached the CRM");
  assert.ok(!written.includes("2031-12-25"), "an expiry date reached the CRM");
});

test("an expiry mismatch alone still asks for attention", () => {
  const state = shapePassportState({
    [PASSPORT_PROPS.ocrStatus]: "ok",
    [PASSPORT_PROPS.ocrFirst]: "Jon",
    [PASSPORT_PROPS.ocrLast]: "Smith",
    [PASSPORT_PROPS.ocrNumber]: NUMBER_VERDICT.MATCH,
    [PASSPORT_PROPS.ocrExpiry]: DATE_VERDICT.MISMATCH,
  }, { recordedFirst: "Jon", recordedLast: "Smith" });
  assert.equal(state.nameMatches, true);
  assert.equal(needsPassportAttention(state), true);
});

// --- 3d. file types ----------------------------------------------------------

test("a PDF scan is read, as a document block not an image block", async () => {
  // Scanner apps (TapScanner, Adobe Scan, iOS Files) export PDFs by default,
  // so this is a large share of real uploads — it used to be refused outright.
  stubFetch({ fileType: "application/pdf", fileUrl: "https://www.jotform.com/uploads/TapScanner%2002-07-2023.pdf" });
  const { statusCode, body } = await callRead("leader@trip.example", { email: "mia@example.com" });
  assert.equal(statusCode, 200);
  assert.equal(body.status, "ok");
  assert.equal(body.passportLast, "SMITH");
  assert.deepEqual(sent.visionBlocks, ["document", "text"]);
});

test("an image still goes as an image block", async () => {
  stubFetch();
  await callRead("leader@trip.example", { email: "mia@example.com" });
  assert.deepEqual(sent.visionBlocks, ["image", "text"]);
});

test("a PDF served without a content type is recognised by extension", async () => {
  stubFetch({ fileType: "application/octet-stream", fileUrl: "https://www.jotform.com/uploads/scan.pdf" });
  const { body } = await callRead("leader@trip.example", { email: "mia@example.com" });
  assert.equal(body.status, "ok");
  assert.deepEqual(sent.visionBlocks, ["document", "text"]);
});

test("a HEIC photo is reported as unreadable-by-format, with what to do", async () => {
  stubFetch({ fileType: "image/heic", fileUrl: "https://www.jotform.com/uploads/IMG_0042.heic" });
  const { body } = await callRead("leader@trip.example", { email: "mia@example.com" });
  assert.equal(body.status, "unsupported");
  assert.match(body.message, /JPEG or PDF/i);
  assert.equal(sent.visionCalls, 0);
  // Settled fact about that upload, so it's cached rather than re-read.
  assert.equal(sent.patch[PASSPORT_PROPS.ocrStatus], "unsupported");
});

test("an oversized file says so rather than failing silently", async () => {
  stubFetch({ fileType: "application/pdf", fileUrl: "https://www.jotform.com/uploads/big.pdf", fileBytes: 12 * 1024 * 1024 });
  const { body } = await callRead("leader@trip.example", { email: "mia@example.com" });
  assert.equal(body.status, "unsupported");
  assert.match(body.message, /12\.0MB|over the 10MB/);
});

test("a download failure is transient — reported, not cached", async () => {
  stubFetch({ fileDownloadFails: true });
  const { body } = await callRead("leader@trip.example", { email: "mia@example.com" });
  assert.equal(body.status, "error");
  assert.match(body.message, /couldn't be downloaded/i);
  assert.equal(sent.patch, null, "a transient failure must not be cached");
});

test("a date of birth on Jotform's Birth Date field is still found", async () => {
  // control_birthdate is a DIFFERENT type string from control_datetime. It
  // used to be invisible here, which silently dropped the DOB check for any
  // form built with Jotform's own birth-date field.
  stubFetch({ formDob: null, docDob: "2008-03-16" });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("api.jotform.com/form/111111/submissions")) {
      return jsonRes({ content: [{
        id: "sub-1", created_at: "2026-03-01 10:00:00",
        answers: {
          "1": { type: "control_email", text: "Email", order: "1", answer: "mia@example.com" },
          // Labelled in a way the old patterns missed, AND a birthdate type.
          "4": { type: "control_birthdate", text: "Birthday", order: "4",
                 answer: { day: "15", month: "03", year: "2008" } },
          "9": { type: "control_fileupload", text: "Passport Cover Page Photo", order: "9",
                 answer: ["https://www.jotform.com/uploads/passport.jpg"] },
        },
      }] });
    }
    return realFetch(url, init);
  };
  const { body } = await callRead("leader@trip.example", { email: "mia@example.com" });
  assert.equal(body.formDob, "2008-03-15");
  assert.equal(body.dobVerdict, DATE_VERDICT.MISMATCH); // passport says the 16th
});

test("expiry labelled 'Valid Until' is still found", async () => {
  stubFetch({ formExpiry: null });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("api.jotform.com/form/111111/submissions")) {
      return jsonRes({ content: [{
        id: "sub-1", created_at: "2026-03-01 10:00:00",
        answers: {
          "1": { type: "control_email", text: "Email", order: "1", answer: "mia@example.com" },
          "6": { type: "control_datetime", text: "Valid Until", order: "6",
                 answer: { day: "01", month: "06", year: "2030" } },
          "9": { type: "control_fileupload", text: "Passport Cover Page Photo", order: "9",
                 answer: ["https://www.jotform.com/uploads/passport.jpg"] },
        },
      }] });
    }
    return realFetch(url, init);
  };
  const { body } = await callRead("leader@trip.example", { email: "mia@example.com" });
  assert.equal(body.formExpiry, "2030-06-01");
  assert.equal(body.expiryVerdict, DATE_VERDICT.MATCH);
});

test("given names come back whole — the read never splits first from middle", async () => {
  // A passport has "Surname" and "Given names". It does not say which given
  // name is a first and which is a middle, so neither may we.
  stubFetch();
  const { body } = await callRead("leader@trip.example", { email: "mia@example.com" });
  assert.equal(body.passportFirst, "JONATHAN MICHAEL");
  assert.equal(body.passportLast, "SMITH");
});

test("a name is transcribed verbatim — accents and punctuation survive", async () => {
  stubFetch({ visionReply: {
    readable: true, surname: "ST. JOHN-MÜLLER", given_names: "MARÍA JOSÉ",
    document_number: "LA123456", date_of_birth: "2008-03-15", expiry_date: "2030-06-01",
    source: "printed", reason: "",
  } });
  const { body } = await callRead("leader@trip.example", { email: "mia@example.com" });
  // The old cleaner stripped everything outside [letters, space, hyphen,
  // apostrophe], which turned "ST. JOHN-MÜLLER" into "ST JOHN-MÜLLER".
  assert.equal(body.passportLast, "ST. JOHN-MÜLLER");
  assert.equal(body.passportFirst, "MARÍA JOSÉ");
});

test("MRZ filler is decoded, but nothing else is altered", async () => {
  stubFetch({ visionReply: {
    readable: true, surname: "VAN<DER<BERG", given_names: "JAN<PIETER",
    document_number: "", date_of_birth: "", expiry_date: "", source: "mrz", reason: "",
  } });
  const { body } = await callRead("leader@trip.example", { email: "mia@example.com" });
  assert.equal(body.passportLast, "VAN DER BERG");
  assert.equal(body.passportFirst, "JAN PIETER");
});

test("a passport number keeps its own punctuation and case", async () => {
  stubFetch({ visionReply: {
    readable: true, surname: "SMITH", given_names: "JON",
    document_number: "la-123456", date_of_birth: "", expiry_date: "", source: "printed", reason: "",
  } });
  const { body } = await callRead("leader@trip.example", { email: "mia@example.com" });
  assert.equal(body.passportNumber, "la-123456");
  // Comparison is still case- and separator-insensitive, so this matches the
  // "LA123456" on the form.
  assert.equal(body.numberVerdict, NUMBER_VERDICT.MATCH);
});

test("a date that isn't returned in the exact requested form is dropped, never coerced", async () => {
  stubFetch({ visionReply: {
    readable: true, surname: "SMITH", given_names: "JON",
    document_number: "LA123456", date_of_birth: "circa 2008", expiry_date: "2030/06/01",
    source: "printed", reason: "",
  } });
  const { body } = await callRead("leader@trip.example", { email: "mia@example.com" });
  assert.equal(body.passportDob, "");
  assert.equal(body.passportExpiry, "");
});

test("a cache from before the date checks is re-read, not served as blanks", async () => {
  // Every record read before the dob/expiry checks shipped has no verdict
  // stored for them. Treating that as a valid cache would leave those two
  // checks permanently undone on everyone already in the system, and the
  // panel would show the dates as empty forever.
  const { createHash } = await import("node:crypto");
  stubFetch({ contactProps: {
    [PASSPORT_PROPS.ocrStatus]: "ok",
    [PASSPORT_PROPS.ocrFirst]: "JONATHAN",
    [PASSPORT_PROPS.ocrLast]: "SMITH",
    [PASSPORT_PROPS.ocrNumber]: "match",
    // dob + expiry verdicts absent — an older read.
    [PASSPORT_PROPS.ocrHash]: createHash("sha256")
      .update("https://www.jotform.com/uploads/passport.jpg").digest("hex").slice(0, 32),
  } });
  const { body } = await callRead("leader@trip.example", { email: "mia@example.com" });
  assert.notEqual(body.cached, true, "a stale cache must not be served");
  assert.equal(sent.visionCalls, 1);
  assert.equal(body.passportDob, "2008-03-15");
  assert.equal(body.dobVerdict, DATE_VERDICT.MATCH);
});

// --- 4. the ops tick --------------------------------------------------------

function callVerify(email, payload) {
  return setVerified({
    httpMethod: "POST",
    headers: { authorization: `Bearer ${createToken({ email, role: email.includes("ops") ? "Director" : "user", ver: 0 })}` },
    body: JSON.stringify(payload),
  }).then(r => ({ statusCode: r.statusCode, body: JSON.parse(r.body) }));
}

test("an expedition leader cannot tick the ops check", async () => {
  stubFetch();
  const { statusCode } = await callVerify("leader@trip.example", { email: "mia@example.com", verified: true });
  assert.equal(statusCode, 403);
  assert.equal(sent.patch, null);
});

test("ops can tick it, and the tick is attributed", async () => {
  stubFetch();
  const { statusCode } = await callVerify("ops@unearthed.example", { email: "mia@example.com", verified: true });
  assert.equal(statusCode, 200);
  assert.equal(sent.patch[PASSPORT_PROPS.verified], "true");
  assert.equal(sent.patch[PASSPORT_PROPS.verifiedBy], "ops@unearthed.example");
  assert.ok(sent.patch[PASSPORT_PROPS.verifiedAt]);
});

test("un-ticking clears who signed it off", async () => {
  stubFetch();
  await callVerify("ops@unearthed.example", { email: "mia@example.com", verified: false });
  assert.equal(sent.patch[PASSPORT_PROPS.verified], "false");
  assert.equal(sent.patch[PASSPORT_PROPS.verifiedBy], "");
  assert.equal(sent.patch[PASSPORT_PROPS.verifiedAt], "");
});

await run();
console.log(`\n${passed} passed`);
