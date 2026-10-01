// Passport photo widget support.
//
// Since October 2026 the application form collects the passport through the
// "Passport bio page upload" custom widget (field name `passportPhoto`, qid 133
// on form 251396787451873) instead of Jotform's own file upload. The widget
// checks the photo really is a passport bio page, stores it in the
// "Jotform uploads" folder of the Passports Shared Drive, and saves the Drive
// link as the answer — a plain string on a `control_widget` question.
//
// The old "Passport Cover Page Photo" upload (qid 89) is hidden on the form but
// still holds the files for every earlier submission, so both shapes exist.
//
// Rather than teach every reader about the widget, submissions are normalised
// as they're fetched: a widget answer holding a passport Drive link is
// rewritten to look like a one-file `control_fileupload`. Everything that
// already understands uploads — the passport check, the documents list, the
// leader view, the group export — then picks it up unchanged. Downloads of
// the Drive file go through the passport-check Worker (see fetchPassportDriveFile
// and the /document-proxy edge function), because the Shared Drive is private.
//
// Env vars (Netlify):
//   PASSPORT_FILES_URL  base URL of the Worker, e.g.
//                       https://passport-check.unearthededucation.workers.dev
//   PASSPORT_FILES_KEY  shared secret; must match the Worker's PORTAL_FILE_KEY

const DRIVE_FILE_RE = /^https:\/\/drive\.google\.com\/file\/d\/([A-Za-z0-9_-]{10,})(?:[/?#]|$)/;

// The Drive file ID inside a passport link, or null if it isn't one.
export function driveFileId(url) {
  const m = DRIVE_FILE_RE.exec(String(url || "").trim());
  return m ? m[1] : null;
}

export function isPassportDriveUrl(url) {
  return driveFileId(url) !== null;
}

// Rewrites a passport-widget answer in place to the file-upload shape. Safe to
// call on any submission, any number of times; returns the submission.
export function normalizePassportWidget(submission) {
  const answers = submission?.answers;
  if (!answers || typeof answers !== "object") return submission;
  for (const key of Object.keys(answers)) {
    const a = answers[key];
    if (!a || String(a.type || "").toLowerCase() !== "control_widget") continue;
    const raw = typeof a.answer === "string" ? a.answer.trim() : "";
    const looksLikePassportWidget = a.name === "passportPhoto" || isPassportDriveUrl(raw);
    if (!looksLikePassportWidget) continue;
    a.originalType = "control_widget";
    a.type = "control_fileupload";
    a.answer = isPassportDriveUrl(raw) ? [raw] : "";
  }
  return submission;
}

// Downloads a passport file from the Shared Drive via the Worker. Returns a
// fetch Response (check .ok). Throws if the portal isn't configured for it.
export async function fetchPassportDriveFile(url) {
  const id = driveFileId(url);
  if (!id) throw new Error("not a passport Drive link");
  const base = (process.env.PASSPORT_FILES_URL || "").replace(/\/+$/, "");
  const key = process.env.PASSPORT_FILES_KEY || "";
  if (!base || !key) {
    throw new Error("PASSPORT_FILES_URL / PASSPORT_FILES_KEY are not set — see PASSPORT_SETUP.md");
  }
  return fetch(`${base}/file/${encodeURIComponent(id)}`, { headers: { "x-portal-key": key } });
}
