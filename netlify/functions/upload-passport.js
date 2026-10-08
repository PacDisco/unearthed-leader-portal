// Upload a passport photo for a person on the roster, from the leader portal.
//
// For people who never uploaded one on their application (or uploaded a file
// that can't be read). The file is:
//   1. stored PRIVATELY in HubSpot Files (folder /portal-passports),
//   2. attached to the person's contact as a note, so it shows under the
//      contact's Attachments in HubSpot like any other file, and
//   3. recorded on the contact's `passport_upload` property (the file id),
//      which read-passport.js checks before the application form — so the
//      passport check runs against it straight away.
//
// Who can upload: the same people who can edit the roster — an admin, or an
// expedition leader ("Trip Leader") on a trip the person is on
// (resolveRosterEditAccess). Teachers can't.
//
// POST JSON { email, fileName, contentType, data }  — data is base64.
// Netlify caps a function request at ~6MB, so the file itself must be under
// MAX_UPLOAD_BYTES; the page shrinks large photos before sending.
//
// Setup (see PASSPORT_SETUP.md): a `passport_upload` contact property, and the
// HubSpot private app needs the `files` scope.

import { authenticate } from "./_shared/auth.js";
import { resolveRosterEditAccess } from "./_shared/portal-access.js";
import { PASSPORT_PROPS } from "./_shared/passport.js";

export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const ALLOWED_TYPES = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "application/pdf": "pdf",
};
const FOLDER = "/portal-passports";

function json(statusCode, payload) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) };
}

function hsAuth() {
  return { Authorization: `Bearer ${process.env.HUBSPOT_API_KEY}` };
}

// Sniff the real type from the first bytes rather than trusting the browser's
// label: a renamed HEIC would otherwise be stored and then fail the read.
export function sniffType(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.length >= 4 && buf.slice(0, 4).toString("latin1") === "%PDF") return "application/pdf";
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.slice(0, 6).toString("latin1"))) return "image/gif";
  if (buf.length >= 12 && buf.slice(0, 4).toString("latin1") === "RIFF" && buf.slice(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

function safeName(email, ext) {
  const who = String(email).split("@")[0].replace(/[^a-z0-9]+/gi, "-").slice(0, 40) || "person";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `passport-${who}-${stamp}.${ext}`;
}

export async function handler(event) {
  try {
    if (event.httpMethod && event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

    const auth = await authenticate(event);
    if (auth.response) return auth.response;

    let body;
    try { body = JSON.parse(event.body || "{}"); }
    catch { return json(400, { error: "Invalid request body" }); }

    const email = String(body.email || "").toLowerCase().trim();
    if (!email) return json(400, { error: "Missing email" });
    if (!body.data) return json(400, { error: "No file was sent." });

    const access = await resolveRosterEditAccess(auth.session, email);
    if (access.response) return access.response;

    const buf = Buffer.from(String(body.data), "base64");
    if (buf.length === 0) return json(400, { error: "The file was empty." });
    if (buf.length > MAX_UPLOAD_BYTES) {
      return json(413, { error: `That file is ${(buf.length / 1024 / 1024).toFixed(1)}MB — the limit is ${MAX_UPLOAD_BYTES / 1024 / 1024}MB. Try a photo instead of a scan, or a smaller PDF.` });
    }
    const type = sniffType(buf);
    if (!type || !ALLOWED_TYPES[type]) {
      return json(415, { error: "Upload a photo (JPEG, PNG or WebP) or a PDF of the passport photo page. iPhone HEIC photos need to be exported as JPEG first." });
    }

    // 1. Store the file privately in HubSpot.
    const form = new FormData();
    form.append("file", new Blob([buf], { type }), safeName(email, ALLOWED_TYPES[type]));
    form.append("folderPath", FOLDER);
    form.append("options", JSON.stringify({
      access: "PRIVATE",
      overwrite: false,
      duplicateValidationStrategy: "NONE",
      duplicateValidationScope: "EXACT_FOLDER",
    }));
    const up = await fetch("https://api.hubapi.com/files/v3/files", { method: "POST", headers: hsAuth(), body: form });
    if (!up.ok) {
      const detail = (await up.text().catch(() => "")).slice(0, 300);
      console.error("[upload-passport] file upload failed:", up.status, detail);
      return json(502, { error: up.status === 403
        ? "HubSpot refused the upload — the private app needs the `files` scope."
        : "The file couldn't be saved to HubSpot. Try again in a moment." });
    }
    const fileId = String((await up.json()).id || "");
    if (!fileId) return json(502, { error: "HubSpot didn't return a file id." });

    // 2. Point the passport check at it. This is the part that matters, so a
    //    failure here fails the request.
    const patch = await fetch(
      `https://api.hubapi.com/crm/v3/objects/contacts/${encodeURIComponent(access.contactId)}`,
      {
        method: "PATCH",
        headers: { ...hsAuth(), "Content-Type": "application/json" },
        body: JSON.stringify({ properties: {
          [PASSPORT_PROPS.upload]: fileId,
          // Forget the previous read so the next check reads the new file.
          [PASSPORT_PROPS.ocrHash]: "",
        } }),
      }
    );
    if (!patch.ok) {
      const detail = (await patch.text().catch(() => "")).slice(0, 300);
      console.error("[upload-passport] contact patch failed:", patch.status, detail);
      return json(500, { error: `The file was saved, but couldn't be linked to the contact — check the \`${PASSPORT_PROPS.upload}\` contact property exists in HubSpot.` });
    }

    // 3. Attach it to the contact as a note (best-effort: the check already
    //    works without it; this is what makes it visible in HubSpot).
    let attached = true;
    try {
      const note = await fetch("https://api.hubapi.com/crm/v3/objects/notes", {
        method: "POST",
        headers: { ...hsAuth(), "Content-Type": "application/json" },
        body: JSON.stringify({
          properties: {
            hs_timestamp: new Date().toISOString(),
            hs_note_body: `Passport photo uploaded through the leader portal by ${auth.session.email}.`,
            hs_attachment_ids: fileId,
          },
          associations: [{
            to: { id: String(access.contactId) },
            types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 202 }], // note → contact
          }],
        }),
      });
      if (!note.ok) {
        attached = false;
        console.warn("[upload-passport] note failed:", note.status, (await note.text().catch(() => "")).slice(0, 300));
      }
    } catch (err) {
      attached = false;
      console.warn("[upload-passport] note threw:", err?.message || err);
    }

    return json(200, { ok: true, fileId, attached });
  } catch (err) {
    console.error("[upload-passport] error:", err?.stack || err?.message || err);
    return json(500, { error: "Could not upload the passport." });
  }
}
