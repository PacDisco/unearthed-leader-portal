// Returns the most recent application-form (Jotform) submission for a given
// contact email, with each answered field flattened to {label, value, type,
// order, qid}. Used by the Trip Leader tab to expand a student card and show
// their passport / medical / health / dietary details.
//
// Inputs (querystring):
//   email   — the contact email to look up (required)
//   formId  — comma-separated Jotform form ID(s); defaults to env
//             JOTFORM_APPLICATION_FORM_ID, else
//             "251396787451873,253477140703050,260388618557066" (the original application
//             form + the newer version some students use).
//
// Required env var: JOTFORM_API_KEY
// Optional env var: JOTFORM_BASE_URL  (default https://api.jotform.com)
// Optional env var: JOTFORM_APPLICATION_FORM_ID — comma-separated list of
//                   form IDs to search across. Add more here when new
//                   application-form versions are spun up so old students
//                   don't drop out of the lookup.

const DEFAULT_FORM_IDS = (process.env.JOTFORM_APPLICATION_FORM_ID
  || "251396787451873,253477140703050,260388618557066")
  .split(",").map(s => s.trim()).filter(Boolean);

export async function handler(event) {
  try {
    const { email, formId } = event.queryStringParameters || {};

    if (!email) {
      return { statusCode: 400, body: JSON.stringify({ error: "Missing email" }) };
    }
    if (!process.env.JOTFORM_API_KEY) {
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: "Jotform is not configured",
          details: "Set JOTFORM_API_KEY in Netlify environment variables."
        })
      };
    }

    const cleanEmail = String(email).toLowerCase().trim();
    const apiKey = process.env.JOTFORM_API_KEY;
    const baseUrl = (process.env.JOTFORM_BASE_URL || "https://api.jotform.com").replace(/\/+$/, "");

    const targetFormIds = (formId
      ? String(formId).split(",").map(s => s.trim()).filter(Boolean)
      : DEFAULT_FORM_IDS);
    if (targetFormIds.length === 0) {
      return { statusCode: 400, body: JSON.stringify({ error: "No form IDs configured" }) };
    }

    // Fetch every submission across all configured form IDs in parallel.
    const perForm = await Promise.all(
      targetFormIds.map(id => fetchAllSubmissions(id, apiKey, baseUrl)
        .then(r => ({ id, ...r })))
    );

    let firstError = null;
    const matching = []; // { submission, formId }
    for (const r of perForm) {
      if (r.error) { if (!firstError) firstError = r.error; continue; }
      for (const s of r.list) {
        if (submissionEmailMatches(s, cleanEmail)) {
          matching.push({ submission: s, formId: r.id });
        }
      }
    }

    if (matching.length === 0) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          found: false,
          formId: targetFormIds.join(","),
          submissionId: null,
          submittedAt: null,
          fields: [],
          warning: firstError || null
        })
      };
    }

    // Most recent submission across all forms wins
    matching.sort((a, b) => {
      const ta = new Date(a.submission.created_at || 0).getTime();
      const tb = new Date(b.submission.created_at || 0).getTime();
      return tb - ta;
    });

    const winner = matching[0];
    const fields = extractFields(winner.submission);

    return {
      statusCode: 200,
      body: JSON.stringify({
        found: true,
        formId: winner.formId,
        submissionId: winner.submission.id,
        submittedAt: winner.submission.created_at || null,
        fields,
        warning: firstError || null
      })
    };

  } catch (err) {
    console.error("ERROR:", err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
}

// ---------- helpers ----------

function submissionEmailMatches(submission, cleanEmail) {
  const answers = submission?.answers || {};
  for (const k of Object.keys(answers)) {
    const a = answers[k];
    if (!a) continue;
    if (String(a.type || "").toLowerCase() === "control_email" && a.answer) {
      if (String(a.answer).toLowerCase().trim() === cleanEmail) return true;
    }
  }
  return false;
}

function extractFields(submission) {
  const answers = submission?.answers || {};
  const out = [];

  // Sort by order so the frontend can render in form order.
  const ordered = Object.entries(answers)
    .map(([qid, a]) => ({ qid, ...(a || {}) }))
    .sort((x, y) => {
      const ox = parseInt(x.order, 10);
      const oy = parseInt(y.order, 10);
      if (Number.isFinite(ox) && Number.isFinite(oy)) return ox - oy;
      return parseInt(x.qid, 10) - parseInt(y.qid, 10);
    });

  for (const a of ordered) {
    const label = (a.text || a.name || "").trim();
    if (!label) continue;
    const value = formatAnswer(a);
    if (value == null || value === "") continue;
    out.push({
      qid: a.qid,
      order: parseInt(a.order, 10) || null,
      type: a.type || null,
      label,
      value
    });
  }

  return out;
}

function formatAnswer(a) {
  const v = a.answer;
  const t = String(a.type || "").toLowerCase();
  if (v == null) return null;

  if (t === "control_fileupload") {
    if (Array.isArray(v)) return v.filter(Boolean);
    return v ? [String(v)] : [];
  }

  if (t === "control_datetime" && typeof v === "object") {
    const day = v.day, month = v.month, year = v.year;
    if (day && month && year) {
      return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
    return JSON.stringify(v);
  }

  if (t === "control_fullname" && typeof v === "object") {
    const parts = [v.first, v.middle, v.last].filter(Boolean).map(s => String(s).trim());
    return parts.join(" ").trim() || null;
  }

  if (t === "control_address" && typeof v === "object") {
    const parts = [v.addr_line1, v.addr_line2, v.city, v.state, v.postal, v.country]
      .filter(Boolean).map(s => String(s).trim());
    return parts.join(", ");
  }

  if (typeof v === "string") return v.trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(s => String(s)).filter(Boolean).join(", ");
  return JSON.stringify(v);
}

async function fetchAllSubmissions(formId, apiKey, baseUrl) {
  const list = [];
  let offset = 0;
  const pageSize = 1000;
  while (true) {
    const url = `${baseUrl}/form/${encodeURIComponent(formId)}/submissions` +
      `?apiKey=${encodeURIComponent(apiKey)}&limit=${pageSize}&offset=${offset}`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });

    if (!res.ok) {
      const text = await res.text();
      return { error: `HTTP ${res.status}: ${text.slice(0, 300)}` };
    }

    const data = await res.json();
    const page = Array.isArray(data?.content) ? data.content : [];
    list.push(...page);
    if (page.length < pageSize) break;
    offset += pageSize;
    if (offset >= 5000) break;
  }
  return { list };
}
