// ---------------------------------------------------------------------------
// group-info.js — pure assembly of the four "Expedition Leader Information"
// group sheets from portal data. NO network, NO auth, NO PDF: it takes the
// already-fetched roster + Jotform submissions and returns plain data that the
// front-end turns into a PDF (see the DOWNLOAD GROUP INFORMATION button in
// index.html).
//
// The four sheets, grouped by role (Expedition Leader → School Leaders →
// Students) exactly like the reference workbook:
//   1. Motivations           — students' pre-departure reflection answers
//   2. Emergency Contacts     — up to two emergency contacts per person
//   3. Medical Details        — condition summary + detail + review status
//   4. Travel / Passenger     — passport + dietary details
//
// WHY a config block: every column below is mapped from a Jotform *question
// label*. Those labels are whatever the school typed into the form, and this
// repo can't see the live form. So all label strings live in FIELD_MAP with a
// `// VERIFY` marker. If a column comes out blank in the PDF, the fix is almost
// always a label string here — not the plumbing. The endpoint also returns
// `availableLabels` (every label actually seen on submissions) so you can
// copy the correct string straight in.
// ---------------------------------------------------------------------------

// Normalise a label/answer for tolerant matching: lowercase, collapse
// whitespace, strip most punctuation. So "Date of Birth" == "date of birth"
// and "Expiry Date " == "expiry date".
function norm(s) {
  return String(s == null ? "" : s)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9 ]/g, "")
    .trim();
}

// Treat these answers as "empty / negative" so a plain "No" doesn't get
// reported as a medical condition.
const NEGATIVE_ANSWERS = new Set(["", "no", "none", "n/a", "na", "nil", "false"]);

function isAffirmative(v) {
  const n = norm(v);
  return n !== "" && !NEGATIVE_ANSWERS.has(n);
}

// ---------------------------------------------------------------------------
// FIELD MAP — the only place you should need to edit to correct the PDF.
// Each entry is an array of *candidate* labels; the first one present on a
// person's submission wins, so you can list old + new wording safely.
// ---------------------------------------------------------------------------
export const FIELD_MAP = {
  // Sheet 1 — Motivations. These four strings are taken verbatim from the
  // reference workbook and should match the Jotform question text.
  motivations: [
    { key: "why",       label: "Why have you chosen to participate in this program and what are you hoping to gain from this experience?" }, // VERIFY
    { key: "lookingFor", label: "Which components or parts of the program are you most looking forward too, or focussed on?" },              // VERIFY
    { key: "concerned",  label: "Which parts are you concerned, or nervous about, if any?" },                                               // VERIFY
    { key: "challenges", label: "There will be times when you are challenged outside of your comfort zone. What do you imagine are the biggest challenges you will face during the program? And how do you think you will respond? Or could be supported?" }, // VERIFY
  ],

  // Sheet 4 — Travel / passenger details (labels partly confirmed against the
  // trip-leader whitelist already in index.html).
  travel: {
    // Middle names come from the passport-name question on the application —
    // a Jotform full-name field whose `middle` sub-field is what the airline
    // ticket has to match. `passportName` lists the candidate question labels;
    // `middleName` covers forms that ask for the middle name on its own.
    // If neither is on the form, the HubSpot fallback (person.middleName) wins.
    passportName:    ["Name (as noted in your passport)", "Name as noted in your passport",
                      "Full Name", "Name", "Student Name"],                          // confirmed on UE application form
    middleName:      ["Middle Name", "Middle Names", "Middle Name(s)",
                      "Middle name (as on passport)"],                               // VERIFY
    gender:          ["Gender", "Sex"],                                              // VERIFY
    dateOfBirth:     ["Date of Birth", "Birth Date", "DOB", "Date Of Birth"],        // VERIFY
    passportNumber:  ["Passport Number"],                                            // confirmed in index.html whitelist
    passportCountry: ["Country of Issue on Passport", "Country of Issue"],           // confirmed
    passportExpiry:  ["Expiry Date", "Passport Expiry Date"],                        // confirmed
    // On the UE application these two are Yes/No questions; the actual detail
    // ("vegetarian", "peanut allergy") is in the "If you answered YES ..."
    // follow-up that comes straight after them. That follow-up label is used
    // THREE times on the form (medical, health, dietary), so it is found by
    // position — the first one after the food-allergy question — not by label.
    dietary:         ["Dietary Restrictions or Preferences eg Vegetarian, celiac, gluten free?",
                      "Dietary Requirements", "Dietary Restrictions or Preferences", "Dietary Req."], // confirmed on UE form
    foodAllergies:   ["Do you have any food allergies?", "Any food allergies?"],                    // confirmed on UE form
    dietaryDetail:   ["If you answered YES to any of the above, please provide more information"],  // confirmed (positional)
  },

  // Sheet 2 — Emergency contacts. Jotform emergency-contact questions vary a
  // lot between forms, so we match up to two contacts by common patterns.
  // If nothing matches, the assembler falls back to HubSpot parent contacts
  // (name + phone; role left blank) for students.
  emergency: {
    // Each contact is { name, phone, role }. We look for numbered / first-second
    // phrasings. Adjust to your form's exact labels.
    contacts: [
      // Labels confirmed against the live UE application form (251396787451873).
      { name:  ["Primary Contact Name", "Emergency Contact Name", "Emergency Contact 1 Name", "Contact Name"],
        phone: ["Primary Contact Phone Number", "Primary Contact Phone", "Emergency Contact Phone", "Emergency Contact 1 Phone", "Contact Phone"],
        email: ["Primary Contact Email", "Emergency Contact Email", "Emergency Contact 1 Email"],
        role:  ["Relationship to student", "Emergency Contact Relationship", "Emergency Contact 1 Relationship", "Contact Role"] },
      { name:  ["Secondary emergency contact name", "Emergency Contact 2 Name", "Second Emergency Contact Name", "Alternate Contact Name"],
        phone: ["Secondary emergency contact phone number", "Emergency Contact 2 Phone", "Second Emergency Contact Phone", "Alternate Contact Phone"],
        email: ["Secondary emergency contact email", "Emergency Contact 2 Email"],
        role:  ["Secondary emergency contact relationship to student", "Emergency Contact 2 Relationship", "Second Emergency Contact Relationship", "Alternate Contact Role"] },
    ],
  },

  // Sheet 3 — Medical. The actual medical/health questions & answers are pulled
  // straight from the application. Each question the applicant answered (with
  // anything other than a plain No/None — unless `includeNegatives` is true) is
  // shown as: **question** answer. `ue_student_status` (HubSpot) is the Status.
  medical: {
    questions: [
      "Respiratory Problems or Asthma?",
      "Migraines or Headaches?",
      "Skin Disorders?",
      "Muscular-skeletel Problems?",
      "Diabetes?",
      "Claustrophobia or Motion Sickness?",
      "Neurological problems or seizures? (i.e. autism, etc.)",
      "Allergic reactions to Medications?",
      "Any chronic medical conditions? (heart conditions, hearing loss, IBS, etc.)",
      "Any chronic mental health conditions? (i.e. psychosis, bipolar disorder, etc.)",
      "Have you ever had any suicidal ideation?",
      "Have you ever self-harmed?",
      "Do you currently take, or have been prescribed, any medications?",
      "If you answered YES to any of the above, please provide more information",
      "Have you attended a mental health practitioner, more than once, in the last 2 years?",
      "Do you suffer from anxiety, depression, ADHD or other mood disorders?",
      "Have you ever been, or are you currently being treated for substance abuse?",
      "Do you have any physical, psychological, or chronic conditions that may impact your participation in physical activities?",
      "Have you been admitted to hospital in the last 3 years?",
      "Any non-food relate allergies or illnesses?",
      "Do you have any food allergies?",
      "Does the student have objection to blood transfusions? (in case of medical emergency)",
      "Does the student have objection to immunisations?",
    ], // VERIFY these match your application's medical/health questions
    // true = also list questions answered "No"/"None" (full checklist view).
    includeNegatives: false,
  },
};

// Look up the first matching answer for a set of candidate labels on a
// person's flattened Jotform fields ([{label, value}]).
function fieldValue(fields, candidateLabels) {
  if (!Array.isArray(fields) || !candidateLabels) return "";
  const wanted = candidateLabels.map(norm);
  for (const f of fields) {
    if (wanted.includes(norm(f.label))) {
      const v = String(f.value == null ? "" : f.value).trim();
      if (v) return v;
    }
  }
  return "";
}

// The answer to a follow-up question (`labels`) that IMMEDIATELY follows the
// last of `anchorLabels` in form order. Used for the repeated "If you answered
// YES ..." follow-up, which can't be told apart by label alone. Only the very
// next answered field is considered, so an empty dietary follow-up can never
// pick up another section's explanation instead. (Section headers carry no
// answer, so they are already absent from `fields`.)
function fieldAfter(fields, anchorLabels, labels) {
  if (!Array.isArray(fields)) return "";
  const anchors = anchorLabels.map(norm);
  const wanted = labels.map(norm);
  let anchorIdx = -1;
  fields.forEach((f, i) => { if (f && anchors.includes(norm(f.label))) anchorIdx = i; });
  if (anchorIdx < 0) return "";
  const next = fields[anchorIdx + 1];
  if (!next || !wanted.includes(norm(next.label))) return "";
  return String(next.value == null ? "" : next.value).trim();
}

// Look up a sub-field ("first" / "middle" / "last") of a Jotform full-name
// answer. get-group-info.js attaches `parts` to those fields when the
// submission carries them; anything else has no parts and is skipped.
function namePart(fields, candidateLabels, part) {
  if (!Array.isArray(fields) || !candidateLabels) return "";
  const wanted = candidateLabels.map(norm);
  for (const f of fields) {
    if (!f || !f.parts) continue;
    if (!wanted.includes(norm(f.label))) continue;
    const v = String(f.parts[part] == null ? "" : f.parts[part]).trim();
    if (v) return v;
  }
  return "";
}

// Middle name(s) for the passenger sheet = the given names on record that are
// NOT already in the First Name column, so First + Middle always reads as the
// full set of given names exactly once.
//
// WHY "not already in First": the passport check's USE THIS writes the
// passport's given names VERBATIM into HubSpot `firstname` ("Mia Grace") and
// the form's name first-subfield, and clears the middle subfield. Taking the
// middle name from a separate source after that printed the given names twice
// (First "Mia Grace", Middle "Mia Grace"). Before an apply, a form that holds
// first "Mia" + middle "Grace" still gives Middle "Grace".
//
// Source, in order of authority:
//   1. the passport-name question on the form (first + middle subfields) —
//      authoritative whenever the submission has it, even if middle is blank
//   2. a standalone "Middle Name" question on the form
//   3. the HubSpot contact fallback resolved in get-group-info.js
function middleName(person, fields) {
  const t = FIELD_MAP.travel;
  const firstOnRecord = splitName(person || {}).first;
  const lastOnRecord = splitName(person || {}).last;
  const taken = new Set(norm(`${firstOnRecord} ${lastOnRecord}`).split(" ").filter(Boolean));
  const remainder = (given) => String(given || "").trim().split(/\s+/)
    .filter(w => w && !taken.has(norm(w))).join(" ");

  const passportField = Array.isArray(fields) && fields.find(f =>
    f && f.parts && t.passportName.map(norm).includes(norm(f.label)));
  if (passportField) {
    return remainder(`${passportField.parts.first || ""} ${passportField.parts.middle || ""}`);
  }
  const standalone = fieldValue(fields, t.middleName);
  if (standalone) return remainder(standalone);
  return remainder((person && person.middleName) || "");
}

// Split a "First Last" style name; prefer HubSpot first/last when present.
function splitName(person) {
  const first = (person.firstName || "").trim();
  const last = (person.lastName || "").trim();
  if (first || last) return { first, last };
  const parts = (person.name || "").trim().split(/\s+/);
  if (parts.length <= 1) return { first: parts[0] || "", last: "" };
  return { first: parts.slice(0, -1).join(" "), last: parts[parts.length - 1] };
}

// ----- per-sheet row builders --------------------------------------------

function motivationRow(person, fields) {
  const { first } = splitName(person);
  const row = { firstName: person.name || first };
  for (const q of FIELD_MAP.motivations) {
    row[q.key] = fieldValue(fields, [q.label]);
  }
  return row;
}

// Loose "same person" test between a HubSpot parent and a Jotform contact:
// same email, same full name, or same first + last word of the name.
function samePerson(p, j) {
  const pe = String(p.email || "").toLowerCase().trim();
  const je = String(j.email || "").toLowerCase().trim();
  if (pe && je && pe === je) return true;
  const pn = norm(p.name), jn = norm(j.name);
  if (!pn || !jn) return false;
  if (pn === jn) return true;
  const pw = pn.split(" "), jw = jn.split(" ");
  return pw.length > 1 && jw.length > 1 && pw[0] === jw[0] && pw[pw.length - 1] === jw[jw.length - 1];
}

function emergencyRow(index, person, fields) {
  const { first, last } = splitName(person);

  // Two sources: the emergency contacts typed on the application (Primary /
  // Secondary — name, phone, email, relationship) and the student's HubSpot
  // Parent contacts. They are merged PER PERSON, never by position: HubSpot
  // returns parents in no particular order, so pairing parent #1 with Jotform
  // contact #1 used to put the mother's name next to the father's relationship.
  // The application's Primary/Secondary order wins; each slot is backfilled
  // from the matching HubSpot parent (and vice versa), then any HubSpot parent
  // not on the form fills an empty slot.
  const parents = (Array.isArray(person.parents) ? person.parents : [])
    .filter(p => p && (p.name || p.phone));
  const jf = FIELD_MAP.emergency.contacts
    .map(c => ({
      name: fieldValue(fields, c.name),
      phone: fieldValue(fields, c.phone),
      email: fieldValue(fields, c.email || []),
      role: fieldValue(fields, c.role),
    }))
    .filter(j => j.name || j.phone);

  const used = new Set();
  const merged = jf.map(j => {
    const pi = parents.findIndex((p, i) => !used.has(i) && samePerson(p, j));
    const p = pi >= 0 ? parents[pi] : {};
    if (pi >= 0) used.add(pi);
    return {
      name: j.name || p.name || "",
      phone: j.phone || p.phone || "",
      role: j.role || p.role || "",
    };
  });
  parents.forEach((p, i) => {
    if (used.has(i)) return;
    merged.push({ name: p.name || "", phone: p.phone || "", role: p.role || "" });
  });

  const contacts = [0, 1].map(i => merged[i] || { name: "", phone: "", role: "" });
  return { index, first, last, contacts };
}

function medicalRow(index, person, fields) {
  const { first, last } = splitName(person);
  const includeNeg = !!FIELD_MAP.medical.includeNegatives;

  // Pull the actual question/answer pairs from the application, in FORM
  // order, keeping every occurrence. "If you answered YES ... more
  // information" appears once per section (medical, health, dietary); looking
  // it up by label only ever returned the first, which dropped the health and
  // dietary explanations.
  const wanted = new Set(FIELD_MAP.medical.questions.map(norm));
  const items = [];
  for (const f of Array.isArray(fields) ? fields : []) {
    if (!f || !wanted.has(norm(f.label))) continue;
    const v = String(f.value == null ? "" : f.value).trim();
    if (!v) continue;
    if (!includeNeg && !isAffirmative(v)) continue;
    items.push({ question: f.label, answer: v });
  }

  return {
    index,
    first,
    last,
    items,
    status: (person.status || "").trim(),
  };
}

// Age at a given departure date, from a YYYY-MM-DD (or parseable) DOB.
function ageOnDeparture(dob, departureDate) {
  if (!dob || !departureDate) return "";
  // HubSpot date properties arrive as epoch milliseconds; Jotform dates as
  // YYYY-MM-DD. Both are read as calendar dates in NZ time (where the office
  // enters departures), so a 6am NZ flight isn't "the day before".
  const toDate = (v) => {
    const raw = String(v).trim();
    if (/^\d{10,}$/.test(raw)) {
      const ymd = new Date(Number(raw)).toLocaleDateString("en-CA", { timeZone: "Pacific/Auckland" });
      return new Date(ymd + "T00:00:00Z");
    }
    const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
    return new Date(raw);
  };
  const b = toDate(dob);
  const d = toDate(departureDate);
  if (isNaN(b.getTime()) || isNaN(d.getTime())) return "";
  let age = d.getUTCFullYear() - b.getUTCFullYear();
  const m = d.getUTCMonth() - b.getUTCMonth();
  if (m < 0 || (m === 0 && d.getUTCDate() < b.getUTCDate())) age--;
  return age >= 0 && age < 130 ? String(age) : "";
}

function travelRow(index, person, fields, departureDate) {
  const { first, last } = splitName(person);
  const t = FIELD_MAP.travel;
  const dob = fieldValue(fields, t.dateOfBirth);

  // The dietary and food-allergy questions are Yes/No; the real requirement
  // is in the follow-up text after them. Show that text (flagging allergies),
  // "None" when both are No, and the raw answer if the form ever makes the
  // dietary question free text.
  const dietaryAns = fieldValue(fields, t.dietary);
  const allergyAns = fieldValue(fields, t.foodAllergies);
  const detail = fieldAfter(fields, [...t.foodAllergies, ...t.dietary], t.dietaryDetail);
  const yesNo = (v) => /^(yes|no)$/i.test(String(v).trim());
  const dietYes = isAffirmative(dietaryAns);
  const allergyYes = isAffirmative(allergyAns);
  let dietary = "";
  if (dietYes || allergyYes) {
    const parts = [];
    if (dietYes && !yesNo(dietaryAns)) parts.push(dietaryAns);       // free-text answer
    if (detail) parts.push(detail);
    if (!parts.length) parts.push("Yes \u2014 no details given");
    dietary = (allergyYes ? "FOOD ALLERGY: " : "") + parts.join("; ");
  } else if (dietaryAns || allergyAns) {
    dietary = "None";
  }

  return {
    index,
    first,
    middle: middleName(person, fields),
    last,
    gender: fieldValue(fields, t.gender),
    dateOfBirth: dob,
    ageOnDeparture: ageOnDeparture(dob, departureDate),
    passportNumber: fieldValue(fields, t.passportNumber),
    passportCountry: fieldValue(fields, t.passportCountry),
    passportExpiry: fieldValue(fields, t.passportExpiry),
    dietary,
  };
}

// Standard airline dietary codes shown as a legend on the travel sheet
// (mirrors the reference workbook).
export const DIETARY_LEGEND = [
  ["Vegetarian", ""],
  ["VGML", "Vegan Meal (no animal products, dairy, or eggs)"],
  ["VLML", "Vegetarian Lacto-Ovo Meal (includes dairy and eggs)"],
  ["AVML", "Asian Vegetarian Meal (spiced vegetarian, Indian-style)"],
  ["VJML", "Vegetarian Jain Meal (strict vegetarian, no root vegetables)"],
  ["Religious", ""],
  ["KSML", "Kosher Meal (compliant with Jewish dietary law)"],
  ["MOML", "Muslim/Halal Meal (no pork, alcohol, or non-halal meat)"],
  ["HNML", "Hindu Meal (non-vegetarian, usually lamb/fish, no beef)"],
  ["ORML", "Oriental Meal (spiced, often Asian-style)"],
  ["Medical/Health", ""],
  ["GFML", "Gluten-Free Meal"],
  ["DBML", "Diabetic Meal (low sugar, high fibre)"],
  ["LFML", "Low Fat / Low Cholesterol Meal"],
  ["LSML", "Low Sodium/Salt Meal"],
  ["NLML", "Non-Lactose/Dairy-Free Meal"],
  ["BLML", "Bland Meal (soft foods, low-fat for sensitive stomachs)"],
  ["PFML", "Peanut-Free Meal (specific allergy restriction)"],
];

// ----- main entry point ----------------------------------------------------
//
// input:
//   program           — { name, id }
//   expeditionLeaders — [ person ]  (Trip Leaders)
//   schoolLeaders     — [ person ]  (Teachers)
//   students          — [ person ]
//   appByEmail        — Map<lowercased email, fields[]>  (Jotform, flattened)
//   departureDate     — optional ISO date for Age on Departure
//
// where person = { name, firstName?, middleName?, lastName?, email, phone?,
//                  status?, parents? }
//
// output: { program, generatedAt, motivations, emergency, medical, travel,
//           availableLabels }
export function assembleGroupInfo(input) {
  const {
    program = {},
    expeditionLeaders = [],
    schoolLeaders = [],
    students = [],
    appByEmail = new Map(),
    departureDate = "",
    generatedAt = "",
  } = input || {};

  const fieldsFor = (person) => {
    const key = String(person.email || "").toLowerCase().trim();
    return (key && appByEmail.get(key)) || [];
  };

  // Ordered, numbered roster: Expedition Leaders, then School Leaders, then Students.
  const groups = [
    { role: "Expedition Leader", people: expeditionLeaders },
    { role: "School Leaders", people: schoolLeaders },
    { role: "Students", people: students },
  ];

  // Sheets 2/3/4 are grouped with a running index across all people.
  const emergency = { columns: null, groups: [] };
  const medical = { groups: [] };
  const travel = { groups: [] };
  let idx = 0;

  for (const g of groups) {
    const eRows = [], mRows = [], tRows = [];
    for (const person of g.people) {
      idx += 1;
      const fields = fieldsFor(person);
      eRows.push(emergencyRow(idx, person, fields));
      mRows.push(medicalRow(idx, person, fields));
      tRows.push(travelRow(idx, person, fields, departureDate));
    }
    emergency.groups.push({ role: g.role, rows: eRows });
    medical.groups.push({ role: g.role, rows: mRows });
    travel.groups.push({ role: g.role, rows: tRows });
  }

  // Sheet 1 (Motivations) is students only, matching the reference workbook.
  const motivations = {
    questions: FIELD_MAP.motivations.map(q => ({ key: q.key, label: q.label })),
    rows: students.map(s => motivationRow(s, fieldsFor(s))),
  };

  // Every distinct Jotform label we saw — so you can correct FIELD_MAP fast.
  const labelSet = new Set();
  for (const fields of appByEmail.values()) {
    for (const f of fields || []) if (f && f.label) labelSet.add(f.label);
  }

  return {
    program: { name: program.name || "", id: program.id || "" },
    generatedAt,
    dietaryLegend: DIETARY_LEGEND,
    motivations,
    emergency,
    medical,
    travel,
    availableLabels: Array.from(labelSet).sort(),
  };
}
