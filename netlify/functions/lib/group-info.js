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
    gender:          ["Gender", "Sex"],                                              // VERIFY
    dateOfBirth:     ["Date of Birth", "Birth Date", "DOB", "Date Of Birth"],        // VERIFY
    passportNumber:  ["Passport Number"],                                            // confirmed in index.html whitelist
    passportCountry: ["Country of Issue on Passport", "Country of Issue"],           // confirmed
    passportExpiry:  ["Expiry Date", "Passport Expiry Date"],                        // confirmed
    dietary:         ["Dietary Req.", "Dietary Requirements",
                      "Dietary Restrictions or Preferences eg Vegetarian, celiac, gluten free?"], // VERIFY
  },

  // Sheet 2 — Emergency contacts. Jotform emergency-contact questions vary a
  // lot between forms, so we match up to two contacts by common patterns.
  // If nothing matches, the assembler falls back to HubSpot parent contacts
  // (name + phone; role left blank) for students.
  emergency: {
    // Each contact is { name, phone, role }. We look for numbered / first-second
    // phrasings. Adjust to your form's exact labels.
    contacts: [
      { name:  ["Emergency Contact Name", "Emergency Contact 1 Name", "Contact Name", "Primary Emergency Contact Name"],   // VERIFY
        phone: ["Emergency Contact Phone", "Emergency Contact 1 Phone", "Contact Phone", "Primary Emergency Contact Phone"],// VERIFY
        role:  ["Emergency Contact Relationship", "Emergency Contact 1 Relationship", "Contact Role", "Relationship to Student"] }, // VERIFY
      { name:  ["Emergency Contact 2 Name", "Second Emergency Contact Name", "Alternate Contact Name"],                     // VERIFY
        phone: ["Emergency Contact 2 Phone", "Second Emergency Contact Phone", "Alternate Contact Phone"],                  // VERIFY
        role:  ["Emergency Contact 2 Relationship", "Second Emergency Contact Relationship", "Alternate Contact Role"] },   // VERIFY
    ],
  },

  // Sheet 3 — Medical. There is no single "condition" field on the form, so we
  // derive it: any of these yes/no questions answered affirmatively contributes
  // its short topic to the Condition column, and the free-text fields below are
  // concatenated into Description. `ue_student_status` (HubSpot) is the Status.
  medical: {
    // question label (matched loosely) -> short topic shown in "Medical Condition"
    yesNoTopics: {
      "Respiratory Problems or Asthma?": "Asthma/Respiratory",
      "Migraines or Headaches?": "Migraines",
      "Skin Disorders?": "Skin",
      "Muscular-skeletel Problems?": "Musculoskeletal",
      "Diabetes?": "Diabetes",
      "Claustrophobia or Motion Sickness?": "Motion Sickness",
      "Neurological problems or seizures? (i.e. autism, etc.)": "Neurological",
      "Allergic reactions to Medications?": "Medication Allergy",
      "Any chronic medical conditions? (heart conditions, hearing loss, IBS, etc.)": "Chronic Condition",
      "Any chronic mental health conditions? (i.e. psychosis, bipolar disorder, etc.)": "Mental Health",
      "Do you suffer from anxiety, depression, ADHD or other mood disorders?": "Mood Disorder",
      "Do you have any food allergies?": "Food Allergy",
      "Any non-food relate allergies or illnesses?": "Other Allergy/Illness",
    }, // VERIFY the exact question wording against your form
    // free-text fields whose answers are concatenated into "Description"
    detailFields: [
      "If you answered YES to any of the above, please provide more information",
      "Any chronic medical conditions? (heart conditions, hearing loss, IBS, etc.)",
      "Do you currently take, or have been prescribed, any medications?",
      "Do you have any food allergies?",
      "Any non-food relate allergies or illnesses?",
      "Dietary Restrictions or Preferences eg Vegetarian, celiac, gluten free?",
    ], // VERIFY
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

function emergencyRow(index, person, fields) {
  const { first, last } = splitName(person);

  // Emergency contacts are the student's HubSpot *Parent* contacts — that's the
  // authoritative source for name + phone. The Jotform emergency-contact fields
  // (if the form has them) are only used to backfill anything the parent record
  // is missing, and to supply a relationship/role when the parent association
  // didn't carry one.
  const parents = Array.isArray(person.parents) ? person.parents : [];
  const jf = FIELD_MAP.emergency.contacts.map(c => ({
    name: fieldValue(fields, c.name),
    phone: fieldValue(fields, c.phone),
    role: fieldValue(fields, c.role),
  }));

  const contacts = [0, 1].map(i => {
    const p = parents[i] || {};
    const j = jf[i] || {};
    return {
      name: p.name || j.name || "",
      phone: p.phone || j.phone || "",
      // Prefer the parent's own relationship (from the HubSpot association
      // label / property); fall back to the Jotform relationship field.
      role: p.role || j.role || "",
    };
  });

  return { index, first, last, contacts };
}

function medicalRow(index, person, fields) {
  const { first, last } = splitName(person);

  const topics = [];
  for (const [label, topic] of Object.entries(FIELD_MAP.medical.yesNoTopics)) {
    const v = fieldValue(fields, [label]);
    if (isAffirmative(v)) topics.push(topic);
  }

  const details = [];
  for (const label of FIELD_MAP.medical.detailFields) {
    const v = fieldValue(fields, [label]);
    if (isAffirmative(v)) {
      const short = label.replace(/\?.*$/, "").replace(/\s*\(.*?\)\s*/g, " ").trim();
      details.push(`${short}: ${v}`);
    }
  }

  return {
    index,
    first,
    last,
    condition: topics.join(", "),
    description: details.join(" | "),
    status: (person.status || "").trim(),
  };
}

// Age at a given departure date, from a YYYY-MM-DD (or parseable) DOB.
function ageOnDeparture(dob, departureDate) {
  if (!dob || !departureDate) return "";
  const b = new Date(dob);
  const d = new Date(departureDate);
  if (isNaN(b.getTime()) || isNaN(d.getTime())) return "";
  let age = d.getFullYear() - b.getFullYear();
  const m = d.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && d.getDate() < b.getDate())) age--;
  return age >= 0 && age < 130 ? String(age) : "";
}

function travelRow(index, person, fields, departureDate) {
  const { first, last } = splitName(person);
  const t = FIELD_MAP.travel;
  const dob = fieldValue(fields, t.dateOfBirth);
  return {
    index,
    first,
    last,
    gender: fieldValue(fields, t.gender),
    dateOfBirth: dob,
    ageOnDeparture: ageOnDeparture(dob, departureDate),
    passportNumber: fieldValue(fields, t.passportNumber),
    passportCountry: fieldValue(fields, t.passportCountry),
    passportExpiry: fieldValue(fields, t.passportExpiry),
    dietary: fieldValue(fields, t.dietary),
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
// where person = { name, firstName?, lastName?, email, phone?, status?, parents? }
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
