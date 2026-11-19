/**
 * The model registry. Every model is required through THIS file so associations
 * are wired exactly once, and the rest of the app imports models from here
 * (`const { User } = require("../models")`) rather than reaching into individual
 * files. This is also where `sequelize` is re-exported for transactions.
 */
const sequelize = require("../config/database");

const User = require("./user.model");
const RefreshToken = require("./refreshToken.model");
const PasswordResetToken = require("./passwordResetToken.model");
const PasswordResetOtp = require("./passwordResetOtp.model");
const DoctorProfile = require("./doctorProfile.model");
const PatientProfile = require("./patientProfile.model");
// ── Doctor registration & portfolio ─────────────────────────────────────────
const Specialization = require("./specialization.model");
const SubSpecialization = require("./subSpecialization.model");
const Language = require("./language.model");
const DoctorSpecialization = require("./doctorSpecialization.model");
const DoctorSubSpecialization = require("./doctorSubSpecialization.model");
const DoctorLanguage = require("./doctorLanguage.model");
const DoctorAward = require("./doctorAward.model");
const DoctorTestimonial = require("./doctorTestimonial.model");
const DoctorLink = require("./doctorLink.model");
const DoctorDocument = require("./doctorDocument.model");
const DoctorSearchKeyword = require("./doctorSearchKeyword.model");
// ── Doctor portfolio v2 (full public profile sections) ───────────────────────
const DoctorEducation = require("./doctorEducation.model");
const DoctorExperience = require("./doctorExperience.model");
const DoctorService = require("./doctorService.model");
const DoctorPublication = require("./doctorPublication.model");
const DoctorMembership = require("./doctorMembership.model");
const DoctorGallery = require("./doctorGallery.model");
const DoctorFaq = require("./doctorFaq.model");
// Portfolio affiliations / fellowships / expertise (migration 049).
const DoctorAffiliation = require("./doctorAffiliation.model");
const DoctorFellowship = require("./doctorFellowship.model");
const DoctorExpertise = require("./doctorExpertise.model");
const Insurance = require("./insurance.model");
const DoctorInsurance = require("./doctorInsurance.model");
// ── Clinic portal accounts (an organisation with its own login) ──────────────
const ClinicProfile = require("./clinicProfile.model");
const ClinicDocument = require("./clinicDocument.model");
// ── Clinics & availability (a DOCTOR'S location — unrelated to ClinicProfile) ─
const Clinic = require("./clinic.model");
const ClinicAvailability = require("./clinicAvailability.model");
const DoctorOnlineAvailability = require("./doctorOnlineAvailability.model");
const AvailabilityException = require("./availabilityException.model");
// ── Bookings & payments ──────────────────────────────────────────────────────
const Booking = require("./booking.model");
const ConsultationSession = require("./consultationSession.model");
const Payment = require("./payment.model");
// ── Video consultation ───────────────────────────────────────────────────────
const VideoSession = require("./videoSession.model");
// ── Multi-doctor referrals & care journeys ───────────────────────────────────
const CareJourney = require("./careJourney.model");
const Referral = require("./referral.model");
// ── Prescriptions & configurable letterhead ──────────────────────────────────
const PrescriptionTemplate = require("./prescriptionTemplate.model");
const Prescription = require("./prescription.model");
const PrescriptionItem = require("./prescriptionItem.model");
// ── Doctor medicine master list ──────────────────────────────────────────────
const Medicine = require("./medicine.model");
// ── Clinical notes (doctor consultation log) ─────────────────────────────────
const ClinicalNote = require("./clinicalNote.model");
// ── Patient health records (self-recorded profile + vitals timeline) ─────────
const Allergy = require("./allergy.model");
const Condition = require("./condition.model");
const PatientAllergy = require("./patientAllergy.model");
const PatientCondition = require("./patientCondition.model");
const PatientCurrentMedication = require("./patientCurrentMedication.model");
const UploadedRecord = require("./uploadedRecord.model");
const DoctorPatientStatus = require("./doctorPatientStatus.model");
// ── Doctor-defined follow-up statuses (docs/follow-up-status) ────────────────
const FollowUpStatus = require("./followUpStatus.model");
const PatientFollowUp = require("./patientFollowUp.model");
const PatientVitals = require("./patientVitals.model");
// ── Automatic follow-up reminders (docs/follow-up-reminders-07-09-2026) ─────
const FollowUpReminder = require("./followUpReminder.model");
// ── Public contact form ──────────────────────────────────────────────────────
const ContactMessage = require("./contactMessage.model");
// ── Medicine store & MR module ──────────────────────────────────────────────
const MedicineCategory = require("./medicineCategory.model");
const MedicineMaster = require("./medicineMaster.model");
const MedicineMasterImage = require("./medicineMasterImage.model");
const MedicineMasterSubstitute = require("./medicineMasterSubstitute.model");
const MedicineStoreMedicine = require("./medicineStoreMedicine.model");
const MedicineCartItem = require("./medicineCartItem.model");
const MedicineOrderGroup = require("./medicineOrderGroup.model");
const MedicineOrder = require("./medicineOrder.model");
const MedicinePayment = require("./medicinePayment.model");
const MedicineNotification = require("./medicineNotification.model");
// ── Patient medicine routines + dose tracking (migration 055) ────────────
const PatientMedicine = require("./patientMedicine.model");
const MedicineDoseLog = require("./medicineDoseLog.model");
const MedicineDoseEvent = require("./medicineDoseEvent.model");
const PatientMedicineSettings = require("./patientMedicineSettings.model");
// ── Patient acquisition sources (migration 056) ──────────────────────────
const PatientAcquisitionSource = require("./patientAcquisitionSource.model");
const BookingAcquisitionSource = require("./bookingAcquisitionSource.model");
// ── Pharmacy management (migration 043) ──────────────────────────────────
const PharmacySupplier = require("./pharmacySupplier.model");
const MedicineStockBatch = require("./medicineStockBatch.model");
const MedicineStockMovement = require("./medicineStockMovement.model");
const PharmacyPurchase = require("./pharmacyPurchase.model");
const PharmacyPurchaseItem = require("./pharmacyPurchaseItem.model");
const MedicineReturn = require("./medicineReturn.model");
const MedicineReturnItem = require("./medicineReturnItem.model");
const PharmacyProfile = require("./pharmacyProfile.model");
// ── Provider UPI QR payments (migration 044) ──────────────────────────────
const ProviderPaymentQr = require("./providerPaymentQr.model");
const DoctorAccessRequest = require("./doctorAccessRequest.model");
const DoctorAccessGrantItem = require("./doctorAccessGrantItem.model");
const AccessAuditLog = require("./accessAuditLog.model");
// ── Doctor EMR workspace (migration 051) ──────────────────────────────────
const ClinicalEntry = require("./clinicalEntry.model");
// ── ICD code master (migration 059) ───────────────────────────────────────
const IcdCode = require("./icdCode.model");
// ── ICD Excel import audit trail (migration 060) ──────────────────────────
const IcdImportBatch = require("./icdImportBatch.model");
// ── Patient prescription upload ──────────────────────────────────────────
const PrescriptionRequest = require("./prescriptionRequest.model");
const PrescriptionRequestItem = require("./prescriptionRequestItem.model");
// ── Diagnostic Lab Center (migration 038) ─────────────────────────────────
const DiagnosticTest = require("./diagnosticTest.model");
const DiagnosticRequest = require("./diagnosticRequest.model");
const DiagnosticRequestTest = require("./diagnosticRequestTest.model");
// ── Blood Bank (migration 039) ──────────────────────────────────────────────
const BloodBankProfile = require("./bloodBankProfile.model");
const BloodDonor = require("./bloodDonor.model");
const BloodDonorScreening = require("./bloodDonorScreening.model");
const BloodCamp = require("./bloodCamp.model");
const BloodCampRegistration = require("./bloodCampRegistration.model");
const BloodDonation = require("./bloodDonation.model");
const BloodTest = require("./bloodTest.model");
const BloodUnit = require("./bloodUnit.model");
const BloodRequest = require("./bloodRequest.model");
const BloodReservation = require("./bloodReservation.model");
const BloodCrossmatch = require("./bloodCrossmatch.model");
const BloodIssue = require("./bloodIssue.model");
const BloodAuditLog = require("./bloodAuditLog.model");
// ── Ambulance (migration 040) ───────────────────────────────────────────────
const AmbulanceProviderProfile = require("./ambulanceProviderProfile.model");
const AmbulanceDriver = require("./ambulanceDriver.model");
const Ambulance = require("./ambulance.model");
const AmbulanceBooking = require("./ambulanceBooking.model");
const AmbulanceBookingEvent = require("./ambulanceBookingEvent.model");

// ── Associations ────────────────────────────────────────────────────────────
User.hasMany(RefreshToken, { foreignKey: "userId", as: "refreshTokens", onDelete: "CASCADE" });
RefreshToken.belongsTo(User, { foreignKey: "userId", as: "user" });

User.hasMany(PasswordResetToken, { foreignKey: "userId", as: "resetTokens", onDelete: "CASCADE" });
PasswordResetToken.belongsTo(User, { foreignKey: "userId", as: "user" });
User.hasMany(PasswordResetOtp, { foreignKey: "userId", as: "resetOtps", onDelete: "CASCADE" });
PasswordResetOtp.belongsTo(User, { foreignKey: "userId", as: "user" });

User.hasOne(DoctorProfile, { foreignKey: "userId", as: "doctorProfile", onDelete: "CASCADE" });
DoctorProfile.belongsTo(User, { foreignKey: "userId", as: "user" });

User.hasOne(PatientProfile, { foreignKey: "userId", as: "patientProfile", onDelete: "CASCADE" });
PatientProfile.belongsTo(User, { foreignKey: "userId", as: "user" });

User.hasOne(ClinicProfile, { foreignKey: "userId", as: "clinicProfile", onDelete: "CASCADE" });
ClinicProfile.belongsTo(User, { foreignKey: "userId", as: "user" });

// Verification paperwork. CASCADE is right here (unlike a medical record):
// the document belongs to the account, not to a patient.
ClinicProfile.hasMany(ClinicDocument, { foreignKey: "clinicId", as: "documents", onDelete: "CASCADE" });
ClinicDocument.belongsTo(ClinicProfile, { foreignKey: "clinicId", as: "clinic" });

// ── Doctor portfolio associations ───────────────────────────────────────────
// All FKs point at doctor_profiles.user_id, which is DoctorProfile's PK `userId`.

// M:N specialties & languages (through the junction tables).
DoctorProfile.belongsToMany(Specialization, {
  through: DoctorSpecialization,
  foreignKey: "doctorId",
  otherKey: "specializationId",
  as: "specializations",
});
Specialization.belongsToMany(DoctorProfile, {
  through: DoctorSpecialization,
  foreignKey: "specializationId",
  otherKey: "doctorId",
  as: "doctors",
});

// Sub-specializations: Specialization has many SubSpecializations (1:M).
Specialization.hasMany(SubSpecialization, {
  foreignKey: "specializationId",
  as: "subSpecializations",
  onDelete: "CASCADE",
});
SubSpecialization.belongsTo(Specialization, {
  foreignKey: "specializationId",
  as: "specialization",
});

// M:N doctor ↔ sub-specializations (through the junction table).
DoctorProfile.belongsToMany(SubSpecialization, {
  through: DoctorSubSpecialization,
  foreignKey: "doctorId",
  otherKey: "subSpecializationId",
  as: "subSpecializations",
});
SubSpecialization.belongsToMany(DoctorProfile, {
  through: DoctorSubSpecialization,
  foreignKey: "subSpecializationId",
  otherKey: "doctorId",
  as: "doctors",
});

DoctorProfile.belongsToMany(Language, {
  through: DoctorLanguage,
  foreignKey: "doctorId",
  otherKey: "languageId",
  as: "languages",
});
Language.belongsToMany(DoctorProfile, {
  through: DoctorLanguage,
  foreignKey: "languageId",
  otherKey: "doctorId",
  as: "doctors",
});

// 1:M portfolio + documents.
DoctorProfile.hasMany(DoctorAward, { foreignKey: "doctorId", as: "awards", onDelete: "CASCADE" });
DoctorAward.belongsTo(DoctorProfile, { foreignKey: "doctorId", as: "doctor" });

// Doctor-managed testimonials (migration 048).
DoctorProfile.hasMany(DoctorTestimonial, { foreignKey: "doctorId", as: "testimonials", onDelete: "CASCADE" });
DoctorTestimonial.belongsTo(DoctorProfile, { foreignKey: "doctorId", as: "doctor" });

DoctorProfile.hasMany(DoctorLink, { foreignKey: "doctorId", as: "links", onDelete: "CASCADE" });
DoctorLink.belongsTo(DoctorProfile, { foreignKey: "doctorId", as: "doctor" });

DoctorProfile.hasMany(DoctorDocument, { foreignKey: "doctorId", as: "documents", onDelete: "CASCADE" });
DoctorDocument.belongsTo(DoctorProfile, { foreignKey: "doctorId", as: "doctor" });

DoctorProfile.hasMany(DoctorSearchKeyword, { foreignKey: "doctorId", as: "keywords", onDelete: "CASCADE" });
DoctorSearchKeyword.belongsTo(DoctorProfile, { foreignKey: "doctorId", as: "doctor" });

// ── Doctor portfolio v2 associations ─────────────────────────────────────────
// The 7 new 1:M section tables all hang off doctor_profiles.user_id (`doctorId`).
const portfolioHasMany = (Model, as) => {
  DoctorProfile.hasMany(Model, { foreignKey: "doctorId", as, onDelete: "CASCADE" });
  Model.belongsTo(DoctorProfile, { foreignKey: "doctorId", as: "doctor" });
};
portfolioHasMany(DoctorEducation, "education");
portfolioHasMany(DoctorExperience, "experience");
portfolioHasMany(DoctorService, "services");
portfolioHasMany(DoctorPublication, "publications");
portfolioHasMany(DoctorMembership, "memberships");
portfolioHasMany(DoctorGallery, "gallery");
portfolioHasMany(DoctorFaq, "faqs");
portfolioHasMany(DoctorAffiliation, "affiliations");
portfolioHasMany(DoctorFellowship, "fellowships");
portfolioHasMany(DoctorExpertise, "expertise");

// M:N accepted insurance (mirrors the languages junction).
DoctorProfile.belongsToMany(Insurance, {
  through: DoctorInsurance,
  foreignKey: "doctorId",
  otherKey: "insuranceId",
  as: "insurances",
});
Insurance.belongsToMany(DoctorProfile, {
  through: DoctorInsurance,
  foreignKey: "insuranceId",
  otherKey: "doctorId",
  as: "doctors",
});

// ── Clinics & availability associations ──────────────────────────────────────
// All doctor FKs point at doctor_profiles.user_id (DoctorProfile's PK `userId`).

// Doctor -> many medicines (private master list).
DoctorProfile.hasMany(Medicine, { foreignKey: "doctorId", as: "medicines", onDelete: "CASCADE" });
Medicine.belongsTo(DoctorProfile, { foreignKey: "doctorId", as: "doctor" });

// Doctor -> many clinics (PRD §4.3a).
DoctorProfile.hasMany(Clinic, { foreignKey: "doctorId", as: "clinics", onDelete: "CASCADE" });
Clinic.belongsTo(DoctorProfile, { foreignKey: "doctorId", as: "doctor" });

// Clinic -> many weekly slots (each clinic has its own schedule).
Clinic.hasMany(ClinicAvailability, { foreignKey: "clinicId", as: "availability", onDelete: "CASCADE" });
ClinicAvailability.belongsTo(Clinic, { foreignKey: "clinicId", as: "clinic" });

// Doctor -> many online/video slots (independent of any clinic).
DoctorProfile.hasMany(DoctorOnlineAvailability, {
  foreignKey: "doctorId",
  as: "onlineAvailability",
  onDelete: "CASCADE",
});
DoctorOnlineAvailability.belongsTo(DoctorProfile, { foreignKey: "doctorId", as: "doctor" });

// Doctor -> many blocked-date exceptions, optionally scoped to a clinic.
DoctorProfile.hasMany(AvailabilityException, {
  foreignKey: "doctorId",
  as: "exceptions",
  onDelete: "CASCADE",
});
AvailabilityException.belongsTo(DoctorProfile, { foreignKey: "doctorId", as: "doctor" });
AvailabilityException.belongsTo(Clinic, { foreignKey: "clinicId", as: "clinic" });

// ── Bookings & payments associations ─────────────────────────────────────────
// A booking's patient is a User (users.id); its doctor is a DoctorProfile
// (doctor_profiles.user_id); its clinic is nullable (NULL = video consult).
User.hasMany(Booking, { foreignKey: "patientId", as: "bookings" });
Booking.belongsTo(User, { foreignKey: "patientId", as: "patient" });

DoctorProfile.hasMany(Booking, { foreignKey: "doctorId", as: "bookings" });
Booking.belongsTo(DoctorProfile, { foreignKey: "doctorId", as: "doctor" });

Booking.belongsTo(Clinic, { foreignKey: "clinicId", as: "clinic" });

// A session is a doctor's consulting window at one place on one day; its
// bookings are the queue that formed inside it, ordered by token.
ConsultationSession.hasMany(Booking, { foreignKey: "sessionId", as: "queue" });
Booking.belongsTo(ConsultationSession, { foreignKey: "sessionId", as: "session" });
DoctorProfile.hasMany(ConsultationSession, { foreignKey: "doctorId", as: "sessions" });
ConsultationSession.belongsTo(DoctorProfile, { foreignKey: "doctorId", as: "doctor" });
Clinic.hasMany(ConsultationSession, { foreignKey: "clinicId", as: "sessions" });
ConsultationSession.belongsTo(Clinic, { foreignKey: "clinicId", as: "clinic" });
// NOTE: deliberately NO ConsultationSession.belongsTo(Booking) for
// current_booking_id. It would close a cycle with bookings.session_id and break
// Sequelize's sync ordering — the same hazard documented for Booking <-> Referral
// below. The service reads the current booking by id when it needs it.

// Payment is 1:1 with a booking.
Booking.hasOne(Payment, { foreignKey: "bookingId", as: "payment", onDelete: "CASCADE" });
Payment.belongsTo(Booking, { foreignKey: "bookingId", as: "booking" });

// A video consult has 0/1 runtime session (LiveKit lifecycle). One-directional
// FK (video_sessions.booking_id → bookings.id) — no cycle, unlike Booking↔Referral.
Booking.hasOne(VideoSession, { foreignKey: "bookingId", as: "videoSession", onDelete: "CASCADE" });
VideoSession.belongsTo(Booking, { foreignKey: "bookingId", as: "booking" });

// ── Multi-doctor referral & care-journey associations ────────────────────────
// A patient has many care journeys; a journey has many bookings (the ordered
// consultations) + many referral edges. All doctor FKs point at
// doctor_profiles.user_id, patient FKs at users.id.
User.hasMany(CareJourney, { foreignKey: "patientId", as: "careJourneys", onDelete: "CASCADE" });
CareJourney.belongsTo(User, { foreignKey: "patientId", as: "patient" });
CareJourney.belongsTo(DoctorProfile, { foreignKey: "originDoctorId", as: "originDoctor" });
CareJourney.belongsTo(Clinic, { foreignKey: "originClinicId", as: "originClinic" });

CareJourney.hasMany(Booking, { foreignKey: "journeyId", as: "consultations" });
Booking.belongsTo(CareJourney, { foreignKey: "journeyId", as: "journey" });

CareJourney.hasMany(Referral, { foreignKey: "journeyId", as: "referrals", onDelete: "CASCADE" });
Referral.belongsTo(CareJourney, { foreignKey: "journeyId", as: "journey" });

// A referral: patient + from/to doctor + source/target booking. The two
// DoctorProfile belongsTo need distinct aliases; the two Booking belongsTo too.
Referral.belongsTo(User, { foreignKey: "patientId", as: "patient" });
Referral.belongsTo(DoctorProfile, { foreignKey: "fromDoctorId", as: "fromDoctor" });
Referral.belongsTo(DoctorProfile, { foreignKey: "toDoctorId", as: "toDoctor" });
Referral.belongsTo(Booking, { foreignKey: "sourceBookingId", as: "sourceBooking" });
Referral.belongsTo(Booking, { foreignKey: "targetBookingId", as: "targetBooking" });

// NOTE: we deliberately do NOT declare `Booking.belongsTo(Referral)` here.
// bookings.referral_id → referrals.id combined with referrals.source/target_booking_id
// → bookings.id is a CYCLIC foreign-key reference, which forces Sequelize's
// dev-only `sequelize.sync()` down its _syncModelsWithCyclicReferences path
// (it drops + re-adds every FK in the schema, aborting boot if any legacy table
// has orphan rows). The `referralId` column still exists on the Booking model,
// and the prod migration (011) defines the FK — we just don't need the reverse
// association in code (nothing reads `booking.incomingReferral`).

// ── Prescription associations ────────────────────────────────────────────────
// A template belongs to a doctor and (optionally) one of their clinics.
DoctorProfile.hasMany(PrescriptionTemplate, {
  foreignKey: "doctorId",
  as: "prescriptionTemplates",
  onDelete: "CASCADE",
});
PrescriptionTemplate.belongsTo(DoctorProfile, { foreignKey: "doctorId", as: "doctor" });
PrescriptionTemplate.belongsTo(Clinic, { foreignKey: "clinicId", as: "clinic" });

// A booking has many prescriptions only in the versioning sense (v1 superseded
// by v2). The app treats the newest non-superseded one as "the" prescription.
Booking.hasMany(Prescription, { foreignKey: "bookingId", as: "prescriptions" });
Prescription.belongsTo(Booking, { foreignKey: "bookingId", as: "booking" });

DoctorProfile.hasMany(Prescription, { foreignKey: "doctorId", as: "prescriptions" });
Prescription.belongsTo(DoctorProfile, { foreignKey: "doctorId", as: "doctor" });

User.hasMany(Prescription, { foreignKey: "patientId", as: "prescriptions" });
Prescription.belongsTo(User, { foreignKey: "patientId", as: "patient" });

Prescription.belongsTo(Clinic, { foreignKey: "clinicId", as: "clinic" });
Prescription.belongsTo(PrescriptionTemplate, { foreignKey: "templateId", as: "template" });
Prescription.belongsTo(Prescription, { foreignKey: "parentPrescriptionId", as: "parent" });

Prescription.hasMany(PrescriptionItem, {
  foreignKey: "prescriptionId",
  as: "items",
  onDelete: "CASCADE",
});
PrescriptionItem.belongsTo(Prescription, { foreignKey: "prescriptionId", as: "prescription" });

// ── Clinical note associations ───────────────────────────────────────────────
// Patient-wide log: `patientId`/`doctorId` are both users.id (the doctor's is
// also its doctor_profiles.user_id), so the author joins back to User by doctorId.
User.hasMany(ClinicalNote, { foreignKey: "patientId", as: "clinicalNotes", onDelete: "CASCADE" });
ClinicalNote.belongsTo(User, { foreignKey: "patientId", as: "patient" });
ClinicalNote.belongsTo(User, { foreignKey: "doctorId", as: "author" });
ClinicalNote.belongsTo(Booking, { foreignKey: "bookingId", as: "booking" });

// ── Record provenance (migration 018) ────────────────────────────────────────
// "Who wrote this?" — the author's users.id on every medical record, so the
// source chip can show a name. `constraints: false` on the association is NOT
// used: the FK is real, but it is ON DELETE SET NULL, so `recordedBy` can be
// null on a row whose author account was deleted. The record outlives it.
ClinicalNote.belongsTo(User, { foreignKey: "recordedByUserId", as: "recordedBy" });
PatientVitals.belongsTo(User, { foreignKey: "recordedByUserId", as: "recordedBy" });

// ── Doctor EMR structured entries (migration 051) ──────────────────────────
// Author / editor / visit are ON DELETE SET NULL in the migration: an entry
// outlives the account that wrote it and the booking it was written in.
User.hasMany(ClinicalEntry, { foreignKey: "patientId", as: "clinicalEntries", onDelete: "CASCADE" });
ClinicalEntry.belongsTo(User, { foreignKey: "patientId", as: "patient" });
ClinicalEntry.belongsTo(User, { foreignKey: "doctorId", as: "author" });
ClinicalEntry.belongsTo(User, { foreignKey: "updatedBy", as: "editor" });
ClinicalEntry.belongsTo(Booking, { foreignKey: "bookingId", as: "booking" });
// Migration 059 — the catalogue row a diagnosis was coded from (ON DELETE SET NULL;
// the entry keeps its own code snapshot either way).
ClinicalEntry.belongsTo(IcdCode, { foreignKey: "icdCodeId", as: "icdCode" });
IcdImportBatch.belongsTo(User, { foreignKey: "importedBy", as: "importer", constraints: false });

// ── Follow-up statuses ───────────────────────────────────────────────────────
// No CASCADE from FollowUpStatus → PatientFollowUp on purpose: deleting a
// status that patients still carry must FAIL, not silently untag them.
User.hasMany(FollowUpStatus, { foreignKey: "doctorId", as: "followUpStatuses", onDelete: "CASCADE" });
FollowUpStatus.belongsTo(User, { foreignKey: "doctorId", as: "doctor" });
FollowUpStatus.hasMany(PatientFollowUp, { foreignKey: "statusId", as: "assignments" });
PatientFollowUp.belongsTo(FollowUpStatus, { foreignKey: "statusId", as: "status" });
PatientFollowUp.belongsTo(User, { foreignKey: "patientId", as: "patient" });
PatientFollowUp.belongsTo(User, { foreignKey: "doctorId", as: "doctor" });
// ── Automatic follow-up reminders (docs/follow-up-reminders-07-09-2026) ─────
Booking.hasOne(FollowUpReminder, { foreignKey: "bookingId", as: "reminder", onDelete: "CASCADE" });
FollowUpReminder.belongsTo(Booking, { foreignKey: "bookingId", as: "booking" });
FollowUpReminder.belongsTo(User, { foreignKey: "doctorId", as: "doctor" });
FollowUpReminder.belongsTo(User, { foreignKey: "patientId", as: "patient" });
FollowUpReminder.belongsTo(Clinic, { foreignKey: "clinicId", as: "clinic" });
UploadedRecord.belongsTo(User, { foreignKey: "recordedByUserId", as: "recordedBy" });
PatientAllergy.belongsTo(User, { foreignKey: "recordedByUserId", as: "recordedBy" });
PatientCondition.belongsTo(User, { foreignKey: "recordedByUserId", as: "recordedBy" });

// Who CREATED a booking, when it wasn't the patient (migration 019). NULL for
// every direct patient→doctor booking, which is unchanged by this feature.
Booking.belongsTo(User, { foreignKey: "bookedByUserId", as: "bookedBy" });

// ── Patient health records associations ──────────────────────────────────────
// Allergies/conditions are M:N via junctions that carry the per-patient extra
// (severity / diagnosed year); the junction FK is patient_profiles.user_id.
PatientProfile.belongsToMany(Allergy, {
  through: PatientAllergy,
  foreignKey: "patientId",
  otherKey: "allergyId",
  as: "allergies",
});
Allergy.belongsToMany(PatientProfile, {
  through: PatientAllergy,
  foreignKey: "allergyId",
  otherKey: "patientId",
  as: "patients",
});
PatientProfile.belongsToMany(Condition, {
  through: PatientCondition,
  foreignKey: "patientId",
  otherKey: "conditionId",
  as: "conditions",
});
Condition.belongsToMany(PatientProfile, {
  through: PatientCondition,
  foreignKey: "conditionId",
  otherKey: "patientId",
  as: "patients",
});

// Junction → lookup belongsTo, so a list read can join the name in one query.
PatientAllergy.belongsTo(Allergy, { foreignKey: "allergyId", as: "allergy" });
PatientCondition.belongsTo(Condition, { foreignKey: "conditionId", as: "condition" });

// Current medications + vitals timeline are 1:M off patient_profiles.user_id.
PatientProfile.hasMany(PatientCurrentMedication, { foreignKey: "patientId", as: "medications", onDelete: "CASCADE" });
PatientCurrentMedication.belongsTo(PatientProfile, { foreignKey: "patientId", as: "patient" });
PatientProfile.hasMany(PatientVitals, { foreignKey: "patientId", as: "vitals", onDelete: "CASCADE" });
PatientVitals.belongsTo(PatientProfile, { foreignKey: "patientId", as: "patient" });

// Uploaded records FK users.id (docs/dbstruct.md §16), so they hang off User.
User.hasMany(UploadedRecord, { foreignKey: "patientId", as: "uploadedRecords", onDelete: "CASCADE" });
UploadedRecord.belongsTo(User, { foreignKey: "patientId", as: "patient" });

// ── Medicine store & MR module associations ─────────────────────────────────
// Medicine belongs to a category (nullable).
MedicineStoreMedicine.belongsTo(MedicineCategory, { foreignKey: "categoryId", as: "category" });
MedicineCategory.hasMany(MedicineStoreMedicine, { foreignKey: "categoryId", as: "medicines" });

// Global medicine catalogue (migration 035): a master belongs to a category and
// is sold by many providers, each through their own inventory row.
MedicineMaster.belongsTo(MedicineCategory, { foreignKey: "categoryId", as: "category" });
MedicineCategory.hasMany(MedicineMaster, { foreignKey: "categoryId", as: "masters" });
MedicineStoreMedicine.belongsTo(MedicineMaster, { foreignKey: "medicineMasterId", as: "master" });
MedicineMaster.hasMany(MedicineStoreMedicine, { foreignKey: "medicineMasterId", as: "inventories" });

// Medicine images + substitutes (migration 037) — both belong to the GLOBAL
// master. A substitute is another master (self-referencing M:N through
// medicine_master_substitutes), never a copied medicine.
MedicineMaster.hasMany(MedicineMasterImage, { foreignKey: "medicineMasterId", as: "images", onDelete: "CASCADE" });
MedicineMasterImage.belongsTo(MedicineMaster, { foreignKey: "medicineMasterId", as: "master" });
MedicineMaster.hasMany(MedicineMasterSubstitute, { foreignKey: "medicineMasterId", as: "substituteLinks", onDelete: "CASCADE" });
MedicineMasterSubstitute.belongsTo(MedicineMaster, { foreignKey: "medicineMasterId", as: "master" });
MedicineMasterSubstitute.belongsTo(MedicineMaster, { foreignKey: "substituteMasterId", as: "substitute" });

// A medicine listing is published by a provider user (MR / Medicine Store).
MedicineStoreMedicine.belongsTo(User, { foreignKey: "providerId", as: "provider" });
User.hasMany(MedicineStoreMedicine, { foreignKey: "providerId", as: "medicineStoreMedicines" });

// A medicine order references a specific medicine listing.
MedicineOrder.belongsTo(MedicineStoreMedicine, { foreignKey: "medicineId", as: "medicine" });
MedicineStoreMedicine.hasMany(MedicineOrder, { foreignKey: "medicineId", as: "orders" });

// Order belongs to a patient (User).
User.hasMany(MedicineOrder, { foreignKey: "patientId", as: "medicineOrders" });
MedicineOrder.belongsTo(User, { foreignKey: "patientId", as: "patient" });

// ── Cart (migration 036) ────────────────────────────────────────────────
// A cart line is one patient holding one provider inventory row. The line
// carries no price: `medicine` is the single source of price and stock.
User.hasMany(MedicineCartItem, { foreignKey: "patientId", as: "cartItems", onDelete: "CASCADE" });
MedicineCartItem.belongsTo(User, { foreignKey: "patientId", as: "patient" });
MedicineCartItem.belongsTo(MedicineStoreMedicine, { foreignKey: "medicineId", as: "medicine" });
MedicineStoreMedicine.hasMany(MedicineCartItem, { foreignKey: "medicineId", as: "cartItems", onDelete: "CASCADE" });
MedicineCartItem.belongsTo(PrescriptionRequest, {
  foreignKey: "prescriptionRequestId",
  as: "prescriptionRequest",
});

// ── Order group / bill (migration 036) ──────────────────────────────────
// One checkout against one pharmacy. The existing per-medicine MedicineOrder
// rows are its lines, so nothing about the provider's order management moved.
User.hasMany(MedicineOrderGroup, { foreignKey: "patientId", as: "medicineOrderGroups" });
MedicineOrderGroup.belongsTo(User, { foreignKey: "patientId", as: "patient" });
User.hasMany(MedicineOrderGroup, { foreignKey: "providerId", as: "providerOrderGroups" });
MedicineOrderGroup.belongsTo(User, { foreignKey: "providerId", as: "provider" });

MedicineOrderGroup.hasMany(MedicineOrder, { foreignKey: "orderGroupId", as: "items" });
MedicineOrder.belongsTo(MedicineOrderGroup, { foreignKey: "orderGroupId", as: "group" });

MedicineOrderGroup.belongsTo(PrescriptionRequest, {
  foreignKey: "prescriptionRequestId",
  as: "prescriptionRequest",
});
PrescriptionRequest.hasMany(MedicineOrderGroup, {
  foreignKey: "prescriptionRequestId",
  as: "orderGroups",
  onDelete: "SET NULL",
});

// A group's payment attempts (simulated in this phase).
MedicineOrderGroup.hasMany(MedicinePayment, {
  foreignKey: "orderGroupId",
  as: "payments",
  onDelete: "CASCADE",
});
MedicinePayment.belongsTo(MedicineOrderGroup, { foreignKey: "orderGroupId", as: "group" });

// Notifications belong to a user.
User.hasMany(MedicineNotification, { foreignKey: "userId", as: "medicineNotifications" });
MedicineNotification.belongsTo(User, { foreignKey: "userId", as: "user" });

// ── Patient medicine routines (migration 055) ─────────────────────────────
User.hasMany(PatientMedicine, { foreignKey: "patientId", as: "patientMedicines", onDelete: "CASCADE" });
PatientMedicine.belongsTo(User, { foreignKey: "patientId", as: "patient" });
PatientMedicine.belongsTo(User, { foreignKey: "prescribedBy", as: "prescriber" });
PatientMedicine.belongsTo(Prescription, { foreignKey: "prescriptionId", as: "prescription" });
PatientMedicine.belongsTo(MedicineMaster, { foreignKey: "medicineMasterId", as: "master" });
PatientMedicine.hasMany(MedicineDoseLog, { foreignKey: "patientMedicineId", as: "doses", onDelete: "CASCADE" });
MedicineDoseLog.belongsTo(PatientMedicine, { foreignKey: "patientMedicineId", as: "medicine" });
MedicineDoseLog.hasMany(MedicineDoseEvent, { foreignKey: "doseLogId", as: "events", onDelete: "CASCADE" });
MedicineDoseEvent.belongsTo(MedicineDoseLog, { foreignKey: "doseLogId", as: "dose" });
User.hasOne(PatientMedicineSettings, { foreignKey: "patientId", as: "medicineSettings", onDelete: "CASCADE" });

// ── Patient acquisition sources (migration 056) ───────────────────────────
PatientAcquisitionSource.belongsTo(User, { foreignKey: "patientId", as: "patient" });
PatientAcquisitionSource.belongsTo(User, { foreignKey: "doctorId", as: "doctor" });
Booking.hasOne(BookingAcquisitionSource, { foreignKey: "bookingId", as: "acquisition", onDelete: "CASCADE" });
BookingAcquisitionSource.belongsTo(Booking, { foreignKey: "bookingId", as: "booking" });
Medicine.belongsTo(MedicineMaster, { foreignKey: "medicineMasterId", as: "master" });

// ── Pharmacy management associations (migration 043) ─────────────────────
// Suppliers, batches, the stock ledger, purchases, returns and the store
// profile all belong to ONE pharmacy (a provider `users` row) and hang off its
// existing inventory rows — no second medicine or inventory table.
User.hasMany(PharmacySupplier, { foreignKey: "providerId", as: "pharmacySuppliers", onDelete: "CASCADE" });
PharmacySupplier.belongsTo(User, { foreignKey: "providerId", as: "provider" });
MedicineStoreMedicine.belongsTo(PharmacySupplier, { foreignKey: "supplierId", as: "supplier" });

MedicineStoreMedicine.hasMany(MedicineStockBatch, { foreignKey: "inventoryId", as: "batches", onDelete: "CASCADE" });
MedicineStockBatch.belongsTo(MedicineStoreMedicine, { foreignKey: "inventoryId", as: "inventory" });
MedicineStockBatch.belongsTo(PharmacySupplier, { foreignKey: "supplierId", as: "supplier" });

MedicineStoreMedicine.hasMany(MedicineStockMovement, { foreignKey: "inventoryId", as: "stockMovements", onDelete: "CASCADE" });
MedicineStockMovement.belongsTo(MedicineStoreMedicine, { foreignKey: "inventoryId", as: "inventory" });
MedicineStockMovement.belongsTo(MedicineStockBatch, { foreignKey: "batchId", as: "batch" });

User.hasMany(PharmacyPurchase, { foreignKey: "providerId", as: "pharmacyPurchases", onDelete: "CASCADE" });
PharmacyPurchase.belongsTo(User, { foreignKey: "providerId", as: "provider" });
PharmacyPurchase.belongsTo(PharmacySupplier, { foreignKey: "supplierId", as: "supplier" });
PharmacySupplier.hasMany(PharmacyPurchase, { foreignKey: "supplierId", as: "purchases" });
PharmacyPurchase.hasMany(PharmacyPurchaseItem, { foreignKey: "purchaseId", as: "items", onDelete: "CASCADE" });
PharmacyPurchaseItem.belongsTo(PharmacyPurchase, { foreignKey: "purchaseId", as: "purchase" });
PharmacyPurchaseItem.belongsTo(MedicineStoreMedicine, { foreignKey: "inventoryId", as: "inventory" });
PharmacyPurchaseItem.belongsTo(MedicineStockBatch, { foreignKey: "batchId", as: "batch" });

MedicineOrderGroup.hasMany(MedicineReturn, { foreignKey: "orderGroupId", as: "returns", onDelete: "CASCADE" });
MedicineReturn.belongsTo(MedicineOrderGroup, { foreignKey: "orderGroupId", as: "group" });
MedicineReturn.belongsTo(User, { foreignKey: "patientId", as: "patient" });
MedicineReturn.hasMany(MedicineReturnItem, { foreignKey: "returnId", as: "items", onDelete: "CASCADE" });
MedicineReturnItem.belongsTo(MedicineReturn, { foreignKey: "returnId", as: "return" });
MedicineOrder.hasMany(MedicineReturnItem, { foreignKey: "orderLineId", as: "returnItems" });
MedicineReturnItem.belongsTo(MedicineOrder, { foreignKey: "orderLineId", as: "orderLine" });

User.hasOne(PharmacyProfile, { foreignKey: "providerId", as: "pharmacyProfile", onDelete: "CASCADE" });
PharmacyProfile.belongsTo(User, { foreignKey: "providerId", as: "provider" });

// A provider's own UPI QR (doctor / medicine store / pharmacy hospital), one row per user.
User.hasOne(ProviderPaymentQr, { foreignKey: "userId", as: "paymentQr", onDelete: "CASCADE" });
ProviderPaymentQr.belongsTo(User, { foreignKey: "userId", as: "user" });

// ── Doctor record-access consent (migration 045) ────────────────────────────
DoctorAccessRequest.belongsTo(User, { foreignKey: "doctorId", as: "doctor" });
DoctorAccessRequest.belongsTo(User, { foreignKey: "patientId", as: "patient" });
DoctorAccessRequest.hasMany(DoctorAccessGrantItem, { foreignKey: "requestId", as: "items", onDelete: "CASCADE" });
DoctorAccessGrantItem.belongsTo(DoctorAccessRequest, { foreignKey: "requestId", as: "request" });
DoctorAccessGrantItem.belongsTo(UploadedRecord, { foreignKey: "recordId", as: "record" });

// ── Prescription request associations ────────────────────────────────────
User.hasMany(PrescriptionRequest, { foreignKey: "patientId", as: "prescriptionRequests" });
PrescriptionRequest.belongsTo(User, { foreignKey: "patientId", as: "patient" });
User.hasMany(PrescriptionRequest, { foreignKey: "providerId", as: "providerPrescriptions" });
PrescriptionRequest.belongsTo(User, { foreignKey: "providerId", as: "provider" });

// A request carries the provider's per-medicine availability answers.
PrescriptionRequest.hasMany(PrescriptionRequestItem, {
  foreignKey: "prescriptionRequestId",
  as: "items",
  onDelete: "CASCADE",
});
PrescriptionRequestItem.belongsTo(PrescriptionRequest, {
  foreignKey: "prescriptionRequestId",
  as: "request",
});

// An available item points back at the provider's own listing.
PrescriptionRequestItem.belongsTo(MedicineStoreMedicine, { foreignKey: "medicineId", as: "medicine" });
MedicineStoreMedicine.hasMany(PrescriptionRequestItem, { foreignKey: "medicineId", as: "prescriptionItems" });

// An order placed off a shared prescription carries the request id (migration 033).
PrescriptionRequest.hasMany(MedicineOrder, {
  foreignKey: "prescriptionRequestId",
  as: "orders",
  onDelete: "SET NULL",
});
MedicineOrder.belongsTo(PrescriptionRequest, {
  foreignKey: "prescriptionRequestId",
  as: "prescriptionRequest",
});

// ── Diagnostic Lab associations (migration 038) ──────────────────────────
// A lab's own test catalogue.
User.hasMany(DiagnosticTest, { foreignKey: "labId", as: "diagnosticTests", onDelete: "CASCADE" });
DiagnosticTest.belongsTo(User, { foreignKey: "labId", as: "lab" });

// A request is one patient → one lab.
User.hasMany(DiagnosticRequest, { foreignKey: "patientId", as: "diagnosticRequests" });
DiagnosticRequest.belongsTo(User, { foreignKey: "patientId", as: "patient" });
User.hasMany(DiagnosticRequest, { foreignKey: "labId", as: "labDiagnosticRequests" });
DiagnosticRequest.belongsTo(User, { foreignKey: "labId", as: "lab" });

// The lab's per-test answers (+ the patient's selection and the report link).
DiagnosticRequest.hasMany(DiagnosticRequestTest, {
  foreignKey: "diagnosticRequestId",
  as: "tests",
  onDelete: "CASCADE",
});
DiagnosticRequestTest.belongsTo(DiagnosticRequest, { foreignKey: "diagnosticRequestId", as: "request" });
DiagnosticRequestTest.belongsTo(DiagnosticTest, { foreignKey: "diagnosticTestId", as: "catalogTest" });
DiagnosticTest.hasMany(DiagnosticRequestTest, { foreignKey: "diagnosticTestId", as: "requestTests" });

// The report is a row in the patient's EXISTING medical records.
DiagnosticRequestTest.belongsTo(UploadedRecord, { foreignKey: "reportRecordId", as: "report" });
UploadedRecord.hasMany(DiagnosticRequestTest, { foreignKey: "reportRecordId", as: "diagnosticTests" });

// ── Blood Bank associations (migration 039) ─────────────────────────────────
// The bank's own profile (PK-is-the-FK, like ClinicProfile).
User.hasOne(BloodBankProfile, { foreignKey: "userId", as: "bloodBankProfile", onDelete: "CASCADE" });
BloodBankProfile.belongsTo(User, { foreignKey: "userId", as: "user" });

// Donors belong to the bank that registered them (optionally linked to a patient account).
BloodDonor.belongsTo(User, { foreignKey: "bloodBankId", as: "bloodBank" });
BloodDonor.belongsTo(User, { foreignKey: "patientUserId", as: "patientUser" });
BloodDonor.hasMany(BloodDonorScreening, { foreignKey: "donorId", as: "screenings", onDelete: "CASCADE" });
BloodDonorScreening.belongsTo(BloodDonor, { foreignKey: "donorId", as: "donor" });
BloodDonor.hasMany(BloodDonation, { foreignKey: "donorId", as: "donations", onDelete: "CASCADE" });
BloodDonation.belongsTo(BloodDonor, { foreignKey: "donorId", as: "donor" });
BloodDonation.belongsTo(BloodDonorScreening, { foreignKey: "screeningId", as: "screening" });
BloodDonation.belongsTo(BloodCamp, { foreignKey: "campId", as: "camp" });

// Lab results on the donation sample, and the units made from the donation.
BloodDonation.hasMany(BloodTest, { foreignKey: "donationId", as: "tests", onDelete: "CASCADE" });
BloodTest.belongsTo(BloodDonation, { foreignKey: "donationId", as: "donation" });
BloodDonation.hasMany(BloodUnit, { foreignKey: "donationId", as: "units", onDelete: "CASCADE" });
BloodUnit.belongsTo(BloodDonation, { foreignKey: "donationId", as: "donation" });
BloodUnit.belongsTo(BloodDonor, { foreignKey: "donorId", as: "donor" });
BloodUnit.belongsTo(BloodUnit, { foreignKey: "parentUnitId", as: "parentUnit" });
BloodUnit.hasMany(BloodUnit, { foreignKey: "parentUnitId", as: "childUnits" });

// Requests: patient -> bank (+ optional referring doctor).
BloodRequest.belongsTo(User, { foreignKey: "patientId", as: "patient" });
BloodRequest.belongsTo(User, { foreignKey: "bloodBankId", as: "bloodBank" });
BloodRequest.belongsTo(User, { foreignKey: "referredByDoctorId", as: "referredByDoctor" });
BloodRequest.hasMany(BloodReservation, { foreignKey: "requestId", as: "reservations", onDelete: "CASCADE" });
BloodReservation.belongsTo(BloodRequest, { foreignKey: "requestId", as: "request" });
BloodReservation.belongsTo(BloodUnit, { foreignKey: "unitId", as: "unit" });
BloodUnit.hasMany(BloodReservation, { foreignKey: "unitId", as: "reservations" });
BloodRequest.hasMany(BloodCrossmatch, { foreignKey: "requestId", as: "crossmatches", onDelete: "CASCADE" });
BloodCrossmatch.belongsTo(BloodRequest, { foreignKey: "requestId", as: "request" });
BloodCrossmatch.belongsTo(BloodUnit, { foreignKey: "unitId", as: "unit" });
BloodCrossmatch.belongsTo(BloodReservation, { foreignKey: "reservationId", as: "reservation" });
BloodRequest.hasMany(BloodIssue, { foreignKey: "requestId", as: "issues", onDelete: "CASCADE" });
BloodIssue.belongsTo(BloodRequest, { foreignKey: "requestId", as: "request" });
BloodIssue.belongsTo(BloodUnit, { foreignKey: "unitId", as: "unit" });
BloodIssue.belongsTo(BloodCrossmatch, { foreignKey: "crossmatchId", as: "crossmatch" });
BloodIssue.belongsTo(BloodReservation, { foreignKey: "reservationId", as: "reservation" });

// Camps + patient registrations.
BloodCamp.belongsTo(User, { foreignKey: "bloodBankId", as: "bloodBank" });
BloodCamp.hasMany(BloodCampRegistration, { foreignKey: "campId", as: "registrations", onDelete: "CASCADE" });
BloodCampRegistration.belongsTo(BloodCamp, { foreignKey: "campId", as: "camp" });
BloodCampRegistration.belongsTo(User, { foreignKey: "patientId", as: "patient" });

BloodAuditLog.belongsTo(User, { foreignKey: "actorUserId", as: "actor" });

// ── Ambulance associations (migration 040) ──────────────────────────────────
// The provider's organisation profile (PK-is-the-FK, like BloodBankProfile).
User.hasOne(AmbulanceProviderProfile, { foreignKey: "userId", as: "ambulanceProviderProfile", onDelete: "CASCADE" });
AmbulanceProviderProfile.belongsTo(User, { foreignKey: "userId", as: "user" });

// Vehicles + drivers belong to the provider account.
User.hasMany(Ambulance, { foreignKey: "providerId", as: "ambulances", onDelete: "CASCADE" });
Ambulance.belongsTo(User, { foreignKey: "providerId", as: "provider" });
User.hasMany(AmbulanceDriver, { foreignKey: "providerId", as: "ambulanceDrivers", onDelete: "CASCADE" });
AmbulanceDriver.belongsTo(User, { foreignKey: "providerId", as: "provider" });
Ambulance.belongsTo(AmbulanceDriver, { foreignKey: "defaultDriverId", as: "defaultDriver" });

// Bookings: patient -> provider's ambulance (+ assigned driver), with a status history.
AmbulanceBooking.belongsTo(User, { foreignKey: "patientId", as: "patient" });
AmbulanceBooking.belongsTo(User, { foreignKey: "providerId", as: "provider" });
AmbulanceBooking.belongsTo(Ambulance, { foreignKey: "ambulanceId", as: "ambulance" });
Ambulance.hasMany(AmbulanceBooking, { foreignKey: "ambulanceId", as: "bookings" });
AmbulanceBooking.belongsTo(AmbulanceDriver, { foreignKey: "driverId", as: "driver" });
AmbulanceDriver.hasMany(AmbulanceBooking, { foreignKey: "driverId", as: "bookings" });
AmbulanceBooking.hasMany(AmbulanceBookingEvent, { foreignKey: "bookingId", as: "events", onDelete: "CASCADE" });
AmbulanceBookingEvent.belongsTo(AmbulanceBooking, { foreignKey: "bookingId", as: "booking" });
AmbulanceBookingEvent.belongsTo(User, { foreignKey: "actorUserId", as: "actor" });

module.exports = {
  sequelize,
  User,
  RefreshToken,
  PasswordResetToken,
  PasswordResetOtp,
  DoctorProfile,
  PatientProfile,
  Specialization,
  SubSpecialization,
  Language,
  DoctorSpecialization,
  DoctorSubSpecialization,
  DoctorLanguage,
  DoctorAward,
  DoctorTestimonial,
  DoctorLink,
  DoctorDocument,
  DoctorSearchKeyword,
  DoctorEducation,
  DoctorExperience,
  DoctorService,
  DoctorPublication,
  DoctorMembership,
  DoctorGallery,
  DoctorFaq,
  DoctorAffiliation,
  DoctorFellowship,
  DoctorExpertise,
  Insurance,
  DoctorInsurance,
  ClinicProfile,
  ClinicDocument,
  Clinic,
  ClinicAvailability,
  DoctorOnlineAvailability,
  AvailabilityException,
  Booking,
  ConsultationSession,
  Payment,
  VideoSession,
  CareJourney,
  Referral,
  PrescriptionTemplate,
  Prescription,
  PrescriptionItem,
  Medicine,
  ClinicalNote,
  Allergy,
  Condition,
  PatientAllergy,
  PatientCondition,
  PatientCurrentMedication,
  UploadedRecord,
  DoctorPatientStatus,
  FollowUpStatus,
  PatientFollowUp,
  PatientVitals,
  FollowUpReminder,
  ContactMessage,
  MedicineCategory,
  MedicineMaster,
  MedicineMasterImage,
  MedicineMasterSubstitute,
  MedicineStoreMedicine,
  MedicineCartItem,
  MedicineOrderGroup,
  MedicineOrder,
  MedicinePayment,
  MedicineNotification,
  PatientMedicine,
  MedicineDoseLog,
  MedicineDoseEvent,
  PatientMedicineSettings,
  PatientAcquisitionSource,
  BookingAcquisitionSource,
  PharmacySupplier,
  MedicineStockBatch,
  MedicineStockMovement,
  PharmacyPurchase,
  PharmacyPurchaseItem,
  MedicineReturn,
  MedicineReturnItem,
  PharmacyProfile,
  ProviderPaymentQr,
  DoctorAccessRequest,
  DoctorAccessGrantItem,
  AccessAuditLog,
  ClinicalEntry,
  IcdCode,
  IcdImportBatch,
  PrescriptionRequest,
  PrescriptionRequestItem,
  DiagnosticTest,
  DiagnosticRequest,
  DiagnosticRequestTest,
  BloodBankProfile,
  BloodDonor,
  BloodDonorScreening,
  BloodCamp,
  BloodCampRegistration,
  BloodDonation,
  BloodTest,
  BloodUnit,
  BloodRequest,
  BloodReservation,
  BloodCrossmatch,
  BloodIssue,
  BloodAuditLog,
  AmbulanceProviderProfile,
  AmbulanceDriver,
  Ambulance,
  AmbulanceBooking,
  AmbulanceBookingEvent,
};
