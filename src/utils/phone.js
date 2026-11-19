/**
 * Indian mobile-number helpers, shared by login-by-mobile and the password-reset
 * OTP flow.
 *
 * `users.phone` is free text (the register/profile validators accept "+91 …",
 * spaces and dashes) and is NOT unique, so a number is always compared in its
 * canonical 10-digit form — never as the raw stored string. Stored values are
 * never rewritten; this only normalises for comparison.
 */

/** A valid Indian mobile: 10 digits starting 6–9. */
const MOBILE_RE = /^[6-9]\d{9}$/;

/**
 * "+91 98765-43210" / "098765 43210" / "9876543210" → "9876543210".
 * Returns null for anything that isn't an Indian mobile number.
 */
function normalizeIndianMobile(raw) {
  if (raw == null) return null;
  let digits = String(raw).replace(/[\s\-().]/g, "");
  if (digits.startsWith("+")) {
    if (!digits.startsWith("+91")) return null;
    digits = digits.slice(3);
  } else if (digits.length === 12 && digits.startsWith("91")) {
    digits = digits.slice(2);
  } else if (digits.length === 11 && digits.startsWith("0")) {
    digits = digits.slice(1);
  }
  return MOBILE_RE.test(digits) ? digits : null;
}

/** "9876543210" → "+919876543210" (E.164, what SMS providers expect). */
function toE164India(mobile) {
  return `+91${mobile}`;
}

/** "9876543210" → "******3210" — safe to log. */
function maskMobile(mobile) {
  return `******${String(mobile).slice(-4)}`;
}

module.exports = { normalizeIndianMobile, toE164India, maskMobile, MOBILE_RE };
