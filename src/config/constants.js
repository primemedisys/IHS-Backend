/**
 * Shared enums and magic values. Import from here instead of retyping string
 * literals like "admin" or "local" across the codebase — one place to change,
 * and typos become reference errors instead of silent bugs.
 */

const ROLES = Object.freeze({
  ADMIN: "admin",
  DOCTOR: "doctor",
  PATIENT: "patient",
  // The clinic portal (migration 017). An organisation with its own login —
  // NOT the `clinics` table, which is one doctor's location.
  CLINIC: "clinic",
  // Medicine platform (migration 030).
  /**
   * LEGACY. Medicine Representative is no longer an active pharmacy provider
   * type (migration 036). Existing MR accounts and all their historical rows
   * are untouched and still readable; the role simply can no longer be
   * registered and is excluded from the patient-facing pharmacy surfaces.
   */
  MR: "mr",
  /** Pharmacy — Medicine Store / Clinic (the DB value is unchanged). */
  MEDICINE_STORE: "medicine_store",
  /** Pharmacy — Hospital (migration 036). */
  PHARMACY_HOSPITAL: "pharmacy_hospital",
  /**
   * Diagnostic Lab Center (migration 038). Signs in through the same provider
   * portal as the pharmacies but is NOT a medicine provider: it is absent from
   * every *_MEDICINE_PROVIDER_ROLES list, so no medicine route admits it.
   */
  DIAGNOSTIC_LAB: "diagnostic_lab",
  /**
   * Blood Bank / Blood Centre (migration 039). Has its OWN portal and login
   * (frontend-blood-bank, POST /auth/blood-bank/login) and, like the clinic
   * portal, sits at verification_status='pending' until an admin approves it.
   */
  BLOOD_BANK: "blood_bank",
  /**
   * Ambulance provider / operator (migration 040). Has its OWN portal and login
   * (frontend-ambulance, POST /auth/ambulance/login) and, like the blood bank,
   * sits at verification_status='pending' until an admin approves it. Each of
   * its ambulances is approved separately before it becomes bookable.
   */
  AMBULANCE_PROVIDER: "ambulance_provider",
});

/**
 * Roles that are allowed to self-register through the public signup endpoint.
 *
 * A clinic self-registers but then sits at verification_status='pending' until
 * an admin approves it, so signing up grants an account and nothing else — no
 * patient data is reachable before approval (requireApprovedClinic).
 */
const SELF_REGISTERABLE_ROLES = Object.freeze([
  ROLES.DOCTOR,
  ROLES.PATIENT,
  ROLES.CLINIC,
  // Pharmacy providers. ROLES.MR is deliberately ABSENT (migration 036): no new
  // Medicine Representative account can be created, while every existing one
  // keeps working and keeps its data.
  ROLES.MEDICINE_STORE,
  ROLES.PHARMACY_HOSPITAL,
  ROLES.DIAGNOSTIC_LAB,
  // A blood bank signs up (normally through POST /auth/blood-bank/register,
  // which also takes the centre details) and then waits at 'pending' for admin
  // approval before it can receive patient requests (requireApprovedBloodBank).
  ROLES.BLOOD_BANK,
  // An ambulance provider signs up through POST /auth/ambulance/register and
  // waits at 'pending'; nothing it registers is publicly bookable until an
  // admin approves it (requireApprovedAmbulanceProvider + ambulanceSearch).
  ROLES.AMBULANCE_PROVIDER,
]);

/**
 * Verification paperwork a clinic can upload. Unlike DOC_TYPES these are not a
 * DB enum (clinic_documents.doc_type is a plain VARCHAR), so this list is the
 * only gate — it is enforced by the Joi validator.
 */
const CLINIC_DOC_TYPES = Object.freeze({
  REGISTRATION_CERTIFICATE: "registration_certificate",
  ID_PROOF: "id_proof",
  ADDRESS_PROOF: "address_proof",
  OTHER: "other",
});

/** Paperwork a clinic must upload before it can submit for verification. */
const CLINIC_REQUIRED_DOC_TYPES = Object.freeze([
  CLINIC_DOC_TYPES.REGISTRATION_CERTIFICATE,
  CLINIC_DOC_TYPES.ID_PROOF,
]);

/**
 * The onboarding steps that gate a clinic's "Submit for verification", mirroring
 * ONBOARDING_REQUIRED_STEPS for doctors. The completeness engine and the submit
 * guard both read THIS list, so they can never drift.
 */
const CLINIC_ONBOARDING_REQUIRED_STEPS = Object.freeze(["profile", "location", "documents"]);

/**
 * Who authored a medical record (migration 018 `source` columns).
 *
 * Reuses the name already on `patient_vitals` rather than inventing a parallel
 * concept, so every record type reads identically wherever it is displayed.
 */
const RECORD_SOURCES = Object.freeze({
  PATIENT: "patient",
  DOCTOR: "doctor",
  CLINIC: "clinic",
  /** Admin-portal uploads on a patient's behalf (uploaded_records only, migration 024). */
  ADMIN: "admin",
  /** A diagnostic lab's report, filed on completion (uploaded_records only, migration 038). */
  DIAGNOSTIC_LAB: "diagnostic_lab",
});

/**
 * uploaded_records.file_type values (migration 058 added `identity`).
 * `identity` rows (Aadhaar, insurance / scheme cards) are the patient's own:
 * the model's default scope hides them from every doctor, clinic, lab and
 * admin read — only the patient's own record endpoints opt in.
 */
const RECORD_FILE_TYPES = Object.freeze(["prescription", "lab_report", "xray", "mri", "other", "identity"]);
const IDENTITY_FILE_TYPE = "identity";

/**
 * What a patient-uploaded document is (uploaded_records.document_kind,
 * migration 058) → the file_type it is filed under. The server derives
 * file_type from the kind, so the doctor-consent category a document falls
 * under (clinicalAccess FILE_TYPE_CATEGORY) can never be chosen wrongly by a
 * client. Kinds without a dedicated file_type (CT, ultrasound, discharge
 * summary …) use `other`, which is protected as tests & reports.
 */
const DOCUMENT_KIND_FILE_TYPE = Object.freeze({
  // Identity & insurance — never shared with doctors.
  aadhaar: "identity",
  abha_card: "identity",
  other_id: "identity",
  insurance_card: "identity",
  health_scheme_card: "identity",
  // Prescriptions written outside IHS (or an older copy).
  prescription: "prescription",
  // Investigations & diagnostic reports.
  blood_test: "lab_report",
  lab_report: "lab_report",
  xray: "xray",
  mri: "mri",
  ct_scan: "other",
  ultrasound: "other",
  ecg: "other",
  diagnostic_other: "other",
  // Other medical documents.
  discharge_summary: "other",
  hospital_report: "other",
  treatment_record: "other",
  referral_letter: "other",
  consultation_report: "other",
  medical_certificate: "other",
  other_medical: "other",
});
const DOCUMENT_KINDS = Object.freeze(Object.keys(DOCUMENT_KIND_FILE_TYPE));

const AUTH_PROVIDERS = Object.freeze({
  LOCAL: "local",
  GOOGLE: "google",
});

/** Machine-readable error codes returned in the `{ error: { code } }` envelope. */
const ERROR_CODES = Object.freeze({
  VALIDATION_ERROR: "VALIDATION_ERROR",
  INVALID_CREDENTIALS: "INVALID_CREDENTIALS",
  // Valid credentials, but the account belongs to a different portal
  // (e.g. a doctor signing in on the patient app).
  WRONG_PORTAL: "WRONG_PORTAL",
  EMAIL_IN_USE: "EMAIL_IN_USE",
  UNAUTHENTICATED: "UNAUTHENTICATED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  TOKEN_INVALID: "TOKEN_INVALID",
  RATE_LIMITED: "RATE_LIMITED",
  // ── Login by mobile / password reset by SMS OTP (migration 050) ──
  // The number is on more than one account, so it can't pick ONE to sign into
  // or reset — only ever returned after the password / OTP has been proven.
  PHONE_SHARED: "PHONE_SHARED",
  OTP_INVALID: "OTP_INVALID",
  SMS_UNAVAILABLE: "SMS_UNAVAILABLE",
  EMAIL_UNAVAILABLE: "EMAIL_UNAVAILABLE",
  INTERNAL: "INTERNAL",
  // ── Doctor registration & portfolio ─────────────────────────────
  REG_NUMBER_IN_USE: "REG_NUMBER_IN_USE",
  ONBOARDING_INCOMPLETE: "ONBOARDING_INCOMPLETE",
  DOC_REQUIRED: "DOC_REQUIRED",
  UNSUPPORTED_FILE_TYPE: "UNSUPPORTED_FILE_TYPE",
  // ── File storage (CLOUDINARY_SETUP.md) ──────────────────────────
  STORAGE_UNAVAILABLE: "STORAGE_UNAVAILABLE", // the storage provider failed or timed out
  FILE_LINK_EXPIRED: "FILE_LINK_EXPIRED", // a signed /api/files link is past its expiry
  // ── Patient profile & booking (docs/booking-payments) ───────────────
  PROFILE_INCOMPLETE: "PROFILE_INCOMPLETE",
  // Retained through the queue migration: SLOT_TAKEN is now the token-collision
  // backstop and SLOT_UNAVAILABLE still means "the doctor doesn't offer that".
  // Every client already handles both.
  SLOT_TAKEN: "SLOT_TAKEN",
  SLOT_UNAVAILABLE: "SLOT_UNAVAILABLE",
  // ── Consultation queue (docs/consultation-queue) ─────────────────────
  SESSION_FULL: "SESSION_FULL", // the doctor capped the day and it is reached
  SESSION_CLOSED: "SESSION_CLOSED", // ended or cancelled — no new tokens
  SESSION_NOT_FOUND: "SESSION_NOT_FOUND",
  // The patient already holds a live token (pending payment or confirmed) in
  // that doctor's session for that day — one patient, one token per session.
  DUPLICATE_BOOKING: "DUPLICATE_BOOKING",
  NOT_YOUR_TURN: "NOT_YOUR_TURN", // patient tried to join before being called
  QUEUE_ALREADY_SERVING: "QUEUE_ALREADY_SERVING", // finish or skip the current patient first
  // A follow-up status can't be deleted while patients still carry it
  // (docs/follow-up-status) — the client turns this into "Archive instead?".
  STATUS_IN_USE: "STATUS_IN_USE",
  PAYMENT_VERIFICATION_FAILED: "PAYMENT_VERIFICATION_FAILED",
  BOOKING_NOT_PAYABLE: "BOOKING_NOT_PAYABLE",
  // ── Prescriptions & letterhead (docs/prescriptions) ──────────────────
  TEMPLATE_NOT_FOUND: "TEMPLATE_NOT_FOUND",
  TEMPLATE_IN_USE: "TEMPLATE_IN_USE",
  RX_ALREADY_EXISTS: "RX_ALREADY_EXISTS",
  MEDICINE_DUPLICATE: "MEDICINE_DUPLICATE", // doctor's own list already has this name + strength
  CATALOGUE_DUPLICATE: "CATALOGUE_DUPLICATE", // the shared medicine catalogue already has this medicine
  ICD_DUPLICATE: "ICD_DUPLICATE", // same code already in this coding system + version
  ICD_INACTIVE: "ICD_INACTIVE", // the picked catalogue row is missing or deactivated
  ICD_IMPORT_STALE: "ICD_IMPORT_STALE", // the confirmed file is not the one that was previewed
  RX_NOT_EDITABLE: "RX_NOT_EDITABLE",
  // Patient medicine routines (migration 055)
  PATIENT_MEDICINE_NOT_EDITABLE: "PATIENT_MEDICINE_NOT_EDITABLE", // completed / cancelled routine
  PRESCRIBED_FIELD_LOCKED: "PRESCRIBED_FIELD_LOCKED", // patient tried to change a doctor's instruction
  DOSE_ALREADY_TAKEN: "DOSE_ALREADY_TAKEN",
  DOSE_NOT_ACTIONABLE: "DOSE_NOT_ACTIONABLE", // e.g. snoozing a skipped dose, acting on a future dose
  RX_BOOKING_NOT_ELIGIBLE: "RX_BOOKING_NOT_ELIGIBLE",
  PDF_RENDER_FAILED: "PDF_RENDER_FAILED",
  // ── Multi-doctor referrals & care journeys (docs/multi-doctor-referrals) ──
  REFERRAL_NOT_FOUND: "REFERRAL_NOT_FOUND",
  REFERRAL_TARGET_INVALID: "REFERRAL_TARGET_INVALID", // self / not approved / inactive
  REFERRAL_NOT_CANCELLABLE: "REFERRAL_NOT_CANCELLABLE", // already booked/completed
  REFERRAL_ALREADY_LINKED: "REFERRAL_ALREADY_LINKED", // referral not pending / mismatched
  JOURNEY_NOT_FOUND: "JOURNEY_NOT_FOUND",
  // ── Video consultation (docs/video-consultation) ─────────────────────
  VIDEO_NOT_AVAILABLE: "VIDEO_NOT_AVAILABLE", // not a video booking, or not confirmed
  VIDEO_WINDOW_CLOSED: "VIDEO_WINDOW_CLOSED", // outside the join window (too early / closed)
  VIDEO_NOT_CONFIGURED: "VIDEO_NOT_CONFIGURED", // LiveKit keys absent (503)
  // ── Medicine cart / checkout / payment (migration 036) ───────────────
  CART_EMPTY: "CART_EMPTY", // checkout with nothing selected
  STOCK_UNAVAILABLE: "STOCK_UNAVAILABLE", // provider stock no longer covers the quantity
  PAYMENT_FAILED: "PAYMENT_FAILED", // the (simulated) payment did not succeed
  ORDER_NOT_PAYABLE: "ORDER_NOT_PAYABLE", // already paid / cancelled / COD
  INVALID_STATUS_TRANSITION: "INVALID_STATUS_TRANSITION",
  // ── Ambulance (migration 040) ─────────────────────────────────────────
  VEHICLE_IN_USE: "VEHICLE_IN_USE", // registration / vehicle number already registered
  AMBULANCE_UNAVAILABLE: "AMBULANCE_UNAVAILABLE", // not available / on another trip
  OUTSIDE_SERVICE_AREA: "OUTSIDE_SERVICE_AREA", // pickup beyond the ambulance's service radius
  DRIVER_BUSY: "DRIVER_BUSY", // driver already on another active trip
  // ── Provider UPI QR payments (migration 044) ─────────────────────────────
  // The provider has no active payment QR (or removed it), or the booking /
  // order isn't a UPI-QR one — the patient must pick another payment method.
  PAYMENT_QR_UNAVAILABLE: "PAYMENT_QR_UNAVAILABLE",
  // A patient's "I have paid" report on something no longer awaiting payment.
  PAYMENT_NOT_PENDING: "PAYMENT_NOT_PENDING",
  // ── Doctor record-access consent (migration 045) ─────────────────────────
  // The doctor already treats this patient, so the existing booking-based rule
  // gives access — no consent request is needed (or allowed).
  ACCESS_ALREADY_AUTHORIZED: "ACCESS_ALREADY_AUTHORIZED",
  // An identical request (same doctor, patient, category) is still pending.
  ACCESS_REQUEST_PENDING: "ACCESS_REQUEST_PENDING",
  // The request is no longer in a state that allows this action.
  ACCESS_REQUEST_CLOSED: "ACCESS_REQUEST_CLOSED",
  // The doctor's grant is missing, expired, revoked or does not cover the file.
  ACCESS_NOT_GRANTED: "ACCESS_NOT_GRANTED",
  // Only verified (approved) doctors may search patients or request records.
  DOCTOR_NOT_VERIFIED: "DOCTOR_NOT_VERIFIED",
  // The patient declined this category recently; asking again must wait.
  ACCESS_REQUEST_COOLDOWN: "ACCESS_REQUEST_COOLDOWN",
});

const BCRYPT_COST = 12;

// ── Doctor portfolio enums (mirror the DB enums in docs/dbstruct.md) ─────────
/** Uploaded verification document types (doctor_documents.doc_type). */
const DOC_TYPES = Object.freeze({
  DEGREE_CERTIFICATE: "degree_certificate",
  ID_PROOF: "id_proof",
  COUNCIL_REGISTRATION: "council_registration",
  OTHER: "other",
});

/** Doctor gender (doctor_profiles.gender) — hero + public card. */
const GENDERS = Object.freeze(["male", "female", "other"]);

/** Portfolio social/web link types (doctor_links.link_type). */
const LINK_TYPES = Object.freeze({
  WEBSITE: "website",
  LINKEDIN: "linkedin",
  INSTAGRAM: "instagram",
  YOUTUBE: "youtube",
  OTHER: "other",
});

/**
 * Portfolio expertise categories (doctor_expertise.category, migration 049).
 * Procedures are NOT here — they reuse doctor_services.
 */
const EXPERTISE_CATEGORIES = Object.freeze({
  CLINICAL: "clinical",
  SCIENTIFIC: "scientific",
  AREA: "area",
  INTEREST: "interest",
});

/** Clinical-gallery photo categories (doctor_gallery.category, migration 049). */
const GALLERY_CATEGORIES = Object.freeze([
  "clinic",
  "facilities",
  "equipment",
  "events",
  "activities",
  "other",
]);

/** Doc types a doctor must upload before they can submit for verification. */
const REQUIRED_DOC_TYPES = Object.freeze([
  DOC_TYPES.DEGREE_CERTIFICATE,
  DOC_TYPES.ID_PROOF,
  DOC_TYPES.COUNCIL_REGISTRATION,
]);

/**
 * The onboarding steps that gate "Submit for verification" — the completeness
 * engine and the submit guard both read this list, so they can never drift
 * (README §5.2).
 *
 * Deliberately narrowed to what an ADMIN actually needs in order to make a
 * verification decision: who the doctor is (professional), what they practise
 * (specialties), and the paperwork proving it (documents).
 *
 * `portfolio`, `clinics` and `availability` are no longer gates. They are how a
 * doctor presents and operates their practice, not evidence of legitimacy, and
 * requiring them meant a fully-credentialled doctor could not even be reviewed
 * until they had written a bio and set opening hours. They remain fully
 * editable — and are still reported in the checklist below — from the Portfolio
 * hub in the doctor app.
 *
 * `computeChecklist` still returns all six, so nothing that reads a step's
 * completeness breaks; only the submit gate changed.
 */
const ONBOARDING_REQUIRED_STEPS = Object.freeze([
  "professional",
  "specialties",
  "documents",
]);

// ── Clinics & availability ───────────────────────────────────────────────────
/** Day-of-week index (0=Sunday..6=Saturday) → short label for public cards. */
const DAYS = Object.freeze(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]);

/** Default consult slot length (minutes) when a weekly slot omits it. */
const SLOT_DEFAULT_MINUTES = 15;

/** Cap on rows accepted in a single replace-the-set availability write. */
const MAX_SLOTS_PER_SCHEDULE = 50;

// ── Patient profile (docs/booking-payments) ──────────────────────────────────
/**
 * The minimum profile fields a patient must fill before they can create a
 * booking — "a doctor can't review the case without them" (PRD §4.5). The
 * booking gate AND the frontend read this ONE list so they can never drift
 * (mirrors ONBOARDING_REQUIRED_STEPS). `name` is already required at signup.
 * `phone` lives on `users`; the rest on `patient_profiles`.
 */
const PATIENT_REQUIRED_FIELDS = Object.freeze(["phone", "dateOfBirth", "gender", "city"]);

// ── Bookings & payments (docs/booking-payments) ──────────────────────────────
/** Frontend booking vocabulary → maps to bookings.booking_type in the service. */
const BOOKING_MODES = Object.freeze({ VIDEO: "video", CLINIC: "clinic" });

/** bookings.status lifecycle (mirrors the DB enum). */
const BOOKING_STATUS = Object.freeze({
  PENDING: "pending_payment",
  CONFIRMED: "confirmed",
  COMPLETED: "completed",
  CANCELLED: "cancelled",
  NO_SHOW: "no_show",
});

/** payments.status lifecycle (mirrors the DB enum). */
const PAYMENT_STATUS = Object.freeze({
  INITIATED: "initiated",
  SUCCESS: "success",
  FAILED: "failed",
  REFUNDED: "refunded",
  PENDING_AT_CLINIC: "pending_at_clinic",
});

/**
 * How an OFFLINE booking payment is collected (payments.offline_method,
 * migration 044). Either way it sits at `pending_at_clinic` until the doctor
 * confirms receipt — the platform never marks it paid on its own.
 */
const OFFLINE_PAYMENT_METHOD = Object.freeze({
  CASH: "cash",
  UPI_QR: "upi_qr",
});

/**
 * The Payment columns every booking view loads — what serializeBookingPayment
 * reads (status, mode, and the migration-044 UPI QR fields).
 */
const BOOKING_PAYMENT_VIEW_ATTRS = Object.freeze(["status", "mode", "offlineMethod", "payerReference", "payerReportedAt"]);

/**
 * A provider's payment QR image (migration 044): bitmap formats only (it is
 * rendered in an <img> and scanned off a screen), and small — a QR is a few
 * KB; 2 MB leaves room for a phone screenshot.
 */
const PAYMENT_QR_IMAGE_MIME = Object.freeze(["image/png", "image/jpeg", "image/webp"]);
const PAYMENT_QR_MAX_BYTES = 2 * 1024 * 1024;

/** How long a `pending_payment` booking holds its token before it's swept free. */
const BOOKING_HOLD_MINUTES = 10;

// ── Consultation queue (docs/consultation-queue) ─────────────────────────────
/** consultation_sessions.status lifecycle (mirrors the DB enum). */
const SESSION_STATUS = Object.freeze({
  SCHEDULED: "scheduled", // published, nobody called in yet
  IN_PROGRESS: "in_progress", // the doctor is working the queue
  PAUSED: "paused", // stepped away; patients keep their place
  COMPLETED: "completed", // the day is closed (or auto-closed)
  CANCELLED: "cancelled",
});

/**
 * bookings.queue_state — where a patient stands in the day, which is a
 * different question from bookings.status (paid? cancelled?). Only ONE writer
 * touches each: payment code owns `status`, queue code owns `queue_state`, and
 * `complete()` — the one action that legitimately means both — writes them
 * together in a single transaction.
 */
const QUEUE_STATE = Object.freeze({
  WAITING: "waiting",
  SERVING: "serving",
  DONE: "done",
  SKIPPED: "skipped",
});

/** Bookings that occupy a place in the queue (and therefore hold a token). */
const LIVE_QUEUE_STATUSES = Object.freeze([BOOKING_STATUS.PENDING, BOOKING_STATUS.CONFIRMED]);

/** How often a client re-reads the queue. Sent on the wire so one value rules. */
const QUEUE_POLL_SECONDS = 20;

/** A session nobody ended is auto-closed this long after its end_time, so a
 *  doctor who forgets never leaves patients reading "in consultation" all night. */
const SESSION_AUTO_CLOSE_HOURS = 6;

/** Consults that must finish before a session's own average is trusted — one
 *  40-minute first patient must not tell everyone else to come back tomorrow. */
const AVG_CONSULT_MIN_SAMPLE = 3;

/** Fallback when a session has no measured average and no template value. */
const DEFAULT_CONSULT_MINUTES = SLOT_DEFAULT_MINUTES;

/** How far ahead sessions are published to patients. */
const SESSION_HORIZON_DAYS = 30;
const SESSION_HORIZON_MAX_DAYS = 60;

/** Platform cut on a successful online payment (README §4; global for MVP). */
const PLATFORM_COMMISSION_PCT = 0.15;

// ── Dashboards & earnings (docs/dashboards-earnings) ─────────────────────────
/** Buckets a series may be grouped by. `day` is capped at DASHBOARD_MAX_DAYS. */
const SERIES_GRANULARITY = Object.freeze(["day", "month"]);
/**
 * IST as a FIXED offset. Aggregates bucket with CONVERT_TZ(col,'+00:00',IST_OFFSET)
 * and never with the named zone 'Asia/Kolkata': the named form returns NULL on a
 * MySQL whose `mysql.time_zone*` tables were never loaded, and a NULL bucket key
 * silently collapses a whole month. India has no DST, so the offset is exact.
 */
const IST_OFFSET = "+05:30";
/** Default series window when the caller sends no from/to. */
const DASHBOARD_DEFAULT_MONTHS = 6;
/** A `day` series wider than a quarter is a report, not a chart. */
const DASHBOARD_MAX_DAYS = 92;
const LEDGER_PAGE_SIZE_DEFAULT = 20;
const LEDGER_PAGE_SIZE_MAX = 100;
const ADMIN_TOP_DOCTORS_LIMIT = 5;
/**
 * Admin pharmacy tracking: an inventory row with 1..N units left is "low stock".
 * No low-stock rule existed before this; this is the one place it is decided.
 */
const ADMIN_MEDICINE_LOW_STOCK_THRESHOLD = 10;

// ── Prescriptions (docs/prescriptions) ───────────────────────────────────────
/** prescriptions.status — `finalized` is signed, numbered, rendered and frozen. */
const PRESCRIPTION_STATUS = Object.freeze({ DRAFT: "draft", FINALIZED: "finalized" });

/** prescription_items.route / .timing (mirror the DB enums). */
const MEDICINE_ROUTES = Object.freeze(["oral", "topical", "injection", "drops", "inhaler", "other"]);
const MEDICINE_TIMINGS = Object.freeze(["before_food", "after_food", "with_food", "anytime"]);
/** What `prescription_items.duration_days` counts in (migration 015). */
const MEDICINE_DURATION_UNITS = Object.freeze(["day", "week", "month"]);

/** Doctor medicine master list form (reuses MEDICINE_ROUTES values). */
const MEDICINE_FORMS = Object.freeze(["oral", "topical", "injection", "drops", "inhaler", "other"]);

/** The uploadable branding images a letterhead owns. */
const TEMPLATE_ASSET_KINDS = Object.freeze(["logo", "watermark", "signature"]);

/** Images only — a PDF "logo" passes middlewares/upload.js but breaks the renderer. */
const TEMPLATE_ASSET_MIME = Object.freeze(["image/png", "image/jpeg"]);

/**
 * The patient/vitals strip on the letterhead. The Joi validator AND the doctor
 * app's field picker read this ONE frozen list, so the two can never drift
 * (same discipline as ONBOARDING_REQUIRED_STEPS / PATIENT_REQUIRED_FIELDS).
 */
const PRESCRIPTION_PATIENT_FIELDS = Object.freeze([
  "name", "age", "sex", "phone", "address",
  "bp", "pulse", "weight", "height", "temperature", "spo2", "date",
]);

/** Columns the medicine table may render, in the order the doctor picks them. */
const MEDICINE_COLUMNS = Object.freeze([
  "medicineName", "dosage", "route", "frequency", "timing", "durationDays", "notes",
]);

/** Print-safe families only — the PDF renders on the SERVER, where the doctor's font isn't installed. */
const PRESCRIPTION_FONTS = Object.freeze([
  "Helvetica, Arial, sans-serif",
  "Georgia, 'Times New Roman', serif",
  "'Courier New', monospace",
  "Verdana, Geneva, sans-serif",
  "'Trebuchet MS', sans-serif",
]);

/** Booking states that may carry a prescription. */
const RX_ELIGIBLE_BOOKING_STATUSES = Object.freeze([
  BOOKING_STATUS.CONFIRMED,
  BOOKING_STATUS.COMPLETED,
]);

// ── Treatment timeline (docs/treatment-timeline) ─────────────────────────────
/**
 * Which bookings are "treatment" and therefore appear as timeline rows
 * (README §7-D). Completed only: a confirmed-but-future appointment is not
 * care that happened, and its Issue/Prescription columns would be empty.
 */
const TIMELINE_BOOKING_STATUSES = Object.freeze([BOOKING_STATUS.COMPLETED]);

/**
 * Which bookings make a patient "mine" for the My Patients roster and the
 * patient-keyed access gate (README §5.4). Wider than the row filter — a doctor
 * with a confirmed upcoming consult is already treating that patient.
 */
const TREATED_BOOKING_STATUSES = Object.freeze([
  BOOKING_STATUS.CONFIRMED,
  BOOKING_STATUS.COMPLETED,
]);

/** Newest-first row cap; the response flags `capped` so the UI can say so. */
const TIMELINE_ROW_CAP = 200;
/** Roster cap. Search/paging over the roster is a follow-up, not v1. */
const TIMELINE_ROSTER_CAP = 500;

/**
 * My Patients statuses (migration 023). NEW and OPD_FOLLOWUP are DERIVED from
 * visit count unless overridden; the surgery pair is always doctor-set — no
 * booking data can know an operation is planned.
 */
const PATIENT_STATUSES = Object.freeze({
  NEW: "new_patient",
  OPD_FOLLOWUP: "opd_followup",
  SURGERY_PENDING: "surgery_pending",
  SURGERY_FOLLOWUP: "surgery_followup",
});

// ── Video consultation (docs/video-consultation) ─────────────────────────────
/** video_sessions.status lifecycle (mirrors the DB enum). */
const VIDEO_SESSION_STATUS = Object.freeze({
  PENDING: "pending", // provisioned at payment; nobody has joined yet
  LIVE: "live", // the room is up (room_started / a participant joined)
  ENDED: "ended", // the room closed (room_finished); duration recorded
});

/**
 * The join window for a video consult: the "Join" link is live from
 * VIDEO_JOIN_LEAD_MINUTES before the slot start to VIDEO_JOIN_GRACE_MINUTES
 * after the slot end. The minted LiveKit token's TTL is bounded by this window.
 */
const VIDEO_JOIN_LEAD_MINUTES = 10;
const VIDEO_JOIN_GRACE_MINUTES = 30;

// ── Multi-doctor referrals & care journeys (docs/multi-doctor-referrals) ─────
/** referrals.status lifecycle (mirrors the DB enum). */
const REFERRAL_STATUS = Object.freeze({
  PENDING: "pending", // created; awaiting the patient to book the target
  BOOKED: "booked", // a booking now fulfils it (targetBookingId set)
  COMPLETED: "completed", // the target consult is done
  CANCELLED: "cancelled", // referrer withdrew it while pending
  DECLINED: "declined", // reserved: target-doctor accept/decline (out of MVP)
});

/** care_journeys.status lifecycle. */
const JOURNEY_STATUS = Object.freeze({ OPEN: "open", CLOSED: "closed" });

/** Referral-target autocomplete page size (self-excluded, approved+active only). */
const REFERRAL_TARGET_LIMIT = 8;

// ── Public doctor discovery ──────────────────────────────────────────────────
/** Sort keys accepted by GET /doctors. `nearest` additionally requires lat+lng. */
const DOCTOR_SORTS = Object.freeze(["relevance", "rating", "experience", "fee", "nearest"]);
const DOCTOR_PAGE_SIZE_DEFAULT = 9;
const DOCTOR_PAGE_SIZE_MAX = 50;
/** Hard cap on GET /doctors/map — the map renders every pin in one payload. */
const DOCTOR_MAP_LIMIT = 500;
/** Doctors in the same specialty returned by GET /doctors/:slug/related. */
const DOCTOR_RELATED_LIMIT = 3;

// ── Automatic follow-up reminders (docs/follow-up-reminders-07-09-2026) ─────
/** follow_up_reminders.status lifecycle. */
const REMINDER_STATUS = Object.freeze({
  PENDING: "pending",
  PROCESSING: "processing",
  SENT: "sent",
  FAILED: "failed",
  CANCELLED: "cancelled",
});

/** follow_up_reminders.channel — which delivery channels are active. */
const REMINDER_CHANNEL = Object.freeze({
  EMAIL: "email",
  WHATSAPP: "whatsapp",
  BOTH: "both",
});

/** Per-channel delivery status. */
const CHANNEL_STATUS = Object.freeze({
  PENDING: "pending",
  SENT: "sent",
  FAILED: "failed",
});

/** How many days before follow_up_on to trigger the reminder by default. */
const DEFAULT_REMINDER_DAYS_BEFORE = 3;

/** Maximum delivery retries per channel before marking as failed. */
const MAX_REMINDER_RETRIES = 3;

/** How often the scheduler queries for due reminders (milliseconds). */
const SCHEDULER_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// ── Medicine / MR module (migration 030) ─────────────────────────────────────

const MEDICINE_TYPES = Object.freeze([
  "tablet",
  "capsule",
  "syrup",
  "injection",
  "drops",
  "cream",
  "ointment",
  "gel",
  "spray",
  "inhaler",
  "powder",
  "other",
]);

/**
 * medicine_orders.status — the delivery lifecycle, in order. The existing
 * values are kept exactly as they were (nothing is renamed, no historical row
 * changes meaning); `on_the_way` is the one value added by migration 036 so
 * the pharmacy can distinguish "handed to the rider" from "near you".
 *
 *   pending   → ORDER PLACED
 *   confirmed → CONFIRMED
 *   processing→ PREPARING
 *   shipped   → OUT FOR DELIVERY
 *   on_the_way→ ON THE WAY
 *   delivered → DELIVERED
 */
const MEDICINE_ORDER_STATUS = Object.freeze({
  PENDING: "pending",
  CONFIRMED: "confirmed",
  PROCESSING: "processing",
  SHIPPED: "shipped",
  ON_THE_WAY: "on_the_way",
  DELIVERED: "delivered",
  REJECTED: "rejected",
  CANCELLED: "cancelled",
});

/**
 * The ONE allowed-transition table. The order service, the group-level update
 * and the provider UI all read this, so a "next step" can never drift from
 * what the backend will actually accept. `shipped → delivered` is retained
 * from the pre-036 lifecycle so a pharmacy that skips the on-the-way ping is
 * not blocked.
 */
const MEDICINE_ORDER_TRANSITIONS = Object.freeze({
  [MEDICINE_ORDER_STATUS.PENDING]: [MEDICINE_ORDER_STATUS.CONFIRMED, MEDICINE_ORDER_STATUS.REJECTED],
  [MEDICINE_ORDER_STATUS.CONFIRMED]: [MEDICINE_ORDER_STATUS.PROCESSING],
  [MEDICINE_ORDER_STATUS.PROCESSING]: [MEDICINE_ORDER_STATUS.SHIPPED],
  [MEDICINE_ORDER_STATUS.SHIPPED]: [MEDICINE_ORDER_STATUS.ON_THE_WAY, MEDICINE_ORDER_STATUS.DELIVERED],
  [MEDICINE_ORDER_STATUS.ON_THE_WAY]: [MEDICINE_ORDER_STATUS.DELIVERED],
});

/** Statuses a patient may still cancel from (stock is returned on cancel). */
const MEDICINE_ORDER_CANCELLABLE = Object.freeze([
  MEDICINE_ORDER_STATUS.PENDING,
  MEDICINE_ORDER_STATUS.CONFIRMED,
]);

/** Statuses that no longer hold provider stock (cancel/reject already returned it). */
const MEDICINE_ORDER_CLOSED = Object.freeze([
  MEDICINE_ORDER_STATUS.REJECTED,
  MEDICINE_ORDER_STATUS.CANCELLED,
]);

const MEDICINE_ORDER_PAYMENT_STATUS = Object.freeze({
  PENDING: "pending",
  PAID: "paid",
  FAILED: "failed",
  REFUNDED: "refunded",
});

/**
 * How a medicine order is paid (migration 036).
 *
 * `online` is SIMULATED in this phase — no gateway, no credentials, no money
 * moves (see MEDICINE_PAYMENT_GATEWAY). The column exists so a real gateway
 * can be added later without touching the order tables.
 */
const MEDICINE_PAYMENT_METHOD = Object.freeze({
  COD: "cod",
  ONLINE: "online",
  /**
   * The patient pays the pharmacy's OWN UPI QR (migration 044). Nothing is
   * verified automatically: the order stays payment `pending` until the
   * pharmacy confirms the money reached its UPI app.
   */
  UPI_QR: "upi_qr",
});

/**
 * Methods whose order is LIVE the moment it is placed — visible to the
 * pharmacy, notified, counted in its sales — with the money collected (and
 * confirmed) outside the platform. The simulated online method is not here:
 * it only becomes real once its payment succeeds.
 */
const MEDICINE_LIVE_ON_PLACE_METHODS = Object.freeze([
  MEDICINE_PAYMENT_METHOD.COD,
  MEDICINE_PAYMENT_METHOD.UPI_QR,
]);

/**
 * Which processor produced a medicine payment row. Only `simulated` exists in
 * this phase; a real gateway adds its own value and the order/billing code
 * above it does not change.
 */
const MEDICINE_PAYMENT_GATEWAY = Object.freeze({
  SIMULATED: "simulated",
  /** A UPI transfer straight to the pharmacy's own QR, confirmed by the pharmacy (migration 044). */
  MANUAL_UPI: "manual_upi",
});

/** medicine_payments.status — one attempt's outcome. */
const MEDICINE_PAYMENT_ATTEMPT_STATUS = Object.freeze({
  PENDING: "pending",
  SUCCESS: "success",
  FAILED: "failed",
});

const MEDICINE_PROVIDER_TYPE = Object.freeze({
  /** LEGACY — historical rows only; never selectable for new business. */
  MR: "mr",
  MEDICINE_STORE: "medicine_store",
  PHARMACY_HOSPITAL: "pharmacy_hospital",
});

/**
 * The pharmacy provider types that are ACTIVE for new business: patient
 * search, prescription sharing, cart, checkout and registration all use this
 * list. MR is excluded here and nowhere else — that single omission is the
 * whole of the "MR is no longer an active provider type" rule (migration 036).
 */
const ACTIVE_MEDICINE_PROVIDER_ROLES = Object.freeze([
  ROLES.MEDICINE_STORE,
  ROLES.PHARMACY_HOSPITAL,
]);

/** Provider roles that still have historical medicine data (read paths only). */
const LEGACY_MEDICINE_PROVIDER_ROLES = Object.freeze([ROLES.MR]);

/**
 * Every provider role the medicine module has ever used. Read/authorization
 * paths (a provider signing in to manage their OWN existing inventory and
 * orders) use THIS list, so an MR keeps full access to its own history.
 */
const ALL_MEDICINE_PROVIDER_ROLES = Object.freeze([
  ...ACTIVE_MEDICINE_PROVIDER_ROLES,
  ...LEGACY_MEDICINE_PROVIDER_ROLES,
]);

/** Display names for a provider type — the one place the wording is decided. */
const MEDICINE_PROVIDER_TYPE_LABELS = Object.freeze({
  [MEDICINE_PROVIDER_TYPE.MEDICINE_STORE]: "Pharmacy Medicine Store / Clinic",
  [MEDICINE_PROVIDER_TYPE.PHARMACY_HOSPITAL]: "Pharmacy Hospital",
  [MEDICINE_PROVIDER_TYPE.MR]: "Medicine Representative (legacy)",
});

/** prescription_requests.status lifecycle (mirrors the DB enum). */
const PRESCRIPTION_REQUEST_STATUS = Object.freeze({
  PENDING: "pending",
  VIEWED: "viewed",
  PROCESSING: "processing",
  COMPLETED: "completed",
  REJECTED: "rejected",
});

/** prescription_request_items.status — a provider's per-medicine answer. */
const PRESCRIPTION_ITEM_STATUS = Object.freeze({
  AVAILABLE: "available",
  UNAVAILABLE: "unavailable",
});

/**
 * Every role that signs in through the provider portal (frontend-mr): the
 * pharmacies (legacy MR included) and the Diagnostic Lab Center. Used ONLY by
 * the portal login routes — route authorization keeps using the narrower
 * medicine / diagnostic lists so a lab never reaches a medicine route and a
 * pharmacy never reaches a diagnostic one.
 */
const PROVIDER_PORTAL_ROLES = Object.freeze([...ALL_MEDICINE_PROVIDER_ROLES, ROLES.DIAGNOSTIC_LAB]);

/** diagnostic_requests.status lifecycle (mirrors the DB enum, migration 038). */
const DIAGNOSTIC_REQUEST_STATUS = Object.freeze({
  PENDING: "pending",
  VIEWED: "viewed",
  /** The lab has answered with test availability + prices. */
  AVAILABLE: "available",
  /** The patient picked tests and a date. */
  BOOKING_REQUESTED: "booking_requested",
  CONFIRMED: "confirmed",
  TEST_COMPLETED: "test_completed",
  REPORT_READY: "report_ready",
  REJECTED: "rejected",
});

/**
 * Which statuses a LAB may move a request to by hand, from each status.
 * `available` and `booking_requested` are reached through their own actions
 * (respond / book), and `report_ready` only by uploading a report.
 */
const DIAGNOSTIC_LAB_TRANSITIONS = Object.freeze({
  [DIAGNOSTIC_REQUEST_STATUS.PENDING]: [DIAGNOSTIC_REQUEST_STATUS.VIEWED, DIAGNOSTIC_REQUEST_STATUS.REJECTED],
  [DIAGNOSTIC_REQUEST_STATUS.VIEWED]: [DIAGNOSTIC_REQUEST_STATUS.REJECTED],
  [DIAGNOSTIC_REQUEST_STATUS.AVAILABLE]: [DIAGNOSTIC_REQUEST_STATUS.REJECTED],
  [DIAGNOSTIC_REQUEST_STATUS.BOOKING_REQUESTED]: [
    DIAGNOSTIC_REQUEST_STATUS.CONFIRMED,
    DIAGNOSTIC_REQUEST_STATUS.REJECTED,
  ],
  [DIAGNOSTIC_REQUEST_STATUS.CONFIRMED]: [DIAGNOSTIC_REQUEST_STATUS.TEST_COMPLETED],
});

/** A lab may (re)send its test answer only before the patient has booked. */
const DIAGNOSTIC_RESPONDABLE_STATUSES = Object.freeze([
  DIAGNOSTIC_REQUEST_STATUS.PENDING,
  DIAGNOSTIC_REQUEST_STATUS.VIEWED,
  DIAGNOSTIC_REQUEST_STATUS.AVAILABLE,
]);

/** Reports can be uploaded once the test is done (and more added after the first). */
const DIAGNOSTIC_REPORTABLE_STATUSES = Object.freeze([
  DIAGNOSTIC_REQUEST_STATUS.TEST_COMPLETED,
  DIAGNOSTIC_REQUEST_STATUS.REPORT_READY,
]);

/** diagnostic_request_tests.status — the lab's per-test answer. */
const DIAGNOSTIC_TEST_STATUS = Object.freeze({
  AVAILABLE: "available",
  UNAVAILABLE: "unavailable",
});

/** uploaded_records.file_type values a lab report may be filed as. */
const DIAGNOSTIC_REPORT_FILE_TYPES = Object.freeze(["lab_report", "xray", "mri", "other"]);

/** medicine_notifications.reference_type for diagnostic events (shared notification table). */
const DIAGNOSTIC_NOTIFICATION_REF = "diagnostic_request";

/**
 * In-app notifications (the shared medicine_notifications table) for doctor
 * appointments and doctor record-access consent. Only these events notify —
 * not every write. reference_type values below tell the apps what to open.
 */
const NOTIFICATION_TYPES = Object.freeze({
  APPOINTMENT_BOOKED: "appointment_booked", // → doctor
  APPOINTMENT_CANCELLED: "appointment_cancelled", // → doctor (patient cancelled)
  APPOINTMENT_RESCHEDULED: "appointment_rescheduled", // → patient
  CONSULTATION_COMPLETED: "consultation_completed", // → patient
  PAYMENT_REPORTED: "appointment_payment_reported", // → doctor (patient says they paid by UPI QR)
  PAYMENT_CONFIRMED: "appointment_payment_confirmed", // → patient (doctor confirmed receipt)
  PRESCRIPTION_READY: "prescription_ready", // → patient
  ACCESS_REQUESTED: "record_access_requested", // → patient
  ACCESS_APPROVED: "record_access_approved", // → doctor
  ACCESS_REJECTED: "record_access_rejected", // → doctor
  ACCESS_REVOKED: "record_access_revoked", // → doctor
  // Patient medicine routines (migration 055) — all → patient.
  MEDICINE_PRESCRIBED: "medicine_prescribed", // a finalized prescription added medicines
  MEDICINE_PRESCRIPTION_UPDATED: "medicine_prescription_updated", // an amendment replaced them
  MEDICINE_ADDED: "medicine_added", // the patient added their own medicine(s)
  MEDICINE_DOSE_DUE: "medicine_dose_due", // a dose (or a snoozed dose) is due now
  MEDICINE_ROUTINE_COMPLETED: "medicine_routine_completed",
  MEDICINE_ROUTINE_PAUSED: "medicine_routine_paused",
  MEDICINE_ROUTINE_STOPPED: "medicine_routine_stopped",
});

const NOTIFICATION_REFS = Object.freeze({
  BOOKING: "booking",
  PRESCRIPTION: "prescription",
  ACCESS_REQUEST: "doctor_access_request",
  PATIENT_MEDICINE: "patient_medicine",
  MEDICINE_DOSE: "medicine_dose",
});

// ── Patient acquisition sources (migration 056) ──────────────────────────────
/**
 * "How did you hear about Dr. X?" — the ONE configurable catalogue. Clients
 * render it from GET /patient/acquisition/sources, so adding an option here
 * (or a group) needs no app release. `group` is what the dashboard cards add
 * up by; `value` is stored as `source`. Values are permanent once used —
 * relabel freely, never rename or reuse a value.
 *   textField: an optional free-text box is offered ("Other: ___")
 *   referral:  optional referrer details may be given (name / clinic)
 */
const ACQUISITION_GROUPS = Object.freeze([
  { value: "google", label: "Google" },
  { value: "social", label: "Social media / Meta" },
  { value: "referral", label: "Referral" },
  { value: "ihs", label: "IHS website or app" },
  { value: "other", label: "Other" },
  { value: "undisclosed", label: "Not sure / prefer not to say" },
]);
const ACQUISITION_SOURCES = Object.freeze([
  { value: "google_search", label: "Google Search", group: "google" },
  { value: "google_maps", label: "Google Maps", group: "google" },
  { value: "google_ads", label: "Google advertisement", group: "google" },
  { value: "google_other", label: "Other Google source", group: "google", textField: true },
  { value: "instagram", label: "Instagram", group: "social" },
  { value: "facebook", label: "Facebook", group: "social" },
  { value: "meta_ads", label: "Meta (Facebook / Instagram) advertisement", group: "social" },
  { value: "whatsapp", label: "WhatsApp", group: "social" },
  { value: "youtube", label: "YouTube", group: "social" },
  { value: "social_other", label: "Other social platform", group: "social", textField: true },
  { value: "friend", label: "Friend", group: "referral", referral: true },
  { value: "family", label: "Family", group: "referral", referral: true },
  { value: "existing_patient", label: "Existing patient of the doctor", group: "referral", referral: true },
  { value: "doctor_referral", label: "Another doctor", group: "referral", referral: true },
  { value: "hospital_referral", label: "Hospital", group: "referral", referral: true },
  { value: "clinic_referral", label: "Clinic", group: "referral", referral: true },
  { value: "referral_other", label: "Other referral", group: "referral", referral: true, textField: true },
  { value: "ihs_website", label: "IHS website", group: "ihs" },
  { value: "ihs_app", label: "IHS mobile app", group: "ihs" },
  { value: "other", label: "Other", group: "other", textField: true },
  { value: "not_sure", label: "Not sure", group: "undisclosed" },
  { value: "prefer_not_to_say", label: "Prefer not to say", group: "undisclosed" },
]);
/** Where an answer was captured (audit only — never used to infer the source). */
const ACQUISITION_CAPTURED_VIA = Object.freeze(["web", "mobile", "clinic"]);
/** The UTM keys kept (when the landing URL carried them), separate from the answer. */
const ACQUISITION_UTM_KEYS = Object.freeze(["source", "medium", "campaign", "term", "content"]);

// ── Patient medicine routines + dose tracking (migration 055) ────────────────
/** patient_medicines.source */
const PATIENT_MEDICINE_SOURCES = Object.freeze({ PRESCRIPTION: "prescription", PATIENT: "patient" });
/** patient_medicines.status */
const PATIENT_MEDICINE_STATUS = Object.freeze({
  ACTIVE: "active",
  PAUSED: "paused",
  COMPLETED: "completed",
  CANCELLED: "cancelled",
});
/** Why a routine left `active` (patient_medicines.status_reason). */
const PATIENT_MEDICINE_STATUS_REASONS = Object.freeze({
  PATIENT: "patient", // the patient paused / stopped it
  ENDED: "ended", // the end date passed
  SUPERSEDED: "prescription_amended", // a newer version of the prescription replaced it
});
/** medicine_dose_logs.status */
const DOSE_STATUS = Object.freeze({
  PENDING: "pending",
  TAKEN: "taken",
  SKIPPED: "skipped",
  SNOOZED: "snoozed",
  MISSED: "missed",
});
/** What a patient can do to one dose. */
const DOSE_ACTIONS = Object.freeze({ TAKEN: "taken", SKIPPED: "skipped", SNOOZE: "snooze" });
/** Where a dose action came from (medicine_dose_logs.action_source). */
const DOSE_ACTION_SOURCES = Object.freeze(["web", "mobile", "notification"]);
/** Snooze choices offered to the patient (minutes). */
const DOSE_SNOOZE_MINUTES = Object.freeze([5, 10, 15, 30]);
/** A dose still open this long after its due time is recorded as missed. */
const DOSE_MISSED_AFTER_MINUTES = 120;
/** How far ahead dose rows are generated — a rolling window, never unbounded. */
const DOSE_WINDOW_DAYS = 7;
/** A due-dose reminder older than this is not sent at all (server was down). */
const DOSE_NOTIFY_STALE_MINUTES = 30;
/** Max reminder times per day on one routine. */
const MAX_REMINDER_TIMES = 6;
/** Max medicines confirmed in one "add medicines" request. */
const MAX_MEDICINES_PER_REQUEST = 10;
/** The medicine reminder sweep (due notifications, missed marking, expiry). */
const MEDICINE_REMINDER_INTERVAL_MS = 60 * 1000;
const DEFAULT_PATIENT_TIMEZONE = "Asia/Kolkata";
/**
 * Doses per day a frequency code implies — a SUGGESTION for how many reminder
 * times to ask for, never enforced and never a dose. `null` = no fixed count
 * (SOS / weekly / free text): the patient chooses.
 */
const FREQUENCY_DAILY_COUNT = Object.freeze({ OD: 1, BD: 2, TDS: 3, QID: 4, HS: 1 });

/** Socket.IO event carrying one freshly persisted notification. */
const REALTIME_NOTIFICATION_EVENT = "notification";

/**
 * Doctor record-access consent (migration 045). A doctor who does NOT treat a
 * patient asks for ONE category of the patient's uploaded records; the patient
 * picks exactly which documents of that category to share. The grant covers
 * only those documents and only until it expires or is revoked.
 */
const ACCESS_REQUEST_STATUS = Object.freeze({
  PENDING: "pending",
  APPROVED: "approved",
  REJECTED: "rejected",
  REVOKED: "revoked",
  EXPIRED: "expired",
  CANCELLED: "cancelled",
});
/** = uploaded_records.file_type. A category is one file type, never "everything". */
const DOCUMENT_ACCESS_CATEGORIES = Object.freeze(["prescription", "lab_report", "xray", "mri", "other"]);

/**
 * Clinical-history consent (migration 057). A TREATING doctor always sees the
 * records they created themselves; another doctor's records of each category
 * stay private until the patient approves that category. One request row per
 * category, so the patient can approve one and decline another.
 */
const CLINICAL_ACCESS_CATEGORY = Object.freeze({
  MEDICAL_HISTORY: "medical_history", // history + long-term condition entries
  CONSULTATIONS: "consultations", // other doctors' visits: complaint, examination, visit vitals, follow-up
  DIAGNOSES: "diagnoses",
  MEDICATIONS: "medications", // other doctors' prescriptions + uploaded prescription documents
  INVESTIGATIONS: "investigations", // ordered tests + uploaded lab / scan reports
  DOCTOR_NOTES: "doctor_notes", // published notes + legacy consultation notes
  VITALS: "vitals", // readings not taken in this doctor's own visits (home, clinic, other doctors)
});
const CLINICAL_ACCESS_CATEGORIES = Object.freeze(Object.values(CLINICAL_ACCESS_CATEGORY));
/**
 * IHS access policy (2026-11-03): common clinical information is visible to
 * every TREATING doctor without a request — history, other doctors' visits
 * (complaint, examination, vitals, diagnosis, advice, follow-up), diagnoses,
 * published notes and the full vitals history.
 */
const CLINICAL_OPEN_CATEGORIES = Object.freeze([
  CLINICAL_ACCESS_CATEGORY.MEDICAL_HISTORY,
  CLINICAL_ACCESS_CATEGORY.CONSULTATIONS,
  CLINICAL_ACCESS_CATEGORY.DIAGNOSES,
  CLINICAL_ACCESS_CATEGORY.DOCTOR_NOTES,
  CLINICAL_ACCESS_CATEGORY.VITALS,
]);
/** Sensitive history that stays private until the patient approves: prescriptions/medicines and tests/reports. */
const CLINICAL_CONSENT_CATEGORIES = Object.freeze(
  CLINICAL_ACCESS_CATEGORIES.filter((c) => !CLINICAL_OPEN_CATEGORIES.includes(c))
);
/** Every value doctor_access_requests.category may hold. */
const ACCESS_CATEGORIES = Object.freeze([...DOCUMENT_ACCESS_CATEGORIES, ...CLINICAL_ACCESS_CATEGORIES]);
/** After a patient declines a category, the same doctor may ask again only after this. */
const CLINICAL_REREQUEST_COOLDOWN_HOURS = 24;
/** An unanswered request lapses after this many days. */
const ACCESS_REQUEST_TTL_DAYS = 7;
/** How long an approval lasts — the patient picks one; default 30. */
const ACCESS_GRANT_DAYS = Object.freeze([7, 30, 90]);
const ACCESS_GRANT_DEFAULT_DAYS = 30;
/** Max documents one approval may share. */
const ACCESS_MAX_ITEMS = 50;

/** Append-only access_audit_logs.action values. */
const ACCESS_AUDIT_ACTIONS = Object.freeze({
  PATIENT_SEARCH: "patient_search",
  PATIENT_VIEW: "patient_basic_view",
  REQUESTED: "access_requested",
  CANCELLED: "access_cancelled",
  APPROVED: "access_approved",
  REJECTED: "access_rejected",
  REVOKED: "access_revoked",
  EXPIRED: "access_expired",
  RECORD_DOWNLOADED: "record_downloaded",
  HISTORY_VIEWED: "clinical_history_viewed",
});

/** Package / strip photos a global medicine may carry (migration 037). */
const MAX_MEDICINE_IMAGES = 4;
/** Substitute medicines one medicine may list (migration 037). */
const MAX_MEDICINE_SUBSTITUTES = 12;

// ── Doctor EMR workspace (migration 051) ─────────────────────────────────────
/**
 * The structured consultation entries a doctor records. One table
 * (clinical_entries) keyed by `kind`; every entry is tied to the patient, the
 * authoring doctor and the visit (booking) it was written in.
 */
const CLINICAL_ENTRY_KIND = Object.freeze({
  COMPLAINT: "complaint",
  HISTORY: "history",
  COMORBIDITY: "comorbidity",
  EXAMINATION: "examination",
  DIAGNOSIS: "diagnosis",
  INVESTIGATION: "investigation",
  DOCTOR_NOTE: "doctor_note",
});
const CLINICAL_ENTRY_KINDS = Object.freeze(Object.values(CLINICAL_ENTRY_KIND));

/** Entries are never deleted — a wrong one is retired, keeping the history. */
const CLINICAL_ENTRY_STATUS = Object.freeze({
  ACTIVE: "active",
  ENTERED_IN_ERROR: "entered_in_error",
});

/**
 * How long the author may still correct an entry in place. After this window
 * (or once a doctor's note is published) the entry is final: it can only be
 * retired with a reason, never silently rewritten.
 */
const CLINICAL_ENTRY_EDIT_HOURS = 24;

/**
 * Who sees an entry by default. A doctor's note starts PRIVATE (a draft only
 * its author sees) and reaches the patient + other treating doctors only when
 * the doctor publishes it. Everything else is the patient's own clinical
 * information and is shown to them unless the doctor unticks it.
 */
const CLINICAL_ENTRY_DEFAULT_VISIBLE = Object.freeze({
  complaint: true,
  history: true,
  comorbidity: true,
  examination: true,
  diagnosis: true,
  investigation: true,
  doctor_note: false,
});

/**
 * Patient-history categories. `appliesTo` keeps irrelevant categories out of
 * the form (menstrual/obstetric only for female patients, neonatal and
 * developmental only for children) — a category is shown when the patient's
 * demographics are unknown, so nothing is hidden by missing data.
 */
const HISTORY_CATEGORIES = Object.freeze([
  { key: "hpi", label: "HPI (History of present illness)", fields: [
    { key: "presentIllness", label: "History of present illness", multiline: true },
    { key: "pastIllness", label: "History of past illness", multiline: true },
  ] },
  { key: "family", label: "Family history" },
  { key: "surgical", label: "Surgical history" },
  { key: "personal", label: "Personal history" },
  { key: "menstrual", label: "Menstrual history", appliesTo: { gender: "female" } },
  { key: "obstetric", label: "Obstetric history", appliesTo: { gender: "female" } },
  { key: "neonatal", label: "Neonatal history", appliesTo: { maxAge: 12 } },
  { key: "immunization", label: "Immunization history" },
  { key: "developmental", label: "Developmental history", appliesTo: { maxAge: 18 } },
  { key: "premorbid_personality", label: "Premorbid personality" },
  { key: "temperament", label: "Temperament" },
  { key: "other", label: "Other history" },
]);

/** Comorbidity groups (the screenshot's categories). The condition is free text. */
const COMORBIDITY_CATEGORIES = Object.freeze([
  { key: "diabetes", label: "Diabetes mellitus" },
  { key: "ckd", label: "Chronic kidney disease" },
  { key: "cardiac", label: "Cardiac" },
  { key: "pulmonary", label: "Pulmonary" },
  { key: "thyroid", label: "Thyroid" },
  { key: "hypertension", label: "Hypertension" },
  { key: "other", label: "Other" },
]);

/**
 * Examination forms: standard clinical examination HEADINGS, each a set of
 * free-text findings fields. These are structure, not clinical content — the
 * doctor writes every finding. IHS had no examination templates before 051.
 */
const EXAMINATION_FORMS = Object.freeze([
  { key: "general", label: "General examination", fields: [
    { key: "build", label: "Build / nourishment" },
    { key: "pallor", label: "Pallor" },
    { key: "icterus", label: "Icterus" },
    { key: "cyanosis", label: "Cyanosis" },
    { key: "clubbing", label: "Clubbing" },
    { key: "lymphadenopathy", label: "Lymphadenopathy" },
    { key: "oedema", label: "Oedema" },
  ] },
  { key: "systemic", label: "Systemic examination", fields: [
    { key: "cvs", label: "CVS", multiline: true },
    { key: "rs", label: "Respiratory system", multiline: true },
    { key: "abdomen", label: "Abdomen", multiline: true },
    { key: "cns", label: "CNS", multiline: true },
  ] },
  { key: "local", label: "Local examination", fields: [
    { key: "site", label: "Site" },
    { key: "findings", label: "Findings", multiline: true },
  ] },
  { key: "cns", label: "CNS examination", fields: [
    { key: "higherFunctions", label: "Higher mental functions", multiline: true },
    { key: "cranialNerves", label: "Cranial nerves", multiline: true },
    { key: "motor", label: "Motor system", multiline: true },
    { key: "sensory", label: "Sensory system", multiline: true },
    { key: "reflexes", label: "Reflexes" },
    { key: "gait", label: "Gait / coordination" },
  ] },
  { key: "ent", label: "ENT examination", fields: [
    { key: "ear", label: "Ear", multiline: true },
    { key: "nose", label: "Nose", multiline: true },
    { key: "throat", label: "Throat", multiline: true },
  ] },
  { key: "physical", label: "Physical examination (free text)", fields: [
    { key: "findings", label: "Findings", multiline: true },
  ] },
]);

const DIAGNOSIS_TYPES = Object.freeze(["provisional", "final", "differential"]);
const INVESTIGATION_TYPES = Object.freeze(["laboratory", "radiology", "cardiology", "package", "other"]);
const ORDER_PRIORITIES = Object.freeze(["routine", "urgent", "stat"]);
const DOCTOR_NOTE_TYPES = Object.freeze(["progress", "consultation", "procedure", "counselling", "other"]);
const MEDICINE_NAME_TYPES = Object.freeze(["trade", "generic"]);
const FOLLOW_UP_INTERVAL_UNITS = Object.freeze(["day", "week", "month"]);

/** access_audit_logs actions for the EMR workspace (sensitive clinical actions). */
const EMR_AUDIT_ACTIONS = Object.freeze({
  VIEW: "emr_patient_view",
  VITALS_ADDED: "emr_vitals_added",
  ENTRY_CREATED: "emr_entry_created",
  ENTRY_UPDATED: "emr_entry_updated",
  NOTE_PUBLISHED: "emr_note_published",
  ENTRY_RETIRED: "emr_entry_retired",
});

/**
 * Coding systems the admin ICD master accepts (migration 059). They are NOT
 * interchangeable — every catalogue row stores its system AND version, and a
 * code is unique only within that pair.
 */
const ICD_CODING_SYSTEMS = Object.freeze([
  Object.freeze({ key: "ICD-10", label: "ICD-10 (WHO)" }),
  Object.freeze({ key: "ICD-10-CM", label: "ICD-10-CM (US clinical modification)" }),
  Object.freeze({ key: "ICD-11", label: "ICD-11 MMS (WHO)" }),
]);
/** Rows per admin import request — the client sends a verified file in chunks (JSON body limit is 1 MB). */
const ICD_IMPORT_MAX_ROWS = 500;
/** Doctor diagnosis search: catalogue rows per query. */
const ICD_SEARCH_LIMIT = 20;
/** Excel import into the ICD & Diagnosis Master (migration 060). */
const ICD_EXCEL = Object.freeze({
  MAX_ROWS: 100000, // a full ICD-10-CM release is ~74k codes
  MAX_MB: 10,
  ISSUE_CAP: 500, // rows of each issue type returned in a preview
  SAMPLE_ROWS: 25, // new rows shown in a preview
  ERROR_SAMPLE: 50, // rejected rows kept on the audit record
  CHUNK: 1000, // rows per INSERT statement inside the import transaction
  DUPLICATE_POLICIES: Object.freeze(["skip", "update"]),
});

/** Display registration number built from the patient's real user id. */
const PATIENT_REG_PREFIX = "IHS-P-";

/** Workbench caps — the response flags `capped` so the UI can say so. */
const WORKBENCH_LIST_CAP = 300;
const WORKBENCH_UPCOMING_CAP = 100;


module.exports = {
  CLINICAL_ENTRY_KIND,
  CLINICAL_ENTRY_KINDS,
  CLINICAL_ENTRY_STATUS,
  CLINICAL_ENTRY_EDIT_HOURS,
  CLINICAL_ENTRY_DEFAULT_VISIBLE,
  HISTORY_CATEGORIES,
  COMORBIDITY_CATEGORIES,
  EXAMINATION_FORMS,
  DIAGNOSIS_TYPES,
  INVESTIGATION_TYPES,
  ORDER_PRIORITIES,
  DOCTOR_NOTE_TYPES,
  MEDICINE_NAME_TYPES,
  FOLLOW_UP_INTERVAL_UNITS,
  PATIENT_REG_PREFIX,
  EMR_AUDIT_ACTIONS,
  ICD_CODING_SYSTEMS,
  ICD_IMPORT_MAX_ROWS,
  ICD_SEARCH_LIMIT,
  ICD_EXCEL,
  WORKBENCH_LIST_CAP,
  WORKBENCH_UPCOMING_CAP,
  NOTIFICATION_TYPES,
  NOTIFICATION_REFS,
  ACQUISITION_GROUPS,
  ACQUISITION_SOURCES,
  ACQUISITION_CAPTURED_VIA,
  ACQUISITION_UTM_KEYS,
  PATIENT_MEDICINE_SOURCES,
  PATIENT_MEDICINE_STATUS,
  PATIENT_MEDICINE_STATUS_REASONS,
  DOSE_STATUS,
  DOSE_ACTIONS,
  DOSE_ACTION_SOURCES,
  DOSE_SNOOZE_MINUTES,
  DOSE_MISSED_AFTER_MINUTES,
  DOSE_WINDOW_DAYS,
  DOSE_NOTIFY_STALE_MINUTES,
  MAX_REMINDER_TIMES,
  MAX_MEDICINES_PER_REQUEST,
  MEDICINE_REMINDER_INTERVAL_MS,
  DEFAULT_PATIENT_TIMEZONE,
  FREQUENCY_DAILY_COUNT,
  REALTIME_NOTIFICATION_EVENT,
  ACCESS_REQUEST_STATUS,
  ACCESS_CATEGORIES,
  DOCUMENT_ACCESS_CATEGORIES,
  CLINICAL_ACCESS_CATEGORY,
  CLINICAL_ACCESS_CATEGORIES,
  CLINICAL_OPEN_CATEGORIES,
  CLINICAL_CONSENT_CATEGORIES,
  CLINICAL_REREQUEST_COOLDOWN_HOURS,
  ACCESS_REQUEST_TTL_DAYS,
  ACCESS_GRANT_DAYS,
  ACCESS_GRANT_DEFAULT_DAYS,
  ACCESS_MAX_ITEMS,
  ACCESS_AUDIT_ACTIONS,
  ROLES,
  SELF_REGISTERABLE_ROLES,
  PROVIDER_PORTAL_ROLES,
  DIAGNOSTIC_REQUEST_STATUS,
  DIAGNOSTIC_LAB_TRANSITIONS,
  DIAGNOSTIC_RESPONDABLE_STATUSES,
  DIAGNOSTIC_REPORTABLE_STATUSES,
  DIAGNOSTIC_TEST_STATUS,
  DIAGNOSTIC_REPORT_FILE_TYPES,
  DIAGNOSTIC_NOTIFICATION_REF,
  CLINIC_DOC_TYPES,
  CLINIC_REQUIRED_DOC_TYPES,
  CLINIC_ONBOARDING_REQUIRED_STEPS,
  RECORD_SOURCES,
  RECORD_FILE_TYPES,
  IDENTITY_FILE_TYPE,
  DOCUMENT_KIND_FILE_TYPE,
  DOCUMENT_KINDS,
  AUTH_PROVIDERS,
  ERROR_CODES,
  BCRYPT_COST,
  DOC_TYPES,
  GENDERS,
  LINK_TYPES,
  EXPERTISE_CATEGORIES,
  GALLERY_CATEGORIES,
  REQUIRED_DOC_TYPES,
  ONBOARDING_REQUIRED_STEPS,
  DAYS,
  SLOT_DEFAULT_MINUTES,
  MAX_SLOTS_PER_SCHEDULE,
  PATIENT_REQUIRED_FIELDS,
  BOOKING_MODES,
  BOOKING_STATUS,
  PAYMENT_STATUS,
  OFFLINE_PAYMENT_METHOD,
  BOOKING_PAYMENT_VIEW_ATTRS,
  PAYMENT_QR_IMAGE_MIME,
  PAYMENT_QR_MAX_BYTES,
  BOOKING_HOLD_MINUTES,
  SESSION_STATUS,
  QUEUE_STATE,
  LIVE_QUEUE_STATUSES,
  QUEUE_POLL_SECONDS,
  SESSION_AUTO_CLOSE_HOURS,
  AVG_CONSULT_MIN_SAMPLE,
  DEFAULT_CONSULT_MINUTES,
  SESSION_HORIZON_DAYS,
  SESSION_HORIZON_MAX_DAYS,
  PLATFORM_COMMISSION_PCT,
  SERIES_GRANULARITY,
  IST_OFFSET,
  DASHBOARD_DEFAULT_MONTHS,
  DASHBOARD_MAX_DAYS,
  LEDGER_PAGE_SIZE_DEFAULT,
  LEDGER_PAGE_SIZE_MAX,
  ADMIN_TOP_DOCTORS_LIMIT,
  ADMIN_MEDICINE_LOW_STOCK_THRESHOLD,
  PRESCRIPTION_STATUS,
  MEDICINE_ROUTES,
  MEDICINE_TIMINGS,
  MEDICINE_DURATION_UNITS,
  MEDICINE_FORMS,
  TEMPLATE_ASSET_KINDS,
  TEMPLATE_ASSET_MIME,
  PRESCRIPTION_PATIENT_FIELDS,
  MEDICINE_COLUMNS,
  PRESCRIPTION_FONTS,
  RX_ELIGIBLE_BOOKING_STATUSES,
  TIMELINE_BOOKING_STATUSES,
  TREATED_BOOKING_STATUSES,
  PATIENT_STATUSES,
  TIMELINE_ROW_CAP,
  TIMELINE_ROSTER_CAP,
  VIDEO_SESSION_STATUS,
  VIDEO_JOIN_LEAD_MINUTES,
  VIDEO_JOIN_GRACE_MINUTES,
  REFERRAL_STATUS,
  JOURNEY_STATUS,
  REFERRAL_TARGET_LIMIT,
  DOCTOR_SORTS,
  DOCTOR_PAGE_SIZE_DEFAULT,
  DOCTOR_PAGE_SIZE_MAX,
  DOCTOR_MAP_LIMIT,
  DOCTOR_RELATED_LIMIT,
  REMINDER_STATUS,
  REMINDER_CHANNEL,
  CHANNEL_STATUS,
  DEFAULT_REMINDER_DAYS_BEFORE,
  MAX_REMINDER_RETRIES,
  SCHEDULER_INTERVAL_MS,
  MEDICINE_TYPES,
  MEDICINE_ORDER_STATUS,
  MEDICINE_ORDER_TRANSITIONS,
  MEDICINE_ORDER_CANCELLABLE,
  MEDICINE_ORDER_CLOSED,
  MEDICINE_ORDER_PAYMENT_STATUS,
  MEDICINE_PAYMENT_METHOD,
  MEDICINE_LIVE_ON_PLACE_METHODS,
  MEDICINE_PAYMENT_GATEWAY,
  MEDICINE_PAYMENT_ATTEMPT_STATUS,
  MEDICINE_PROVIDER_TYPE,
  ACTIVE_MEDICINE_PROVIDER_ROLES,
  LEGACY_MEDICINE_PROVIDER_ROLES,
  ALL_MEDICINE_PROVIDER_ROLES,
  MEDICINE_PROVIDER_TYPE_LABELS,
  PRESCRIPTION_REQUEST_STATUS,
  PRESCRIPTION_ITEM_STATUS,
  MAX_MEDICINE_IMAGES,
  MAX_MEDICINE_SUBSTITUTES,
};
