// Tests for expedition-leader roster editing — the EDIT action on the
// Expedition Leader tab that writes back to the Jotform submission and the
// HubSpot contact.
//
// Run with:  node test/roster-edit.test.mjs   (or npm test)
//
// Two layers:
//   1. Pure logic — the contact-property whitelist, the audit-note body, and
//      the two jotform.js behaviours that differ between the student's own
//      editor and the leader's (sensitive values revealed / blanks written).
//   2. The update-person handler end to end with HubSpot and Jotform stubbed
//      at the fetch boundary. The authorization cases matter most here: a
//      teacher can READ a student's medical answers and must not be able to
//      change them.

import assert from "node:assert/strict";

process.env.SESSION_SECRET = "test-secret-value-that-is-long-enough";
process.env.HUBSPOT_API_KEY = "hs-test-key";
process.env.JOTFORM_API_KEY = "jf-test-key";
process.env.JOTFORM_APPLICATION_FORM_ID = "111111";

const { createToken } = await import("../netlify/functions/_shared/auth.js");
const {
  filterContactChanges,
  buildAuditNoteBody,
} = await import("../netlify/functions/_shared/roster-edit.js");
const {
  buildUpdatePayload,
  buildClientFields,
  describeFields,
} = await import("../netlify/functions/lib/jotform.js");
const { handler } = await import("../netlify/functions/update-person.js");
const { handler: formHandler } = await import("../netlify/functions/get-person-form.js");

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

// --- fixtures ---------------------------------------------------------------

const PORTAL_OBJECT = "2-58156993";
const PORTAL_ID = "9001";
const OTHER_PORTAL = "9002";

const CONTACT_IDS = {
  "leader@trip.example":   "100",  // Trip Leader on 9001
  "other@trip.example":    "101",  // Trip Leader on 9002 only
  "teacher@school.example": "20",  // Teacher on 9001
  "mia@example.com":        "10",  // Student on 9001
  "admin@unearthed.example": "1",
};

const PORTAL_MEMBERS = {
  [PORTAL_ID]: [
    { toObjectId: "100", associationTypes: [{ label: "Trip Leader" }] },
    { toObjectId: "20",  associationTypes: [{ label: "Teacher" }] },
    { toObjectId: "10",  associationTypes: [{ label: "Student" }] },
  ],
  [OTHER_PORTAL]: [
    { toObjectId: "101", associationTypes: [{ label: "Trip Leader" }] },
  ],
};

const PORTALS_FOR_CONTACT = {
  "100": [PORTAL_ID], "20": [PORTAL_ID], "10": [PORTAL_ID], "101": [OTHER_PORTAL], "1": [],
};

// A submission with one plain field, one sensitive (medical) field and an
// address composite, so the payload rules can be exercised.
const SUBMISSION = {
  id: "sub-1",
  created_at: "2026-03-01 10:00:00",
  answers: {
    "1": { type: "control_email",    text: "Email",            order: "1", answer: "mia@example.com" },
    "2": { type: "control_textbox",  text: "Emergency Contact", order: "2", answer: "Anna Reynolds" },
    "3": { type: "control_textbox",  text: "Passport Number",   order: "3", answer: "LA123456" },
    "4": { type: "control_textarea", text: "Do you have any food allergies?", order: "4", answer: "Peanuts" },
    "5": { type: "control_datetime", text: "Expiry Date",       order: "5", answer: { day: "01", month: "06", year: "2030" } },
    "6": { type: "control_address",  text: "Home Address",      order: "6", answer: { addr_line1: "1 High St", city: "Dunedin" } },
  },
};

function jsonRes(body, ok = true, status = 200) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) };
}

// Captures what the handler wrote, so tests can assert on the actual requests
// rather than only on the response body.
let sent;

function stubFetch(opts = {}) {
  sent = { jotform: null, contactPatch: null, note: null };

  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const body = init.body ? String(init.body) : "";

    // --- HubSpot contact search: token-version read vs. email → id lookup ---
    if (u.includes("/crm/v3/objects/contacts/search")) {
      const parsed = JSON.parse(body || "{}");
      const wanted = parsed.filterGroups?.[0]?.filters?.[0]?.value;
      if ((parsed.properties || []).includes("portal_token_version")) {
        // Token is minted with ver 0; match it so authenticate() passes.
        return jsonRes({ results: [{ id: CONTACT_IDS[wanted] || "0", properties: { portal_token_version: "0" } }] });
      }
      const id = CONTACT_IDS[wanted];
      return jsonRes({ results: id ? [{ id, properties: { email: wanted } }] : [] });
    }

    // --- contact → portals ---
    let m = u.match(/\/crm\/v4\/objects\/contacts\/(\d+)\/associations\/2-58156993/);
    if (m) {
      return jsonRes({ results: (PORTALS_FOR_CONTACT[m[1]] || []).map(id => ({ toObjectId: id })) });
    }

    // --- portal → contacts (with labels) ---
    m = u.match(new RegExp(`/objects/${PORTAL_OBJECT}/(\\d+)/associations/contacts`));
    if (m) return jsonRes({ results: PORTAL_MEMBERS[m[1]] || [] });

    // --- Jotform ---
    if (u.includes("api.jotform.com/form/111111/submissions")) {
      return jsonRes({ content: opts.noSubmission ? [] : [SUBMISSION] });
    }
    if (u.includes("api.jotform.com/form/")) return jsonRes({ content: [] });
    if (u.includes("api.jotform.com/submission/")) {
      if (opts.jotformFails) return jsonRes({ error: "nope" }, false, 500);
      sent.jotform = body;
      return jsonRes({ responseCode: 200 });
    }

    // --- HubSpot contact read (get-person-form prefill) ---
    if (u.match(/\/crm\/v3\/objects\/contacts\/\d+\?properties=/) && (init.method || "GET") === "GET") {
      return jsonRes({ id: "10", properties: { phone: "021 111", ue_student_status: "Cleared", notes__c: "" } });
    }

    // --- HubSpot writes ---
    if (u.match(/\/crm\/v3\/objects\/contacts\/\d+$/) && (init.method === "PATCH")) {
      if (opts.contactPatchFails) return jsonRes({ error: "nope" }, false, 500);
      sent.contactPatch = JSON.parse(body || "{}");
      return jsonRes({ id: "10" });
    }
    if (u.includes("/crm/v3/objects/notes")) {
      if (opts.noteFails) return jsonRes({ error: "nope" }, false, 500);
      sent.note = JSON.parse(body || "{}");
      return jsonRes({ id: "note-1" });
    }

    throw new Error(`unstubbed fetch: ${init.method || "GET"} ${u}`);
  };
}

function call(email, payload) {
  return handler({
    httpMethod: "POST",
    headers: { authorization: `Bearer ${createToken({ email, role: email.includes("admin") ? "Director" : "user", ver: 0 })}` },
    body: JSON.stringify(payload),
  }).then(res => ({ statusCode: res.statusCode, body: JSON.parse(res.body) }));
}

// --- 1. pure logic ----------------------------------------------------------

test("contact whitelist: phone is editable for anyone on the trip", () => {
  const { properties, skipped } = filterContactChanges({ phone: "021 000" }, { isStudent: false });
  assert.deepEqual(properties, { phone: "021 000" });
  assert.deepEqual(skipped, []);
});

test("contact whitelist: status and notes are student-only", () => {
  const forStudent = filterContactChanges({ ue_student_status: "Cleared", notes__c: "ok" }, { isStudent: true });
  assert.deepEqual(Object.keys(forStudent.properties).sort(), ["notes__c", "ue_student_status"]);

  const forTeacher = filterContactChanges({ ue_student_status: "Cleared", notes__c: "ok" }, { isStudent: false });
  assert.deepEqual(forTeacher.properties, {});
  assert.equal(forTeacher.skipped.length, 2);
});

test("contact whitelist: anything off the list is refused", () => {
  // email is the key submissions are matched on — editing it would orphan
  // this person's application.
  const { properties, skipped } = filterContactChanges(
    { email: "new@example.com", hs_lead_status: "x", phone: "021 1" }, { isStudent: true }
  );
  assert.deepEqual(properties, { phone: "021 1" });
  assert.deepEqual(skipped.map(s => s.field).sort(), ["email", "hs_lead_status"]);
});

test("leader write: a blank sensitive field is a deliberate clear", () => {
  const changes = { "3": "" }; // Passport Number — matches the sensitive patterns
  const asStudent = buildUpdatePayload(SUBMISSION, changes);
  assert.deepEqual(asStudent.fields, {}, "self-service editor must preserve it");
  assert.match(asStudent.skipped[0].reason, /preserved/);

  const asLeader = buildUpdatePayload(SUBMISSION, changes, { allowSensitiveBlank: true });
  assert.deepEqual(asLeader.fields, { "3": "" }, "leader editor must write the clear");
});

test("read-only types are refused whatever the caller claims", () => {
  // Date, email and file uploads can't take a flat write without corrupting
  // the stored shape.
  const { fields, skipped } = buildUpdatePayload(
    SUBMISSION, { "5": "2031-01-01", "1": "hacker@example.com" }, { allowSensitiveBlank: true }
  );
  assert.deepEqual(fields, {});
  assert.equal(skipped.length, 2);
});

test("a date is writable through its subfields but not as a flat string", () => {
  // Flat write refused — that's what corrupts the stored {day, month, year}.
  const flat = buildUpdatePayload(SUBMISSION, { "5": "2031-01-01" }, { allowSensitiveBlank: true });
  assert.deepEqual(flat.fields, {});

  // Subfield write accepted — this is how a passport expiry gets corrected.
  const parts = buildUpdatePayload(
    SUBMISSION, { "5_day": "2", "5_month": "7", "5_year": "2031" }, { allowSensitiveBlank: true }
  );
  assert.deepEqual(parts.fields, { "5_day": "2", "5_month": "7", "5_year": "2031" });
});

test("a Jotform Birth Date field is editable through its subfields", () => {
  const sub = { id: "s", answers: {
    "7": { type: "control_birthdate", text: "Birthday", order: "7", answer: { day: "15", month: "3", year: "2008" } },
  } };
  const { fields } = buildUpdatePayload(sub, { "7_day": "16" }, { allowSensitiveBlank: true });
  assert.deepEqual(fields, { "7_day": "16" });
  // And a flat write is still refused.
  assert.deepEqual(buildUpdatePayload(sub, { "7": "2008-03-16" }, { allowSensitiveBlank: true }).fields, {});
});

test("an unknown date subfield is refused", () => {
  const { fields, skipped } = buildUpdatePayload(
    SUBMISSION, { "5_hour": "09" }, { allowSensitiveBlank: true }
  );
  assert.deepEqual(fields, {});
  assert.match(skipped[0].reason, /subfield/);
});

test("address composites are written subfield by subfield", () => {
  const { fields } = buildUpdatePayload(SUBMISSION, { "6_city": "Wanaka" }, { allowSensitiveBlank: true });
  assert.deepEqual(fields, { "6_city": "Wanaka" });
});

test("buildClientFields hides sensitive values by default, reveals them for a leader", () => {
  const hidden = buildClientFields(SUBMISSION).find(f => f.label === "Passport Number");
  assert.equal(hidden.value, null);
  assert.equal(hidden.sensitive, true);

  const shown = buildClientFields(SUBMISSION, { revealSensitive: true }).find(f => f.label === "Passport Number");
  assert.equal(shown.value, "LA123456");
  assert.equal(shown.sensitive, true, "still flagged, just not withheld");
});

test("buildClientFields includes fields left blank so a gap can be filled", () => {
  const sparse = { id: "s", answers: { "2": { type: "control_textbox", text: "Emergency Contact", order: "2" } } };
  const fields = buildClientFields(sparse, { revealSensitive: true });
  assert.equal(fields.length, 1);
  assert.equal(fields[0].hasValue, false);
  assert.equal(fields[0].editable, true);
});

test("describeFields resolves labels, including address subfields", () => {
  const described = describeFields(SUBMISSION, { "2": "Peter", "6_city": "Wanaka" });
  assert.deepEqual(described.map(d => d.label), ["Emergency Contact", "Home Address — City"]);
});

test("audit note records who, when and what — and escapes HTML", () => {
  const note = buildAuditNoteBody({
    editorEmail: "leader@trip.example",
    personName: "Mia Reynolds",
    changes: [
      { label: "Emergency Contact", value: "<script>x</script>" },
      { label: "Notes", value: "" },
    ],
    when: new Date("2026-04-02T03:04:00Z"),
  });
  assert.match(note, /leader@trip\.example/);
  assert.match(note, /Mia Reynolds/);
  assert.match(note, /2026-04-02 03:04 UTC/);
  assert.match(note, /Emergency Contact/);
  assert.ok(!note.includes("<script>"), "note body must not carry raw HTML");
  assert.match(note, /Notes: \(cleared\)/, "a cleared field should read as cleared, not blank");
});

// --- 2. update-person, end to end ------------------------------------------

test("a teacher cannot edit a student they can read", async () => {
  stubFetch();
  const { statusCode, body } = await call("teacher@school.example", {
    email: "mia@example.com", application: { "2": "Peter Reynolds" },
  });
  assert.equal(statusCode, 403);
  assert.match(body.error, /expedition leader/i);
  assert.equal(sent.jotform, null, "nothing may be written on a refusal");
  assert.equal(sent.contactPatch, null);
});

test("an expedition leader on another trip is refused", async () => {
  stubFetch();
  const { statusCode } = await call("other@trip.example", {
    email: "mia@example.com", application: { "2": "Peter Reynolds" },
  });
  assert.equal(statusCode, 403);
  assert.equal(sent.jotform, null);
});

test("the trip's expedition leader saves to Jotform and HubSpot", async () => {
  stubFetch();
  const { statusCode, body } = await call("leader@trip.example", {
    email: "mia@example.com",
    name: "Mia Reynolds",
    application: { "2": "Peter Reynolds", "4": "Peanuts, shellfish" },
    contact: { phone: "021 555", ue_student_status: "Cleared" },
  });

  assert.equal(statusCode, 200);
  assert.equal(body.updated, true);
  assert.equal(body.applicationCount, 2);
  assert.equal(body.contactCount, 2);

  // Jotform is posted as form-encoded submission[QID]=value.
  assert.match(sent.jotform, /submission%5B2%5D=Peter\+Reynolds/);
  assert.match(sent.jotform, /submission%5B4%5D=Peanuts%2C\+shellfish/);

  assert.deepEqual(sent.contactPatch.properties, { phone: "021 555", ue_student_status: "Cleared" });
});

test("an admin may edit anyone", async () => {
  stubFetch();
  const { statusCode, body } = await call("admin@unearthed.example", {
    email: "mia@example.com", application: { "2": "Peter Reynolds" },
  });
  assert.equal(statusCode, 200);
  assert.equal(body.updated, true);
});

test("a school leader's own details are editable too, minus the student fields", async () => {
  stubFetch();
  const { statusCode, body } = await call("leader@trip.example", {
    email: "teacher@school.example",
    contact: { phone: "021 777", ue_student_status: "Cleared" },
  });
  assert.equal(statusCode, 200);
  assert.deepEqual(sent.contactPatch.properties, { phone: "021 777" });
  assert.equal(body.skipped.some(s => s.field === "ue_student_status"), true);
});

test("every save is logged against the contact", async () => {
  stubFetch();
  await call("leader@trip.example", {
    email: "mia@example.com", name: "Mia Reynolds", application: { "2": "Peter Reynolds" },
  });
  assert.ok(sent.note, "no audit note was written");
  assert.match(sent.note.properties.hs_note_body, /leader@trip\.example/);
  assert.match(sent.note.properties.hs_note_body, /Emergency Contact: Peter Reynolds/);
  // Associated to the person edited, not the editor.
  assert.equal(sent.note.associations[0].to.id, "10");
});

test("a failed audit note does not fail the save", async () => {
  stubFetch({ noteFails: true });
  const { statusCode, body } = await call("leader@trip.example", {
    email: "mia@example.com", application: { "2": "Peter Reynolds" },
  });
  assert.equal(statusCode, 200);
  assert.equal(body.updated, true);
  assert.equal(body.warnings.length, 1);
  assert.match(body.warnings[0], /couldn't be logged/i);
});

test("no submission on file still saves the contact side, with a warning", async () => {
  stubFetch({ noSubmission: true });
  const { statusCode, body } = await call("leader@trip.example", {
    email: "mia@example.com",
    application: { "2": "Peter Reynolds" },
    contact: { phone: "021 555" },
  });
  assert.equal(statusCode, 200);
  assert.equal(body.contactCount, 1);
  assert.equal(body.applicationCount, 0);
  assert.match(body.warnings[0], /No application submission/i);
});

test("an empty change set is a no-op", async () => {
  stubFetch();
  const { statusCode, body } = await call("leader@trip.example", { email: "mia@example.com" });
  assert.equal(statusCode, 200);
  assert.equal(body.updated, false);
  assert.equal(sent.jotform, null);
});

test("GET is refused", async () => {
  stubFetch();
  const res = await handler({ httpMethod: "GET", headers: {}, body: "" });
  assert.equal(res.statusCode, 405);
});

// --- 3. get-person-form: the endpoint that reveals sensitive values --------

function callForm(email, target) {
  return formHandler({
    httpMethod: "GET",
    queryStringParameters: { email: target },
    headers: { authorization: `Bearer ${createToken({ email, role: email.includes("admin") ? "Director" : "user", ver: 0 })}` },
  }).then(res => ({ statusCode: res.statusCode, body: JSON.parse(res.body) }));
}

test("the edit form refuses a teacher — it reveals passport and medical values", async () => {
  stubFetch();
  const { statusCode, body } = await callForm("teacher@school.example", "mia@example.com");
  assert.equal(statusCode, 403);
  assert.equal(body.fields, undefined);
});

test("the edit form gives the trip's leader the real values to edit", async () => {
  stubFetch();
  const { statusCode, body } = await callForm("leader@trip.example", "mia@example.com");
  assert.equal(statusCode, 200);
  const passport = body.fields.find(f => f.label === "Passport Number");
  assert.equal(passport.value, "LA123456");
  assert.equal(body.isStudent, true);
  // Name is editable because of the passport-matching problem; email is not.
  assert.deepEqual(body.editableContactFields,
    ["firstname", "lastname", "phone", "ue_student_status", "notes__c"]);
});

test("the edit form offers a school leader phone only", async () => {
  stubFetch();
  const { body } = await callForm("leader@trip.example", "teacher@school.example");
  assert.equal(body.isStudent, false);
  assert.deepEqual(body.editableContactFields, ["firstname", "lastname", "phone"]);
});

await run();
console.log(`\n${passed} passed`);
