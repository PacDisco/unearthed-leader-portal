// Tests for the school-leader roster returned by get-students.js — the
// "SCHOOL LEADERS" grid on the Expedition Leader tab.
//
// Run with:  node test/leader-roster.test.mjs   (or npm test)
//
// HubSpot and Jotform are stubbed at the global fetch boundary, so these
// exercise the real handler: association bucketing by label, the batch reads,
// photo preference (form portrait → HubSpot headshot), and the failure modes
// that must not take the student roster down with them.

import assert from "node:assert/strict";

process.env.SESSION_SECRET = "test-secret-value-that-is-long-enough";
process.env.HUBSPOT_API_KEY = "hs-test-key";
process.env.JOTFORM_API_KEY = "jf-test-key";
process.env.JOTFORM_APPLICATION_FORM_ID = "111111";

const { createToken } = await import("../netlify/functions/_shared/auth.js");
const { handler } = await import("../netlify/functions/get-students.js");

// Tests run SEQUENTIALLY: each one installs its own global fetch stub, so
// overlapping them would let one test's stub answer another's request.
let passed = 0;
const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}
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

const PORTAL_ID = "9001";
const PORTAL_OBJECT = "2-58156993";

// Admin token: assertPortalAccess short-circuits on admin, so these tests
// cover the roster shaping rather than re-testing the authz helper (which
// portal-access.js owns).
const TOKEN = createToken({ email: "admin@unearthed.example", role: "Director", ver: 0 });

const CONTACTS = {
  // students
  "10": { id: "10", properties: { firstname: "Mia",   lastname: "Reynolds", email: "mia@example.com",  phone: "021 111", ue_student_status: "Cleared" } },
  // teachers — "Bell" sorts before "Okafor" to prove alphabetical ordering
  "20": { id: "20", properties: { firstname: "Sarah", lastname: "Okafor",   email: "sarah@school.example", phone: "021 222", expedition_leader_photo: "" } },
  "21": { id: "21", properties: { firstname: "Tom",   lastname: "Bell",     email: "tom@school.example",   phone: "",        expedition_leader_photo: "778899" } },
};

const ASSOCIATIONS = [
  { toObjectId: "10", associationTypes: [{ label: "Student" }] },
  { toObjectId: "20", associationTypes: [{ label: "Teacher" }] },
  { toObjectId: "21", associationTypes: [{ label: "Teacher" }] },
  // A parent on the trip must NOT land in either roster list.
  { toObjectId: "30", associationTypes: [{ label: "Parent" }] },
];

// Only Sarah has a portrait on her application-form submission. Tom does not,
// so he should fall back to his HubSpot headshot (File ID 778899).
const JOTFORM_SUBMISSIONS = [
  {
    id: "s1", created_at: "2026-03-01 10:00:00",
    answers: {
      1: { type: "control_email", text: "Email", order: "1", answer: "mia@example.com" },
      2: { type: "control_fileupload", text: "Portrait Photo", order: "2", answer: ["https://www.jotform.com/uploads/mia.jpg"] },
    }
  },
  {
    id: "s2", created_at: "2026-03-02 10:00:00",
    answers: {
      1: { type: "control_email", text: "Email", order: "1", answer: "sarah@school.example" },
      2: { type: "control_fileupload", text: "Portrait Photo", order: "2", answer: ["https://www.jotform.com/uploads/sarah.jpg"] },
    }
  },
];

function jsonRes(body, ok = true, status = 200) {
  return {
    ok, status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

// Installs a stubbed global fetch. `opts.failTeacherRead` makes the teacher
// batch-read return a 500 so we can assert the student roster survives it.
function stubFetch(opts = {}) {
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);

    // Token-revocation lookup in authenticate(): returning not-ok makes it
    // fail open on the version check (signature + expiry still apply).
    if (u.includes("/crm/v3/objects/contacts/search")) return jsonRes({}, false, 404);

    if (u.includes(`/objects/${PORTAL_OBJECT}/${PORTAL_ID}/associations/contacts`)) {
      return jsonRes({ results: ASSOCIATIONS });
    }

    if (u.includes("/crm/v3/objects/contacts/batch/read")) {
      const body = JSON.parse(init.body || "{}");
      const ids = (body.inputs || []).map(i => String(i.id));
      const isTeacherRead = (body.properties || []).includes("expedition_leader_photo");
      if (isTeacherRead && opts.failTeacherRead) return jsonRes({ error: "boom" }, false, 500);
      return jsonRes({ results: ids.map(id => CONTACTS[id]).filter(Boolean) });
    }

    // No parents, no deals — not what these tests are about.
    if (u.includes("/associations/contacts") || u.includes("/associations/deals")) {
      return jsonRes({ results: [] });
    }

    if (u.includes("/files/v3/files/778899/signed-url")) {
      return jsonRes({ url: "https://cdn.hubspot.example/tom-headshot.png" });
    }

    if (u.includes("api.jotform.com/form/111111/submissions")) {
      return jsonRes({ content: JOTFORM_SUBMISSIONS });
    }
    if (u.includes("api.jotform.com/form/")) return jsonRes({ content: [] });

    throw new Error(`unstubbed fetch: ${u}`);
  };
}

async function callHandler() {
  const res = await handler({
    queryStringParameters: { portalId: PORTAL_ID },
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  return { statusCode: res.statusCode, body: JSON.parse(res.body) };
}

// --- tests ------------------------------------------------------------------

test("returns teachers alongside students, sorted by display name", async () => {
  stubFetch();
  const { statusCode, body } = await callHandler();
  assert.equal(statusCode, 200);
  assert.deepEqual(body.students.map(s => s.name), ["Mia Reynolds"]);
  // Sorted on the full "First Last" display name, matching how students and
  // the Overview tab's contact lists are already ordered.
  assert.deepEqual(body.teachers.map(t => t.name), ["Sarah Okafor", "Tom Bell"]);
});

test("a Parent association never appears in either roster", async () => {
  stubFetch();
  const { body } = await callHandler();
  const ids = [...body.students, ...body.teachers].map(p => p.id);
  assert.ok(!ids.includes("30"), "parent contact leaked into the roster");
});

test("teacher card carries the contact fields the card renders", async () => {
  stubFetch();
  const { body } = await callHandler();
  const sarah = body.teachers.find(t => t.name === "Sarah Okafor");
  assert.equal(sarah.email, "sarah@school.example");
  assert.equal(sarah.phone, "021 222");
  assert.equal(sarah.role, "Teacher");
  // No student-only fields on a staff record.
  assert.equal(sarah.parents, undefined);
  assert.equal(sarah.totalPaid, undefined);
});

test("form portrait wins, proxied with the caller's token", async () => {
  stubFetch();
  const { body } = await callHandler();
  const sarah = body.teachers.find(t => t.name === "Sarah Okafor");
  assert.ok(sarah.portraitUrl.startsWith("/document-proxy?url="));
  assert.ok(sarah.portraitUrl.includes(encodeURIComponent("https://www.jotform.com/uploads/sarah.jpg")));
  assert.ok(sarah.portraitUrl.includes(`token=${encodeURIComponent(TOKEN)}`));
});

test("no form portrait falls back to the HubSpot headshot, unproxied", async () => {
  stubFetch();
  const { body } = await callHandler();
  const tom = body.teachers.find(t => t.name === "Tom Bell");
  assert.equal(tom.portraitUrl, "https://cdn.hubspot.example/tom-headshot.png");
  // A HubSpot CDN URL must NOT pick up the proxy token — signed URLs break
  // when reserialised through /document-proxy.
  assert.ok(!tom.portraitUrl.includes("token="));
});

test("a failed teacher read still returns the student roster", async () => {
  stubFetch({ failTeacherRead: true });
  const { statusCode, body } = await callHandler();
  assert.equal(statusCode, 200);
  assert.deepEqual(body.students.map(s => s.name), ["Mia Reynolds"]);
  assert.deepEqual(body.teachers, []);
});

test("teachers are returned even when the trip has no students", async () => {
  stubFetch();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes(`/${PORTAL_ID}/associations/contacts`)) {
      return jsonRes({ results: ASSOCIATIONS.filter(a => a.toObjectId !== "10") });
    }
    return realFetch(url, init);
  };
  const { body } = await callHandler();
  assert.deepEqual(body.students, []);
  assert.equal(body.teachers.length, 2);
});

test("a trip with neither students nor teachers returns both lists empty", async () => {
  stubFetch();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes(`/${PORTAL_ID}/associations/contacts`)) {
      return jsonRes({ results: [ASSOCIATIONS[3]] });
    }
    return realFetch(url, init);
  };
  const { body } = await callHandler();
  assert.deepEqual(body.students, []);
  assert.deepEqual(body.teachers, []);
});

await run();
console.log(`\n${passed} passed`);
