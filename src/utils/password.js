/**
 * The only place bcrypt is used. Keeping hash/compare behind one module means
 * the cost factor and algorithm live in exactly one spot.
 */
const bcrypt = require("bcryptjs");
const { BCRYPT_COST } = require("../config/constants");

/** @returns {Promise<string>} the bcrypt hash of a plaintext password. */
exports.hash = (plain) => bcrypt.hash(plain, BCRYPT_COST);

/** @returns {Promise<boolean>} whether `plain` matches a stored hash. */
exports.compare = (plain, hash) => {
  if (!hash) return Promise.resolve(false); // google-only accounts have no hash
  return bcrypt.compare(plain, hash);
};
