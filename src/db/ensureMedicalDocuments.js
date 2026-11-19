/**
 * Idempotent schema guard for migration 058 (medical documents on
 * uploaded_records). Runs on every boot in every environment, because the
 * UploadedRecord model reads the new columns on every query. Additive only:
 * widens one ENUM with a NEW value and adds missing nullable columns — no row
 * is ever touched.
 */
const { QueryTypes } = require("sequelize");
const { RECORD_FILE_TYPES } = require("../config/constants");

const COLUMNS = [
  ["document_kind", "VARCHAR(40) NULL AFTER file_type"],
  ["doctor_name", "VARCHAR(120) NULL"],
  ["description", "VARCHAR(1000) NULL"],
  ["id_last4", "CHAR(4) NULL"],
  ["original_name", "VARCHAR(255) NULL"],
  ["mime_type", "VARCHAR(120) NULL"],
  ["file_size", "INT UNSIGNED NULL"],
  ["updated_at", "DATETIME NULL"],
];

module.exports = async function ensureMedicalDocuments(sequelize) {
  const rows = await sequelize.query(
    `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'uploaded_records'`,
    { type: QueryTypes.SELECT }
  );
  if (!rows.length) return false; // table not created yet
  const have = new Map(rows.map((r) => [r.name, String(r.type)]));
  let changed = false;

  const fileType = have.get("file_type") || "";
  if (!RECORD_FILE_TYPES.every((t) => fileType.includes(`'${t}'`))) {
    const values = RECORD_FILE_TYPES.map((t) => `'${t}'`).join(",");
    await sequelize.query(
      `ALTER TABLE uploaded_records MODIFY COLUMN file_type ENUM(${values}) NOT NULL DEFAULT 'prescription'`
    );
    changed = true;
  }
  for (const [name, ddl] of COLUMNS) {
    if (have.has(name)) continue;
    await sequelize.query(`ALTER TABLE uploaded_records ADD COLUMN ${name} ${ddl}`);
    changed = true;
  }
  return changed;
};
