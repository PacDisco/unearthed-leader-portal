// POST /.netlify/functions/read-passport   { "email": "<person>", "force": false }
//
// Reads the name off a person's uploaded passport photo and caches the result
// on their HubSpot contact, so the Expedition Leader tab can show whether the
// name on record matches the passport a booking has to be made against.
//
// The read NEVER writes the name onto the record. It only records what the
// passport says; applying it is a separate, deliberate action by a leader
// (update-person). A misread must not be able to reach a manifest on its own.
//
// CACHING: the result is stored with a hash of the photo it was read from. A
// second call for the same photo returns the cached answer without touching
// the vision API, so each passport costs one read however many times the card
// is opened. Uploading a new photo changes the hash and triggers a re-read.
// `force: true` bypasses the cache (the RE-READ button).
//
// SECURITY: same gate as roster editing — an admin, or an expedition leader on
// a trip this person belongs to.
//
// Required env var: ANTHROPIC_API_KEY
// Optional:         PASSPORT_OCR_MODEL   (default claude-sonnet-4-5)
//                   ANTHROPIC_API_BASE   (default https://api.anthropic.com)

import crypto from "crypto";
import { authenticate } from "./_shared/auth.js";
import { resolveRosterEditAccess } from "./_shared/portal-access.js";
import { APPLICATION_FORM_IDS_CSV } from "./_shared/application-forms.js";
import { findSubmissionByEmail } from "./lib/jotform.js";
import {
  PASSPORT_STATUS, PASSPORT_PROPS, ALL_PASSPORT_PROPS, NUMBER_VERDICT, DATE_VERDICT,
  buildOcrPatch, shapePassportState, compareDocumentNumbers, compareDates,
} from "./_shared/passport.js";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;  // Anthropic's per-image limit
const MAX_PDF_BYTES = 10 * 1024 * 1024;   // well inside the request-size limit once base64'd
const SUPPORTED_IMAGE_MEDIA = ["image/jpeg", "image/png", "image/gif", "image/webp"];
const PDF_MEDIA = "application/pdf";

function json(statusCode, payload) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) };
}

function hsHeaders() {
  return {
    Authorization: `Bearer ${process.env.HUBSPOT_API_KEY}`,
    "Content-Type": "application/json",
  };
}

export async function handler(event) {
  try {
    if (event.httpMethod && event.httpMethod !== "POST") {
      return json(405, { error: "Method not allowed" });
    }

    const auth = await authenticate(event);
    if (auth.response) return auth.response;

    let body;
    try { body = JSON.parse(event.body || "{}"); }
    catch { return json(400, { error: "Invalid request body" }); }

    const email = String(body.email || "").toLowerCase().trim();
    if (!email) return json(400, { error: "Missing email" });

    const access = await resolveRosterEditAccess(auth.session, email);
    if (access.response) return access.response;

    const contact = await readContact(access.contactId);
    const recorded = {
      recordedFirst: contact.firstname || "",
      recordedLast: contact.lastname || "",
    };

    // 1. Locate the passport photo on their application submission.
    if (!process.env.JOTFORM_API_KEY) return json(500, { error: "Jotform is not configured." });
    const submission = await findSubmissionByEmail(email, APPLICATION_FORM_IDS_CSV);
    const photoUrl = submission.found ? passportPhotoUrl(submission.submission) : null;

    if (!photoUrl) {
      await savePassportState(access.contactId, buildOcrPatch({
        status: PASSPORT_STATUS.NO_PHOTO, first: "", last: "", hash: "",
        numberVerdict: NUMBER_VERDICT.UNKNOWN,
        dobVerdict: DATE_VERDICT.UNKNOWN,
        expiryVerdict: DATE_VERDICT.UNKNOWN,
      }));
      return json(200, {
        ...shapePassportState({
          ...contact,
          [PASSPORT_PROPS.ocrStatus]: PASSPORT_STATUS.NO_PHOTO,
        }, recorded),
        message: "No passport photo has been uploaded for this person.",
      });
    }

    // 2. Cache check — same photo, already read, and not forced.
    const hash = crypto.createHash("sha256").update(photoUrl).digest("hex").slice(0, 32);
    const cachedHash = contact[PASSPORT_PROPS.ocrHash] || "";
    const cachedStatus = contact[PASSPORT_PROPS.ocrStatus] || "";
    if (!body.force && cachedHash === hash && cachedStatus === PASSPORT_STATUS.OK) {
      return json(200, {
        ...shapePassportState(contact, recorded),
        cached: true,
        // The form's own value is already on screen in the modal below, so
        // including it costs nothing. The number read off the IMAGE is not
        // here — it was never stored — so a cached mismatch shows the verdict
        // and RE-READ reveals both.
        formNumber: formPassportNumber(submission.submission) || "",
        formDob: formFieldValue(submission.submission, DOB_LABELS) || "",
        formExpiry: formFieldValue(submission.submission, EXPIRY_LABELS) || "",
      });
    }

    // 3. Fetch the image and read it.
    let file;
    try {
      file = await fetchDocument(photoUrl);
    } catch (err) {
      const unsupported = err instanceof FetchProblem && err.kind === "unsupported";
      console.warn("[read-passport] file fetch failed:", err?.message || err);

      // An unsupported file is a settled fact about that upload, so it's
      // cached like any other verdict — re-reading it would just fail again.
      // A download failure is transient and deliberately isn't cached.
      const status = unsupported ? PASSPORT_STATUS.UNSUPPORTED : PASSPORT_STATUS.ERROR;
      if (unsupported) {
        await savePassportState(access.contactId, buildOcrPatch({
          status, first: "", last: "", hash,
          numberVerdict: NUMBER_VERDICT.UNKNOWN,
          dobVerdict: DATE_VERDICT.UNKNOWN,
          expiryVerdict: DATE_VERDICT.UNKNOWN,
        }));
      }
      return json(200, {
        ...shapePassportState({ ...contact, [PASSPORT_PROPS.ocrStatus]: status }, recorded),
        message: unsupported
          ? (err.detail || "That file type can't be read.")
          : "The passport file couldn't be downloaded. Try again in a moment.",
      });
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      return json(500, { error: "Passport reading is not configured (ANTHROPIC_API_KEY is not set)." });
    }

    let read;
    try {
      read = await readPassportFile(file);
    } catch (err) {
      console.error("[read-passport] vision call failed:", err?.message || err);
      return json(200, {
        ...shapePassportState({ ...contact, [PASSPORT_PROPS.ocrStatus]: PASSPORT_STATUS.ERROR }, recorded),
        message: "The passport couldn't be read just now. Try again, or check it by hand.",
      });
    }

    const status = (read.first || read.last) ? PASSPORT_STATUS.OK : PASSPORT_STATUS.UNREADABLE;

    // Compare the number typed on the application form against the one on the
    // image. A transposed passport number fails a booking just as surely as a
    // wrong name.
    const formNumber = formPassportNumber(submission.submission);
    const numberComparison = compareDocumentNumbers(formNumber, read.number);

    // Same treatment for the two dates. A wrong date of birth or a passport
    // that expires before the trip both stop someone travelling.
    const formDob = formFieldValue(submission.submission, DOB_LABELS);
    const formExpiry = formFieldValue(submission.submission, EXPIRY_LABELS);
    const dobComparison = compareDates(formDob, read.dob);
    const expiryComparison = compareDates(formExpiry, read.expiry);

    const patch = buildOcrPatch({
      status, first: read.first, last: read.last, hash,
      numberVerdict: numberComparison.verdict,
      dobVerdict: dobComparison.verdict,
      expiryVerdict: expiryComparison.verdict,
    });
    const saved = await savePassportState(access.contactId, patch);

    const state = shapePassportState({ ...contact, ...patch }, recorded);
    return json(200, {
      ...state,
      cached: false,
      // Returned to the leader who triggered this read, and not stored: the
      // CRM never holds a passport number. A cached mismatch therefore shows
      // the verdict without the number, and RE-READ reveals it again.
      formNumber: formNumber || "",
      passportNumber: read.number || "",
      formDob: formDob || "",
      passportDob: read.dob || "",
      formExpiry: formExpiry || "",
      passportExpiry: read.expiry || "",
      message: status === PASSPORT_STATUS.UNREADABLE
        ? (read.reason || "The name couldn't be made out on this photo — check it by hand.")
        : null,
      warning: saved.warning || null,
    });

  } catch (err) {
    console.error("[read-passport] error:", err?.stack || err?.message || err);
    return json(500, { error: "Could not read this passport." });
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function readContact(contactId) {
  try {
    const props = ["firstname", "lastname", ...ALL_PASSPORT_PROPS];
    const res = await fetch(
      `https://api.hubapi.com/crm/v3/objects/contacts/${encodeURIComponent(contactId)}` +
      `?properties=${encodeURIComponent(props.join(","))}`,
      { headers: hsHeaders() }
    );
    if (!res.ok) return {};
    const data = await res.json();
    return data?.properties || {};
  } catch (_) {
    return {};
  }
}

// Best-effort: if the passport_* properties haven't been created in HubSpot
// yet the PATCH fails, and that must not turn into an error for the leader.
// The read still comes back; it just isn't cached.
async function savePassportState(contactId, properties) {
  try {
    const res = await fetch(
      `https://api.hubapi.com/crm/v3/objects/contacts/${encodeURIComponent(contactId)}`,
      { method: "PATCH", headers: hsHeaders(), body: JSON.stringify({ properties }) }
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn(`[read-passport] could not cache result (${res.status}): ${text.slice(0, 200)}`);
      return { saved: false, warning: "The result couldn't be saved — see PASSPORT_SETUP.md for the contact properties this needs." };
    }
    return { saved: true };
  } catch (err) {
    console.warn("[read-passport] cache write threw:", err?.message || err);
    return { saved: false, warning: "The result couldn't be saved." };
  }
}

// The passport image on the application submission: a file upload whose label
// mentions passport. "Passport Cover Page Photo" on the current form.
function passportPhotoUrl(submission) {
  const answers = submission?.answers || {};
  for (const key of Object.keys(answers)) {
    const a = answers[key] || {};
    if (String(a.type || "").toLowerCase() !== "control_fileupload") continue;
    if (!/passport/i.test(String(a.text || a.name || ""))) continue;
    const v = a.answer;
    if (Array.isArray(v) && v.length) return String(v[0]);
    if (typeof v === "string" && v) return v;
  }
  return null;
}

// Question labels for the two dates, kept in step with FIELD_MAP.travel in
// lib/group-info.js so the export and this check read the same questions.
const DOB_LABELS = [/date\s*of\s*birth/i, /^dob$/i, /birth\s*date/i];
const EXPIRY_LABELS = [/expiry/i, /expiration/i];

// First answered field whose label matches any of the patterns. Dates come
// back from Jotform as a {day, month, year} object, which is flattened to
// YYYY-MM-DD so it compares against the passport's date directly.
function formFieldValue(submission, patterns) {
  const answers = submission?.answers || {};
  for (const key of Object.keys(answers)) {
    const a = answers[key] || {};
    const label = String(a.text || a.name || "");
    if (!patterns.some(re => re.test(label))) continue;

    const v = a.answer;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const { day, month, year } = v;
      if (day && month && year) {
        return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      }
      continue;
    }
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number") return String(v);
  }
  return "";
}

// The passport number as typed on the application form — the value the
// comparison is against. Matched by label, like every other form lookup here.
function formPassportNumber(submission) {
  const answers = submission?.answers || {};
  for (const key of Object.keys(answers)) {
    const a = answers[key] || {};
    const label = String(a.text || a.name || "");
    if (!/passport/i.test(label) || !/number|no\b|#/i.test(label)) continue;
    const v = a.answer;
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number") return String(v);
  }
  return "";
}

// Jotform-hosted files need the API key appended server-side.
async function fetchDocument(url) {
  let target = url;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const isJotform = host === "jotform.com" || host.endsWith(".jotform.com")
      || host === "jotfor.ms" || host.endsWith(".jotfor.ms");
    if (isJotform) {
      parsed.searchParams.set("apiKey", process.env.JOTFORM_API_KEY);
      target = parsed.toString();
    }
  } catch (_) { /* use as-is */ }

  const res = await fetch(target);
  if (!res.ok) throw new FetchProblem("download", `passport file fetch ${res.status}`);

  const contentType = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new FetchProblem("download", "empty file");

  // Scanner apps (TapScanner, Adobe Scan, iOS Files) export PDFs by default,
  // so a large share of uploaded passports are PDFs rather than photos. They
  // go to the API as a document block instead of an image block; everything
  // downstream is identical.
  const mediaType = SUPPORTED_IMAGE_MEDIA.includes(contentType) ? contentType
    : contentType === PDF_MEDIA ? PDF_MEDIA
    : guessMedia(target);

  if (!mediaType) {
    throw new FetchProblem("unsupported", `unsupported passport file type: ${contentType || "unknown"}`,
      describeType(contentType, target));
  }

  const isPdf = mediaType === PDF_MEDIA;
  const cap = isPdf ? MAX_PDF_BYTES : MAX_IMAGE_BYTES;
  if (buf.length > cap) {
    throw new FetchProblem("unsupported",
      `file too large (${buf.length} bytes)`,
      `The uploaded file is ${(buf.length / 1024 / 1024).toFixed(1)}MB, over the ${Math.round(cap / 1024 / 1024)}MB limit for reading.`);
  }

  return { base64: buf.toString("base64"), mediaType, isPdf };
}

// Carries whether the problem was getting the file or the file itself, so the
// card can say which — "couldn't be downloaded" sent people looking in the
// wrong place when the real answer was "that's a PDF and we didn't send it".
class FetchProblem extends Error {
  constructor(kind, message, detail) {
    super(message);
    this.kind = kind;       // "download" | "unsupported"
    this.detail = detail;   // a sentence for the person reading the card
  }
}

// A human-readable "we can't read that" for the file types people actually
// upload by mistake.
function describeType(contentType, url) {
  const ext = (String(url).split("?")[0].split(".").pop() || "").toLowerCase();
  if (ext === "heic" || ext === "heif" || /hei[cf]/.test(contentType)) {
    return "This is an iPhone HEIC photo, which can't be read. Ask for it again as a JPEG or PDF.";
  }
  if (/word|officedocument|msword/.test(contentType) || ["doc", "docx"].includes(ext)) {
    return "This is a Word document. Ask for the passport as a photo or PDF.";
  }
  return `This file (${contentType || ext || "unknown type"}) isn't a photo or PDF, so it can't be read. Ask for a JPEG, PNG or PDF.`;
}

function guessMedia(url) {
  const clean = String(url).split("?")[0].toLowerCase();
  if (clean.endsWith(".jpg") || clean.endsWith(".jpeg")) return "image/jpeg";
  if (clean.endsWith(".png")) return "image/png";
  if (clean.endsWith(".webp")) return "image/webp";
  if (clean.endsWith(".gif")) return "image/gif";
  if (clean.endsWith(".pdf")) return PDF_MEDIA;
  return null;
}

// Asks the model for the name only, as strict JSON. The machine-readable zone
// is preferred when it's legible because that's what the airline's system
// reads; the printed page is the fallback.
const PROMPT = `You are reading the photo page of a passport (the file may be a scan of several pages — use the page showing the passport's printed data and machine-readable zone, and ignore the rest) to extract the holder's name, passport number, date of birth and expiry date.

Prefer the machine-readable zone (the two lines of monospaced text with << separators) when it is legible, since that is the authoritative form of the name. Otherwise read the printed "Surname" and "Given names" fields.

Reply with ONLY a JSON object, no other text:
{"readable": true|false, "surname": "", "given_names": "", "document_number": "", "date_of_birth": "", "expiry_date": "", "source": "mrz"|"printed", "reason": ""}

Rules:
- "surname" is the family name; "given_names" is every given name, space separated.
- In the MRZ, << separates surname from given names and < stands for a space. Convert them back.
- Keep the passport's own spelling and order. Do not correct, expand or guess any part of a name.
- If the image is not a passport, is too blurred, or the name cannot be made out with confidence, return {"readable": false, "surname": "", "given_names": "", "source": "", "reason": "<short reason>"}.
- "document_number" is the passport number: the field labelled Passport No. on the printed page, or characters 1-9 of the second MRZ line. Give it exactly as printed, without spaces. Leave it "" if you cannot read it confidently — a guessed number is worse than none.
- "date_of_birth" and "expiry_date" must be returned as YYYY-MM-DD. Take the century from the printed page, which shows a four-digit year — do NOT infer it from the MRZ's two-digit year. Leave a date "" if you cannot read it confidently.
- Never invent a name, a number or a date. An uncertain read must be reported as not readable.`;

async function readPassportFile({ base64, mediaType, isPdf }) {
  const base = (process.env.ANTHROPIC_API_BASE || "https://api.anthropic.com").replace(/\/+$/, "");
  const model = process.env.PASSPORT_OCR_MODEL || "claude-sonnet-4-5";

  const res = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 300,
      messages: [{
        role: "user",
        content: [
          isPdf
            ? { type: "document", source: { type: "base64", media_type: mediaType, data: base64 } }
            : { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
          { type: "text", text: PROMPT },
        ],
      }],
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Anthropic ${res.status}: ${text.slice(0, 300)}`);
  }

  const data = await res.json();
  const text = (data?.content || [])
    .filter(b => b?.type === "text")
    .map(b => b.text)
    .join("")
    .trim();

  const parsed = parseJsonObject(text);
  if (!parsed || parsed.readable !== true) {
    return { first: "", last: "", number: "", dob: "", expiry: "", reason: (parsed && parsed.reason) || "" };
  }

  return {
    first: cleanNamePart(parsed.given_names),
    last: cleanNamePart(parsed.surname),
    number: cleanDocNumber(parsed.document_number),
    dob: cleanDate(parsed.date_of_birth),
    expiry: cleanDate(parsed.expiry_date),
    source: parsed.source || "",
    reason: "",
  };
}

// The model is asked for bare JSON, but tolerate it being wrapped in prose or
// a code fence rather than throwing away a good read.
function parseJsonObject(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch (_) { /* try harder */ }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch (_) { return null; }
}

// Only an exact YYYY-MM-DD is accepted back. Anything else the model returned
// is discarded rather than guessed at — a wrong date is worse than no date.
function cleanDate(v) {
  const t = String(v == null ? "" : v).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : "";
}

// Passport numbers are alphanumeric; strip MRZ filler and any separators the
// model echoed back.
function cleanDocNumber(v) {
  return String(v == null ? "" : v).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// Names only: letters, spaces, hyphens and apostrophes. Anything else is OCR
// noise or MRZ filler that shouldn't be written to a record.
function cleanNamePart(v) {
  return String(v == null ? "" : v)
    .replace(/</g, " ")
    .replace(/[^\p{L}\s'-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
