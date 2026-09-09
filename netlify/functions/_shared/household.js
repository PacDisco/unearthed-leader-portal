// Who counts as "this student's household" — the people whose Jotform
// uploads belong together on one student record.
//
// ---------------------------------------------------------------------------
// THE PROBLEM THIS SOLVES
// ---------------------------------------------------------------------------
// A Jotform submission carries only the email the submitter typed. Matching
// that against a single email meant every view of a student's documents was
// really a view of "documents submitted under this exact address":
//
//   * a parent uploaded the passport  → the student's own portal showed
//     nothing, and the student re-uploaded it
//   * a student uploaded the passport → the parent's portal showed nothing
//   * an instructor opening UPLOADED DOCUMENTS for a student saw only the
//     subset the student sent themselves, and chased documents that were
//     already in
//
// The household is the fix: resolve the people around the student in HubSpot,
// and treat an upload from any of them as belonging to that student.
//
// ---------------------------------------------------------------------------
// HOW THE HOUSEHOLD IS RESOLVED
// ---------------------------------------------------------------------------
// Two sources, unioned, because in the live portal each one misses cases the
// other catches:
//
//   1. Contacts associated with the student's DEALS. This is where a paying
//      parent reliably ends up, including a second parent added later.
//   2. Contacts linked to the student contact-to-contact with the "Parent"
//      association label — the same link the student cards already read for
//      their parent list (get-students.js). Catches a parent who was never
//      associated to the deal.
//
// Everything here FAILS SOFT: any HubSpot error returns whatever was gathered
// so far (often nothing), and the caller falls back to the anchor email
// alone. Showing one person's documents is a degraded view; a 500 on the
// modal is a broken one.
//
// Required env var: HUBSPOT_API_KEY

// Association labels that mean "this contact is a third party to the student",
// not a member of their household. HubSpot's contact-to-contact labels are
// free-form per portal, so this is a denylist of the ones that must never
// widen the audience — a referee or an emergency contact for one student can
// easily be a parent in another family.
const NON_HOUSEHOLD_LABELS =
  /referee|reference|emergency|doctor|gp\b|school|teacher|instructor|agent|advisor|adviser/i;

// A contact can carry several deals (a program plus a College Credit add-on,
// or a returning alumnus). We read the contacts on all of them — they are the
// same family — but cap the fan-out so one odd record can't fire off dozens
// of association calls per page view.
const MAX_DEALS = 10;

// Short-lived cache. The offline-save routine warms get-uploaded-documents
// once per student on the roster, and such a run would otherwise repeat the
// same household lookups within seconds of each other.
// Netlify may or may not reuse the instance; when it does, this saves the
// calls, and when it doesn't the cache is simply empty.
const CACHE_MS = 60 * 1000;
const _cache = new Map();

export function hubspotHeaders() {
  return {
    Authorization: `Bearer ${process.env.HUBSPOT_API_KEY}`,
    "Content-Type": "application/json"
  };
}

// Builds the email → uploader map the submission filter runs against.
//
// `anchorEmail` is the person whose record is being viewed (the student, when
// an instructor opens the modal). `viewerEmail` is the logged-in caller, so a
// student or parent looking at their own portal can be shown "You" instead of
// their own name. For an instructor the two differ and nothing is "You".
//
// The anchor is ALWAYS in the audience, even when HubSpot returned nothing —
// their own documents must never disappear behind an API failure.
export function buildAudience(anchorEmail, contacts = [], viewerEmail = null) {
  const anchor = clean(anchorEmail);
  const viewer = clean(viewerEmail);
  const audience = new Map();

  for (const c of contacts || []) {
    const email = clean(c?.email);
    if (!email) continue;
    const name = String(c?.name || "").trim();
    audience.set(email, {
      email,
      name: name || null,
      role: c?.role || null,
      isAnchor: email === anchor,
      isSelf: Boolean(viewer) && email === viewer
    });
  }

  if (anchor && !audience.has(anchor)) {
    audience.set(anchor, {
      email: anchor,
      name: null,
      role: null,
      isAnchor: true,
      isSelf: Boolean(viewer) && anchor === viewer
    });
  }
  return audience;
}

// Email fields on a student-side form that belong to somebody outside the
// household.
//
// A parent or guardian email field is deliberately NOT excluded: on these
// forms the parent is very often the person filling it in, and skipping those
// labels would hide the exact uploads this module exists to surface.
//
// What IS excluded is the emergency-contact family of fields. Without that, a
// submission naming another family's parent as an emergency contact would
// file that student's passport under the wrong household.
const OUTSIDE_HOUSEHOLD_EMAIL_RE =
  /next of kin|next-of-kin|emergency|referee|reference|doctor|gp\b|school|teacher|instructor|agent|advisor|adviser|insurer|insurance/i;

// Every email on a submission that could identify its submitter, in display
// order, with emergency-contact-style fields skipped.
//
// Returns them all rather than picking one because forms differ in which
// address they ask for first — some lead with the student's, some with the
// parent's — and the caller only keeps a submission when one of these is a
// household member, so a wrong guess here would drop a real document.
export function submitterEmails(submission) {
  const answers = submission?.answers || {};
  const rows = [];

  for (const [qid, a] of Object.entries(answers)) {
    if (!a || typeof a !== "object") continue;
    if (String(a.type || "").toLowerCase() !== "control_email") continue;
    if (OUTSIDE_HOUSEHOLD_EMAIL_RE.test(String(a.text || a.name || ""))) continue;
    const email = clean(firstValue(a.answer));
    if (!email) continue;
    const order = parseInt(a.order, 10);
    rows.push({
      email,
      order: Number.isFinite(order) ? order : Number.MAX_SAFE_INTEGER,
      qid: parseInt(qid, 10) || 0
    });
  }

  rows.sort((x, y) => (x.order - y.order) || (x.qid - y.qid));

  const seen = new Set();
  return rows.map(r => r.email).filter(e => !seen.has(e) && seen.add(e));
}

// Jotform answers arrive as strings, arrays, or objects (name / address
// sub-fields), and any part can be null.
function firstValue(answer) {
  if (answer == null) return "";
  if (Array.isArray(answer)) {
    for (const v of answer) { const s = firstValue(v); if (s) return s; }
    return "";
  }
  if (typeof answer === "object") {
    for (const v of Object.values(answer)) { const s = firstValue(v); if (s) return s; }
    return "";
  }
  return String(answer).trim();
}

// Resolves the household around one email. Returns
// { contactId, contacts: [{ id, email, name, role }], dealIds, degraded }.
//
// `degraded` is true when a HubSpot step failed, so the caller can tell the
// difference between "this student genuinely has no linked parents" and "we
// couldn't ask" — the portal words those differently.
export async function fetchHousehold(anchorEmail, headers = hubspotHeaders()) {
  const anchor = clean(anchorEmail);
  const empty = { contactId: null, contacts: [], dealIds: [], degraded: false };
  if (!anchor) return empty;

  const cached = _cache.get(anchor);
  if (cached && Date.now() - cached.ts < CACHE_MS) return cached.value;

  if (!process.env.HUBSPOT_API_KEY) return { ...empty, degraded: true };

  try {
    const contact = await findContactByEmail(anchor, headers);
    if (!contact) {
      // No HubSpot contact for this email at all. Not an error — the caller
      // falls back to the anchor alone.
      const value = { ...empty, contacts: [] };
      _cache.set(anchor, { value, ts: Date.now() });
      return value;
    }

    let degraded = false;

    // Deals and direct parent links are independent — fetch both at once.
    const [dealIds, linked] = await Promise.all([
      listDealIds(contact.id, headers).catch(err => {
        console.warn(`[household] deal lookup failed for ${anchor}:`, err?.message || err);
        degraded = true;
        return [];
      }),
      listLinkedContacts(contact.id, headers).catch(err => {
        console.warn(`[household] contact-link lookup failed for ${anchor}:`, err?.message || err);
        degraded = true;
        return [];
      })
    ]);

    // role wins on first sight, so a specific label ("Parent") set on one
    // association isn't overwritten by an unlabelled one elsewhere.
    const roleById = new Map();
    const note = (id, role) => {
      const key = String(id);
      if (!roleById.has(key) || (!roleById.get(key) && role)) roleById.set(key, role || null);
    };

    for (const l of linked) note(l.id, l.role);

    const dealContactLists = await Promise.all(
      dealIds.slice(0, MAX_DEALS).map(id =>
        listDealContacts(id, headers).catch(err => {
          console.warn(`[household] contacts for deal ${id} failed:`, err?.message || err);
          degraded = true;
          return [];
        })
      )
    );
    for (const list of dealContactLists) {
      for (const c of list) note(c.id, c.role);
    }

    // Drop third parties (a referee, an emergency contact, the school) — one
    // family's emergency contact is another family's parent, so a label like
    // that must never widen the audience.
    for (const [id, role] of [...roleById]) {
      if (NON_HOUSEHOLD_LABELS.test(role || "")) roleById.delete(id);
    }

    // The student themself appears in both association lists (or in neither,
    // for a contact with no deal). Their own uploads are wanted, so they are
    // always in the audience, and their role is fixed rather than inherited
    // from whatever label a stray association carried.
    roleById.set(String(contact.id), "Student");

    const ids = [...roleById.keys()];

    let contacts = [];
    if (ids.length) {
      try {
        contacts = await readContacts(ids, headers);
      } catch (err) {
        console.warn(`[household] contact batch-read failed for ${anchor}:`, err?.message || err);
        degraded = true;
        contacts = [];
      }
    }

    const value = {
      contactId: contact.id,
      contacts: contacts.map(c => ({ ...c, role: roleById.get(String(c.id)) || null })),
      dealIds,
      degraded
    };
    // Don't cache a half-answer — the next call should get a real one.
    if (!degraded) _cache.set(anchor, { value, ts: Date.now() });
    return value;

  } catch (err) {
    console.warn(`[household] lookup threw for ${anchor}:`, err?.message || err);
    return { ...empty, degraded: true };
  }
}

// ---------------------------------------------------------------------------
// HubSpot I/O — each throws on a non-OK response so the caller can mark the
// result degraded rather than silently reporting an empty household.
// ---------------------------------------------------------------------------

async function findContactByEmail(email, headers) {
  const res = await fetch("https://api.hubapi.com/crm/v3/objects/contacts/search", {
    method: "POST",
    headers,
    body: JSON.stringify({
      filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }],
      properties: ["email", "firstname", "lastname"]
    })
  });
  if (!res.ok) throw new Error(`contact search HTTP ${res.status}`);
  const data = await res.json();
  const c = data.results?.[0];
  return c ? { id: String(c.id), properties: c.properties || {} } : null;
}

async function listDealIds(contactId, headers) {
  const res = await fetch(
    `https://api.hubapi.com/crm/v4/objects/contacts/${contactId}/associations/deals?limit=100`,
    { headers }
  );
  if (!res.ok) throw new Error(`deal associations HTTP ${res.status}`);
  const data = await res.json();
  return (data.results || []).map(r => r.toObjectId).filter(v => v != null).map(String);
}

async function listDealContacts(dealId, headers) {
  const res = await fetch(
    `https://api.hubapi.com/crm/v4/objects/deals/${encodeURIComponent(dealId)}/associations/contacts?limit=100`,
    { headers }
  );
  if (!res.ok) throw new Error(`deal contacts HTTP ${res.status}`);
  const data = await res.json();
  return (data.results || [])
    .filter(r => r?.toObjectId != null)
    .map(r => ({ id: String(r.toObjectId), role: firstLabel(r) }));
}

// Contact-to-contact links. Only labelled household relationships widen the
// audience here: an unlabelled contact-to-contact link is too weak a signal
// on its own (HubSpot creates them for all sorts of reasons), whereas a deal
// association is a hard commercial link.
async function listLinkedContacts(contactId, headers) {
  const res = await fetch(
    `https://api.hubapi.com/crm/v4/objects/contacts/${contactId}/associations/contacts?limit=100`,
    { headers }
  );
  if (!res.ok) throw new Error(`contact associations HTTP ${res.status}`);
  const data = await res.json();
  return (data.results || [])
    .filter(r => r?.toObjectId != null)
    .map(r => ({ id: String(r.toObjectId), role: firstLabel(r) }))
    .filter(r => r.role);
}

async function readContacts(ids, headers) {
  const res = await fetch("https://api.hubapi.com/crm/v3/objects/contacts/batch/read", {
    method: "POST",
    headers,
    body: JSON.stringify({
      inputs: [...new Set(ids.map(String))].map(id => ({ id })),
      properties: ["email", "firstname", "lastname"]
    })
  });
  if (!res.ok) throw new Error(`contact batch-read HTTP ${res.status}`);
  const data = await res.json();
  return (data.results || []).map(c => {
    const p = c.properties || {};
    return {
      id: String(c.id),
      email: clean(p.email),
      name: `${p.firstname || ""} ${p.lastname || ""}`.trim(),
      role: null
    };
  }).filter(c => c.email);
}

function firstLabel(assoc) {
  return (assoc?.associationTypes || [])
    .map(t => String(t?.label || "").trim())
    .find(Boolean) || null;
}

function clean(s) {
  return String(s == null ? "" : s).toLowerCase().trim();
}
