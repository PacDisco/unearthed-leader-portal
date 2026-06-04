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
