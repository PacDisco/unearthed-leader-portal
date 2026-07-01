// get-flight-tickets.js
//
// WHAT THIS DOES
//   The program's flight tickets live in ONE shared Google Drive parent
//   folder (hardcoded below / overridable via env). Inside it there is one
//   sub-folder per trip, named to match the trip's Portal title in HubSpot.
//
//   This endpoint:
//     1. Confirms the caller is signed in.
//     2. Works out which trip the caller is viewing (?portalId=…) and reads
//        that Portal record's `portal_title` from HubSpot.
//     3. Lists the sub-folders of the parent Drive folder and finds the one
//        whose name matches the portal title (case-insensitive, trimmed).
//     4. Returns that sub-folder's shareable link — or { url: null } when no
//        matching folder exists yet, so the frontend simply hides the button.
//
//   It is intentionally fail-soft: if the Google credentials aren't
//   configured, or Drive is unreachable, it returns { url: null } (200) and
//   logs the reason, rather than breaking the leader tabs.
//
// REQUIRED ENV VARS (set in Netlify → Site settings → Environment variables)
//   GOOGLE_SERVICE_ACCOUNT_JSON
//       The full JSON key file for a Google Cloud service account, pasted as
//       a single value. (Alternatively set GOOGLE_SERVICE_ACCOUNT_EMAIL and
//       GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY separately.)
//   FLIGHT_TICKETS_PARENT_FOLDER_ID   (optional)
//       Overrides the hardcoded parent folder id below.
//   HUBSPOT_API_KEY                   (already used across the portal)
//
// GOOGLE SETUP (one-time)
//   - Create a service account in Google Cloud and download its JSON key.
//   - Enable the Google Drive API for that project.
//   - Share the parent Drive folder (and, if it's a Shared Drive, the drive
//     itself) with the service account's client_email, "Viewer" is enough.
//   See FLIGHT_TICKETS_SETUP.md for step-by-step instructions.

import crypto from "crypto";
import { authenticate } from "./_shared/auth.js";

// Parent folder that holds one sub-folder per trip. Taken from the Drive URL
// the program shared:
//   https://drive.google.com/drive/u/0/folders/11Bi_OQUZnB0HVj1u6Uw-dHSu_nF3Nw_4
const DEFAULT_PARENT_FOLDER_ID = "11Bi_OQUZnB0HVj1u6Uw-dHSu_nF3Nw_4";

// HubSpot custom-object type id for Portal records (same as portal.js).
const PORTAL_OBJECT = "2-58156993";

function jsonOk(body) {
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  };
}

// Read the service-account credentials from whichever env shape is present.
// Returns { client_email, private_key } or null if not configured.
function readServiceAccount() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (raw && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed.client_email && parsed.private_key) {
        return {
          client_email: parsed.client_email,
          // Netlify often stores the key with literal "\n" — normalise both
          // that and any real newlines into proper line breaks.
          private_key: String(parsed.private_key).replace(/\\n/g, "\n")
        };
      }
    } catch (err) {
      console.error("[get-flight-tickets] GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON:", err.message);
    }
  }
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;
  if (email && key) {
    return { client_email: email, private_key: String(key).replace(/\\n/g, "\n") };
  }
  return null;
}

function b64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// Mint a Google OAuth access token from a service account using a signed JWT
// (the standard two-legged OAuth flow). No external dependency needed — Node's
// crypto signs the RS256 assertion.
async function getAccessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/drive.readonly",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600
  };
  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claim))}`;
  const signature = crypto
    .createSign("RSA-SHA256")
    .update(unsigned)
    .sign(sa.private_key);
  const assertion = `${unsigned}.${b64url(signature)}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion
    })
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`token endpoint ${res.status}: ${txt.slice(0, 200)}`);
  }
  const data = await res.json();
  if (!data.access_token) throw new Error("no access_token in token response");
  return data.access_token;
}

// Look up the program name for a given portal id. The Drive sub-folders are
// named to match the `unearthed_program` property (label "Unearthed Program"
// in HubSpot, e.g. "Nayland College - Malaysia 2026"). We fall back to
// portal_title / destination only if that's empty. Returns "" if unavailable.
async function fetchPortalName(portalId) {
  if (!portalId) return "";
  try {
    const res = await fetch(
      `https://api.hubapi.com/crm/v3/objects/${PORTAL_OBJECT}/${encodeURIComponent(portalId)}?properties=unearthed_program,portal_title,destination`,
      { headers: { Authorization: `Bearer ${process.env.HUBSPOT_API_KEY}` } }
    );
    if (!res.ok) {
      console.error("[get-flight-tickets] HubSpot portal fetch failed:", res.status);
      return "";
    }
    const data = await res.json();
    const p = data.properties || {};
    return (p.unearthed_program || p.portal_title || p.destination || "").trim();
  } catch (err) {
    console.error("[get-flight-tickets] HubSpot portal fetch error:", err.message);
    return "";
  }
}

// List immediate sub-folders of the parent folder. Works for both ordinary
// "My Drive" folders and Shared Drives (the allDrives flags are harmless for
// ordinary folders).
async function listSubfolders(accessToken, parentId) {
  const q = [
    `'${parentId}' in parents`,
    "mimeType = 'application/vnd.google-apps.folder'",
    "trashed = false"
  ].join(" and ");
  const params = new URLSearchParams({
    q,
    fields: "files(id,name,webViewLink)",
    pageSize: "1000",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
    corpora: "allDrives"
  });
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params.toString()}`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`drive list ${res.status}: ${txt.slice(0, 200)}`);
  }
  const data = await res.json();
  return Array.isArray(data.files) ? data.files : [];
}

const norm = (s) => String(s || "").trim().toLowerCase();

export async function handler(event) {
  try {
    // Any signed-in user. The leader tabs that call this are already gated
    // client-side to Trip Leaders / Teachers; the link itself points at a
    // share-restricted Drive folder.
    const auth = await authenticate(event);
    if (auth.response) return auth.response;

    const params = event.queryStringParameters || {};
    const parentId = (process.env.FLIGHT_TICKETS_PARENT_FOLDER_ID || DEFAULT_PARENT_FOLDER_ID).trim();

    // Portal name: prefer resolving server-side from the portal id; fall back
    // to a client-supplied name (the frontend already holds the program name).
    let portalName = await fetchPortalName(params.portalId);
    if (!portalName && params.name) portalName = String(params.name).trim();

    if (!portalName) {
      console.warn("[get-flight-tickets] no portal name resolved — hiding button.");
      return jsonOk({ url: null });
    }

    const sa = readServiceAccount();
    if (!sa) {
      console.warn("[get-flight-tickets] Google service account not configured — hiding button.");
      return jsonOk({ url: null });
    }

    let accessToken;
    try {
      accessToken = await getAccessToken(sa);
    } catch (err) {
      console.error("[get-flight-tickets] could not get Google access token:", err.message);
      return jsonOk({ url: null });
    }

    let folders;
    try {
      folders = await listSubfolders(accessToken, parentId);
    } catch (err) {
      console.error("[get-flight-tickets] Drive list failed:", err.message);
      return jsonOk({ url: null });
    }

    const want = norm(portalName);
    // Exact (normalised) match first; then a forgiving contains match so minor
    // punctuation/spacing differences between HubSpot and the folder name
    // still resolve.
    let match =
      folders.find((f) => norm(f.name) === want) ||
      folders.find((f) => norm(f.name).includes(want) || want.includes(norm(f.name)));

    if (!match) {
      console.log(`[get-flight-tickets] no folder matching "${portalName}" in parent ${parentId}.`);
      return jsonOk({ url: null });
    }

    const url = match.webViewLink || `https://drive.google.com/drive/folders/${match.id}`;
    return jsonOk({ url, folderName: match.name });
  } catch (err) {
    console.error("[get-flight-tickets] ERROR:", err);
    // Fail soft: the button just won't appear.
    return jsonOk({ url: null });
  }
}
