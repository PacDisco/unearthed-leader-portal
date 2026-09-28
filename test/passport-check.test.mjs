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
          ...(opts.noPhoto ? {} : {
            "9": { type: "control_fileupload", text: "Passport Cover Page Photo", order: "9",
                   answer: ["https://www.jotform.com/uploads/passport.jpg"] }
          }),
        },
      }] });
    }
    if (u.includes("api.jotform.com/form/")) return jsonRes({ content: [] });

    if (u.includes("jotform.com/uploads/")) {
      sent.imageFetches++;
      return {
        ok: true, status: 200,
        headers: { get: () => "image/jpeg" },
        arrayBuffer: async () => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).buffer,
      };
    }

    if (u.includes("api.anthropic.com/v1/messages")) {
      sent.visionCalls++;
      if (opts.visionFails) return jsonRes({ error: "boom" }, false, 500);
      const payload = opts.visionReply || {
        readable: true, surname: "SMITH", given_names: "JONATHAN MICHAEL",
        document_number: opts.docNumber === undefined ? "LA123456" : opts.docNumber,
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
