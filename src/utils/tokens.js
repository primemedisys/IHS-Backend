/**
 * Opaque-token helpers. Refresh tokens and reset tokens are random strings; we
 * hand the RAW value to the client (Bearer / email link) but persist only its
 * SHA-256 hash, so a database leak can't be replayed. `sha256` is deterministic
 * so we can look a presented token up by hashing it and matching the column.
 */
const crypto = require("crypto");

/** A cryptographically-random hex string (default 32 bytes → 64 hex chars). */
exports.randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString("hex");

/** SHA-256 hex digest — used to hash a raw token before storing/looking it up. */
exports.sha256 = (raw) => crypto.createHash("sha256").update(raw).digest("hex");
