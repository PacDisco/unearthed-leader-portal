# Security fixes — leader portal

The same three findings reported on the parent portal applied here too. All are
addressed in this repo with the same approach.

## 1. Jotform submissions editable at jotform.com/edit/<id>
- CODE: The "EDIT APPLICATION" button no longer opens the native Jotform edit
  URL. It now opens the secure in-portal editor (`/edit-application.html`),
  which authenticates the user and resolves their submission server-side. The
  submission ID and edit URL are never exposed to the browser.
- The editor is locked to application form **251396787451873** only.
- MANUAL (Jotform side, not code): in the Jotform form settings, require login
  to edit submissions and remove the edit link from confirmation emails /
  thank-you page, so the public `jotform.com/edit/<id>` URL stops exposing data.

## 2. Token not invalidated on logout — FIXED
Tokens embed a version (`ver`) mirrored on the HubSpot contact as
`portal_token_version`. `authenticate()` rejects any token whose `ver` no
longer matches. The new `logout.js` increments that value (the frontend
`logout()` buttons call it before clearing local state), instantly
invalidating every token issued before logout. A 30s in-memory cache keeps
this from adding a HubSpot read to every request; revocation fully propagates
within ~30s. On a HubSpot read error the check fails open (signature + 12h
expiry still apply).

## 3. Token valid 2 weeks — FIXED
`TOKEN_TTL_MS` is now 12 hours (was 14 days). Pre-change tokens have no `ver`
and are rejected, so everyone re-logs in once after deploy.

## REQUIRED before deploy
- HubSpot Number contact property **`portal_token_version`** (default 0).
  Without it, logout can't persist the version bump (login + 12h expiry still
  work, but logout won't actively revoke).
- Env vars (unchanged): `SESSION_SECRET`, `HUBSPOT_API_KEY`, `JOTFORM_API_KEY`.

## Files changed / added
- `_shared/auth.js` — 12h TTL, token `ver`, async revocation check + helpers.
- `logout.js` — NEW.
- `lib/jotform.js`, `get-application.js`, `update-application.js` — NEW (secure editor backend, form locked to 251396787451873).
- `public/edit-application.html` — NEW (secure editor UI).
- `login.js`, `set-password.js` — stamp `ver` into issued tokens.
- all protected endpoints — `authenticate*()` is async, calls `await`ed.
- `public/index.html`, `admin.html`, `my-trips.html` — `logout()` calls /logout; EDIT APPLICATION opens the secure editor.
- `public/service-worker.js` — cache bumped to v9.

## After deploying
Load once online so the new service worker swaps in; everyone re-logs in
(expected). Verify: log in, copy token, log out, confirm the copied token is
rejected by a protected endpoint.

## 4. Session token exposed in every file URL — FIXED

**The problem.** Files are shown in `<img>` and `<a target="_blank">`, neither
of which can send an `Authorization` header, so the credential rode in the
query string:

```
/document-proxy?url=<jotform file>&token=<SESSION TOKEN>
```

That was the same token that authorises every API call. Two consequences:

1. Anyone who obtained a document URL — browser history, a referrer header, a
   pasted link, a screenshot, a support ticket — held a **working session** for
   that user until it expired. For an admin, that is the whole CRM.
2. `/document-proxy` only asked "is this a valid session", never "were you
   given this file". Any signed-in user could proxy **any** Jotform or HubSpot
   URL they could guess or reuse — another trip's passport scans included.

**The fix.** `_shared/doc-token.js` mints a *doc token*: bound to one file
URL, carrying no role, expiring with the session that minted it, and signed in
a separate HMAC domain (`document-proxy.v1:`) so it cannot be replayed as a
session token — or vice versa. `/document-proxy` now accepts only these, and
checks the token against the URL actually being requested.

A leaked document link therefore exposes that one file, until that session
ends, and nothing else.

**Where tokens are minted.** Server-side only, by the endpoints that hand out
file links: `get-students` (portraits), `get-teachers` (staff photos),
`get-uploaded-documents`, and `get-application-data` (file-upload answers,
which are now returned ready-proxied). The browser no longer attaches a
credential to anything — it previously read `portalToken` out of
`sessionStorage` to build "VIEW" links, and no longer does. The session token
now appears only in `Authorization` headers.

**Why the tokens are deterministic.** The service worker caches files by URL,
so a token that changed between renders would orphan everything already saved
for offline use. Same viewer + same file + same session expiry produces a
byte-identical token, so URLs stay stable for the life of the session.

**Effect on existing links.** Any document URL already in a history, email or
cached page stops working immediately — it carries a session token, which the
proxy no longer accepts. Reloading the portal reissues every link. This is
intended: those old URLs are exactly the credentials being retired.

**Tests.** `test/doc-token.test.mjs` — one file only, no cross-file reuse, no
role, session/doc tokens not interchangeable, tamper resistance, and the real
edge handler run against real minted tokens (the Deno verifier and the Node
minter are separate implementations of one scheme; if they drift, every
document 401s).

### Still worth doing

- **Rotate `SESSION_SECRET`** if a document URL has been shared outside the
  team. That invalidates every existing session and doc token at once.
- Session tokens still last 12 hours (`TOKEN_TTL_MS` in `_shared/auth.js`).
  Shortening that limits the window on any leaked credential.
