// Pulls a parent/student's previously-uploaded files directly from the
// Jotform form(s) they submitted them through.
//
// Why we go to Jotform directly rather than reading them off the contact in
// HubSpot: Jotform is the source of truth for the actual file URLs and the
// per-question labels (e.g. "Passport", "Medical form", "Consent letter"),
// and a HubSpot mirror would lose that context.
//
// Inputs (querystring):
//   email     — the logged-in portal user's email (required)
//   formIds   — comma-separated Jotform form IDs (preferred)
//   formId    — single Jotform form ID (legacy, still supported)
//
// Required env var: JOTFORM_API_KEY
// Optional env var: JOTFORM_BASE_URL (default https://api.jotform.com — set to
//                   https://eu-api.jotform.com or https://hipaa-api.jotform.com
//                   if your account is on those regions)
//
// Per-form labelling:
//   Most forms (e.g. the application form) have one named upload field per
//   document — "Passport", "Medical Form", etc. — and we use that field's
//   own label as the document name in the portal.
//
//   The free-form "document upload" form has a repeating pattern of
//   "Document Name" textbox + generic file-upload, so we use the value the
//   parent typed into that textbox as the label.
//
//   The doc-name replacement is triggered when EITHER:
//     (a) the form's ID is opted in via DOC_NAME_PATTERN_FORMS below, OR
//     (b) the upload field's own label is generic — "Additional File Upload",
//         "Upload", "File", "Attachment", "Photo Upload", etc.
//   Specific labels like "Passport" or "Medical Form" never get overridden,
//   so the application form is unaffected.
const DOC_NAME_PATTERN_FORMS = new Set([
  // Add a form ID here if it has SPECIFIC upload-field labels but you still
  // want the textbox-before-upload value to take precedence. Most forms don't
  // need this — the generic-label fallback below handles them automatically.
]);

// Returns true if a Jotform upload-field label is generic enough that we'd
// rather show the user-typed "document name" textbox value instead.
function isGenericUploadLabel(label) {
  if (!label) return true;
  const l = String(label).toLowerCase().trim();
  if (!l) return true;
  // "Additional File Upload", "File Upload", "Document Upload", "Photo Upload",
  // "Image Upload", "Attachment Upload", plain "Upload", plain "File", etc.
  if (/^(additional\s+|please\s+|new\s+|another\s+)?(file\s+|document\s+|attachment\s+|photo\s+|image\s+)?(upload|attachment|file|document)s?$/i.test(l)) {
    return true;
  }
  // "Upload (a/the/your) (file/document/photo/image/attachment)"
  if (/^upload(\s+(a|the|your))?\s+(file|document|attachment|photo|image)s?$/i.test(l)) {
    return true;
  }
  return false;
}

export async function handler(event) {
  try {
    const { email, formId, formIds } = event.queryStringParameters || {};

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

    // Accept either a single formId or multiple via formIds=.
    const idList = (formIds || formId || "")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean);

    if (idList.length === 0) {
      return { statusCode: 400, body: JSON.stringify({ error: "Missing formId / formIds" }) };
    }

    const cleanEmail = String(email).toLowerCase().trim();
    const apiKey = process.env.JOTFORM_API_KEY;
    const baseUrl = (process.env.JOTFORM_BASE_URL || "https://api.jotform.com").replace(/\/+$/, "");

    // Process all forms in parallel — title fetch + submissions fetch each.
    const perForm = await Promise.all(idList.map(id => loadFormData(id, cleanEmail, apiKey, baseUrl)));

    // Aggregate
    const documents = [];
    const forms = [];
    let firstError = null;
    for (const r of perForm) {
      if (r.error && !firstError) firstError = r.error;
      forms.push({ id: r.id, title: r.title || null });
      for (const d of r.documents) documents.push(d);
    }

    documents.sort((a, b) => {
      const ta = a.uploadedAt ? new Date(a.uploadedAt).getTime() : 0;
      const tb = b.uploadedAt ? new Date(b.uploadedAt).getTime() : 0;
      return tb - ta;
    });

    const response = { documents, forms };
    if (firstError) response.warning = firstError;

    return {
      statusCode: 200,
      body: JSON.stringify(response)
    };

  } catch (err) {
    console.error("ERROR:", err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
}

async function loadFormData(formId, cleanEmail, apiKey, baseUrl) {
  const out = { id: formId, title: null, documents: [], error: null };

  // Fetch form metadata (for the title) and submissions in parallel.
  const [titleRes, submissions] = await Promise.all([
    fetchFormTitle(formId, apiKey, baseUrl),
    fetchAllSubmissions(formId, apiKey, baseUrl)
  ]);

  if (titleRes.error) {
    // Title is nice-to-have; don't fail the whole call over it.
    console.warn(`Form ${formId} title fetch warning:`, titleRes.error);
  } else {
    out.title = titleRes.title || null;
  }

  if (submissions.error) {
    out.error = `Form ${formId}: ${submissions.error}`;
    return out;
  }

  const isOptInForm = DOC_NAME_PATTERN_FORMS.has(String(formId));

  for (const submission of submissions.list) {
    const answers = submission?.answers || {};

    // Sort answers by `order` so we can detect a "Document Name" textbox
    // that immediately precedes a file-upload field.
    const ordered = Object.entries(answers)
      .map(([qid, a]) => ({ qid, ...(a || {}) }))
      .sort((x, y) => {
        const ox = parseInt(x.order, 10);
        const oy = parseInt(y.order, 10);
        if (Number.isFinite(ox) && Number.isFinite(oy)) return ox - oy;
        return parseInt(x.qid, 10) - parseInt(y.qid, 10);
      });

    let submissionEmail = null;
    let lastTextValue = null; // last non-empty textbox/textarea answer seen
    const fileUploads = [];

    for (const a of ordered) {
      const t = String(a.type || "").toLowerCase();
      const label = a.text || a.name || "";

      if (t === "control_email" && a.answer) {
        submissionEmail = String(a.answer).toLowerCase().trim();
      } else if (t === "control_textbox" || t === "control_textarea") {
        const v = a.answer;
        if (v && String(v).trim()) lastTextValue = String(v).trim();
      } else if (t === "control_fileupload" && a.answer) {
        // Decide what label to attach to this upload's documents.
        //
        // Order of preference:
        //   1. If a "Document Name" textbox came right before, use that.
        //   2. Else if the upload field has a SPECIFIC label (e.g. "Passport"),
        //      use that.
        //   3. Else (generic label like "Additional file upload" with nothing
        //      typed in the textbox), return null so the frontend can hide
        //      the heading entirely instead of showing a meaningless one.
        const generic = isGenericUploadLabel(label);
        let effectiveLabel;
        if (lastTextValue && (isOptInForm || generic)) {
          effectiveLabel = lastTextValue;
        } else if (generic) {
          effectiveLabel = null;
        } else {
          effectiveLabel = label;
        }

        const v = a.answer;
        const urls = Array.isArray(v) ? v.filter(Boolean) : [String(v)].filter(Boolean);
        for (const u of urls) {
          fileUploads.push({ url: u, fieldLabel: effectiveLabel });
        }
        // Don't carry the same textbox value over to the next file upload.
        lastTextValue = null;
      }
    }

    if (!submissionEmail || submissionEmail !== cleanEmail) continue;
    if (fileUploads.length === 0) continue;

    for (const f of fileUploads) {
      let filename = "Document";
      try {
        const u = new URL(f.url);
        filename = decodeURIComponent(u.pathname.split("/").pop() || "Document");
      } catch (_) { /* leave default */ }

      out.documents.push({
        submissionId: submission.id,
        formId,
        uploadedAt: submission.created_at || null,
        fieldLabel: f.fieldLabel,
        filename,
        // Route the file through our /document-proxy EDGE function so the
        // parent doesn't need a Jotform login to view it. We use the edge
        // function (not /.netlify/functions/get-document) because uploaded
        // documents — passport scans, medical PDFs, photos — can be larger
        // than the 6MB synchronous-function cap. The edge function streams
        // the upstream body straight through with no base64 overhead.
        url: `/document-proxy?url=${encodeURIComponent(f.url)}`
      });
    }
  }

  return out;
}

async function fetchFormTitle(formId, apiKey, baseUrl) {
  try {
    const res = await fetch(
      `${baseUrl}/form/${encodeURIComponent(formId)}?apiKey=${encodeURIComponent(apiKey)}`,
      { headers: { Accept: "application/json" } }
    );
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const data = await res.json();
    return { title: data?.content?.title || null };
  } catch (err) {
    return { error: err.message };
  }
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
    if (offset >= 5000) break; // safety net
  }
  return { list };
}
