/**
 * Gapless, per-doctor, per-year prescription numbering: `OSC-2026-000123`.
 *
 * `SELECT COUNT(*) + 1` looks tempting and is wrong twice: it re-uses a number
 * after a draft is deleted, and two concurrent finalizes read the same count.
 *
 * Instead we upsert `rx_counters` inside the caller's transaction. The
 * `INSERT ... ON DUPLICATE KEY UPDATE` takes an exclusive lock on the counter
 * row (or on the unique key gap, for the very first prescription of the year),
 * and holds it until commit — so the `SELECT` that follows on the same
 * transaction reads a value nobody else can touch. No read-modify-write race,
 * and no reliance on LAST_INSERT_ID(), which is meaningless on a table with no
 * AUTO_INCREMENT column and would return a stale id from the pooled connection.
 *
 * `prescriptions.rx_number` is UNIQUE regardless, as the backstop.
 */
const env = require("../config/env");

/**
 * Reserve the next sequence value for (doctorId, year). MUST run inside a
 * transaction — without one the row lock is released immediately and two
 * concurrent finalizes can read the same value.
 */
async function nextSequence(sequelize, doctorId, year, transaction) {
  if (!transaction) throw new Error("nextSequence() requires a transaction");

  await sequelize.query(
    `INSERT INTO rx_counters (doctor_id, year, next_val)
          VALUES (:doctorId, :year, 1)
     ON DUPLICATE KEY UPDATE next_val = next_val + 1`,
    { replacements: { doctorId, year }, transaction }
  );

  const [[row]] = await sequelize.query(
    "SELECT next_val AS seq FROM rx_counters WHERE doctor_id = :doctorId AND year = :year",
    { replacements: { doctorId, year }, transaction }
  );
  return Number(row.seq);
}

/**
 * @param {import('sequelize').Sequelize} sequelize
 * @param {number|string} doctorId
 * @param {string|null} prefix   from the template; falls back to env.RX_NUMBER_PREFIX
 * @param {object} opts
 * @param {import('sequelize').Transaction} opts.transaction  required
 * @returns {Promise<string>} e.g. "OSC-2026-000123"
 */
async function nextRxNumber(sequelize, doctorId, prefix, { transaction } = {}) {
  const year = new Date().getFullYear();
  const seq = await nextSequence(sequelize, doctorId, year, transaction);
  const clean =
    String(prefix || env.RX_NUMBER_PREFIX)
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 10) || "RX";
  return `${clean}-${year}-${String(seq).padStart(6, "0")}`;
}

/** An amended version gets a suffix so the base number stays recognisable. */
const amendedRxNumber = (base, version) => `${base}-A${version}`;

module.exports = { nextRxNumber, amendedRxNumber };
