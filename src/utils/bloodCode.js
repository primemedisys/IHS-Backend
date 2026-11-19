/**
 * Gapless, per-year, platform-wide blood-bank reference numbers:
 * `DON-2026-000001`, `UNIT-2026-000001`, `BRQ-…`, `ISS-…`, `DNR-…`.
 *
 * Same technique as utils/rxNumber.js (read that file for the full reasoning):
 * an `INSERT … ON DUPLICATE KEY UPDATE` on `blood_counters` takes an exclusive
 * lock on the (kind, year) row until the caller's transaction commits, so two
 * concurrent donations can never draw the same number. The *_code columns are
 * UNIQUE as the backstop. Numbers are always generated here, on the server —
 * never by a client.
 */

/**
 * @param {import('sequelize').Sequelize} sequelize
 * @param {string} prefix  one of BLOOD_CODE_PREFIX
 * @param {import('sequelize').Transaction} transaction  required
 * @returns {Promise<string>}
 */
async function nextBloodCode(sequelize, prefix, transaction) {
  if (!transaction) throw new Error("nextBloodCode() requires a transaction");
  const year = new Date().getFullYear();
  await sequelize.query(
    `INSERT INTO blood_counters (kind, year, next_val) VALUES (:prefix, :year, 1)
     ON DUPLICATE KEY UPDATE next_val = next_val + 1`,
    { replacements: { prefix, year }, transaction }
  );
  const [[row]] = await sequelize.query(
    "SELECT next_val AS seq FROM blood_counters WHERE kind = :prefix AND year = :year",
    { replacements: { prefix, year }, transaction }
  );
  return `${prefix}-${year}-${String(row.seq).padStart(6, "0")}`;
}

/** Several codes of one kind inside the same transaction (e.g. component units). */
async function nextBloodCodes(sequelize, prefix, count, transaction) {
  const codes = [];
  // Sequential on purpose: each call extends the SAME locked counter row, so
  // this is n cheap statements on one row, not n independent queries.
  for (let i = 0; i < count; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    codes.push(await nextBloodCode(sequelize, prefix, transaction));
  }
  return codes;
}

module.exports = { nextBloodCode, nextBloodCodes };
