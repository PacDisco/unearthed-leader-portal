// Shared currency helpers for the portal's payment flow.
//
// The program's currency is driven by the `program_currency` dropdown on the
// Portal/Program object in HubSpot (3-letter ISO 4217 codes, e.g. "USD",
// "NZD"). This module centralises everything the checkout function needs to
// turn that code into a valid Stripe request:
//   - the set of currencies we support ("major / common")
//   - normalisation + validation
//   - zero-decimal handling (JPY etc.) when converting to Stripe minor units
//   - which Stripe bank-debit payment_method_type (if any) matches a currency
//
// Keep this list in sync with the option values configured on the
// `program_currency` dropdown in HubSpot. See HOW_TO_CURRENCY.md.

// Major / common currencies offered by the portal. Codes are ISO 4217.
export const MAJOR_CURRENCIES = [
  "USD", // US Dollar
  "EUR", // Euro
  "GBP", // British Pound
  "CAD", // Canadian Dollar
  "AUD", // Australian Dollar
  "NZD", // New Zealand Dollar
  "JPY", // Japanese Yen (zero-decimal)
  "CHF", // Swiss Franc
  "SGD", // Singapore Dollar
  "HKD", // Hong Kong Dollar
  "SEK", // Swedish Krona
  "NOK", // Norwegian Krone
  "DKK", // Danish Krone
  "ZAR", // South African Rand
  "AED"  // UAE Dirham
];

// Stripe treats these as zero-decimal: amounts are charged in whole units,
// so `unit_amount` must NOT be multiplied by 100. (Full Stripe list; only a
// subset overlaps with MAJOR_CURRENCIES, but we keep it complete for safety.)
const ZERO_DECIMAL_CURRENCIES = new Set([
  "BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA",
  "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF"
]);

// Map a currency to the Stripe bank-debit payment_method_type that supports
// it. The no-fee bank-transfer option is intentionally restricted to NZD only
// (the only bank-debit method enabled on Unearthed's Stripe account). All
// other currencies are card-only. To enable bank transfer for another
// currency, add it here AND enable the matching method in Stripe:
//   USD → us_bank_account, AUD → au_becs_debit, GBP → bacs_debit,
//   EUR → sepa_debit, CAD → acss_debit.
const DIRECT_DEBIT_METHOD_BY_CURRENCY = {
  NZD: "nz_bank_account" // NZ BECS Direct Debit
};

// Region hint shown on the bank-transfer payment option, since each bank-debit
// method only works for payers in that currency's home region.
const BANK_REGION_LABEL = {
  NZD: "NZ ONLY"
};

// Normalise an arbitrary input to a supported uppercase ISO code, falling
// back to NZD (the historical default) when blank/unknown.
export function normalizeCurrency(input) {
  const code = String(input || "").trim().toUpperCase();
  if (MAJOR_CURRENCIES.includes(code)) return code;
  return "NZD";
}

export function isZeroDecimal(currency) {
  return ZERO_DECIMAL_CURRENCIES.has(String(currency || "").toUpperCase());
}

// Convert a decimal amount (e.g. 1030.00) into the integer Stripe expects for
// `unit_amount`, respecting zero-decimal currencies.
export function toStripeMinorUnits(amount, currency) {
  const n = Number(amount);
  if (!isFinite(n)) return null;
  return isZeroDecimal(currency) ? Math.round(n) : Math.round(n * 100);
}

// The Stripe bank-debit method for a currency, or null if none is available.
export function directDebitMethodFor(currency) {
  return DIRECT_DEBIT_METHOD_BY_CURRENCY[normalizeCurrency(currency)] || null;
}

export function bankRegionLabel(currency) {
  return BANK_REGION_LABEL[normalizeCurrency(currency)] || "";
}
