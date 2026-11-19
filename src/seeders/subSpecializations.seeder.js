/**
 * Seeds sub-specialization data for the doctor specialization hierarchy
 * (docs/bugfix-05-09-2026/doctor-specialization-sub-specialization.md).
 *
 * Idempotent and ADDITIVE: each sub-specialization is topped up only if missing
 * (case-insensitive name match per parent). Safe to run against a database that
 * already has rows — doctor-added entries (POST /doctor/catalog/sub-specializations)
 * are never removed or renamed.
 *
 * Called from server.js on boot in development, and runnable standalone:
 * `npm run seed:sub-specializations`.
 */
const { Specialization, SubSpecialization } = require("../models");
const { subSpecSlug } = require("../utils/slug");

/** "Knee Replacement" → "knee-replacement" */
const slugify = (name) =>
  name
    .toLowerCase()
    .replace(/&/g, " ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/**
 * Sub-specialization data organized by parent specialization name.
 * Each key is a specialization name (must match the seeded SPECIALIZATIONS array
 * in lookups.seeder.js), and the value is an array of sub-specialization names.
 */
const SUB_SPECIALIZATIONS = {
  Cardiology: [
    "Interventional Cardiology",
    "Electrophysiology",
    "Heart Failure Management",
    "Preventive Cardiology",
    "Echocardiography",
  ],
  Orthopaedics: [
    "Trauma",
    "Knee Replacement",
    "Hip Replacement",
    "Spine Surgery",
    "Sports Medicine",
    "Hand Surgery",
    "Shoulder Surgery",
    "Joint Replacement",
    "Paediatric Orthopaedics",
  ],
  Dermatology: [
    "Cosmetic Dermatology",
    "Pediatric Dermatology",
    "Dermatopathology",
    "Dermatosurgery",
  ],
  Neurology: [
    "Stroke",
    "Epilepsy",
    "Movement Disorders",
    "Neuromuscular Disorders",
    "Headache Medicine",
  ],
  "General Surgery": [
    "Laparoscopic Surgery",
    "Bariatric Surgery",
    "Colorectal Surgery",
    "Hepatobiliary Surgery",
    "Hernia Surgery",
  ],
  Neurosurgery: [
    "Spine Surgery",
    "Pediatric Neurosurgery",
    "Vascular Neurosurgery",
    "Functional Neurosurgery",
    "Skull Base Surgery",
  ],
  Oncology: [
    "Medical Oncology",
    "Surgical Oncology",
    "Radiation Oncology",
    "Pediatric Oncology",
    "Hemato-Oncology",
  ],
  Urology: [
    "Urologic Oncology",
    "Pediatric Urology",
    "Reconstructive Urology",
    "Endourology",
    "Andrology",
  ],
  Gastroenterology: [
    "Hepatology",
    "Therapeutic Endoscopy",
    "Inflammatory Bowel Disease",
    "Pancreatic Disorders",
    "Motility Disorders",
  ],
  Pulmonology: [
    "Critical Care Medicine",
    "Sleep Medicine",
    "Interventional Pulmonology",
    "Allergy & Immunology",
  ],
  Nephrology: [
    "Dialysis",
    "Transplant Nephrology",
    "Pediatric Nephrology",
    "Critical Care Nephrology",
  ],
  Endocrinology: [
    "Diabetes Management",
    "Thyroid Disorders",
    "Reproductive Endocrinology",
    "Pediatric Endocrinology",
    "Adrenal Disorders",
  ],
  Rheumatology: [
    "Clinical Immunology",
    "Pediatric Rheumatology",
    "Musculoskeletal Ultrasound",
  ],
  Paediatrics: [
    "Neonatology",
    "Pediatric Cardiology",
    "Developmental Pediatrics",
    "Pediatric Pulmonology",
    "Pediatric Gastroenterology",
  ],
  "Obstetrics & Gynaecology": [
    "Maternal-Fetal Medicine",
    "Reproductive Endocrinology",
    "Gynecologic Oncology",
    "Minimally Invasive Surgery",
    "Urogynecology",
  ],
  Ophthalmology: [
    "Retina",
    "Cornea",
    "Glaucoma",
    "Pediatric Ophthalmology",
    "Oculoplastic Surgery",
    "Neuro-Ophthalmology",
  ],
  "ENT (Otolaryngology)": [
    "Rhinology",
    "Otology",
    "Laryngology",
    "Head & Neck Surgery",
    "Pediatric ENT",
    "Cochlear Implant",
  ],
  Psychiatry: [
    "Child Psychiatry",
    "Addiction Psychiatry",
    "Geriatric Psychiatry",
    "Consultation-Liaison Psychiatry",
  ],
  "Plastic Surgery": [
    "Reconstructive Surgery",
    "Cosmetic Surgery",
    "Hand Surgery",
    "Burn Surgery",
  ],
  Anaesthesiology: [
    "Pain Management",
    "Critical Care Medicine",
    "Regional Anaesthesia",
    "Cardiac Anaesthesia",
    "Pediatric Anaesthesia",
  ],
  Radiology: [
    "Interventional Radiology",
    "Neuroradiology",
    "Musculoskeletal Radiology",
    "Cardiothoracic Radiology",
  ],
  Pathology: [
    "Anatomical Pathology",
    "Clinical Pathology",
    "Hematopathology",
    "Cytopathology",
  ],
  Physiotherapy: [
    "Orthopedic Physiotherapy",
    "Neurological Physiotherapy",
    "Cardiopulmonary Physiotherapy",
    "Pediatric Physiotherapy",
    "Sports Physiotherapy",
  ],
  Dentistry: [
    "Orthodontics",
    "Endodontics",
    "Periodontics",
    "Prosthodontics",
    "Oral Surgery",
    "Pediatric Dentistry",
  ],
  "Vascular Surgery": [
    "Endovascular Surgery",
    "Venous Disease",
    "Lymphedema",
  ],
  "General Physician": [
    "Internal Medicine",
    "Family Medicine",
    "Geriatric Medicine",
    "Preventive Medicine",
  ],
};

/**
 * Insert any sub-specializations a parent specialization does not already have,
 * and fix any existing rows whose slug does not match the current
 * `{parentSlug}-{subSlug}` format (left over from a prior seeding run).
 *
 * One SELECT then bulk operations per parent — never a query per name.
 */
async function topUpSubSpecs(parentName, subNames, specId) {
  const parentSlug = slugify(parentName);
  const existing = await SubSpecialization.findAll({
    where: { specializationId: specId },
    attributes: ["id", "name", "slug"],
  });
  // Match on name AND slug: a doctor-added "Joint-Replacement" shares the slug
  // of the seeded "Joint Replacement", and inserting both would break the
  // unique slug index (and with it, boot).
  const have = new Set(existing.map((r) => r.name.toLowerCase()));
  const haveSlug = new Set(existing.map((r) => subSpecSlug(parentSlug, r.name)));
  const missing = subNames.filter(
    (n) => !have.has(n.toLowerCase()) && !haveSlug.has(subSpecSlug(parentSlug, n))
  );

  // Fix any existing rows whose slug doesn't match the current format.
  let fixed = 0;
  for (const row of existing) {
    const expected = subSpecSlug(parentSlug, row.name);
    if (row.slug !== expected) {
      await row.update({ slug: expected });
      fixed++;
    }
  }

  if (missing.length) {
    await SubSpecialization.bulkCreate(
      missing.map((name) => ({ name, slug: subSpecSlug(parentSlug, name), specializationId: specId }))
    );
  }

  if (fixed) console.log(`  🔧 Fixed ${fixed} slug(s) under "${parentName}"`);
  return missing.length;
}

async function seedSubSpecializations() {
  let total = 0;

  for (const [specName, subNames] of Object.entries(SUB_SPECIALIZATIONS)) {
    const spec = await Specialization.findOne({ where: { name: specName } });
    if (!spec) {
      console.warn(`⚠️  Specialization "${specName}" not found — skipping its sub-specializations`);
      continue;
    }
    const added = await topUpSubSpecs(specName, subNames, spec.id);
    total += added;
  }

  if (total > 0) {
    console.log(`✅ Seeded sub-specializations (+${total} rows)`);
  }
  return { total };
}

module.exports = seedSubSpecializations;

// Standalone: `npm run seed:sub-specializations`
if (require.main === module) {
  const { sequelize } = require("../models");
  seedSubSpecializations()
    .then(() => sequelize.close())
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("❌ Sub-specialization seed failed:", err);
      process.exit(1);
    });
}
