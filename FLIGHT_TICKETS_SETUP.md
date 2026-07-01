# Flight Tickets folder — setup

The Expedition Leader and School Leader tabs now show a **Flight Tickets**
button that opens the Google Drive folder for *that specific trip*. The button
only appears when a matching folder exists, so it stays hidden until you've
created/populated the trip's folder.

## How the matching works

There is one shared **parent** Drive folder:

```
https://drive.google.com/drive/folders/11Bi_OQUZnB0HVj1u6Uw-dHSu_nF3Nw_4
```

Inside it, create **one sub-folder per trip**, and name each sub-folder to
match that trip's **Unearthed Program** name in HubSpot (the
`unearthed_program` property, e.g. "Nayland College - Malaysia 2026").

When a leader opens their tab, the portal reads the trip's `unearthed_program`
value, looks inside the parent folder for a sub-folder with the same name
(case-insensitive, surrounding spaces ignored), and:

- **Match found** → shows the Flight Tickets button linking to that sub-folder.
- **No match** → no button.

So to "turn on" flight tickets for a trip, just create a sub-folder named like
the trip and drop the tickets in. To hide it again, rename or remove the folder.

## One-time Google setup

The site reads the folder list using a Google **service account** (a robot
Google identity). This is done server-side, so no leader needs Google access —
they just click through to the folder, which you control via normal Drive
sharing.

1. **Create a service account + key**
   - Go to <https://console.cloud.google.com/> → create (or pick) a project.
   - APIs & Services → **Enable APIs** → enable **Google Drive API**.
   - APIs & Services → Credentials → **Create credentials → Service account**.
   - Open the new service account → **Keys → Add key → Create new key → JSON**.
     Download the JSON file. Note the `client_email` inside it
     (looks like `something@your-project.iam.gserviceaccount.com`).

2. **Share the Drive folder with the service account**
   - Open the parent folder in Drive → Share → add the service account's
     `client_email` with **Viewer** access.
   - If the parent folder lives in a **Shared Drive**, add the service account
     as a member of that Shared Drive (Viewer is fine) as well.

3. **Add the credentials to Netlify**
   - Netlify → your site → **Site settings → Environment variables**.
   - Add a variable named `GOOGLE_SERVICE_ACCOUNT_JSON` and paste the **entire
     contents** of the downloaded JSON key file as the value.
   - (Optional) `FLIGHT_TICKETS_PARENT_FOLDER_ID` — only needed if the parent
     folder ever changes. Defaults to the folder ID above.
   - Redeploy the site so the function picks up the new variables.

That's it. `HUBSPOT_API_KEY` is already configured for the rest of the portal
and is reused here to read the trip title.

> Alternative to the single JSON variable: you can instead set
> `GOOGLE_SERVICE_ACCOUNT_EMAIL` and `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`
> separately if you prefer not to store the whole JSON blob.

## What was changed in the code

- **`netlify/functions/get-flight-tickets.js`** (new) — authenticates the
  logged-in user, resolves the trip's `unearthed_program` from HubSpot, lists the
  parent folder's sub-folders via the Drive API, and returns the matching
  sub-folder's link (or `{ url: null }`). It is fail-soft: if Google isn't
  configured or is unreachable, it returns no link and the button stays hidden
  rather than erroring.
- **`public/index.html`** — added `injectFlightTicketsCard()`, called at the
  end of both the Expedition Leader (`trip_leader_information_content`) and
  School Leader (`teacher_information_content`) tab renderers. It adds a
  **FLIGHT TICKETS → OPEN FOLDER** card to the existing resource-link grid only
  when the function returns a folder link.

No changes were needed to `netlify.toml`/CSP: the Drive call happens
server-side, and the button is an ordinary link that opens Drive in a new tab.

## Troubleshooting

If the button doesn't appear when you expect it to, check the function logs in
Netlify (Functions → `get-flight-tickets`). It logs a clear reason, e.g.:

- `Google service account not configured` → env var missing/misnamed.
- `could not get Google access token` → key invalid, or Drive API not enabled.
- `Drive list … 404/403` → folder not shared with the service account.
- `no folder matching "<trip>"` → the sub-folder name doesn't match the trip's
  `unearthed_program` value.
