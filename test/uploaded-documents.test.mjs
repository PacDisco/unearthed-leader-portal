// Unit tests for household document pooling — the audience rules in
// _shared/household.js and the submission matching in
// get-uploaded-documents.js.
//
// Run with:  node test/uploaded-documents.test.mjs   (or npm test)
//
// These cover the pure logic only. The HubSpot and Jotform reads need live
// credentials and are exercised against the deployed endpoint.
//
// The "staff view" cases below exercise the same function as the leader
// portal: this endpoint is shared code, and an admin can pass ?email= here
// too, so both paths are worth covering in both repos.

import assert from "node:assert/strict";
import { buildAudience, submitterEmails } from "../netlify/functions/_shared/household.js";
import { documentsFromSubmission } from "../netlify/functions/get-uploaded-documents.js";

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; }
  catch (err) {
    console.error(`FAIL  ${name}\n      ${err.message}`);
    process.exitCode = 1;
  }
}

// --- fixtures ---------------------------------------------------------------

const STUDENT  = { id: "1", email: "mia@example.com", name: "Mia Reynolds",   role: "Student" };
const PARENT   = { id: "2", email: "dad@example.com", name: "Peter Reynolds", role: "Parent" };
const PARENT2  = { id: "3", email: "mum@example.com", name: "Anna Reynolds",  role: "Parent" };
const STAFF_EMAIL = "leader@unearthed.example";

const FILE = "https://www.jotform.com/uploads/pd/1/2/passport.pdf";

// Shaped like the free-form document-upload form: email field(s), a "Document
// Name" textbox, then a generic file upload. `emails` is a list of
// [label, address] pairs so a test can place an emergency-contact field.
function submission({ emails = [], docName = null, upload = null, label = "Upload", created = "2026-03-01 10:00:00" } = {}) {
  const answers = {};
  let order = 1;
  for (const entry of emails) {
    const [text, answer] = Array.isArray(entry) ? entry : ["Email", entry];
    answers[String(order)] = { type: "control_email", text, order: String(order), answer };
    order++;
  }
  if (docName) {
    answers[String(order)] = { type: "control_textbox", text: "Document Name", order: String(order), answer: docName };
    order++;
  }
  if (upload) {
    answers[String(order)] = { type: "control_fileupload", text: label, order: String(order), answer: upload };
  }
  return { id: "sub", created_at: created, answers };
}

// The staff case: viewing Mia's record, logged in as a leader/teacher.
const staffView = () => buildAudience("mia@example.com", [STUDENT, PARENT], STAFF_EMAIL);
// The household's own case: Mia viewing her own portal.
const ownView = () => buildAudience("mia@example.com", [STUDENT, PARENT], "mia@example.com");

// --- buildAudience ----------------------------------------------------------

test("the anchor is always in the audience, even with no contacts", () => {
  const a = buildAudience("MIA@Example.com ", [], STAFF_EMAIL);
  assert.equal(a.size, 1);
  assert.ok(a.has("mia@example.com"), "email is lower-cased and trimmed");
  assert.equal(a.get("mia@example.com").isAnchor, true);
});

test("household contacts join the audience with their roles", () => {
  const a = staffView();
  assert.deepEqual([...a.keys()].sort(), ["dad@example.com", "mia@example.com"]);
  assert.equal(a.get("dad@example.com").role, "Parent");
  assert.equal(a.get("dad@example.com").name, "Peter Reynolds");
});

test("nothing is 'you' when a leader is the viewer", () => {
  const a = staffView();
  assert.ok([...a.values()].every(p => !p.isSelf));
});

test("the viewer is flagged isSelf when they are in the household", () => {
  const a = ownView();
  assert.equal(a.get("mia@example.com").isSelf, true);
  assert.equal(a.get("dad@example.com").isSelf, false);
});

test("contacts with no email are skipped rather than matching everything", () => {
  const a = buildAudience("mia@example.com", [{ id: "9", email: "", name: "No Email" }], STAFF_EMAIL);
  assert.equal(a.size, 1);
  assert.ok(!a.has(""));
});

// --- submitterEmails --------------------------------------------------------

test("a parent email field counts as the submitter", () => {
  // Unlike the instructor-side forms, a parent IS the person filling in a
  // student document-upload form — excluding these would hide the very
  // uploads this change exists to surface.
  assert.deepEqual(
    submitterEmails(submission({ emails: [["Parent/Guardian Email", "dad@example.com"]] })),
    ["dad@example.com"]
  );
});

test("an emergency-contact email is never treated as the submitter", () => {
  const emails = submitterEmails(submission({
    emails: [["Student Email", "mia@example.com"], ["Emergency Contact Email", "someone@example.com"]]
  }));
  assert.deepEqual(emails, ["mia@example.com"]);
});

test("next-of-kin, referee and doctor fields are excluded too", () => {
  const emails = submitterEmails(submission({
    emails: [
      ["Next of Kin Email", "a@example.com"],
      ["Referee Email", "b@example.com"],
      ["Doctor's Email", "c@example.com"],
      ["Email", "mia@example.com"]
    ]
  }));
  assert.deepEqual(emails, ["mia@example.com"]);
});

test("candidates come back in display order, de-duplicated", () => {
  const s = submission({ emails: [] });
  s.answers = {
    "40": { type: "control_email", text: "Email", order: "3", answer: "third@example.com" },
    "6":  { type: "control_email", text: "Email", order: "1", answer: "First@example.com" },
    "9":  { type: "control_email", text: "Email", order: "2", answer: "first@example.com" }
  };
  assert.deepEqual(submitterEmails(s), ["first@example.com", "third@example.com"]);
});

// --- the bug this change fixes ---------------------------------------------

test("a leader sees a document the parent uploaded", () => {
  const docs = documentsFromSubmission(
    submission({ emails: ["dad@example.com"], docName: "Consent letter", upload: [FILE] }),
    staffView()
  );
  assert.equal(docs.length, 1, "a parent's upload belongs on the student's record");
  assert.equal(docs[0].fieldLabel, "Consent letter");
  assert.equal(docs[0].uploadedByName, "Peter Reynolds");
  assert.equal(docs[0].uploadedByRole, "Parent");
  assert.equal(docs[0].uploadedByStudent, false);
  assert.equal(docs[0].uploadedByMe, false);
});

test("a leader still sees the student's own uploads", () => {
  const docs = documentsFromSubmission(
    submission({ emails: ["mia@example.com"], upload: [FILE], label: "Passport" }),
    staffView()
  );
  assert.equal(docs.length, 1);
  assert.equal(docs[0].uploadedByStudent, true);
});

test("a student sees a document their parent uploaded, and vice versa", () => {
  const mia = documentsFromSubmission(
    submission({ emails: ["dad@example.com"], upload: [FILE], label: "Passport" }),
    ownView()
  );
  assert.equal(mia.length, 1);
  assert.equal(mia[0].uploadedByMe, false);

  const dad = documentsFromSubmission(
    submission({ emails: ["mia@example.com"], upload: [FILE], label: "Passport" }),
    buildAudience("mia@example.com", [STUDENT, PARENT], "dad@example.com")
  );
  assert.equal(dad.length, 1);
  assert.equal(dad[0].uploadedByStudent, true);
});

test("a second parent on the deal is included", () => {
  const docs = documentsFromSubmission(
    submission({ emails: ["mum@example.com"], docName: "Insurance", upload: [FILE] }),
    buildAudience("mia@example.com", [STUDENT, PARENT, PARENT2], STAFF_EMAIL)
  );
  assert.equal(docs.length, 1);
  assert.equal(docs[0].uploadedByName, "Anna Reynolds");
});

// --- what must NOT leak -----------------------------------------------------

test("a submission from another family is excluded", () => {
  const docs = documentsFromSubmission(
    submission({ emails: ["other.parent@example.com"], upload: [FILE], label: "Passport" }),
    staffView()
  );
  assert.equal(docs.length, 0, "pooling is per-household, not per-program");
});

test("another student's file can't be filed here via an emergency-contact field", () => {
  // Student B's form lists Mia's father as her emergency contact. Matching on
  // any email would have put B's passport on Mia's record.
  const docs = documentsFromSubmission(
    submission({
      emails: [["Student Email", "otherkid@example.com"], ["Emergency Contact Email", "dad@example.com"]],
      upload: [FILE],
      label: "Passport"
    }),
    staffView()
  );
  assert.equal(docs.length, 0);
});

test("a submission with no email at all is excluded", () => {
  const docs = documentsFromSubmission(
    submission({ emails: [], docName: "Passport", upload: [FILE] }),
    staffView()
  );
  assert.equal(docs.length, 0);
});

test("no email address reaches the browser", () => {
  const [doc] = documentsFromSubmission(
    submission({ emails: ["dad@example.com"], upload: [FILE], label: "Passport" }),
    staffView()
  );
  assert.ok(!JSON.stringify(doc).includes("@"), "cards carry names and roles, not addresses");
});

// --- source form ------------------------------------------------------------

test("each document carries the form it arrived on", () => {
  const [doc] = documentsFromSubmission(
    submission({ emails: ["mia@example.com"], upload: [FILE], label: "Passport" }),
    staffView(),
    { formId: "261220345497052", formTitle: "Student Documents" }
  );
  assert.equal(doc.formId, "261220345497052");
  assert.equal(doc.formTitle, "Student Documents");
});

// --- existing behaviour must survive the refactor ---------------------------

test("a specific upload-field label is kept as the heading", () => {
  const [doc] = documentsFromSubmission(
    submission({ emails: ["mia@example.com"], upload: [FILE], label: "Passport" }),
    staffView()
  );
  assert.equal(doc.fieldLabel, "Passport");
});

test("a generic label with nothing typed leaves the heading off", () => {
  const [doc] = documentsFromSubmission(
    submission({ emails: ["mia@example.com"], upload: [FILE], label: "Additional File Upload" }),
    staffView()
  );
  assert.equal(doc.fieldLabel, null);
});

test("a typed Document Name beats a generic upload label", () => {
  const [doc] = documentsFromSubmission(
    submission({ emails: ["mia@example.com"], docName: "Vaccination record", upload: [FILE], label: "Upload" }),
    staffView()
  );
  assert.equal(doc.fieldLabel, "Vaccination record");
});

test("multiple files in one upload field each become a document", () => {
  const docs = documentsFromSubmission(
    submission({
      emails: ["mia@example.com"],
      docName: "Visa docs",
      upload: [FILE, "https://www.jotform.com/uploads/pd/1/2/visa%20letter.pdf"]
    }),
    staffView()
  );
  assert.equal(docs.length, 2);
  assert.equal(docs[0].filename, "passport.pdf");
  assert.equal(docs[1].filename, "visa letter.pdf", "filenames stay URL-decoded");
});

test("a submission with no files contributes nothing", () => {
  const docs = documentsFromSubmission(
    submission({ emails: ["mia@example.com"], docName: "Passport" }),
    staffView()
  );
  assert.equal(docs.length, 0);
});

test("the upload date is carried through", () => {
  const [doc] = documentsFromSubmission(
    submission({ emails: ["mia@example.com"], upload: [FILE], created: "2026-02-14 09:30:00" }),
    staffView()
  );
  assert.equal(doc.uploadedAt, "2026-02-14 09:30:00");
});

if (!process.exitCode) console.log(`uploaded-documents.test.mjs — ${passed} passed`);
