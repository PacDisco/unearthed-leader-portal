// Server-side Jotform service module.
//
// All Jotform API access goes through here so the owner API key lives in
// exactly one place (environment variables) and never reaches the browser.
// The frontend never sees a submission ID or an edit URL — it only ever
// talks to our own /get-application and /update-application endpoints, which
// call into this module.
//
// Required env var:
//   JOTFORM_API_KEY — Jotform owner API key.
//
// Optional env vars:
//   JOTFORM_BASE_URL            — default https://api.jotform.com
//   JOTFORM_APPLICATION_FORM_ID — comma-separated form ID(s) to search when
//                                 resolving a user's submission by email.
//                                 Defaults to ONLY the Unearthed application
//                                 form (251396787451873). The document-upload
//                                 form (261220345497052) is intentionally
//                                 excluded so the editor can never load it —
//                                 otherwise a more-recent doc-upload submission
//                                 would win over the application submission.

const DEFAULT_FORM_IDS = (process.env.JOTFORM_APPLICATION_FORM_ID
  || "251396787451873")
  .split(",").map(s => s.trim()).filter(Boolean);

function apiKey() {
  const k = process.env.JOTFORM_API_KEY;
  if (!k) throw new Error("JOTFORM_API_KEY is not configured");
  return k;
}
function baseUrl() {
  return (process.env.JOTFORM_BASE_URL || "https://api.jotform.com").replace(/\/+$/, "");
}

// ---------------------------------------------------------------------------
// Sensitive-field detection
// ---------------------------------------------------------------------------
// Fields whose label matches any of these patterns are treated as sensitive:
// their current value is NEVER returned to the browser, and on update they
// are only written if the user actually typed a replacement. Tune this list
// to match your form's wording.
const SENSITIVE_LABEL_PATTERNS = [
  /passport/i,
  /\bvisa\b/i,
  /national\s*id|identity\s*(card|number)/i,
  /health|medical|medication|prescription/i,
  /\ballerg/i,
  /diet|dietary/i,
  /\bcondition(s)?\b/i,
  /mental\s*health|counsel|therapy|psych/i,
  /insurance\s*(policy|number|no\b)/i,
  /\bdisab/i,
];

export function isSensitiveLabel(label = "") {
  return SENSITIVE_LABEL_PATTERNS.some(re => re.test(String(label)));
}

// ---------------------------------------------------------------------------
// Which Jotform control types the portal allows editing.
//
// Simple (scalar) editable types are written as submission[QID]=value.
// Address is a composite type, edited subfield-by-subfield and written as
// submission[QID_addr_line1]=..., etc.
//
// Deliberately READ-ONLY: email — it's the key we match submissions on, so
// editing it would orphan the submission from its contact. Dates and file
// uploads stay read-only too, so a flat write can't corrupt structured data.
// Names are NOT read-only: they're edited through the composite path below,
// one subfield at a time.
// ---------------------------------------------------------------------------
const EDITABLE_TYPES = new Set([
  "control_textbox",
  "control_textarea",
  "control_phone",
  "control_number",
  "control_dropdown",
  "control_radio",
  "control_autocomplete",
]);

// Composite subfields, in display order, per composite type. Keys are
// Jotform's standard subfield names; only these keys are ever accepted on
// update, so a composite can never be written with an arbitrary key.
//
// control_fullname is editable BECAUSE of the passport-name problem: the name
// on a booking has to match the passport, and the only way to correct it is to
// write the name question's parts. It is still never written as one flat
// string — that's what would corrupt the stored shape.
const COMPOSITE_SUBFIELDS = {
  control_address: [
    { key: "addr_line1", label: "Street Address" },
    { key: "addr_line2", label: "Street Address Line 2" },
    { key: "city",       label: "City" },
    { key: "state",      label: "State / Province" },
    { key: "postal",     label: "Postal / Zip Code" },
    { key: "country",    label: "Country" },
  ],
  control_fullname: [
    { key: "prefix", label: "Title" },
    { key: "first",  label: "First Name" },
    { key: "middle", label: "Middle Name(s)" },
    { key: "last",   label: "Last Name" },
    { key: "suffix", label: "Suffix" },
  ],
};

// Jotform only returns the subfields a form actually asks for. Rendering an
// input for a subfield the form doesn't have would invite a write that goes
// nowhere, so the optional ones are only shown when the submission carries
// them (or the form clearly uses them).
const ALWAYS_SHOWN_SUBKEYS = new Set([
  "addr_line1", "addr_line2", "city", "state", "postal", "country",
  "first", "middle", "last",
]);

function subfieldsFor(type) {
  return COMPOSITE_SUBFIELDS[String(type).toLowerCase()] || null;
}

function isEditableType(type = "") {
  return EDITABLE_TYPES.has(String(type).toLowerCase());
}
function isEditableComposite(type = "") {
  return !!subfieldsFor(type);
}

// ---------------------------------------------------------------------------
// Core API methods (exactly as the spec calls for)
// ---------------------------------------------------------------------------

// getSubmission(submissionId) -> raw Jotform submission object.
export async function getSubmission(submissionId) {
  const url = `${baseUrl()}/submission/${encodeURIComponent(submissionId)}` +
    `?apiKey=${encodeURIComponent(apiKey())}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Jotform GET submission ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  return data?.content || null;
}

// updateSubmission(submissionId, fields) where `fields` is a map of Jotform
// submission keys to string values, e.g. { "3": "AB1234567", "5": "..." }.
// Composite subfields use the "qid_sublabel" form, e.g. { "2_first": "Jane" }.
// Posts as application/x-www-form-urlencoded: submission[KEY]=VALUE.
export async function updateSubmission(submissionId, fields) {
  const entries = Object.entries(fields || {}).filter(([, v]) => v != null);
  if (entries.length === 0) {
    return { updated: false, reason: "no fields to update" };
  }

  const body = new URLSearchParams();
  for (const [key, value] of entries) {
    body.append(`submission[${key}]`, String(value));
  }

  const url = `${baseUrl()}/submission/${encodeURIComponent(submissionId)}` +
    `?apiKey=${encodeURIComponent(apiKey())}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Jotform POST submission ${res.status}: ${text.slice(0, 300)}`);
  }
  return { updated: true };
}

// ---------------------------------------------------------------------------
// Resolve a user's own submission by their (already-verified) email.
// Mirrors get-application-data.js: scans configured forms, matches the email
// answer, returns the most recent submission's id + form id.
// ---------------------------------------------------------------------------
export async function findSubmissionByEmail(email, formIdOverride) {
  const cleanEmail = String(email || "").toLowerCase().trim();
  if (!cleanEmail) return { found: false };

  const formIds = (formIdOverride
    ? String(formIdOverride).split(",").map(s => s.trim()).filter(Boolean)
    : DEFAULT_FORM_IDS);

  const perForm = await Promise.all(
    formIds.map(id => fetchAllSubmissions(id).then(r => ({ id, ...r })))
  );

  const matching = [];
  let firstError = null;
  for (const r of perForm) {
    if (r.error) { if (!firstError) firstError = r.error; continue; }
    for (const s of r.list) {
      if (submissionEmailMatches(s, cleanEmail)) matching.push({ submission: s, formId: r.id });
    }
  }
  if (matching.length === 0) return { found: false, warning: firstError };

  matching.sort((a, b) =>
    new Date(b.submission.created_at || 0) - new Date(a.submission.created_at || 0));

  const winner = matching[0];
  return {
    found: true,
    submissionId: winner.submission.id,
    formId: winner.formId,
    submission: winner.submission,
    warning: firstError,
  };
}

// ---------------------------------------------------------------------------
// Build the client-safe field list. Sensitive field VALUES are withheld
// entirely (we only signal whether a value exists) so passport / health data
// never crosses the wire. Non-editable types are flagged read-only.
// ---------------------------------------------------------------------------
// `options.revealSensitive` — used ONLY by the expedition-leader editor. The
// self-service editor withholds passport/medical values because the student is
// assumed to know their own answers and the browser has no business holding
// them. A leader is editing someone ELSE's answers and already sees them in
// the Medical Information modal, so withholding here would mean they could
// only overwrite blind. Authorization for that view is enforced by
// resolveRosterEditAccess before this is ever called.
export function buildClientFields(submission, options = {}) {
  const revealSensitive = !!options.revealSensitive;
  const answers = submission?.answers || {};
  const out = [];

  const ordered = Object.entries(answers)
    .map(([qid, a]) => ({ qid, ...(a || {}) }))
    .sort((x, y) => {
      const ox = parseInt(x.order, 10), oy = parseInt(y.order, 10);
      if (Number.isFinite(ox) && Number.isFinite(oy)) return ox - oy;
      return parseInt(x.qid, 10) - parseInt(y.qid, 10);
    });

  for (const a of ordered) {
    const label = (a.text || a.name || "").trim();
    if (!label) continue;
    const type = String(a.type || "").toLowerCase();
    // Skip pure layout/control fields that carry no user data.
    if (["control_head", "control_text", "control_button", "control_divider", "control_pagebreak", "control_captcha"].includes(type)) {
      continue;
    }

    const sensitive = isSensitiveLabel(label);
    // Withhold the value only when we're NOT in the leader editor.
    const withhold = sensitive && !revealSensitive;

    // Editable composite (address): expose per-subfield values so the UI can
    // render one input per part. Values are still withheld if the field is
    // somehow flagged sensitive, preserving the no-leak guarantee.
    if (isEditableComposite(type)) {
      const v = (a.answer && typeof a.answer === "object") ? a.answer : {};
      const subfields = subfieldsFor(type)
        .filter(sf => ALWAYS_SHOWN_SUBKEYS.has(sf.key) || v[sf.key] != null)
        .map(sf => ({
        key: `${a.qid}_${sf.key}`,        // composite key sent back on update
        label: sf.label,
        value: withhold ? "" : (v[sf.key] != null ? String(v[sf.key]) : ""),
      }));
      out.push({
        qid: a.qid,
        label,
        type,
        sensitive,
        editable: true,
        composite: true,
        hasValue: subfields.some(s => s.value !== ""),
        subfields,
      });
      continue;
    }

    const editable = isEditableType(type);
    const displayValue = formatAnswer(a);
    const hasValue = displayValue != null && displayValue !== "";

    out.push({
      qid: a.qid,
      label,
      type,
      sensitive,
      editable,
      hasValue,
      // CRITICAL: never expose the real value of a sensitive field — unless
      // this is the leader editor, which is authorized to see it.
      value: withhold ? null : (hasValue ? displayValue : ""),
    });
  }
  return out;
}

// Map an incoming {qid -> newValue} change set to Jotform submission keys,
// honouring editability and the sensitive-blank rule (blank sensitive field =
// leave existing value untouched). `submission` is the current raw submission
// (used to confirm field type/label). Returns { fields, skipped }.
// `options.allowSensitiveBlank` — the self-service editor never receives a
// sensitive field's current value, so a blank there means "user didn't retype
// it" and must be preserved. The leader editor DOES show the current value and
// only sends fields that actually changed, so a blank there is a deliberate
// clear and is written through.
export function buildUpdatePayload(submission, changes, options = {}) {
  const allowSensitiveBlank = !!options.allowSensitiveBlank;
  const answers = submission?.answers || {};
  const fields = {};
  const skipped = [];

  for (const [key, rawVal] of Object.entries(changes || {})) {
    const value = rawVal == null ? "" : String(rawVal);

    // Composite subfield key, e.g. "12_addr_line1". The base qid is the
    // leading digits; the remainder is the subfield name.
    const us = key.indexOf("_");
    if (us > 0) {
      const baseQid = key.slice(0, us);
      const sub = key.slice(us + 1);
      const a = answers[baseQid];
      if (!a) { skipped.push({ qid: key, reason: "unknown field" }); continue; }
      const type = String(a.type || "").toLowerCase();
      if (!isEditableComposite(type)) {
        skipped.push({ qid: key, reason: `composite not editable: ${type}` });
        continue;
      }
      const allowed = subfieldsFor(type);
      if (!allowed.some(sf => sf.key === sub)) {
        skipped.push({ qid: key, reason: `unknown ${type} subfield: ${sub}` });
        continue;
      }
      // Composite subfields aren't treated as sensitive; write as-is
      // (including blanks, so e.g. a wrongly-entered middle name can be
      // cleared to match a passport that has none).
      fields[key] = value;
      continue;
    }

    const a = answers[key];
    if (!a) { skipped.push({ qid: key, reason: "unknown field" }); continue; }

    const type = String(a.type || "").toLowerCase();
    const label = (a.text || a.name || "").trim();

    if (!isEditableType(type)) { skipped.push({ qid: key, reason: `read-only type ${type}` }); continue; }

    // Sensitive + blank => preserve existing value (don't write).
    if (!allowSensitiveBlank && isSensitiveLabel(label) && value.trim() === "") {
      skipped.push({ qid: key, reason: "sensitive field left blank — preserved" });
      continue;
    }

    fields[key] = value;
  }

  return { fields, skipped };
}

// Turns the write payload from buildUpdatePayload back into something a human
// can read — used for the audit note written to HubSpot after a leader edits
// someone's application. Composite address keys ("12_city") are resolved to
// "<field label> — City".
export function describeFields(submission, fields) {
  const answers = submission?.answers || {};
  const subLabel = Object.fromEntries(
    Object.values(COMPOSITE_SUBFIELDS).flat().map(s => [s.key, s.label])
  );

  return Object.entries(fields || {}).map(([key, value]) => {
    const us = key.indexOf("_");
    if (us > 0 && answers[key.slice(0, us)]) {
      const base = answers[key.slice(0, us)];
      const sub = key.slice(us + 1);
      const baseLabel = (base.text || base.name || `Field ${key.slice(0, us)}`).trim();
      return { key, label: `${baseLabel} — ${subLabel[sub] || sub}`, value: String(value) };
    }
    const a = answers[key];
    return {
      key,
      label: (a && (a.text || a.name) || `Field ${key}`).trim(),
      value: String(value)
    };
  });
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
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
    if (day && month && year) {
      return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
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
  return "";
}

async function fetchAllSubmissions(formId) {
  const list = [];
  let offset = 0;
  const pageSize = 1000;
  while (true) {
    const url = `${baseUrl()}/form/${encodeURIComponent(formId)}/submissions` +
      `?apiKey=${encodeURIComponent(apiKey())}&limit=${pageSize}&offset=${offset}`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { error: `HTTP ${res.status}: ${text.slice(0, 300)}`, list };
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
