/**
 * Dev-only parity shim for migration 018 (record provenance).
 *
 * All five tables already exist in a dev database, and `sequelize.sync()` never
 * ALTERs an existing table — so without this, every clinic-authored record would
 * fail to insert on an "Unknown column 'source'" error.
 *
 * Mirrors the migration exactly, including:
 *  - widening patient_vitals.source in place (it already exists as a 2-value enum),
 *  - making clinical_notes.doctor_id nullable (a clinic note has no doctor),
 *  - the clinical_notes backfill, so existing notes keep showing their author.
 *
 * FKs are added with the columns; ON DELETE SET NULL keeps a medical record
 * alive when its author's account is deleted. Idempotent throughout.
 */
const { QueryTypes } = require("sequelize");

const SOURCE_ENUM = "ENUM('patient','doctor','clinic')";

/** The four tables that get an identical pair of columns. */
const TABLES = [
  { table: "uploaded_records", defaultSource: "patient", fk: "fk_uploaded_records_recorded_by" },
  { table: "patient_allergies", defaultSource: "patient", fk: "fk_patient_allergies_recorded_by" },
  { table: "patient_conditions", defaultSource: "patient", fk: "fk_patient_conditions_recorded_by" },
  { table: "clinical_notes", defaultSource: "doctor", fk: "fk_clinical_notes_recorded_by" },
];

async function tableExists(sequelize, table) {
  const [{ c }] = await sequelize.query(
    `SELECT COUNT(*) AS c FROM information_schema.tables
       WHERE table_schema = DATABASE() AND table_name = :table`,
    { type: QueryTypes.SELECT, replacements: { table } }
  );
  return Number(c) > 0;
}

async function column(sequelize, table, name) {
  const rows = await sequelize.query(
    `SELECT COLUMN_TYPE AS type, IS_NULLABLE AS nullable FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = :table AND column_name = :name`,
    { type: QueryTypes.SELECT, replacements: { table, name } }
  );
  return rows[0] || null;
}

async function ensureRecordProvenance(sequelize) {
  let changed = false;

  // ── patient_vitals: widen the existing enum, then add the author column ────
  if (await tableExists(sequelize, "patient_vitals")) {
    const src = await column(sequelize, "patient_vitals", "source");
    if (src && !String(src.type).includes("clinic")) {
      await sequelize.query(
        `ALTER TABLE patient_vitals MODIFY source ${SOURCE_ENUM} NOT NULL DEFAULT 'patient'`
      );
      changed = true;
    }
    if (!(await column(sequelize, "patient_vitals", "recorded_by_user_id"))) {
      await sequelize.query(
        `ALTER TABLE patient_vitals
           ADD COLUMN recorded_by_user_id BIGINT UNSIGNED NULL,
           ADD CONSTRAINT fk_patient_vitals_recorded_by FOREIGN KEY (recorded_by_user_id)
             REFERENCES users (id) ON DELETE SET NULL`
      );
      changed = true;
    }
  }

  // ── clinical_notes.doctor_id must accept NULL for a clinic-authored note ───
  if (await tableExists(sequelize, "clinical_notes")) {
    const doctorId = await column(sequelize, "clinical_notes", "doctor_id");
    if (doctorId && doctorId.nullable === "NO") {
      await sequelize.query("ALTER TABLE clinical_notes MODIFY doctor_id BIGINT UNSIGNED NULL");
      changed = true;
    }
  }

  // ── the four identical column pairs ────────────────────────────────────────
  for (const { table, defaultSource, fk } of TABLES) {
    if (!(await tableExists(sequelize, table))) continue;
    if (await column(sequelize, table, "source")) continue;

    await sequelize.query(
      `ALTER TABLE ${table}
         ADD COLUMN source ${SOURCE_ENUM} NOT NULL DEFAULT '${defaultSource}',
         ADD COLUMN recorded_by_user_id BIGINT UNSIGNED NULL,
         ADD CONSTRAINT ${fk} FOREIGN KEY (recorded_by_user_id)
           REFERENCES users (id) ON DELETE SET NULL`
    );
    changed = true;
  }

  // ── backfill: an existing note's author IS its doctor ──────────────────────
  // Runs unconditionally but only touches unattributed rows, so it is a no-op
  // on every boot after the first.
  if (await tableExists(sequelize, "clinical_notes")) {
    await sequelize.query(
      `UPDATE clinical_notes SET recorded_by_user_id = doctor_id, source = 'doctor'
         WHERE recorded_by_user_id IS NULL AND doctor_id IS NOT NULL`
    );
  }

  return changed;
}

module.exports = ensureRecordProvenance;
