# Leader portal — security fixes

This applies the same hardening as the student portal, plus an authorization
model specific to the leader portal (leaders legitimately view students' data,
but only for trips they're assigned to).

## Same as the student portal
- **Signed session tokens** (`_shared/auth.js`) issued at login / set-password;
  every private endpoint verifies them. Closes anonymous access — previously
  anyone could pull a trip's full student roster by guessing a portal ID.
- **Password hashing** (`_shared/password.js`, scrypt) with transparent upgrade
  of legacy plaintext on next login. Same module as the student portal, so a
  password set in one portal works in the other (see "Shared login" below).
- **Login brute-force throttle** (5 fails → 15-min lockout) and **magic-link
  send cooldown** (60s). Fail-open; uses the same two HubSpot properties.
- **Server-authoritative payment amounts** in create-checkout-session.
- **Generic login messages**, **internal error details no longer returned**,
  **PII scrubbed from logs**, **8-char min password**, **security headers**
  (`netlify.toml`), **noindex**, **document-proxy gated** with the session token
  (edge verifies via Web Crypto; URL builders append the token).

## Leader-specific authorization — "assigned trips only"
New helper `_shared/portal-access.js`:
- `assertPortalAccess(session, portalId)` — caller must be **Teacher / Trip
  Leader on that Portal** (or admin). Used by `get-students` and `get-teachers`.
- `assertEmailAccess(session, targetEmail)` — caller may see a person's data if
  they are that person, an admin, or **staff on a trip the target belongs to**.
  Used by `get-application-data`, `get-uploaded-documents`, `get-paid-payments`,
  `create-checkout-session`.

The label check matters: a parent is also *associated* with their trip, so a
plain association check would have let a parent pull their trip's roster. Access
requires the Teacher/Trip Leader label specifically.

`login.js` keeps its existing gate (only admins or Teacher/Trip Leader contacts
may sign in), and `set-password.js` now applies the same gate so the magic-link
path can't hand a session to a non-leader. Leaders get a **non-admin** session
token, so trip-scoping applies to them; only true admins bypass it.

## Shared login with the student portal
Both portals authenticate against the **same HubSpot contact** and the same
`portal_password`, using the **identical** password module. So:
- The same email + password works on both portals.
- A password set or upgraded on one portal works on the other automatically.
- Sessions are still per-site (each portal has its own SESSION_SECRET), so a
  user signs in to each separately — this is same-credentials, not single
  sign-on. (True SSO across the two domains would be a separate project.)
- Authorization still differs by design: a parent can sign into the student
  portal but is correctly refused by the leader portal (not staff).

## REQUIRED before deploy
This is a **separate Netlify site** from the student portal, so it needs its
own environment variable:
- **`SESSION_SECRET`** — a long random value (`openssl rand -hex 32`). Endpoints
  fail closed (500) without it. Use a DIFFERENT value than the student site.
- **`PORTAL_BASE_URL`** (optional) — defaults to
  `https://leaders.unearthededucation.org` in code; set it if the domain differs.

Already done (shared HubSpot account): the two throttle properties
`portal_failed_logins` and `portal_lockout_until` already exist, so the login
throttle works with no extra setup.

## Verified
All 18 functions + 3 shared modules + edge proxy compile and import cleanly. The
edge Web Crypto token verifier was previously confirmed to accept tokens minted
by the Node login function and reject tampered/expired/wrong-secret ones.
