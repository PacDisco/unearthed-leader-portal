# Program currency (multi-currency payments)

The portal's payment currency is now driven by the **`program_currency`**
dropdown on the Portal/Program object in HubSpot. Whatever 3-letter ISO 4217
code is selected there is used for:

- the Stripe Checkout charge (line-item currency + correct minor-units math),
- the bank-transfer (direct-debit) method offered, and
- every amount shown in the portal (price, payment schedule, paid rows).

If `program_currency` is blank on both the trip record and the global defaults
record, it falls back to the `STRIPE_CURRENCY` env var, then to `NZD`.

## 1. Configure the dropdown options in HubSpot

HubSpot dropdown options can't be set through this integration's tools — add
them in the HubSpot UI:

**Settings → Data Management → Properties** → object = your Program/Portal
object → edit **Program currency** (`program_currency`) → add these options.
Use the **3-letter ISO code as both the label and the internal value**:

```
USD  EUR  GBP  CAD  AUD  NZD  JPY  CHF
SGD  HKD  SEK  NOK  DKK  ZAR  AED
```

(This "major / common" set matches `netlify/functions/_shared/currency.js` and
the `SUPPORTED_CURRENCIES` list in the frontend. If you add or remove a code,
update both of those so the portal stays in sync.)

Then set `program_currency` on each Portal record (and on the global defaults
record, id `50506535214`, if you want a portal-wide default).

## 2. Stripe account requirements

- **Cards** work for any supported currency with no extra setup.
- **Bank transfer (no-fee direct debit)** is offered for **NZD only**, since
  that's the only bank-debit method enabled on the Stripe account. Every other
  currency is **card-only** — the bank-transfer button is hidden automatically.

  | Currency | Stripe bank-debit method | Region shown |
  |----------|--------------------------|--------------|
  | NZD | `nz_bank_account` (NZ BECS) | NZ ONLY |

  To enable bank transfer for another currency later, add it to
  `DIRECT_DEBIT_METHOD_BY_CURRENCY` (and `BANK_REGION_LABEL`) in
  `netlify/functions/_shared/currency.js`, mirror it in `BANK_DEBIT_REGION` in
  `public/index.html`, and enable the matching method in **Stripe → Settings →
  Payment methods**: USD→`us_bank_account`, AUD→`au_becs_debit`,
  GBP→`bacs_debit`, EUR→`sepa_debit`, CAD→`acss_debit`.

- Stripe also requires that the charge currency is supported by your Stripe
  account / connected payout setup. Test each currency once in Stripe test
  mode before going live.

## 3. Optional env overrides (Netlify)

- `STRIPE_CURRENCY` — fallback currency when `program_currency` is unset.
- `STRIPE_DIRECT_DEBIT_METHODS` — comma-separated override for the bank-debit
  method(s). Leave unset to let the code pick the right method from the
  program currency automatically.

## Files changed

- `netlify/functions/_shared/currency.js` — new shared currency helper.
- `netlify/functions/create-checkout-session.js` — reads `program_currency`,
  sets Stripe currency, minor-units, and bank-debit method from it.
- `netlify/functions/portal.js`, `netlify/functions/get-portals.js` — expose
  `program_currency` to the frontend.
- `public/index.html`, `public/my-trips.html`, `public/admin.html` —
  currency-aware amount/price formatting and bank-transfer availability.
