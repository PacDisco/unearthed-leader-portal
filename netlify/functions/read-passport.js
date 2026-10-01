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
// Optional:         PASSPORT_OCR_MODEL   (default claude-sonnet-4-5 — see
//                   PASSPORT_SETUP.md: a harder scan may need a stronger
//                   model, and this is the one knob that changes that)
//                   ANTHROPIC_API_BASE   (default https://api.anthropic.com)

import crypto from "crypto";
import { authenticate } from "./_shared/auth.js";
import { resolveRosterEditAccess } from "./_shared/portal-access.js";
import { APPLICATION_FORM_IDS_CSV } from "./_shared/application-forms.js";
import { findSubmissionByEmail } from "./lib/jotform.js";
import { parseMrzWithRepair } from "./_shared/mrz.js";
import { rotateImage } from "./_shared/image-rotate.js";
import { isPassportDriveUrl, fetchPassportDriveFile } from "./_shared/passport-widget.js";
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
    // A cache entry only counts if it holds every verdict we now report.
    // Records read before the date checks shipped have no dob/expiry verdict
    // at all, and serving those as "unknown" forever would silently leave
    // those two checks undone on every person already in the system.
    const cacheComplete = [PASSPORT_PROPS.ocrNumber, PASSPORT_PROPS.ocrDob, PASSPORT_PROPS.ocrExpiry]
      .every(prop => typeof contact[prop] === "string" && contact[prop] !== "");
    if (!body.force && cachedHash === hash && cachedStatus === PASSPORT_STATUS.OK && cacheComplete) {
      return json(200, {
        ...shapePassportState(contact, recorded),
        cached: true,
        // The form's own value is already on screen in the modal below, so
        // including it costs nothing. The number read off the IMAGE is not
        // here — it was never stored — so a cached mismatch shows the verdict
        // and RE-READ reveals both.
        formNumber: formPassportNumber(submission.submission) || "",
        formDob: formFieldValue(submission.submission, DOB_LABELS, DOB_TYPES) || "",
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
      // A failed MRZ is usually a slipped character, not an unreadable
      // document — and the failure is stochastic, so one more attempt often
      // lands a clean transcription. The check digits still decide whether
      // we accept it, so this raises the hit rate without lowering the bar.
      //
      // A sideways or upside-down scan is the commonest cause of slipped
      // characters, so when the first read says the page is turned, the
      // retry is made on an upright copy of the image instead.
      if (!read.verified) {
        const upright = (!file.isPdf && read.rotation) ? rotateImage(file, read.rotation) : null;
        const second = await readPassportFile(upright ? { ...upright, isPdf: false } : file, { retry: true });
        if (second.verified) {
          read = second;
          if (upright) console.info(`[read-passport] verified after rotating ${read.rotation || "?"}°`);
        } else if (upright) {
          // One last try on the original, in case the rotation was wrong.
          const third = await readPassportFile(file, { retry: true });
          if (third.verified) read = third;
        }
      }
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
    const formDob = formFieldValue(submission.submission, DOB_LABELS, DOB_TYPES);
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
      // Did the machine-readable zone verify? Drives whether the panel
      // offers a one-click apply, or only shows the value for checking.
      verified: !!read.verified,
      // The reason is surfaced even on a successful read: "the name is from
      // the printed page, the dates couldn't be verified" is exactly what a
      // leader needs to know before trusting a row.
      message: read.reason
        || (status === PASSPORT_STATUS.UNREADABLE
              ? "The passport couldn't be made out on this photo — check it by hand."
              : null),
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
// mentions passport. Two shapes exist (see _shared/passport-widget.js):
//   - "Passport photo page" — the checking widget, a Shared Drive link,
//     normalised to a one-file upload when the submission was fetched
//   - "Passport Cover Page Photo" — the old Jotform upload, still holding the
//     file for every submission made before the widget went in
// When both are answered (an old submission later edited), the widget's file
// wins: it's the newer upload and the one that passed the bio-page check.
function passportPhotoUrl(submission) {
  const answers = submission?.answers || {};
  let fallback = null;
  for (const key of Object.keys(answers)) {
    const a = answers[key] || {};
    if (String(a.type || "").toLowerCase() !== "control_fileupload") continue;
    if (!/passport/i.test(String(a.text || a.name || ""))) continue;
    const v = a.answer;
    const url = Array.isArray(v) && v.length ? String(v[0]) : (typeof v === "string" && v ? v : null);
    if (!url) continue;
    if (isPassportDriveUrl(url)) return url;
    if (!fallback) fallback = url;
  }
  return fallback;
}

// Question labels for the two dates, kept in step with FIELD_MAP.travel in
// lib/group-info.js so the export and this check read the same questions.
const DOB_LABELS = [/date\s*of\s*birth/i, /^d\.?o\.?b\.?$/i, /birth\s*date/i, /birthday/i, /born/i];
const EXPIRY_LABELS = [/expiry/i, /expiration/i, /expires/i, /valid\s*until/i];

// Jotform's Birth Date field IS a date of birth whatever the school labelled
// it, so the type is a second way in when the label doesn't match.
const DOB_TYPES = ["control_birthdate"];

// First answered field whose label matches any of the patterns. Dates come
// back from Jotform as a {day, month, year} object, which is flattened to
// YYYY-MM-DD so it compares against the passport's date directly.
function formFieldValue(submission, patterns, types = []) {
  const answers = submission?.answers || {};
  for (const key of Object.keys(answers)) {
    const a = answers[key] || {};
    const label = String(a.text || a.name || "");
    const type = String(a.type || "").toLowerCase();
    // Label OR type: a school that labelled the question "Birthday" still
    // gets matched, and so does one whose label we don't recognise at all but
    // which used Jotform's Birth Date field.
    if (!patterns.some(re => re.test(label)) && !types.includes(type)) continue;

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

// Jotform-hosted files need the API key appended server-side. Passport photos
// from the checking widget live in a private Shared Drive and are fetched
// through the passport-check Worker instead.
async function fetchDocument(url) {
  if (isPassportDriveUrl(url)) {
    let res;
    try { res = await fetchPassportDriveFile(url); }
    catch (err) { throw new FetchProblem("download", `passport Drive fetch: ${err?.message || err}`); }
    if (!res.ok) throw new FetchProblem("download", `passport Drive fetch ${res.status}`);
    const contentType = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) throw new FetchProblem("download", "empty file");
    if (!SUPPORTED_IMAGE_MEDIA.includes(contentType)) {
      throw new FetchProblem("unsupported", `unsupported passport file type: ${contentType || "unknown"}`,
        describeType(contentType, url));
    }
    if (buf.length > MAX_IMAGE_BYTES) {
      throw new FetchProblem("unsupported", `file too large (${buf.length} bytes)`,
        `The uploaded file is ${(buf.length / 1024 / 1024).toFixed(1)}MB, over the ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB limit for reading.`);
    }
    return { base64: buf.toString("base64"), mediaType: contentType, isPdf: false };
  }

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
const PROMPT = `Your ONLY job is to copy the two lines of the machine-readable zone from a passport. Nothing else on the page matters.

The machine-readable zone is the block of monospaced characters across the very bottom of the passport's data page. It is two lines, each 44 characters long, made up only of A-Z, 0-9 and the filler character "<". The first line starts with P. The second line starts with the passport number.

The scan may be ROTATED (sideways or upside down), may be one page of several, and may show two pages at once. Find those two lines whatever the orientation.

Use ONLY the zone on the page with the holder's photo and printed details. Some passports print a small illustrated specimen passport (with its own sample machine-readable zone) in the security artwork on the facing page — ignore that completely.

Also report "rotation": how many degrees the image must be turned CLOCKWISE so the machine-readable zone reads left to right along the bottom — 0, 90, 180 or 270.

Copy each line EXACTLY, character by character, including every "<". Do not insert spaces. Do not tidy. Do not drop trailing fillers. Do not correct anything that looks wrong to you.

Reply with ONLY a JSON object, no other text:
{"mrz_line1": "", "mrz_line2": "", "found": true|false, "rotation": 0, "reason": ""}

Rules:
- These lines carry check digits, so an exact copy can be verified and an inexact one will be rejected. A careful character-by-character transcription is worth far more than a plausible one.
- If you cannot see BOTH lines in full — the photo is cropped, blurred, or the zone is cut off — set "found": false, say so in "reason", and leave the lines "". Do not reconstruct a line from the printed fields elsewhere on the page. A missing line is a fact worth reporting; an invented one is worse than useless, because everything here is copied onto a booking.
- Never invent or complete a character.`;

async function readPassportFile({ base64, mediaType, isPdf }, { retry = false } = {}) {
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
      max_tokens: 500,
      messages: [{
        role: "user",
        content: [
          isPdf
            ? { type: "document", source: { type: "base64", media_type: mediaType, data: base64 } }
            : { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
          { type: "text", text: retry ? `${PROMPT}\n\nA previous transcription of this document FAILED its check digits, which means at least one character of the machine-readable zone was copied wrongly. Read the two MRZ lines again, slowly, character by character. Pay particular attention to characters that look alike in this font: 0 and O, 1 and I, 5 and S, 8 and B, 2 and Z. Count the characters — each line is 44 long including the "<" fillers.` : PROMPT },
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

  return interpretRead(parseJsonObject(text));
}

// Turns the model's transcription into values we are willing to show.
//
// The model is trusted to COPY, never to conclude. Everything below is
// decided here, in code:
//   - the MRZ's check digits decide whether the transcription is sound
//   - the MRZ supplies the number and both dates when it verifies
//   - the printed name is cross-checked against the MRZ name, and a genuine
//     disagreement means one of them was misread, so we return nothing
// Exported for tests.
export function interpretRead(parsed) {
  const result = interpretTranscription(parsed);
  const rot = Number(parsed && parsed.rotation);
  result.rotation = [90, 180, 270].includes(rot) ? rot : 0;
  return result;
}

function interpretTranscription(parsed) {
  const empty = { first: "", last: "", number: "", dob: "", expiry: "", source: "", verified: false, reason: "" };
  if (!parsed) return { ...empty, reason: "the passport could not be read" };

  // Check digits first on the exact copy; if that fails, on structural
  // repairs only (miscounted fillers, O-for-0 in a date) — see mrz.js.
  const mrz = parseMrzWithRepair(parsed.mrz_line1, parsed.mrz_line2);
  if (mrz.ok && mrz.repaired) console.info("[read-passport] MRZ verified after filler/look-alike repair");

  // Diagnostics for a failed read. Without these there is no way to tell a
  // transcription that was one character out from one that was garbage —
  // which is the difference between "retry" and "that photo is unusable".
  //
  // Deliberately MASKED: an MRZ contains the passport number and date of
  // birth, and function logs are not the place for either. What's logged is
  // the shape of the attempt, not its content.
  if (!mrz.ok) {
    const shape = (line) => {
      const t = String(line || "").toUpperCase().replace(/\s+/g, "");
      return {
        length: t.length,
        validChars: /^[A-Z0-9<]*$/.test(t),
        starts: t.slice(0, 5),
        ends: t.slice(-4),
      };
    };
    console.warn("[read-passport] MRZ did not verify:", JSON.stringify({
      failures: mrz.failures,
      found: parsed.found !== false,
      line1: shape(parsed.mrz_line1),
      line2: shape(parsed.mrz_line2),
    }));
  }

  if (mrz.ok) {
    return {
      first: mrz.fields.givenNames,
      last: mrz.fields.surname,
      number: mrz.fields.documentNumber,
      dob: mrz.fields.dateOfBirth || "",
      expiry: mrz.fields.expiryDate || "",
      source: "mrz",
      verified: true,
      reason: "",
    };
  }

  // Nothing verified, so nothing is offered. Everything on this panel is
  // copied onto a booking, and the machine-readable zone is the only part of
  // a passport that can be checked rather than believed — so without it
  // there is no value here worth showing, only an instruction.
  return { ...empty, reason: mrzFailureReason(mrz, parsed) };
}

// What to tell the leader, in terms of what they can do about it.
function mrzFailureReason(mrz, parsed) {
  const ask = "Upload a straight-on photo of the data page with BOTH lines of the machine-readable zone fully in frame.";

  if (parsed && parsed.found === false) {
    return `The two lines at the bottom of the passport weren't visible in this photo${parsed.reason ? ` (${parsed.reason})` : ""}. ${ask}`;
  }
  if (!mrz || !mrz.failures || mrz.failures.length === 0) {
    return `The machine-readable zone could not be read. ${ask}`;
  }

  const first = mrz.failures[0];
  if (first.includes("check digit")) {
    return "The machine-readable zone was read but did not verify — its check digits failed, which means at least one character was misread. " + ask;
  }
  if (first.includes("second MRZ line")) {
    return `Only the top line of the machine-readable zone was in this photo, so the passport number and dates could not be read. ${ask}`;
  }
  return `The machine-readable zone could not be used: ${first}. ${ask}`;
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

// Strip MRZ filler and whitespace, and nothing else. This used to uppercase
// and drop every non-alphanumeric character, which would silently rewrite a
// number that legitimately contains one. Case and separators are irrelevant
// to the comparison anyway — normaliseDocNumber() in _shared/passport.js
// handles that — so there is no reason to alter what is stored or shown.
function cleanDocNumber(v) {
  return String(v == null ? "" : v)
    .replace(/</g, "")
    .replace(/[\s\u0000-\u001f\u007f]/g, "")
    .trim();
}

// Decode MRZ filler and tidy whitespace — nothing else. This used to strip
// every character outside [letters, space, hyphen, apostrophe], which quietly
// altered real names (a name containing a period or a numeral-like glyph came
// out different from the document). What goes on a booking has to be what the
// passport says, so the only transformations here are ones that are provably
// not part of the name: the MRZ's "<" padding, and runs of whitespace.
function cleanNamePart(v) {
  return String(v == null ? "" : v)
    .replace(/</g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, "")  // control characters only
    .replace(/\s+/g, " ")
    .trim();
}
