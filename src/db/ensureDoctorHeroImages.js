/**
 * Dev-only parity shim for migrations 046 + 047 on a database that was built by
 * `sequelize.sync()` (which never ALTERs an existing table):
 *   - adds `doctor_profiles.hero_image_urls` (JSON NULL) when missing;
 *   - relaxes `clinics.lat` / `clinics.lng` to NULL when still NOT NULL.
 * Idempotent — a no-op once the schema matches. Mirrors ensureDoctorShowcaseImage.
 */
const { QueryTypes } = require("sequelize");

async function tableExists(sequelize, table) {
  const [{ t }] = await sequelize.query(
    `SELECT COUNT(*) AS t FROM information_schema.tables
       WHERE table_schema = DATABASE() AND table_name = :table`,
    { type: QueryTypes.SELECT, replacements: { table } }
  );
  return Number(t) > 0;
}

async function columnInfo(sequelize, table, column) {
  const rows = await sequelize.query(
    `SELECT IS_NULLABLE AS nullable FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = :table AND column_name = :column`,
    { type: QueryTypes.SELECT, replacements: { table, column } }
  );
  return rows[0] || null;
}

async function ensureDoctorHeroImages(sequelize) {
  let changed = false;

  if (await tableExists(sequelize, "doctor_profiles")) {
    if (!(await columnInfo(sequelize, "doctor_profiles", "hero_image_urls"))) {
      await sequelize.query("ALTER TABLE doctor_profiles ADD COLUMN hero_image_urls JSON NULL");
      changed = true;
    }
  }

  if (await tableExists(sequelize, "clinics")) {
    for (const column of ["lat", "lng"]) {
      const info = await columnInfo(sequelize, "clinics", column);
      if (info && info.nullable === "NO") {
        await sequelize.query(`ALTER TABLE clinics MODIFY COLUMN ${column} DECIMAL(10,7) NULL`);
        changed = true;
      }
    }
  }

  return changed;
}

module.exports = ensureDoctorHeroImages;
