// get-group-info.js
// -----------------------------------------------------------------------------
// Assembles the four "Expedition Leader Information" group sheets for one
// program (Portal custom object) in a SINGLE request, so the Expedition Leader
// tab can offer a one-click "DOWNLOAD GROUP INFORMATION (PDF)".
//
// It returns JSON (not a PDF) — the front-end renders the PDF with pdfmake so
// we don't add a binary/font dependency to the Lambda bundle. The four tables
// (Motivations, Emergency Contacts, Medical Details, Travel/Passenger) are
// assembled by the pure, testable ./lib/group-info.js.
//
// Efficiency: the per-student /get-application-data endpoint scans every
// Jotform submission on every call. Doing that per person for a whole group
// would be N full scans. Here we scan each configured form ONCE, index by
// email, and reuse across the roster.
//
// Auth: signed in AND (Teacher/Trip Leader on this trip, or admin) — same guard
// as get-students.js, the equivalent roster-exposing endpoint.
//
// Inputs (querystring):
//   portalId — Portal (trip) record id. Required.
//
// Required env: HUBSPOT_API_KEY, JOTFORM_API_KEY
// Optional env: JOTFORM_APPLICATION_FORM_ID (comma-separated), JOTFORM_BASE_URL
// -----------------------------------------------------------------------------

import { authenticate } from "./_shared/auth.js";
import { assertPortalAccess } from "./_shared/portal-access.js";
import { assembleGroupInfo } from "./lib/group-info.js";

const PORTAL_OBJECT = "2-58156993";

const DEFAULT_FORM_IDS = (process.env.JOTFORM_APPLICATION_FORM_ID
  || "251396787451873,253477140703050,260388618557066,250747665126866")
  .split(",").map(s => s.trim()).filter(Boolean);

export async function handler(event) {
  try {
    // Auth: signed in.
    const auth = await authenticate(event);
    if (auth.response) return auth.response;

    const { portalId } = event.queryStringParameters || {};
    if (!portalId) {
      return json(400, { error: "Missing portalId" });
    }

    // Authorization: staff on this trip, or admin.
    const access = await assertPortalAccess(auth.session, portalId);
    if (access) return access;

    if (!process.env.HUBSPOT_API_KEY) return json(500, { error: "HUBSPOT_API_KEY is not set" });

    const headers = {
      Authorization: `Bearer ${process.env.HUBSPOT_API_KEY}`,
      "Content-Type": "application/json",
    };

    // 1. Program name (for the PDF header) + optional departure date.
    const program = await fetchProgram(portalId, headers);

    // 2. All associated contacts, bucketed by association label.
    const assocRes = await fetch(
      `https://api.hubapi.com/crm/v4/objects/${PORTAL_OBJECT}/${portalId}/associations/contacts`,
      { headers }
    );
    if (!assocRes.ok) {
      console.error("[get-group-info] associations fetch failed:",
        (await assocRes.text().catch(() => "")).slice(0, 300));
      return json(500, { error: "Portal contact associations fetch failed" });
    }
    const assoc = await assocRes.json();
    const rows = assoc.results || [];

    const idsWith = (label) => rows
      .filter(r => r.associationTypes?.some(t => String(t.label || "").trim() === label))
      .map(r => r.toObjectId);

    const studentIds = idsWith("Student");
    const teacherIds = idsWith("Teacher");        // School Leaders
    const tripLeaderIds = idsWith("Trip Leader"); // Expedition Leaders

    // 3. Batch-read contact properties for each bucket (parallel).
    const [students, schoolLeaders, expeditionLeaders] = await Promise.all([
      readContacts(studentIds, headers, true),
      readContacts(teacherIds, headers, false),
      readContacts(tripLeaderIds, headers, false),
    ]);

    // 4. Scan Jotform once, index flattened fields by email.
    const appByEmail = await buildApplicationIndex();

    // 5. Assemble the four sheets (pure).
    const data = assembleGroupInfo({
      program: { name: program.name, id: portalId },
      expeditionLeaders,
      schoolLeaders,
      students,
      appByEmail,
      departureDate: program.departureDate || "",
      generatedAt: new Date().toISOString(),
    });

    return json(200, data);
  } catch (err) {
    console.error("[get-group-info] ERROR:", err?.message || err);
    return json(500, { error: "Server error" });
  }
}

// ---------- helpers ----------

function json(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

// Portal name + (best-effort) departure date. The departure-date property name
// is a guess — adjust `DEPARTURE_DATE_PROPS` if your Portal uses another. When
// none is found, Age on Departure is simply left blank (as in the workbook).
const DEPARTURE_DATE_PROPS = ["departure_date", "trip_start_date", "start_date", "expedition_start_date"]; // VERIFY
async function fetchProgram(portalId, headers) {
  try {
    const props = ["name", "trip_name", "portal_name", ...DEPARTURE_DATE_PROPS];
    const res = await fetch(
      `https://api.hubapi.com/crm/v3/objects/${PORTAL_OBJECT}/${portalId}?properties=${encodeURIComponent(props.join(","))}`,
      { headers }
    );
    if (!res.ok) return { name: "", departureDate: "" };
    const d = await res.json();
    const p = d.properties || {};
    const name = (p.name || p.trip_name || p.portal_name || "").trim();
    let departureDate = "";
    for (const key of DEPARTURE_DATE_PROPS) {
      if (p[key]) { departureDate = p[key]; break; }
    }
    return { name, departureDate };
  } catch (_) {
    return { name: "", departureDate: "" };
  }
}

// Batch-read a bucket of contacts into the `person` shape group-info expects.
// Students additionally carry ue_student_status (review status) and their
// associated Parent contacts (emergency-contact fallback).
async function readContacts(ids, headers, isStudent) {
  if (!ids || ids.length === 0) return [];

  const properties = ["firstname", "lastname", "email", "phone"];
  if (isStudent) properties.push("ue_student_status");

  const res = await fetch("https://api.hubapi.com/crm/v3/objects/contacts/batch/read", {
    method: "POST",
    headers,
    body: JSON.stringify({ inputs: ids.map(id => ({ id: String(id) })), properties }),
  });
  if (!res.ok) {
    console.error("[get-group-info] contact batch-read failed:",
      (await res.text().catch(() => "")).slice(0, 300));
    return [];
  }
  const data = await res.json();

  const people = await Promise.all((data.results || []).map(async (c) => {
    const p = c.properties || {};
    const person = {
      id: c.id,
      firstName: p.firstname || "",
      lastName: p.lastname || "",
      name: `${p.firstname || ""} ${p.lastname || ""}`.trim(),
      email: p.email || "",
      phone: p.phone || "",
      // Unset ue_student_status defaults to "Discovery" (matches get-students).
      status: isStudent ? ((p.ue_student_status || "").trim() || "Discovery") : "",
      parents: [],
    };
    if (isStudent) person.parents = await fetchParents(c.id, headers);
    return person;
  }));

  people.sort((a, b) => a.name.localeCompare(b.name));
  return people;
}

// Emergency contacts = the student's associated Parent/guardian contacts.
// Returns [{ name, email, phone, role }]. `role` is the relationship, taken
// from the HubSpot association label when it names one (e.g. "Mother",
// "Father", "Guardian") or from a relationship property on the parent contact;
// blank when neither is set (the assembler then falls back to any Jotform
// relationship field).

// Association labels that mark a contact as an emergency/parent contact.
const PARENT_LABELS = ["parent", "mother", "father", "guardian", "caregiver", "carer",
                       "step-parent", "step parent", "grandparent", "next of kin", "emergency contact"]; // VERIFY
// Generic labels that are NOT a usable relationship on their own.
const GENERIC_PARENT_LABELS = new Set(["parent", "contact", "emergency contact"]);
// Contact properties that may hold a free-text relationship, tried in order.
const RELATIONSHIP_PROPS = ["relationship_to_student", "parent_relationship", "contact_relationship", "relationship"]; // VERIFY

function titleCase(s) {
  return String(s || "").toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

async function fetchParents(contactId, headers) {
  try {
    const r = await fetch(
      `https://api.hubapi.com/crm/v4/objects/contacts/${contactId}/associations/contacts`,
      { headers }
    );
    if (!r.ok) return [];
    const d = await r.json();

    // Keep parent contacts + the relationship label their association carries.
    const roleById = new Map();
    const parentIds = [];
    for (const x of d.results || []) {
      const labels = (x.associationTypes || [])
        .map(t => String(t.label || "").trim())
        .filter(Boolean);
      const isParent = labels.some(l => PARENT_LABELS.includes(l.toLowerCase()));
      if (!isParent) continue;
      parentIds.push(x.toObjectId);
      // A relationship label = the first non-generic parent label.
      const rel = labels.find(l => PARENT_LABELS.includes(l.toLowerCase()) && !GENERIC_PARENT_LABELS.has(l.toLowerCase()));
      if (rel) roleById.set(String(x.toObjectId), titleCase(rel));
    }
    if (parentIds.length === 0) return [];

    const pr = await fetch("https://api.hubapi.com/crm/v3/objects/contacts/batch/read", {
      method: "POST",
      headers,
      body: JSON.stringify({
        inputs: parentIds.map(id => ({ id: String(id) })),
        properties: ["firstname", "lastname", "email", "phone", ...RELATIONSHIP_PROPS],
      }),
    });
    if (!pr.ok) return [];
    const pd = await pr.json();
    return (pd.results || []).map(p => {
      const props = p.properties || {};
      let role = roleById.get(String(p.id)) || "";
      if (!role) {
        for (const key of RELATIONSHIP_PROPS) {
          if (props[key]) { role = String(props[key]).trim(); break; }
        }
      }
      return {
        name: `${props.firstname || ""} ${props.lastname || ""}`.trim(),
        email: props.email || "",
        phone: props.phone || "",
        role,
      };
    });
  } catch (_) {
    return [];
  }
}

// Scan every configured Jotform form ONCE and return Map<email, fields[]>,
// where fields are flattened the same way get-application-data.js does. Most
// recent submission per email wins.
async function buildApplicationIndex() {
  const out = new Map();
  if (!process.env.JOTFORM_API_KEY) return out;

  const apiKey = process.env.JOTFORM_API_KEY;
  const baseUrl = (process.env.JOTFORM_BASE_URL || "https://api.jotform.com").replace(/\/+$/, "");

  let all = [];
  try {
    const perForm = await Promise.all(DEFAULT_FORM_IDS.map(id => fetchAllSubmissions(id, apiKey, baseUrl)));
    all = perForm.flat();
  } catch (_) {
    return out;
  }

  // Ascending by created_at so the last write per email is the most recent.
  all.sort((a, b) => new Date(a?.created_at || 0) - new Date(b?.created_at || 0));

  for (const submission of all) {
    const email = submissionEmail(submission);
    if (!email) continue;
    out.set(email, extractFields(submission));
  }
  return out;
}

async function fetchAllSubmissions(formId, apiKey, baseUrl) {
  const list = [];
  let offset = 0;
  const pageSize = 1000;
  while (true) {
    const url = `${baseUrl}/form/${encodeURIComponent(formId)}/submissions` +
      `?apiKey=${encodeURIComponent(apiKey)}&limit=${pageSize}&offset=${offset}`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) break;
    const data = await res.json();
    const page = Array.isArray(data?.content) ? data.content : [];
    list.push(...page);
    if (page.length < pageSize) break;
    offset += pageSize;
    if (offset >= 5000) break;
  }
  return list;
}

function submissionEmail(submission) {
  const answers = submission?.answers || {};
  for (const k of Object.keys(answers)) {
    const a = answers[k];
    if (a && String(a.type || "").toLowerCase() === "control_email" && a.answer) {
      return String(a.answer).toLowerCase().trim();
    }
  }
  return null;
}

// Flatten a submission's answers to [{qid, order, type, label, value}], mirroring
// get-application-data.js so labels line up with the FIELD_MAP in lib/group-info.js.
function extractFields(submission) {
  const answers = submission?.answers || {};
  const ordered = Object.entries(answers)
    .map(([qid, a]) => ({ qid, ...(a || {}) }))
    .sort((x, y) => {
      const ox = parseInt(x.order, 10), oy = parseInt(y.order, 10);
      if (Number.isFinite(ox) && Number.isFinite(oy)) return ox - oy;
      return parseInt(x.qid, 10) - parseInt(y.qid, 10);
    });

  const out = [];
  for (const a of ordered) {
    const label = (a.text || a.name || "").trim();
    if (!label) continue;
    const value = formatAnswer(a);
    if (value == null || value === "") continue;
    out.push({ qid: a.qid, order: parseInt(a.order, 10) || null, type: a.type || null, label, value });
  }
  return out;
}

function formatAnswer(a) {
  const v = a.answer;
  const t = String(a.type || "").toLowerCase();
  if (v == null) return null;

  if (t === "control_fileupload") {
    if (Array.isArray(v)) return v.filter(Boolean).join(", ");
    return v ? String(v) : "";
  }
  if (t === "control_datetime" && typeof v === "object") {
    const { day, month, year } = v;
    if (day && month && year) return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    return "";
  }
  if (t === "control_fullname" && typeof v === "object") {
    return [v.first, v.middle, v.last].filter(Boolean).map(s => String(s).trim()).join(" ").trim() || null;
  }
  if (t === "control_address" && typeof v === "object") {
    return [v.addr_line1, v.addr_line2, v.city, v.state, v.postal, v.country]
      .filter(Boolean).map(s => String(s).trim()).join(", ");
  }
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(s => String(s)).filter(Boolean).join(", ");
  return JSON.stringify(v);
}
