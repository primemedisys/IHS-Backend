/**
 * Reference data for the four lookup tables the UI reads from dropdowns:
 * specializations, languages, allergies and conditions.
 *
 * These are NOT user data — they are the vocabulary the forms offer. A fresh
 * database has them empty, which is why a brand-new local install shows
 * "No options" on the doctor's Specialties step and an unusable allergy picker.
 *
 * Idempotent and ADDITIVE: each table is topped up with any name it is missing
 * and nothing is ever deleted or renamed. Safe to run against a database that
 * already has rows, including ones an admin added by hand — a name that exists
 * is skipped, so ids stay stable and every FK that points at them survives.
 *
 * Called from server.js on boot in development, and runnable standalone:
 * `npm run seed:lookups`.
 */
const { Specialization, Language, Allergy, Condition } = require("../models");

/** "Obstetrics & Gynaecology" → "obstetrics-gynaecology" (specializations have a slug). */
const slugify = (name) =>
  name
    .toLowerCase()
    .replace(/&/g, " ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const SPECIALIZATIONS = [
  "General Physician", "Cardiology", "Dermatology", "Neurology", "Orthopaedics",
  "Paediatrics", "Obstetrics & Gynaecology", "Psychiatry", "Ophthalmology",
  "ENT (Otolaryngology)", "Gastroenterology", "Endocrinology", "Pulmonology",
  "Nephrology", "Urology", "Oncology", "Rheumatology", "Dentistry",
  "General Surgery", "Plastic Surgery", "Anaesthesiology", "Radiology",
  "Pathology", "Physiotherapy", "Ayurveda", "Homeopathy", "Nutrition & Dietetics",
  "Diabetology", "Neurosurgery", "Vascular Surgery",
];

/** The languages a consultation is realistically conducted in across India. */
const LANGUAGES = [
  "English", "Hindi", "Bengali", "Marathi", "Telugu", "Tamil", "Gujarati",
  "Urdu", "Kannada", "Odia", "Malayalam", "Punjabi", "Assamese", "Maithili",
  "Santali", "Kashmiri", "Nepali", "Konkani", "Sindhi", "Manipuri",
];

const ALLERGIES = [
  "Penicillin", "Sulfa drugs", "Aspirin", "Ibuprofen", "Peanuts", "Tree nuts",
  "Shellfish", "Fish", "Eggs", "Milk", "Soy", "Wheat / Gluten", "Sesame",
  "Dust mites", "Pollen", "Pet dander", "Mould", "Latex", "Insect stings",
  "Iodine / Contrast dye", "Anaesthetics", "Nickel", "Fragrances", "Eggplant",
];

const CONDITIONS = [
  "Diabetes (Type 1)", "Diabetes (Type 2)", "Hypertension", "Asthma",
  "Coronary artery disease", "Heart failure", "Stroke", "Chronic kidney disease",
  "COPD", "Tuberculosis", "Hypothyroidism", "Hyperthyroidism", "Anaemia",
  "Arthritis", "Rheumatoid arthritis", "Osteoporosis", "Epilepsy", "Migraine",
  "Depression", "Anxiety disorder", "Obesity", "High cholesterol",
  "Fatty liver disease", "Hepatitis B", "Hepatitis C", "HIV", "Cancer",
  "PCOS", "Irritable bowel syndrome", "Acid reflux (GERD)", "Psoriasis", "Eczema",
];

/**
 * Insert only the names a table does not already have.
 *
 * One SELECT then one bulkCreate per table — never a query per name, which at
 * ~100 names would be ~100 round trips on every boot.
 */
async function topUp(Model, names, buildRow) {
  const existing = await Model.findAll({ attributes: ["name"] });
  const have = new Set(existing.map((r) => r.name.toLowerCase()));
  const missing = names.filter((n) => !have.has(n.toLowerCase()));
  if (!missing.length) return 0;
  await Model.bulkCreate(missing.map(buildRow));
  return missing.length;
}

async function seedLookups() {
  const [specs, langs, allergies, conditions] = await Promise.all([
    topUp(Specialization, SPECIALIZATIONS, (name) => ({ name, slug: slugify(name) })),
    topUp(Language, LANGUAGES, (name) => ({ name })),
    topUp(Allergy, ALLERGIES, (name) => ({ name })),
    topUp(Condition, CONDITIONS, (name) => ({ name })),
  ]);

  const total = specs + langs + allergies + conditions;
  if (total > 0) {
    console.log(
      `✅ Seeded lookups (+${specs} specializations, +${langs} languages, +${allergies} allergies, +${conditions} conditions)`,
    );
  }
  return { specs, langs, allergies, conditions };
}

module.exports = seedLookups;

// Standalone: `npm run seed:lookups`
if (require.main === module) {
  const { sequelize } = require("../models");
  seedLookups()
    .then(() => sequelize.close())
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("❌ Lookup seed failed:", err);
      process.exit(1);
    });
}
