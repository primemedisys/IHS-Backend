/**
 * The process entry point. Boots in order: connect DB → (dev) sync auth tables
 * → seed admin → listen. Any failure here is fatal, so we exit non-zero rather
 * than serve traffic against a broken dependency.
 */
const env = require("./config/env");
const app = require("./app");
const { sequelize } = require("./models");
const seedAdmin = require("./seeders/admin.seeder");
const cloudStorage = require("./services/cloudinaryStorage.service");
const seedLookups = require("./seeders/lookups.seeder");
const seedSubSpecializations = require("./seeders/subSpecializations.seeder");
const ensureBookingLockKey = require("./db/ensureBookingLockKey");
const ensureRxCounters = require("./db/ensureRxCounters");
const ensureClinicalNoteVitals = require("./db/ensureClinicalNoteVitals");
const ensurePatientProfileColumns = require("./db/ensurePatientProfileColumns");
const ensureReferralColumns = require("./db/ensureReferralColumns");
const ensureVitalsLocation = require("./db/ensureVitalsLocation");
const ensureDoctorShowcaseImage = require("./db/ensureDoctorShowcaseImage");
const ensureDoctorListingToggle = require("./db/ensureDoctorListingToggle");
const ensureDoctorHeroImages = require("./db/ensureDoctorHeroImages");
const ensureDoctorAwardsTestimonials = require("./db/ensureDoctorAwardsTestimonials");
const ensureDoctorPortfolioSections = require("./db/ensureDoctorPortfolioSections");
const ensurePasswordResetOtps = require("./db/ensurePasswordResetOtps");
const ensurePrescriptionDurationUnit = require("./db/ensurePrescriptionDurationUnit");
const ensureBookingRescheduleColumns = require("./db/ensureBookingRescheduleColumns");
const ensureClinicRole = require("./db/ensureClinicRole");
const ensureRecordProvenance = require("./db/ensureRecordProvenance");
const ensureBookingAgency = require("./db/ensureBookingAgency");
const ensureNoCurrentMedications = require("./db/ensureNoCurrentMedications");
const ensureRecordTypes = require("./db/ensureRecordTypes");
const ensureRecordLocation = require("./db/ensureRecordLocation");
const ensureDoctorPatientStatus = require("./db/ensureDoctorPatientStatus");
const ensureFollowUpColumns = require("./db/ensureFollowUpColumns");
const ensureFollowUpReminders = require("./db/ensureFollowUpReminders");
const ensureRecordAdminSource = require("./db/ensureRecordAdminSource");
const ensureQueueColumns = require("./db/ensureQueueColumns");
const ensureMedicines = require("./db/ensureMedicines");
const ensureMedicineId = require("./db/ensureMedicineId");
const ensureCategoryProviderColumns = require("./db/ensureCategoryProviderColumns");
const ensurePrescriptionAvailability = require("./db/ensurePrescriptionAvailability");
const ensureProviderLocation = require("./db/ensureProviderLocation");
const ensureMedicineMaster = require("./db/ensureMedicineMaster");
const ensurePharmacyOrdering = require("./db/ensurePharmacyOrdering");
const ensureMedicineMedia = require("./db/ensureMedicineMedia");
const ensureDiagnosticLab = require("./db/ensureDiagnosticLab");
const ensureBloodBank = require("./db/ensureBloodBank");
const ensureAmbulance = require("./db/ensureAmbulance");
const ensurePharmacyManagement = require("./db/ensurePharmacyManagement");
const ensurePaymentQr = require("./db/ensurePaymentQr");
const ensureDoctorRecordAccess = require("./db/ensureDoctorRecordAccess");
const ensureClinicalRecordConsent = require("./db/ensureClinicalRecordConsent");
const ensureMedicalDocuments = require("./db/ensureMedicalDocuments");
const ensureEmrWorkspace = require("./db/ensureEmrWorkspace");
const ensureClinicalCoding = require("./db/ensureClinicalCoding");
const ensureIcdImportBatches = require("./db/ensureIcdImportBatches");
const ensureRxItemDetails = require("./db/ensureRxItemDetails");
const ensureDoctorMedicineDefaults = require("./db/ensureDoctorMedicineDefaults");
const ensurePatientMedicines = require("./db/ensurePatientMedicines");
const ensureAcquisitionSources = require("./db/ensureAcquisitionSources");
const medicineReminder = require("./services/medicineReminder.service");
const realtime = require("./realtime/socket");
const processDiagnostics = require("./utils/processDiagnostics");
const pdfService = require("./services/prescriptionPdf.service");
const reminderScheduler = require("./services/reminderScheduler.service");

async function start() {
  try {
    await sequelize.authenticate();
    console.log("✅ Database connection established");

    // In development you MAY let Sequelize create the auth tables. In
    // production, prefer running the SQL in docs/dbstruct.md + docs/auth.
    if (env.NODE_ENV === "development") {
      // Add provider-ownership columns to medicine_categories BEFORE sync(),
      // otherwise sync() tries to create an index on columns that don't exist yet.
      await ensureCategoryProviderColumns(sequelize);
      // Pharmacy management (migration 043) BEFORE sync() too: sync() would
      // otherwise create its new tables from the models (without the named
      // keys of the migration). Skipped on a database that has no medicine
      // tables yet — the call after sync() covers that case.
      if (await ensurePharmacyManagement.canRun(sequelize)) await ensurePharmacyManagement(sequelize);
      // Provider UPI QR (migration 044) BEFORE sync() for the same reason: the
      // new table comes from the migration file, not from the model.
      if (await ensurePaymentQr.canRun(sequelize)) await ensurePaymentQr(sequelize);
      // Doctor record-access consent (migration 045) BEFORE sync() so the
      // tables come from the migration SQL (with their FKs), not the models.
      if (await ensureDoctorRecordAccess.canRun(sequelize)) await ensureDoctorRecordAccess(sequelize);
      // ...and its clinical-history categories (migration 057), right after.
      await ensureClinicalRecordConsent(sequelize);
      // Award images + doctor testimonials (migration 048) BEFORE sync() so the
      // new table comes from the migration SQL (with its FK), not the model.
      if (await ensureDoctorAwardsTestimonials.canRun(sequelize)) await ensureDoctorAwardsTestimonials(sequelize);
      // Portfolio affiliations / fellowships / expertise (migration 049) BEFORE
      // sync() so the new tables come from the migration SQL (with their FKs).
      if (await ensureDoctorPortfolioSections.canRun(sequelize)) await ensureDoctorPortfolioSections(sequelize);
      // Password reset by mobile OTP (migration 050) BEFORE sync() so the table
      // comes from the migration SQL (with its phone index), not the model.
      if (await ensurePasswordResetOtps.canRun(sequelize)) await ensurePasswordResetOtps(sequelize);
      // Doctor EMR workspace (migration 051) BEFORE sync() so clinical_entries
      // comes from the migration SQL (with its FKs), and the new vitals /
      // follow-up / prescription columns exist before any model reads them.
      if (await ensureEmrWorkspace.canRun(sequelize)) await ensureEmrWorkspace(sequelize);
      // Migration 059 — icd_codes (with its FKs) before sync() could create it from the model.
      if (await ensureClinicalCoding.canRun(sequelize)) await ensureClinicalCoding(sequelize);
      // Migration 060 — icd_import_batches (with its FK) before sync() could create it from the model.
      if (await ensureIcdImportBatches.canRun(sequelize)) await ensureIcdImportBatches(sequelize);
      // Patient medicine routines (migration 055) BEFORE sync() so the new
      // tables come from the migration SQL, with their foreign keys.
      if (await ensurePatientMedicines.canRun(sequelize)) await ensurePatientMedicines(sequelize);
      // Patient acquisition sources (migration 056), same reason.
      if (await ensureAcquisitionSources.canRun(sequelize)) await ensureAcquisitionSources(sequelize);
      await sequelize.sync();
      // ...and again after sync() for a fresh database whose tables sync() just made.
      await ensureEmrWorkspace(sequelize);
      // Structured strength / dosage form on prescription lines (migration 053).
      await ensureRxItemDetails(sequelize);
      // Default frequency / food direction on "My Medicines" (migration 054).
      await ensureDoctorMedicineDefaults(sequelize);
      // sequelize.sync() can't express the bookings generated lock column — add
      // it after sync so the double-booking guard exists in dev too (prod uses
      // the 005 migration). Idempotent.
      await ensureBookingLockKey(sequelize);
      // rx_counters has no model (raw-SQL upsert only), so sync() skips it.
      await ensureRxCounters(sequelize);
      // sync() won't ALTER an existing clinical_notes to add the vitals columns.
      await ensureClinicalNoteVitals(sequelize);
      // sync() won't ALTER an existing patient_profiles to add the health-record columns.
      await ensurePatientProfileColumns(sequelize);
      // sync() won't ALTER an existing bookings to add the referral link columns.
      await ensureReferralColumns(sequelize);
      // sync() won't ALTER an existing patient_vitals to add the location column.
      await ensureVitalsLocation(sequelize);
      // sync() won't ALTER an existing doctor_profiles to add the showcase image column.
      await ensureDoctorShowcaseImage(sequelize);
      // ...nor the admin listing toggle (is_listed).
      await ensureDoctorListingToggle(sequelize);
      // ...nor the portfolio hero images column / optional clinic coordinates
      // (migrations 046 + 047).
      await ensureDoctorHeroImages(sequelize);
      // ...nor the award issuer/image columns (migration 048).
      await ensureDoctorAwardsTestimonials(sequelize);
      // ...nor the new optional portfolio columns (migration 049).
      await ensureDoctorPortfolioSections(sequelize);
      // ...and the OTP phone index on a table an older boot let sync() create (050).
      await ensurePasswordResetOtps(sequelize);
      // ...nor the medicine duration unit on prescription_items.
      await ensurePrescriptionDurationUnit(sequelize);
      // ...nor the reschedule audit columns on bookings.
      await ensureBookingRescheduleColumns(sequelize);
      // ...nor widen the users.role enum for the clinic portal — without this,
      // every clinic signup fails with a data-truncation error.
      await ensureClinicRole(sequelize);
      // ...nor add the `source` / `recorded_by_user_id` pair to the five record
      // tables, without which every clinic-authored record fails to insert.
      await ensureRecordProvenance(sequelize);
      // ...nor the "booked by" column a clinic booking on a patient's behalf needs.
      await ensureBookingAgency(sequelize);
      // ...nor the "no current medications" flag, without which saving that
      // answer on the Reported-history form fails on an unknown column.
      await ensureNoCurrentMedications(sequelize);
      // ...nor widen uploaded_records.file_type for x-ray / MRI uploads.
      await ensureRecordTypes(sequelize);
      // ...nor uploaded_records.location ("where was this test done").
      await ensureRecordLocation(sequelize);
      // ...nor the My-Patients status table (doctor overrides, migration 023).
      await ensureDoctorPatientStatus(sequelize);
      // ...nor widen uploaded_records.source for admin-authored uploads.
      await ensureRecordAdminSource(sequelize);
      // ...nor the follow-up tables' CURRENT_TIMESTAMP defaults (migration 025)
      // ...nor re-key them on the booking (migration 026).
      await ensureFollowUpColumns(sequelize);
      await ensureFollowUpColumns.ensureFollowUpPerBooking(sequelize);
      // ...nor the follow-up reminders table + WhatsApp opt-in column (migration 029).
      await ensureFollowUpReminders(sequelize);
      // ...nor the doctor medicine master list table + prescription_items.medicine_id column.
      await ensureMedicines(sequelize);
      await ensureMedicineId(sequelize);
      // ...nor the structured provider location columns on users (migration 034).
      await ensureProviderLocation(sequelize);
      console.log("🔄 Models synced (development)");
    }

    // Ensure consultation-queue schema exists in ALL environments (migration 027).
    // Idempotent — each step probes information_schema and returns early.
    await ensureQueueColumns(sequelize);

    // ICD code master + coded diagnoses + prescription clinical snapshot
    // (migration 059). Additive and idempotent in ALL environments: the
    // ClinicalEntry / Prescription models read these columns on every query.
    await ensureClinicalCoding(sequelize);
    // ICD Excel import audit trail (migration 060). Additive, idempotent, ALL envs.
    await ensureIcdImportBatches(sequelize);

    // Prescription availability (migration 033): create prescription_request_items
    // and ALTER medicine_orders. Idempotent, probes information_schema first.
    await ensurePrescriptionAvailability(sequelize);

    // Global medicine master (migration 035): create medicine_masters, add the
    // inventory → master link, and link pre-existing inventory rows. Idempotent
    // and additive (never deletes/merges rows), safe on every boot.
    await ensureMedicineMaster(sequelize);

    // Pharmacy provider types + cart / order group / payment schema
    // (migration 036). Additive and idempotent: it only ever widens an enum
    // with a NEW value or creates a missing table/column, so it is safe on
    // every boot and never touches an existing row.
    await ensurePharmacyOrdering(sequelize);

    // Medicine images + substitutes (migration 037): two new tables hanging
    // off medicine_masters. Additive and idempotent.
    await ensureMedicineMedia(sequelize);

    // Diagnostic Lab Center (migration 038): widen users.role + uploaded_records
    // .source and create the three diagnostic tables. Additive and idempotent;
    // runs LAST so no older enum guard can narrow those enums afterwards.
    await ensureDiagnosticLab(sequelize);

    // Blood Bank (migration 039): widen users.role and create the blood_*
    // tables straight from the migration file. Additive and idempotent; runs
    // after every other users.role guard so none of them can narrow it again.
    await ensureBloodBank(sequelize);

    // Ambulance (migration 040): widen users.role and create the ambulance_*
    // tables straight from the migration file. Additive and idempotent; runs
    // after ensureBloodBank so it is the guard that knows every role value.
    await ensureAmbulance(sequelize);

    // Pharmacy management (migration 043): inventory pricing / GST / reorder
    // columns, batches, the stock ledger, suppliers, purchases, returns and
    // the store profile. Additive and idempotent.
    await ensurePharmacyManagement(sequelize);

    // Provider UPI QR payments (migration 044): the provider_payment_qr table,
    // the payer-report columns, and 'upi_qr' on the medicine payment-method
    // enums. Additive and idempotent; runs after every medicine guard so none
    // of them can narrow those enums again.
    await ensurePaymentQr(sequelize);

    // Doctor record-access consent + access audit log (migration 045). New
    // tables only; additive and idempotent.
    await ensureDoctorRecordAccess(sequelize);
    // Clinical-history consent categories (migration 057). Widens one ENUM; idempotent.
    await ensureClinicalRecordConsent(sequelize);
    // Medical documents (migration 058): 'identity' on uploaded_records.file_type
    // plus nullable document metadata columns. Additive and idempotent; runs
    // after every older uploaded_records guard so none can narrow the ENUM.
    await ensureMedicalDocuments(sequelize);

    // Patient medicine routines, dose tracking, reminder settings + the doctor
    // medicine catalogue link (migration 055). New tables and nullable columns
    // only; additive and idempotent.
    await ensurePatientMedicines(sequelize);

    // "How did you hear about Dr. X?" (migration 056). New tables only; idempotent.
    await ensureAcquisitionSources(sequelize);

    await seedAdmin();
    // The dropdown vocabulary (specialities/languages/allergies/conditions).
    // A fresh database has these empty, which renders the doctor's Specialties
    // step unusable ("No options"). Additive and idempotent, so it is safe on
    // every boot — existing rows are never touched.
    await seedLookups();
    // Sub-specializations depend on specializations being seeded first.
    await seedSubSpecializations();

    // Express 5 calls this callback on a listen ERROR too (with the error), so
    // "listening" used to print even when the port was taken. The error itself
    // is reported (and the process stopped) by processDiagnostics.watchServer.
    const server = app.listen(env.PORT, (err) => {
      if (err) return;
      console.log(`🚀 API listening on http://localhost:${env.PORT}${env.API_PREFIX}`);
    });
    // A port already in use used to crash with a bare, unexplained stack.
    processDiagnostics.watchServer(server, env.PORT);

    // File storage: report the driver, and check Cloudinary credentials without
    // blocking boot (a provider outage must not take the whole API down).
    console.log(`🗂  File storage driver: ${env.STORAGE_DRIVER}`);
    if (env.STORAGE_DRIVER === "cloudinary") {
      if (/localhost|127\.0\.0\.1/.test(env.PUBLIC_URL) && env.NODE_ENV === "production") {
        console.warn("⚠️  PUBLIC_URL points at localhost — private file links sent to clients will not resolve");
      }
      cloudStorage.ping().then((okPing) => {
        if (okPing) console.log(`☁️  Cloudinary reachable (cloud "${env.CLOUDINARY_CLOUD_NAME}", folder "${env.CLOUDINARY_FOLDER}")`);
      });
    }

    // Real-time in-app notifications (Socket.IO on the same port). The
    // database row stays the source of truth; the socket only delivers it live.
    realtime.init(server);

    // Start the automatic follow-up reminder scheduler (docs/follow-up-reminders-07-09-2026).
    // Runs only when REMINDER_SCHEDULER_ENABLED is true (default).
    if (env.REMINDER_SCHEDULER_ENABLED !== false) {
      reminderScheduler.start();
      // Medicine dose reminders / missed marking / course completion (migration 055).
      medicineReminder.start();
    }

    // Prove Chromium actually works on THIS box, at boot, instead of finding out
    // when a doctor clicks "View prescription". Deliberately not awaited and
    // never fatal — the API must still serve everything else if it fails — but
    // it logs a loud ❌ that a deploy check can grep for. Also warms the browser
    // singleton so the first real render skips the ~800ms launch.
    void pdfService.preflight();

    // The prescription renderer keeps a headless Chromium alive for the life of
    // the process. Close it on shutdown or the browser outlives the server.
    const stop = async (signal) => {
      console.log(`\n${signal} received — shutting down`);
      reminderScheduler.stop();
      medicineReminder.stop();
      await realtime.close();
      server.close();
      await pdfService.shutdown();
      process.exit(0);
    };
    process.on("SIGTERM", () => stop("SIGTERM"));
    process.on("SIGINT", () => stop("SIGINT"));
  } catch (err) {
    console.error("❌ Failed to start server:", err);
    process.exit(1);
  }
}

// Fail loud on unexpected errors instead of limping along — and leave one
// structured log line saying why (utils/processDiagnostics).
processDiagnostics.install();

start();
