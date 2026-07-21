// Lists the students associated to a given portal record, with each
// student's actual paid totals (read from their associated Deal's
// payment_1..10 strings) and any associated Parent contacts.
//
// Important: payment_1..10 live on the *Deal*, not the Contact. The previous
// implementation read those properties off the contact directly and got
// `undefined` for every student, which meant every card showed
// "TOTAL PAID: $0 / No payments recorded". This version walks contact →
// associated Deals (most recently created), parses the leading numeric
// value out of each deal payment_N string ("250, pi_xxx, 2026-03-12"), and
// sums them.

import { authenticate, tokenFromEvent } from "./_shared/auth.js";
import { assertPortalAccess } from "./_shared/portal-access.js";

export async function handler(event) {
  try {
    // Auth: signed in.
    const auth = await authenticate(event);
    if (auth.response) return auth.response;

    const { portalId } = event.queryStringParameters || {};

    if (!portalId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Missing portalId" })
      };
    }

    // Authorization: caller must be staff (Teacher/Trip Leader) on this trip,
    // or an admin. This is the most sensitive endpoint — it returns the whole
    // student roster with portraits and payment totals.
    const access = await assertPortalAccess(auth.session, portalId);
    if (access) return access;

    const OBJECT = "2-58156993";
    const headers = {
      Authorization: `Bearer ${process.env.HUBSPOT_API_KEY}`,
      "Content-Type": "application/json"
    };

    // 1. Get all contacts associated to this portal
    const assocRes = await fetch(
      `https://api.hubapi.com/crm/v4/objects/${OBJECT}/${portalId}/associations/contacts`,
      { headers }
    );

    if (!assocRes.ok) {
      console.error("[get-students] associations fetch failed:", (await assocRes.text().catch(() => "")).slice(0, 300));
      return {
        statusCode: 500,
        body: JSON.stringify({ error: "Portal contact associations fetch failed" })
      };
    }

    const assocData = await assocRes.json();

    // 2. Filter to only Student associations
    const studentIds = (assocData.results || [])
      .filter(r => r.associationTypes?.some(t => t.label === "Student"))
      .map(r => r.toObjectId);

    if (studentIds.length === 0) {
      return {
        statusCode: 200,
        body: JSON.stringify({ students: [] })
      };
    }

    // 3. Batch-read student contact basic info. Payment data lives on the
    //    associated deal (not here), but we DO pull two contact-level fields
    //    that the Teachers tab surfaces on each student card:
    //      - ue_student_status — e.g. "Confirmed", "Withdrawn", etc.
    //      - notes__c          — free-text notes from the school staff.
    //                            (The "__c" suffix is HubSpot's convention
    //                            for fields that came from a Salesforce
    //                            sync; the property is named "notes" in
    //                            the UI but the internal name keeps the
    //                            Salesforce-side suffix.)
    //    Both are read here regardless of which tab is calling, and the
    //    frontend decides whether to display them (Teachers tab only).
    const studentsRes = await fetch(
      "https://api.hubapi.com/crm/v3/objects/contacts/batch/read",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          inputs: studentIds.map(id => ({ id: String(id) })),
          properties: ["firstname", "lastname", "email", "phone", "ue_student_status", "notes__c"]
        })
      }
    );

    if (!studentsRes.ok) {
      console.error("[get-students] student batch-read failed:", (await studentsRes.text().catch(() => "")).slice(0, 300));
      return {
        statusCode: 500,
        body: JSON.stringify({ error: "Student batch-read failed" })
      };
    }

    const studentsData = await studentsRes.json();

    // 4. For each student, resolve parent contacts and deal-side payments
    //    in parallel. Also pull a single email→portrait map from the Jotform
    //    application form so each card can show a photo.
    const portraitsPromise = loadPortraitsByEmail();

    const studentsRaw = await Promise.all(
      (studentsData.results || []).map(async (student) => {
        const [parents, paymentInfo] = await Promise.all([
          fetchParents(student.id, headers),
          fetchStudentPayments(student.id, headers)
        ]);

        return {
          id: student.id,
          name: `${student.properties.firstname || ""} ${student.properties.lastname || ""}`.trim(),
          email: student.properties.email || "",
          phone: student.properties.phone || "",
          // Teacher-tab-only fields. Sent on every response; the frontend
          // chooses whether to render them based on which tab called.
          status: (student.properties.ue_student_status || "").trim(),
          notes:  (student.properties.notes__c || "").trim(),
          totalPaid: paymentInfo.totalPaid,
          payments: paymentInfo.payments,
          dealAmount: paymentInfo.dealAmount,
          parents
        };
      })
    );

    const portraitsByEmail = await portraitsPromise;
    // Append the caller's session token to portrait proxy URLs so the
    // (auth-gated) /document-proxy can verify the viewer — <img> tags can't
    // send an Authorization header.
    const callerToken = tokenFromEvent(event);
    const tokenSuffix = callerToken ? `&token=${encodeURIComponent(callerToken)}` : "";
    const students = studentsRaw.map(s => {
      const key = (s.email || "").toLowerCase().trim();
      const rawUrl = key ? portraitsByEmail.get(key) : null;
      return {
        ...s,
        // Route the portrait through our /document-proxy EDGE function so it
        // loads in the parent's browser without a Jotform login. We use the
        // edge function (not /.netlify/functions/get-document) because iPhone
        // portrait photos routinely exceed the 6MB synchronous-function
        // response cap. The edge function streams the upstream body straight
        // through, supporting files up to ~20MB. Null when there's no match.
        portraitUrl: rawUrl
          ? `/document-proxy?url=${encodeURIComponent(rawUrl)}${tokenSuffix}`
          : null
      };
    });

    // Sort students alphabetically
    students.sort((a, b) => a.name.localeCompare(b.name));

    return {
      statusCode: 200,
      body: JSON.stringify({ students })
    };

  } catch (err) {
    console.error("[get-students] ERROR:", err?.message || err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Server error" })
    };
  }
}

// ---------- helpers ----------

async function fetchParents(contactId, headers) {
  const parentAssocRes = await fetch(
    `https://api.hubapi.com/crm/v4/objects/contacts/${contactId}/associations/contacts`,
    { headers }
  );
  if (!parentAssocRes.ok) return [];

  const parentAssocData = await parentAssocRes.json();
  const parentIds = (parentAssocData.results || [])
    .filter(r => r.associationTypes?.some(t => t.label === "Parent"))
    .map(r => r.toObjectId);

  if (parentIds.length === 0) return [];

  const parentsRes = await fetch(
    "https://api.hubapi.com/crm/v3/objects/contacts/batch/read",
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        inputs: parentIds.map(id => ({ id: String(id) })),
        properties: ["firstname", "lastname", "email", "phone"]
      })
    }
  );

  if (!parentsRes.ok) return [];

  const parentsData = await parentsRes.json();
  return (parentsData.results || []).map(p => ({
    name: `${p.properties.firstname || ""} ${p.properties.lastname || ""}`.trim(),
    email: p.properties.email || "",
    phone: p.properties.phone || ""
  }));
}

// Returns the student's actual paid totals from their most recently created
// associated Deal. Uses the same payment_N parsing pattern as get-paid-payments.js.
async function fetchStudentPayments(contactId, headers) {
  const empty = { totalPaid: 0, payments: [], dealAmount: null };

  // Find associated deals for the student
  const dealAssocRes = await fetch(
    `https://api.hubapi.com/crm/v4/objects/contacts/${contactId}/associations/deals`,
    { headers }
  );
  if (!dealAssocRes.ok) return empty;

  const dealAssocData = await dealAssocRes.json();
  const dealIds = (dealAssocData.results || [])
    .map(r => r.toObjectId)
    .filter(Boolean);

  if (dealIds.length === 0) return empty;

  // Batch-read those deals — createdate to pick the most recent, plus all
  // payment fields and the deal's amount for context.
  const PAYMENT_FIELDS = [
    "payment_1", "payment_2", "payment_3", "payment_4", "payment_5",
    "payment_6", "payment_7", "payment_8", "payment_9", "payment_10"
  ];

  const dealsRes = await fetch(
    "https://api.hubapi.com/crm/v3/objects/deals/batch/read",
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        inputs: dealIds.map(id => ({ id: String(id) })),
        properties: ["dealname", "createdate", "amount", "total_amount_paid", ...PAYMENT_FIELDS]
      })
    }
  );

  if (!dealsRes.ok) return empty;

  const dealsData = await dealsRes.json();
  const deals = dealsData.results || [];
  if (deals.length === 0) return empty;

  // Pick most recently created
  const sorted = deals.slice().sort((a, b) => {
    const ta = new Date(a.properties?.createdate || 0).getTime();
    const tb = new Date(b.properties?.createdate || 0).getTime();
    return tb - ta;
  });
  const deal = sorted[0];

  let totalPaid = 0;
  const payments = [];
  for (let i = 1; i <= 10; i++) {
    const raw = deal.properties?.[`payment_${i}`];
    const amount = extractPaymentAmount(raw);
    if (amount != null && amount > 0) {
      totalPaid += amount;
      payments.push({ label: `Payment ${i}`, amount });
    }
  }

  return {
    totalPaid: Math.round(totalPaid * 100) / 100,
    payments,
    dealAmount: deal.properties?.amount ? parseFloat(deal.properties.amount) : null
  };
}

// Builds an email → portrait-photo URL map by walking every submission of the
// Jotform application form(s). Form IDs come from the JOTFORM_APPLICATION_FORM_ID
// env var (comma-separated list); default falls back to the original application
// form plus its successor so students who used the newer form aren't missed.
//
// For each submission we look at the email-control answer and any
// control_fileupload whose label mentions "portrait" — if both are present, we
// record the (lowercased) email → first photo URL. Most recent submission wins.
//
// Failures are swallowed silently: if the API key is missing or the call
// fails, we just return an empty map and student cards render without photos.
async function loadPortraitsByEmail() {
  const empty = new Map();
  if (!process.env.JOTFORM_API_KEY) return empty;

  const formIds = (process.env.JOTFORM_APPLICATION_FORM_ID
    || "251396787451873,253477140703050,260388618557066,250747665126866")
    .split(",").map(s => s.trim()).filter(Boolean);
  if (formIds.length === 0) return empty;

  const apiKey = process.env.JOTFORM_API_KEY;
  const baseUrl = (process.env.JOTFORM_BASE_URL || "https://api.jotform.com").replace(/\/+$/, "");

  let allSubmissions = [];
  try {
    const perForm = await Promise.all(formIds.map(async (formId) => {
      const list = [];
      let offset = 0;
      while (true) {
        const url = `${baseUrl}/form/${encodeURIComponent(formId)}/submissions` +
          `?apiKey=${encodeURIComponent(apiKey)}&limit=1000&offset=${offset}`;
        const res = await fetch(url, { headers: { Accept: "application/json" } });
        if (!res.ok) return [];
        const data = await res.json();
        const page = Array.isArray(data?.content) ? data.content : [];
        list.push(...page);
        if (page.length < 1000) break;
        offset += 1000;
        if (offset >= 5000) break; // safety net
      }
      return list;
    }));
    allSubmissions = perForm.flat();
  } catch (_) {
    return empty;
  }

  // Sort ascending by created_at so when we write into the map below, the
  // last value to win is the most recent submission for each email.
  allSubmissions.sort((a, b) => {
    const ta = new Date(a?.created_at || 0).getTime();
    const tb = new Date(b?.created_at || 0).getTime();
    return ta - tb;
  });

  const out = new Map();
  for (const submission of allSubmissions) {
    const answers = submission?.answers || {};
    let email = null;
    let portrait = null;

    for (const k of Object.keys(answers)) {
      const a = answers[k] || {};
      const t = String(a.type || "").toLowerCase();
      if (!email && t === "control_email" && a.answer) {
        email = String(a.answer).toLowerCase().trim();
      } else if (!portrait && t === "control_fileupload" && a.answer) {
        const text = String(a.text || "").toLowerCase();
        if (/portrait/.test(text)) {
          const v = a.answer;
          if (Array.isArray(v) && v.length > 0) portrait = String(v[0]);
          else if (typeof v === "string" && v) portrait = v;
        }
      }
    }

    if (email && portrait) out.set(email, portrait);
  }

  return out;
}

// Pulls the leading numeric value out of a deal's payment_N string, which is
// stored in the loose "<amount>, <stripe_pi>, <date>" format on the Deal
// object. Tolerates messy formats — strips any non-digit chars from the first
// comma-separated token, returns null if nothing valid is left.
function extractPaymentAmount(raw) {
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const first = trimmed.split(",")[0].trim();
  // Keep digits, dots, minus; drop currency symbols, letters, etc.
  const cleaned = first.replace(/[^0-9.\-]/g, "");
  if (!cleaned || cleaned === "-" || cleaned === ".") return null;
  const n = parseFloat(cleaned);
  if (!isFinite(n) || n <= 0) return null;
  return n;
}
