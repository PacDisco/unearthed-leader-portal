// Unit tests for the group information export — middle-name resolution on the
// passenger sheet and the CSV/ZIP download.
//
// Run with:  node test/group-export.test.mjs   (or npm test)
//
// Pure logic only. The HubSpot and Jotform reads need live credentials and are
// exercised against the deployed endpoint.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runInThisContext } from "node:vm";

import { assembleGroupInfo } from "../netlify/functions/lib/group-info.js";
import { middleNameFromProps, nameParts, formatAnswer } from "../netlify/functions/get-group-info.js";

// The two public/ modules are browser scripts (IIFEs that attach to the global),
// not ES modules, so they are evaluated rather than imported.
const HERE = dirname(fileURLToPath(import.meta.url));
function loadBrowserScript(relPath, globalName) {
  const file = join(HERE, "..", relPath);
  runInThisContext(readFileSync(file, "utf8"), { filename: file });
  const api = globalThis[globalName];
  if (!api) throw new Error(`${relPath} did not define ${globalName}`);
  return api;
}
const GroupCsv = loadBrowserScript("public/group-csv.js", "GroupCsv");
const GroupPdf = loadBrowserScript("public/group-pdf.js", "GroupPdf");
const GroupPassports = loadBrowserScript("public/group-passports.js", "GroupPassports");

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; }
  catch (err) {
    console.error(`FAIL  ${name}\n      ${err.message}`);
    process.exitCode = 1;
  }
}

// --- fixtures ---------------------------------------------------------------

// A Jotform full-name answer, as it arrives on a submission.
function fullNameField(label, { first, middle, last }) {
  return {
    qid: "3",
    order: 1,
    type: "control_fullname",
    label,
    value: [first, middle, last].filter(Boolean).join(" "),
    parts: { prefix: "", first: first || "", middle: middle || "", last: last || "", suffix: "" },
  };
}

const PASSPORT_LABEL = "Name (as noted in your passport)";

function group({ students = [], departureDate = "" } = {}) {
  return assembleGroupInfo({
    program: { name: "Fiji 2026", id: "99" },
    students: students.map(s => s.person),
    appByEmail: new Map(students.map(s => [s.person.email, s.fields || []])),
    departureDate,
    generatedAt: "2026-09-21T00:00:00.000Z",
  });
}

function travelRows(data) {
  return data.travel.groups.flatMap(g => g.rows);
}

// --- middle name: Jotform passport field -----------------------------------

test("middle name comes from the passport-name field's middle sub-field", () => {
  const data = group({
    students: [{
      person: { firstName: "Mia", lastName: "Reynolds", name: "Mia Reynolds", email: "mia@example.com" },
      fields: [fullNameField(PASSPORT_LABEL, { first: "Mia", middle: "Grace", last: "Reynolds" })],
    }],
  });
  assert.equal(travelRows(data)[0].middle, "Grace");
});

test("multiple middle names are kept intact", () => {
  const data = group({
    students: [{
      person: { firstName: "Tane", lastName: "Walker", name: "Tane Walker", email: "t@example.com" },
      fields: [fullNameField(PASSPORT_LABEL, { first: "Tane", middle: "Ari Joseph", last: "Walker" })],
    }],
  });
  assert.equal(travelRows(data)[0].middle, "Ari Joseph");
});

test("label matching is tolerant of case and punctuation drift", () => {
  const data = group({
    students: [{
      person: { firstName: "Ana", lastName: "Silva", name: "Ana Silva", email: "a@example.com" },
      fields: [fullNameField("Name as noted in your Passport", { first: "Ana", middle: "Sofia", last: "Silva" })],
    }],
  });
  assert.equal(travelRows(data)[0].middle, "Sofia");
});

test("a standalone Middle Name question is used when there is no full-name field", () => {
  const data = group({
    students: [{
      person: { firstName: "Leo", lastName: "Park", name: "Leo Park", email: "l@example.com" },
      fields: [{ label: "Middle Name", value: "James" }],
    }],
  });
  assert.equal(travelRows(data)[0].middle, "James");
});

test("the HubSpot middle name is the fallback when the form has neither", () => {
  const data = group({
    students: [{
      person: { firstName: "Zoe", middleName: "Rose", lastName: "Kahu", name: "Zoe Kahu", email: "z@example.com" },
      fields: [],
    }],
  });
  assert.equal(travelRows(data)[0].middle, "Rose");
});

test("no middle name anywhere yields an empty string, not undefined", () => {
  const data = group({
    students: [{
      person: { firstName: "Sam", lastName: "Doyle", name: "Sam Doyle", email: "s@example.com" },
      fields: [],
    }],
  });
  assert.equal(travelRows(data)[0].middle, "");
});

test("the passport field wins over the HubSpot fallback", () => {
  const data = group({
    students: [{
      person: { firstName: "Ivy", middleName: "Stale", lastName: "Nguyen", name: "Ivy Nguyen", email: "i@example.com" },
      fields: [fullNameField(PASSPORT_LABEL, { first: "Ivy", middle: "Mai", last: "Nguyen" })],
    }],
  });
  assert.equal(travelRows(data)[0].middle, "Mai");
});

// --- middle name: HubSpot property parsing ---------------------------------

test("first_middle_names has the first name stripped off it", () => {
  assert.equal(middleNameFromProps({ first_middle_names: "Jane Marie Louise" }, "Jane", "Smith"), "Marie Louise");
});

test("a first_middle_names holding only the first name yields nothing", () => {
  assert.equal(middleNameFromProps({ first_middle_names: "Jane" }, "Jane", "Smith"), "");
});

test("the passport property is parsed as Last, First Middle", () => {
  assert.equal(
    middleNameFromProps({ name_on_passport_last_first_name_middle_name: "Smith, Jane Marie" }, "Jane", "Smith"),
    "Marie");
});

test("a trailing surname in the property is stripped too", () => {
  assert.equal(middleNameFromProps({ first_middle_names: "Jane Marie Smith" }, "Jane", "Smith"), "Marie");
});

test("empty or absent properties yield an empty string", () => {
  assert.equal(middleNameFromProps({}, "Jane", "Smith"), "");
  assert.equal(middleNameFromProps({ first_middle_names: "   " }, "Jane", "Smith"), "");
});

// --- name parts extraction --------------------------------------------------

test("nameParts reads first/middle/last off a full-name answer", () => {
  const parts = nameParts({ type: "control_fullname", answer: { first: "Mia", middle: "Grace", last: "Reynolds" } });
  assert.equal(parts.first, "Mia");
  assert.equal(parts.middle, "Grace");
  assert.equal(parts.last, "Reynolds");
});

test("nameParts ignores plain string and address answers", () => {
  assert.equal(nameParts({ type: "control_textbox", answer: "Mia Reynolds" }), null);
  assert.equal(nameParts({ type: "control_address", answer: { addr_line1: "1 Road", city: "Dunedin" } }), null);
});

// --- PDF column -------------------------------------------------------------

test("the passenger table has a Middle Name column between First and Last", () => {
  const data = group({
    students: [{
      person: { firstName: "Mia", lastName: "Reynolds", name: "Mia Reynolds", email: "mia@example.com" },
      fields: [fullNameField(PASSPORT_LABEL, { first: "Mia", middle: "Grace", last: "Reynolds" })],
    }],
  });
  const doc = GroupPdf.buildGroupPdfDocDefinition(data);
  // The passenger table is the one whose title bar names it.
  const table = doc.content
    .filter(x => x && x.table)
    .find(x => x.table.body?.[0]?.[0]?.text === "Passenger Details for Travel").table;

  const header = table.body[1].map(c => c.text);
  assert.deepEqual(header.slice(0, 4), ["#", "First Name", "Middle Name(s)", "Last Name"]);
  assert.equal(header.length, table.widths.length, "widths must match the column count");

  const row = table.body.find(r => r[1] && r[1].text === "Mia");
  assert.equal(row[2].text, "Grace");
  assert.equal(row[3].text, "Reynolds");
  assert.equal(row.length, table.widths.length);
});

// --- CSV --------------------------------------------------------------------

test("csvCell quotes commas, quotes and newlines", () => {
  assert.equal(GroupCsv._csvCell("plain"), "plain");
  assert.equal(GroupCsv._csvCell("a,b"), '"a,b"');
  assert.equal(GroupCsv._csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(GroupCsv._csvCell("line1\nline2"), '"line1\nline2"');
  assert.equal(GroupCsv._csvCell(" padded "), '" padded "');
  assert.equal(GroupCsv._csvCell(null), "");
});

test("csvCell neutralises spreadsheet formula injection", () => {
  assert.equal(GroupCsv._csvCell("=1+1"), "'=1+1");
  assert.equal(GroupCsv._csvCell("@SUM(A1)"), "'@SUM(A1)");
  assert.equal(GroupCsv._csvCell("+cmd|'/c calc'!A0"), "'+cmd|'/c calc'!A0");
  // Phone numbers and negative values keep their leading sign.
  assert.equal(GroupCsv._csvCell("+64 21 555 0199"), "+64 21 555 0199");
  assert.equal(GroupCsv._csvCell("-3"), "-3");
  // A normal hyphenated answer must not be mangled.
  assert.equal(GroupCsv._csvCell("gluten-free"), "gluten-free");
});

test("guardian phone numbers survive the CSV unchanged", () => {
  const data = group({
    students: [{
      person: {
        firstName: "Mia", lastName: "Reynolds", name: "Mia Reynolds", email: "mia@example.com",
        parents: [{ name: "Anna Reynolds", phone: "+64 21 555 0199", role: "Mother" }],
      },
      fields: [],
    }],
  });
  assert.match(GroupCsv.buildGroupCsvs(data)[1].text, /,\+64 21 555 0199,/);
});

test("the export is four CSVs and the travel one carries the middle name", () => {
  const data = group({
    students: [{
      person: { firstName: "Mia", lastName: "Reynolds", name: "Mia Reynolds", email: "mia@example.com",
                status: "Cleared" },
      fields: [
        fullNameField(PASSPORT_LABEL, { first: "Mia", middle: "Grace", last: "Reynolds" }),
        { label: "Passport Number", value: "LA123456" },
        { label: "Date of Birth", value: "2008-04-11" },
        { label: "Diabetes?", value: "Yes, type 1" },
      ],
    }],
    departureDate: "2026-12-01",
  });

  const files = GroupCsv.buildGroupCsvs(data);
  assert.deepEqual(files.map(f => f.name), [
    "1-motivations.csv",
    "2-emergency-contacts.csv",
    "3-medical-details.csv",
    "4-travel-passenger-details.csv",
  ]);

  const travel = files[3].text.split("\r\n");
  assert.deepEqual(travel[0].split(",").slice(0, 5),
    ["Role", "#", "First Name", "Middle Name(s)", "Last Name"]);
  const cells = travel[1].split(",");
  assert.equal(cells[0], "Students");
  assert.equal(cells[3], "Grace");
  assert.equal(cells[6], "2008-04-11", "dates stay ISO so spreadsheets parse them");
  assert.equal(cells[7], "18", "age on departure is still computed");

  // Medical detail keeps one row per person, with the answers in one cell.
  const medical = files[2].text;
  assert.match(medical, /"Diabetes\?: Yes, type 1"/);
});

test("an empty program still produces four well-formed CSVs", () => {
  const files = GroupCsv.buildGroupCsvs(group({}));
  assert.equal(files.length, 4);
  for (const f of files) {
    assert.ok(f.text.endsWith("\r\n"), `${f.name} must end with a line break`);
    assert.ok(f.text.split("\r\n")[0].length > 0, `${f.name} must have a header row`);
  }
});

// --- ZIP --------------------------------------------------------------------

test("crc32 matches the known CRC of 'hello'", () => {
  assert.equal(GroupCsv._crc32(Buffer.from("hello")), 0x3610a686);
});

test("the zip is a real archive that unzip can read back", () => {
  const files = [
    { name: "pkg/one.csv", text: "a,b\r\n1,2\r\n" },
    { name: "pkg/two.csv", text: 'name\r\n"Māori, Tāne"\r\n' },
  ];
  const bytes = GroupCsv._zipStore(files, new Date("2026-09-21T10:30:00Z"));

  // Signature and end-of-central-directory marker.
  assert.deepEqual(Array.from(bytes.slice(0, 4)), [0x50, 0x4b, 0x03, 0x04]);

  const dir = mkdtempSync(join(tmpdir(), "group-zip-"));
  const zipPath = join(dir, "out.zip");
  writeFileSync(zipPath, Buffer.from(bytes));

  // `unzip -t` verifies the CRCs and the central directory.
  execFileSync("unzip", ["-t", zipPath], { stdio: "pipe" });
  execFileSync("unzip", ["-q", zipPath, "-d", dir], { stdio: "pipe" });

  assert.deepEqual(readdirSync(join(dir, "pkg")).sort(), ["one.csv", "two.csv"]);
  const two = readFileSync(join(dir, "pkg", "two.csv"), "utf8");
  assert.ok(two.startsWith("﻿"), "CSVs carry a BOM so Excel reads UTF-8");
  assert.match(two, /Māori, Tāne/, "non-ASCII names survive the round trip");
});

// --- live UE form labels (emergency / dietary / medical / age) ------------

const f = (label, value, order) => ({ label, value, order });
const YES_MORE = "If you answered YES to any of the above, please provide more information";

test("emergency contacts read the UE form's Primary/Secondary labels", () => {
  const data = group({
    students: [{
      person: { firstName: "Mia", lastName: "Reynolds", name: "Mia Reynolds", email: "mia@example.com" },
      fields: [
        f("Primary Contact Name", "Anna Reynolds"),
        f("Primary Contact Phone Number", "021 555 0199"),
        f("Relationship to student", "Mother"),
        f("Secondary emergency contact name", "Tom Reynolds"),
        f("Secondary emergency contact phone number", "021 555 0200"),
        f("Secondary emergency contact relationship to student", "Father"),
      ],
    }],
  });
  const c = data.emergency.groups[2].rows[0].contacts;
  assert.deepEqual(c[0], { name: "Anna Reynolds", phone: "021 555 0199", role: "Mother" });
  assert.deepEqual(c[1], { name: "Tom Reynolds", phone: "021 555 0200", role: "Father" });
});

test("HubSpot parents merge with form contacts by person, not by position", () => {
  const data = group({
    students: [{
      person: {
        firstName: "Mia", lastName: "Reynolds", name: "Mia Reynolds", email: "mia@example.com",
        // HubSpot returns Dad first; the form says Mum is primary.
        parents: [
          { name: "Tom Reynolds", phone: "+64 21 000 0002", role: "" },
          { name: "Anna Reynolds", phone: "+64 21 000 0001", role: "" },
        ],
      },
      fields: [
        f("Primary Contact Name", "Anna Reynolds"),
        f("Relationship to student", "Mother"),
        f("Secondary emergency contact name", "Tom Reynolds"),
        f("Secondary emergency contact relationship to student", "Father"),
      ],
    }],
  });
  const c = data.emergency.groups[2].rows[0].contacts;
  assert.deepEqual(c[0], { name: "Anna Reynolds", phone: "+64 21 000 0001", role: "Mother" });
  assert.deepEqual(c[1], { name: "Tom Reynolds", phone: "+64 21 000 0002", role: "Father" });
});

test("dietary column shows the follow-up detail, not the Yes/No", () => {
  const data = group({
    students: [
      { person: { firstName: "A", lastName: "One", name: "A One", email: "a@x.com" },
        fields: [
          f("Have you been admitted to hospital in the last 3 years?", "Yes", 30),
          f(YES_MORE, "Broken arm 2024", 31),
          f("Dietary Restrictions or Preferences eg Vegetarian, celiac, gluten free?", "Yes", 40),
          f("Do you have any food allergies?", "Yes", 41),
          f(YES_MORE, "Vegetarian, peanut allergy (EpiPen)", 42),
        ] },
      { person: { firstName: "B", lastName: "Two", name: "B Two", email: "b@x.com" },
        fields: [
          f("Dietary Restrictions or Preferences eg Vegetarian, celiac, gluten free?", "No", 40),
          f("Do you have any food allergies?", "No", 41),
        ] },
      { person: { firstName: "C", lastName: "Three", name: "C Three", email: "c@x.com" },
        fields: [
          f("Dietary Restrictions or Preferences eg Vegetarian, celiac, gluten free?", "Yes", 40),
          f("Do you have any food allergies?", "No", 41),
          f("Passport Number", "LA1", 50),
        ] },
    ],
  });
  const rows = travelRows(data);
  assert.equal(rows[0].dietary, "FOOD ALLERGY: Vegetarian, peanut allergy (EpiPen)");
  assert.equal(rows[1].dietary, "None");
  assert.equal(rows[2].dietary, "Yes — no details given");
});

test("medical keeps every 'If you answered YES' follow-up, in form order", () => {
  const data = group({
    students: [{
      person: { firstName: "A", lastName: "One", name: "A One", email: "a@x.com" },
      fields: [
        f("Migraines or Headaches?", "Yes", 10),
        f(YES_MORE, "Occasional migraines", 11),
        f("Have you been admitted to hospital in the last 3 years?", "Yes", 30),
        f(YES_MORE, "Appendix 2025", 31),
      ],
    }],
  });
  const items = data.medical.groups[2].rows[0].items.map(i => i.answer);
  assert.deepEqual(items, ["Yes", "Occasional migraines", "Yes", "Appendix 2025"]);
});

test("age on departure works with HubSpot epoch-ms dates", () => {
  // 2027-03-12 06:30 NZDT = 2027-03-11T17:30Z
  const dep = String(Date.UTC(2027, 2, 11, 17, 30));
  const data = group({
    departureDate: dep,
    students: [{
      person: { firstName: "A", lastName: "One", name: "A One", email: "a@x.com" },
      fields: [f("Date of Birth", "2009-03-12")],
    }],
  });
  assert.equal(travelRows(data)[0].ageOnDeparture, "18", "birthday on NZ departure day counts");
});

test("Jotform phone and birthdate answers are flattened, not JSON", () => {
  assert.equal(formatAnswer({ type: "control_phone", answer: { full: "(021) 555-0199" } }), "(021) 555-0199");
  assert.equal(formatAnswer({ type: "control_phone", answer: { area: "021", phone: "5550199" } }), "021 5550199");
  assert.equal(formatAnswer({ type: "control_birthdate", answer: { day: "3", month: "7", year: "2009" } }), "2009-07-03");
});

// --- names after the passport check's USE THIS -----------------------------

test("after a passport name is applied, given names aren't printed twice", () => {
  const data = group({
    students: [{
      // USE THIS wrote all given names to firstname and cleared the form's middle.
      person: { firstName: "Mia Grace", lastName: "Reynolds", name: "Mia Grace Reynolds",
                email: "mia@example.com", middleName: "Mia Grace" /* stale CRM fallback */ },
      fields: [fullNameField(PASSPORT_LABEL, { first: "Mia Grace", middle: "", last: "Reynolds" })],
    }],
  });
  const r = travelRows(data)[0];
  assert.deepEqual([r.first, r.middle, r.last], ["Mia Grace", "", "Reynolds"]);
});

test("before an apply, form given names missing from First become Middle", () => {
  const data = group({
    students: [
      { person: { firstName: "Mia", lastName: "Reynolds", name: "Mia Reynolds", email: "a@x.com" },
        fields: [fullNameField(PASSPORT_LABEL, { first: "Mia Grace", middle: "", last: "Reynolds" })] },
      { person: { firstName: "Mia", lastName: "Reynolds", name: "Mia Reynolds", email: "b@x.com" },
        fields: [fullNameField(PASSPORT_LABEL, { first: "Mia", middle: "Grace Louise", last: "Reynolds" })] },
    ],
  });
  assert.deepEqual(travelRows(data).map(r => r.middle), ["Grace", "Grace Louise"]);
});

// --- passport zip ------------------------------------------------------------

test("passport files are numbered, role-labelled and typed by content-type", () => {
  const p = { index: 3, role: "Students", first: "Mia", last: "Reynolds", url: "/document-proxy?url=x" };
  assert.equal(GroupPassports._fileBase(p), "03 Students - Reynolds, Mia");
  assert.equal(GroupPassports._extFor("image/png", p.url), "png");
  assert.equal(GroupPassports._extFor("application/pdf; charset=binary", p.url), "pdf");
  assert.equal(GroupPassports._extFor("", "/document-proxy?url=https%3A%2F%2Fx.jotform.com%2Fa%2Fscan.jpeg&token=t"), "jpeg");
});

test("passport zip holds the images byte-for-byte and lists who's missing", () => {
  const jpg = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3, 0xFF, 0xD9]);
  const data = {
    program: { name: "Nepal 2027" },
    people: [
      { index: 1, role: "Expedition Leader", first: "Sam", last: "Lee", url: null },
      { index: 2, role: "Students", first: "Zoë", last: "Ngāti", url: "/document-proxy?url=a" },
      { index: 3, role: "Students", first: "Tom", last: "Ray", url: "/document-proxy?url=b" },
    ],
  };
  const built = GroupPassports._buildEntries(data, [null, { bytes: jpg, contentType: "image/jpeg" }, { error: "HTTP 502" }]);
  assert.equal(built.count, 1);
  assert.equal(built.missing.length, 2);

  const zip = GroupCsv._zipStore(built.entries, new Date("2026-10-14T00:00:00Z"));
  const dir = mkdtempSync(join(tmpdir(), "passport-zip-"));
  const zipPath = join(dir, "p.zip");
  writeFileSync(zipPath, Buffer.from(zip));
  execFileSync("unzip", ["-t", zipPath], { stdio: "pipe" });
  execFileSync("unzip", ["-q", zipPath, "-d", dir], { stdio: "pipe" });
  const folder = join(dir, "Passports-Nepal-2027");
  assert.deepEqual(readdirSync(folder).sort(), ["02 Students - Ngāti, Zoë.jpg", "_MISSING-PASSPORTS.txt"]);
  assert.deepEqual(new Uint8Array(readFileSync(join(folder, "02 Students - Ngāti, Zoë.jpg"))), jpg);
  const missing = readFileSync(join(folder, "_MISSING-PASSPORTS.txt"), "utf8");
  assert.match(missing, /01 Expedition Leader - Lee, Sam — no passport on file/);
  assert.match(missing, /03 Students - Ray, Tom — download failed \(HTTP 502\)/);
});

console.log(`\n${passed} passed${process.exitCode ? " — with failures above" : ""}`);
