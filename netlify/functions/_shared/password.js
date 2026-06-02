// Password hashing for portal accounts.
//
// WHY: passwords were previously stored and compared in plaintext on the
// HubSpot contact's `portal_password` property. This module moves them to a
// salted scrypt hash (Node's built-in crypto — no new dependency) and supports
// a transparent migration: existing plaintext passwords still verify, and are
// re-saved as a hash the next time that user logs in or sets a password.
//
// Stored format for hashed values:  scrypt$<salt_hex>$<derivedkey_hex>
// Anything not starting with "scrypt$" is treated as a legacy plaintext value.

import crypto from "crypto";
import { promisify } from "util";

const scrypt = promisify(crypto.scrypt);
const KEYLEN = 64;
const PREFIX = "scrypt";

export function isHashed(stored) {
  return typeof stored === "string" && stored.startsWith(PREFIX + "$");
}

// Produce a salted scrypt hash string for a new/updated password.
export async function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const dk = await scrypt(String(plain), salt, KEYLEN);
  return `${PREFIX}$${salt.toString("hex")}$${dk.toString("hex")}`;
}

// Verify a plaintext password against the stored value.
// Returns { ok, legacy } where `legacy` is true when the stored value was
// plaintext (so the caller can upgrade it to a hash on a successful login).
export async function verifyPassword(plain, stored) {
  if (stored == null || stored === "") return { ok: false, legacy: false };

  if (isHashed(stored)) {
    const parts = stored.split("$");
    const saltHex = parts[1];
    const hashHex = parts[2];
    if (!saltHex || !hashHex) return { ok: false, legacy: false };
    const salt = Buffer.from(saltHex, "hex");
    const expected = Buffer.from(hashHex, "hex");
    let dk;
    try {
      dk = await scrypt(String(plain), salt, expected.length);
    } catch (_) {
      return { ok: false, legacy: false };
    }
    const ok = dk.length === expected.length && crypto.timingSafeEqual(dk, expected);
    return { ok, legacy: false };
  }

  // Legacy plaintext path. Constant-time compare, flagged for upgrade.
  const a = Buffer.from(String(plain));
  const b = Buffer.from(String(stored));
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  return { ok, legacy: true };
}
