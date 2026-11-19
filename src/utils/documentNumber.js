/**
 * Human-facing document numbers for pharmacy documents: PREFIX-YYYYMMDD-000123
 * (PO for a purchase, CN for a credit note). Derived from the row's own
 * primary key — unique by construction, no counter table, no retry — and dated
 * in IST, the calendar the pharmacy works in. Same shape as the existing
 * MO-… order numbers.
 */
const { istToday } = require("./period");

function documentNumber(prefix, id, now = new Date()) {
  return `${prefix}-${istToday(now).replace(/-/g, "")}-${String(id).padStart(6, "0")}`;
}

module.exports = { documentNumber };
