/**
 * Model → API shape mappers. Controllers/services NEVER send a raw Sequelize
 * instance to the client — they run it through a serializer first. This is the
 * single boundary that guarantees `password_hash` (and any other internal
 * column) can never leak, and it maps snake_case DB columns to the camelCase
 * shape the frontend's types declare.
 */
const { doctorSlug, kebab } = require("./slug");
const { heroImageList } = require("./heroImages");
const { DAYS, SLOT_DEFAULT_MINUTES, OFFLINE_PAYMENT_METHOD } = require("../config/constants");
const vitalsRanges = require("../config/vitalsRanges");
const env = require("../config/env");

/** Normalize a Sequelize instance (or plain object) to a plain object. */
const plain = (row) => (row && typeof row.get === "function" ? row.get({ plain: true }) : row);

/** DB TIME ("HH:mm:ss") → "HH:mm" for the API/UI. */
const hhmm = (t) => (t == null ? null : String(t).slice(0, 5));

/**
 * @returns the public user shape the frontend expects:
 *   { id, name, email, role, avatarUrl, createdAt, updatedAt }
 */
function serializeUser(user) {
  if (!user) return null;
  const u = plain(user);
  return {
    id: String(u.id),
    name: u.name,
    email: u.email,
    role: u.role,
    phone: u.phone ?? null,
    avatarUrl: u.profilePhotoUrl ?? u.profile_photo_url ?? null,
    isEmailVerified: Boolean(u.isEmailVerified ?? u.is_email_verified),
    createdAt: u.createdAt ?? u.created_at ?? null,
    updatedAt: u.updatedAt ?? u.updated_at ?? null,
  };
}

/**
 * The patient's OWN profile (user fields + patient_profiles row) plus the
 * completeness `status` the booking gate reads. `status` is computed by
 * patient.service and passed in, so this serializer stays pure (no service
 * import → no circular dependency).
 */
function serializePatientProfile(user, status, completion) {
  if (!user) return null;
  const u = plain(user);
  const p = plain(u.patientProfile) || {};
  return {
    id: String(u.id),
    name: u.name,
    email: u.email,
    phone: u.phone ?? null,
    avatarUrl: u.profilePhotoUrl ?? null,
    dateOfBirth: p.dateOfBirth ?? null,
    gender: p.gender ?? null,
    bloodGroup: p.bloodGroup ?? "unknown",
    emergencyContactName: p.emergencyContactName ?? null,
    emergencyContactPhone: p.emergencyContactPhone ?? null,
    addressLine: p.addressLine ?? null,
    city: p.city ?? null,
    state: p.state ?? null,
    pincode: p.pincode ?? null,
    noKnownAllergies: Boolean(p.noKnownAllergies),
    noKnownConditions: Boolean(p.noKnownConditions),
    noCurrentMedications: Boolean(p.noCurrentMedications),
    status: status ?? null,
    completion: completion ?? null,
  };
}

// ── Patient health-record serializers (docs/patient-health-records) ──────────

/**
 * The record-table field spec — one COLUMN per vital, in display order
 * (docs/vitals-record-table). `Date` + `Location` are fixed leading columns the
 * component renders from each entry's `recordedOn`/`location`, so they are not
 * listed here. BMI is derived (never stored).
 */
/**
 * `normal` comes from config/vitalsRanges — the ONE place thresholds live, so a
 * client can render a legend or an axis without a second copy. Weight and
 * Height carry none: neither has an adult reference range (weight's signal is
 * BMI), and a field with no `normal` is never coloured.
 */
const VITALS_MATRIX_FIELDS = [
  { key: "weightKg", label: "Weight", unit: "kg" },
  { key: "heightCm", label: "Height", unit: "cm" },
  { key: "bmi", label: "BMI", unit: "", derived: true, normal: vitalsRanges.normalRangeFor("bmi") },
  { key: "pulseRateBpm", label: "Pulse", unit: "bpm", normal: vitalsRanges.normalRangeFor("pulseRateBpm") },
  { key: "bloodPressure", label: "BP", unit: "mmHg", normal: vitalsRanges.normalRangeFor("bloodPressure") },
  { key: "temperatureF", label: "Temp", unit: "°F", normal: vitalsRanges.normalRangeFor("temperatureF") },
  { key: "spo2Percent", label: "SpO₂", unit: "%", normal: vitalsRanges.normalRangeFor("spo2Percent") },
];

/**
 * The FULL vitals field set the doctor EMR workspace shows (migration 051), in
 * the screenshot's column order. A superset of VITALS_MATRIX_FIELDS: older
 * views keep their shorter list, so their tables don't sprout empty columns.
 * BMI and the waist-to-hip ratio are derived, never stored.
 */
const VITALS_EMR_FIELDS = [
  { key: "weightKg", label: "Weight", unit: "kg" },
  { key: "heightCm", label: "Height", unit: "cm" },
  { key: "bmi", label: "BMI", unit: "kg/m²", derived: true, normal: vitalsRanges.normalRangeFor("bmi") },
  { key: "waistCm", label: "Waist", unit: "cm" },
  { key: "hipCm", label: "Hip", unit: "cm" },
  { key: "waistHipRatio", label: "Waist-hip ratio", unit: "", derived: true },
  { key: "temperatureF", label: "Temperature", unit: "°F", normal: vitalsRanges.normalRangeFor("temperatureF") },
  { key: "spo2Percent", label: "SpO₂", unit: "%", normal: vitalsRanges.normalRangeFor("spo2Percent") },
  { key: "respiratoryRate", label: "Respiratory rate", unit: "/min", normal: vitalsRanges.normalRangeFor("respiratoryRate") },
  { key: "pulseRateBpm", label: "Pulse rate", unit: "bpm", normal: vitalsRanges.normalRangeFor("pulseRateBpm") },
  { key: "heartRateBpm", label: "Heart rate", unit: "bpm", normal: vitalsRanges.normalRangeFor("heartRateBpm") },
  { key: "bpSystolic", label: "BP systolic", unit: "mmHg" },
  { key: "bpDiastolic", label: "BP diastolic", unit: "mmHg" },
  { key: "headCircumferenceCm", label: "Head circumference", unit: "cm" },
];

/**
 * The vitals timeline as the record-table matrix: `fields` (rows) + `entries`
 * (columns, newest-first). BMI is derived here (single source of truth); DECIMAL
 * columns come back from mysql2 as strings, so they're coerced to numbers.
 */
function serializePatientVitals(rows, { age = null, fields = VITALS_MATRIX_FIELDS } = {}) {
  const num = (v) => (v == null ? null : Number(v));
  const entries = (rows || []).map(plain).map((r) => {
    const weightKg = num(r.weightKg);
    const heightCm = num(r.heightCm);
    const bmi =
      weightKg != null && heightCm ? Math.round((weightKg / (heightCm / 100) ** 2) * 10) / 10 : null;
    const waistCm = num(r.waistCm);
    const hipCm = num(r.hipCm);
    // Systolic/diastolic: the 051 columns, else parsed from the legacy string
    // ("120/80") — the same reading, never an invented one.
    const parsedBp = vitalsRanges.parseBloodPressure(r.bloodPressure);
    const values = {
      bloodPressure: r.bloodPressure ?? null,
      pulseRateBpm: num(r.pulseRateBpm),
      weightKg,
      heightCm,
      temperatureF: num(r.temperatureF),
      spo2Percent: num(r.spo2Percent),
      bmi,
      // Migration 051 — null on every older row.
      bpSystolic: num(r.bpSystolic) ?? parsedBp?.systolic ?? null,
      bpDiastolic: num(r.bpDiastolic) ?? parsedBp?.diastolic ?? null,
      heartRateBpm: num(r.heartRateBpm),
      respiratoryRate: num(r.respiratoryRate),
      waistCm,
      hipCm,
      waistHipRatio: waistCm != null && hipCm ? Math.round((waistCm / hipCm) * 100) / 100 : null,
      headCircumferenceCm: num(r.headCircumferenceCm),
    };
    return {
      id: String(r.id),
      recordedOn: r.recordedOn, // DATEONLY "YYYY-MM-DD"
      // The exact time (migration 051); null on older date-only rows.
      recordedAt: isoOrNull(r.recordedAt),
      bookingId: r.bookingId != null ? String(r.bookingId) : null,
      source: r.source,
      // The author's name for the source chip. NULL on every pre-existing row
      // and on any row whose author account was since deleted.
      recordedBy: r.recordedBy ? { id: String(r.recordedBy.id), name: r.recordedBy.name } : null,
      note: r.note ?? null,
      location: r.location ?? null,
      values,
      // A PARALLEL map, deliberately — `values` stays exactly as it was, so the
      // prescription prefill, the render view and the PDF keep working with no
      // changes. Nesting { value, status } inside `values` would break them all.
      statuses: vitalsRanges.evaluateEntry(values, { age }),
    };
  });
  return { fields, entries };
}

// ── Follow-up statuses (docs/follow-up-status) ───────────────────────────────
/**
 * A timestamp as ISO, or null.
 *
 * `new Date(null)` is an INVALID Date, not null — and `.toISOString()` on one
 * throws `RangeError: Invalid time value`, which took down the whole bookings
 * list for one row with a null `updated_at`. Serializers must never be the
 * thing that 500s a list.
 */
function isoOrNull(value) {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * One option on the doctor's own list. `inUse` is only present on the options
 * page's payload — the roster doesn't need it, and counting on every read of
 * every roster row would be an N+1 for a number nobody is looking at.
 */
function serializeFollowUpStatus(s) {
  if (!s) return null;
  const x = plain(s);
  return {
    id: String(x.id),
    label: x.label,
    colorHex: x.colorHex,
    sortOrder: x.sortOrder ?? 0,
    isActive: Boolean(x.isActive),
    ...(x.inUse != null ? { inUse: Number(x.inUse) } : {}),
  };
}

/**
 * A patient's CURRENT follow-up, as a roster row carries it. Null when this
 * doctor has not tagged this patient — which is every patient until they do.
 */
function serializeFollowUp(f) {
  if (!f) return null;
  const x = plain(f);
  return {
    status: serializeFollowUpStatus(x.status),
    // DATEONLY — "YYYY-MM-DD", no timezone. The UI must parse it as a LOCAL
    // date; `new Date("2026-09-01")` is UTC and lands a day early west of
    // Greenwich, which would show the wrong follow-up day.
    followUpOn: x.followUpOn ?? null,
    note: x.note ?? null,
    bookingId: x.bookingId != null ? String(x.bookingId) : null,
    // The EMR follow-up plan (migration 051); null/false on older rows.
    intervalValue: x.intervalValue ?? null,
    intervalUnit: x.intervalUnit ?? null,
    homeCare: Boolean(x.homeCare),
    serviceName: x.serviceName ?? null,
    serviceQuantity: x.serviceQuantity ?? null,
    comments: x.comments ?? null,
    updatedAt: isoOrNull(x.updatedAt),
  };
}

// ── Automatic follow-up reminders (docs/follow-up-reminders-07-09-2026) ─────

/** A reminder row as the doctor sees it on the appointment detail. */
function serializeReminder(r) {
  if (!r) return null;
  const x = plain(r);
  return {
    id: String(x.id),
    bookingId: String(x.bookingId),
    followUpOn: x.followUpOn,
    reminderAt: isoOrNull(x.reminderAt),
    channel: x.channel,
    status: x.status,
    emailStatus: x.emailStatus,
    whatsappStatus: x.whatsappStatus,
    sentAt: isoOrNull(x.sentAt),
  };
}

/** An upcoming follow-up as the patient dashboard displays it. */
function serializeUpcomingFollowUp(r) {
  if (!r) return null;
  const x = plain(r);
  const booking = x.booking || {};
  const doctor = booking.doctor || {};
  const doctorUser = doctor.user || {};
  const clinic = booking.clinic || {};
  return {
    id: String(x.id),
    bookingId: String(x.bookingId),
    doctorName: doctorUser.name || "",
    clinicName: clinic.name || null,
    clinicCity: clinic.city || null,
    followUpOn: x.followUpOn,
    status: x.status,
    reminder:
      x.status !== "cancelled"
        ? { status: x.status, channel: x.channel }
        : null,
  };
}

/** One allergy row (junction + joined lookup name). */
function serializeAllergyEntry(row) {
  const x = plain(row);
  return {
    name: x.allergy?.name ?? null,
    severity: x.severity ?? null,
    ...serializeRecordSource(x),
  };
}

/** One chronic-condition row (junction + joined lookup name). */
function serializeConditionEntry(row) {
  const x = plain(row);
  return {
    name: x.condition?.name ?? null,
    diagnosedYear: x.diagnosedYear ?? null,
    ...serializeRecordSource(x),
  };
}

/** One current-medication row. */
function serializeMedication(row) {
  const x = plain(row);
  return {
    id: String(x.id),
    medicineName: x.medicineName,
    dosage: x.dosage ?? null,
    frequency: x.frequency ?? null,
    startedOn: x.startedOn ?? null,
    notes: x.notes ?? null,
  };
}

/** One uploaded-record row. */
function serializeUploadedRecord(row) {
  const x = plain(row);
  return {
    id: String(x.id),
    fileUrl: x.fileUrl,
    fileType: x.fileType,
    recordDate: x.recordDate ?? null,
    tag: x.tag ?? null,
    location: x.location ?? null,
    // Document-library fields (migration 058) — null on older rows.
    documentKind: x.documentKind ?? null,
    doctorName: x.doctorName ?? null,
    description: x.description ?? null,
    // Last four digits only; the UI masks the rest ("XXXX XXXX 1234").
    idLast4: x.idLast4 ?? null,
    originalName: x.originalName ?? null,
    mimeType: x.mimeType ?? null,
    fileSize: x.fileSize ?? null,
    updatedAt: x.updatedAt instanceof Date ? x.updatedAt.toISOString() : (x.updatedAt ?? null),
    uploadedAt: x.uploadedAt instanceof Date ? x.uploadedAt.toISOString() : x.uploadedAt,
    // Who uploaded it (migration 018). "patient" + null on every pre-existing row.
    ...serializeRecordSource(x),
  };
}

// ── Bookings & payments serializers ─────────────────────────────────────────
/** Whole years between a date-of-birth and today (null if no DOB). */
function ageFrom(dob) {
  if (!dob) return null;
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  let age = now.getUTCFullYear() - d.getUTCFullYear();
  const m = now.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < d.getUTCDate())) age -= 1;
  return age;
}

/** Frontend booking mode from the DB's booking_type. */
const bookingMode = (bookingType) => (bookingType === "online" ? "video" : "clinic");

/**
 * "Booked by X Clinic" (migration 019) — NULL for every direct patient→doctor
 * booking, which is what the absence of this key means to the frontends.
 *
 * Falls back to the account's `name` when the clinic profile isn't eager-loaded,
 * so the attribution never silently disappears.
 */
function serializeBookedBy(row) {
  const agent = plain(row);
  if (!agent) return null;
  const profile = plain(agent.clinicProfile) || {};
  return {
    id: String(agent.id),
    role: agent.role ?? null,
    name: profile.clinicName ?? agent.name ?? null,
    phone: profile.phone ?? null,
    city: profile.city ?? null,
  };
}

/**
 * A booking's payment state, as both the patient and the doctor see it.
 * `status` is the key every existing client reads; the rest is migration 044:
 * how an offline payment is collected (cash at the clinic / the doctor's UPI
 * QR) and what the patient REPORTED paying — unverified, for the doctor to
 * check in their UPI app before marking it paid.
 */
function serializeBookingPayment(p) {
  const x = plain(p);
  if (!x) return null;
  return {
    status: x.status,
    mode: x.mode ?? null,
    // NULL on an offline row written before the column existed = cash.
    offlineMethod: x.mode === "offline" ? (x.offlineMethod ?? OFFLINE_PAYMENT_METHOD.CASH) : null,
    payerReference: x.payerReference ?? null,
    reportedAt: isoOrNull(x.payerReportedAt),
  };
}

/**
 * A provider's own payment QR (migration 044), as the provider manages it.
 * `configured` = patients are offered it right now (active AND has an image).
 * A provider who never set one up gets the empty shape, not a 404.
 */
function serializePaymentQr(row) {
  const x = plain(row);
  if (!x) {
    return { upiId: null, payeeName: null, qrImageUrl: null, isActive: false, updatedAt: null, configured: false };
  }
  return {
    upiId: x.upiId ?? null,
    payeeName: x.payeeName ?? null,
    qrImageUrl: x.qrImageUrl ?? null,
    isActive: Boolean(x.isActive),
    updatedAt: isoOrNull(x.updatedAt),
    configured: Boolean(x.isActive && x.qrImageUrl),
  };
}

/**
 * What a patient needs to pay a provider's UPI QR for ONE booking / order:
 * whom (payee name + UPI id + QR image), how much, and the reference to put in
 * the UPI note — plus where the payment stands. Built by the booking / order
 * services; `offlineMethod` is present on bookings only.
 */
function serializeQrPaymentRequest(r) {
  return {
    payee: {
      name: r.qr.payeeName || r.fallbackName || null,
      upiId: r.qr.upiId ?? null,
      qrImageUrl: r.qr.qrImageUrl ?? null,
    },
    amount: Math.round(Number(r.amount || 0) * 100) / 100,
    currency: "INR",
    reference: r.reference,
    paymentStatus: r.paymentStatus,
    ...(r.offlineMethod !== undefined ? { offlineMethod: r.offlineMethod } : {}),
    reportedAt: isoOrNull(r.reportedAt),
    payerReference: r.payerReference ?? null,
  };
}

/** A booking as the PATIENT sees it (doctor + clinic summary + payment state). */
function serializeBookingForPatient(b) {
  const x = plain(b);
  const doctor = plain(x.doctor) || {};
  const dUser = plain(doctor.user) || {};
  const primarySpec = (doctor.specializations || []).map(plain)[0];
  const clinic = plain(x.clinic);
  const payment = plain(x.payment);
  return {
    id: String(x.id),
    mode: bookingMode(x.bookingType),
    doctor: {
      id: doctor.userId != null ? String(doctor.userId) : null,
      name: dUser.name ?? null,
      slug: doctor.userId != null ? doctorSlug(dUser.name, doctor.userId) : null,
      specialtyName: primarySpec?.name ?? null,
      photoUrl: dUser.profilePhotoUrl ?? null,
    },
    clinic: clinic ? { name: clinic.name, address: clinic.addressLine, city: clinic.city ?? null } : null,
    date: x.slotDate,
    /**
     * The SESSION'S window, shared by everyone in the queue — not a personal
     * appointment time. The patient's own place is `queueNumber`, and where
     * they stand right now comes from GET /patient/bookings/:id/queue.
     */
    startTime: hhmm(x.slotStartTime),
    endTime: hhmm(x.slotEndTime),
    queueNumber: x.queueNumber ?? null,
    queueState: x.queueState ?? null,
    status: x.status,
    amount: x.amount != null ? Number(x.amount) : 0,
    paymentMode: x.paymentMode,
    // The care episode this consult belongs to (docs/multi-doctor-referrals) —
    // present when a referral touched this booking; lets the appointment card
    // expand its whole multi-doctor care journey inline.
    journeyId: x.journeyId != null ? String(x.journeyId) : null,
    meetLink: x.meetLink ?? null,
    payment: serializeBookingPayment(payment),
    // Who arranged it. NULL when the patient booked it themselves — the
    // direct flow, unchanged. Non-null renders "via X Clinic".
    bookedBy: serializeBookedBy(x.bookedBy),
    createdAt: x.createdAt instanceof Date ? x.createdAt.toISOString() : x.createdAt,
    updatedAt: x.updatedAt instanceof Date ? x.updatedAt.toISOString() : x.updatedAt,
  };
}

/** A booking as the DOCTOR sees it in their appointments list (patient summary). */
function serializeBookingForDoctor(b) {
  const x = plain(b);
  const patient = plain(x.patient) || {};
  const clinic = plain(x.clinic);
  const payment = plain(x.payment);
  return {
    id: String(x.id),
    mode: bookingMode(x.bookingType),
    patient: {
      id: patient.id != null ? String(patient.id) : null,
      name: patient.name ?? null,
      // The roster row's avatar. Null until the patient uploads one — the row
      // falls back to their initials.
      photoUrl: patient.profilePhotoUrl ?? null,
      // Age / phone / address print under the name on the roster
      // (docs/follow-up-status §4.4). All null on a booking whose patient never
      // completed their profile, which the row renders as a shorter cell.
      phone: patient.phone ?? null,
      age: ageFrom(plain(patient.patientProfile)?.dateOfBirth),
      gender: plain(patient.patientProfile)?.gender ?? null,
      addressLine: plain(patient.patientProfile)?.addressLine ?? null,
      city: plain(patient.patientProfile)?.city ?? null,
      state: plain(patient.patientProfile)?.state ?? null,
    },
    // Where this booking stands in its day (docs/consultation-queue). NULL on
    // every booking made before the queue existed, which the clients render as
    // the fixed appointment it was.
    queueNumber: x.queueNumber ?? null,
    queueState: x.queueState ?? null,
    session: x.session
      ? {
          id: String(plain(x.session).id),
          startTime: hhmm(plain(x.session).startTime),
          endTime: hhmm(plain(x.session).endTime),
          status: plain(x.session).status,
        }
      : null,
    // The patient's CURRENT follow-up for this doctor, or null when untagged.
    // Attached by booking.service.listForDoctor; absent on the single-booking
    // reads, where the composer fetches it directly.
    followUp: serializeFollowUp(x.followUp),
    // Who sent this patient here, and who they were sent on to. Attached by
    // booking.service.listForDoctor in one page-wide query; null on every other
    // read of this shape, which is why the column tolerates its absence.
    referrals: serializeBookingReferrals(x.referrals),
    clinic: clinic
      ? { id: clinic.id != null ? String(clinic.id) : null, name: clinic.name, city: clinic.city ?? null }
      : null,
    date: x.slotDate,
    startTime: hhmm(x.slotStartTime),
    endTime: hhmm(x.slotEndTime),
    status: x.status,
    amount: x.amount != null ? Number(x.amount) : 0,
    paymentMode: x.paymentMode,
    // The in-app "Join call" deep link for a video consult (docs/video-consultation);
    // null for clinic bookings and until the video booking is paid/provisioned.
    meetLink: x.meetLink ?? null,
    payment: serializeBookingPayment(payment),
    // Who arranged it. NULL when the patient booked it themselves — the
    // direct flow, unchanged. Non-null renders "via X Clinic".
    bookedBy: serializeBookedBy(x.bookedBy),
    createdAt: x.createdAt instanceof Date ? x.createdAt.toISOString() : x.createdAt,
  };
}

/**
 * One patient document as a DOCTOR may see it — only ever called on rows the
 * consent gate already allowed (clinicalAccess.recordAllowed, or a document-
 * level grant). The document-library metadata of migration 058 rides along;
 * `idLast4` never does (identity documents never reach a doctor at all).
 * `fileUrl` becomes a short-lived signed link in the response replacer.
 */
function serializeDoctorDocument(row, extra = {}) {
  const r = plain(row);
  return {
    // The row id, so the doctor view can PATCH a record's date in place.
    id: r.id != null ? String(r.id) : null,
    fileUrl: r.fileUrl,
    tag: r.tag ?? null,
    recordDate: r.recordDate ?? null,
    uploadedAt: isoOrNull(r.uploadedAt),
    fileType: r.fileType ?? null,
    documentKind: r.documentKind ?? null,
    location: r.location ?? null,
    doctorName: r.doctorName ?? null,
    description: r.description ?? null,
    originalName: r.originalName ?? null,
    mimeType: r.mimeType ?? null,
    fileSize: r.fileSize ?? null,
    updatedAt: isoOrNull(r.updatedAt),
    ...serializeRecordSource(r),
    ...extra,
  };
}

/**
 * The patient's clinical snapshot the doctor sees for a confirmed booking — the
 * data the patient saved (PRD §4.5). Allergies/conditions/medications/records
 * are reserved (their own models/endpoints land later); demographics ship now.
 */
function serializePatientSnapshot(user) {
  if (!user) return null;
  const u = plain(user);
  const p = u.patientProfile || {};
  // belongsToMany attaches the junction row under the through model's name.
  const allergies = (p.allergies || []).map((a) => ({
    name: a.name ?? null,
    severity: a.PatientAllergy?.severity ?? a.severity ?? null,
  }));
  const conditions = (p.conditions || []).map((c) => ({
    name: c.name ?? null,
    diagnosedYear: c.PatientCondition?.diagnosedYear ?? c.diagnosedYear ?? null,
  }));
  const currentMedications = (p.medications || []).map((m) => ({
    medicineName: m.medicineName,
    dosage: m.dosage ?? null,
    frequency: m.frequency ?? null,
  }));
  // Same shape as the workbench's document list (plus the 058 metadata).
  const uploadedRecords = (u.uploadedRecords || []).map((r) => serializeDoctorDocument(r));
  return {
    name: u.name ?? null,
    phone: u.phone ?? null,
    photoUrl: u.profilePhotoUrl ?? null,
    age: ageFrom(p.dateOfBirth),
    dateOfBirth: p.dateOfBirth ?? null,
    gender: p.gender ?? null,
    bloodGroup: p.bloodGroup ?? "unknown",
    addressLine: p.addressLine ?? null,
    city: p.city ?? null,
    state: p.state ?? null,
    allergies,
    conditions,
    currentMedications,
    uploadedRecords,
  };
}

/**
 * A Razorpay order for the client's Checkout call. `keyId` is the PUBLIC key
 * only — the secret never appears in a response. `amount` is paise (as Razorpay
 * returns it).
 */
function serializeRazorpayOrder(order) {
  if (!order) return null;
  return {
    orderId: order.id,
    amount: order.amount,
    currency: order.currency || "INR",
    keyId: env.RAZORPAY_KEY_ID,
  };
}

// ── Video consultation (docs/video-consultation) ─────────────────────────────
/** The runtime state of a video consult's LiveKit room (audit/"who's here"). */
function serializeVideoSession(s) {
  if (!s) return null;
  const x = plain(s);
  return {
    status: x.status,
    roomName: x.roomName,
    startedAt: x.startedAt instanceof Date ? x.startedAt.toISOString() : (x.startedAt ?? null),
    endedAt: x.endedAt instanceof Date ? x.endedAt.toISOString() : (x.endedAt ?? null),
    durationSec: x.durationSec != null ? Number(x.durationSec) : null,
    doctorJoined: Boolean(x.doctorJoinedAt),
    patientJoined: Boolean(x.patientJoinedAt),
  };
}

/**
 * A LiveKit join grant for the client. `url` is the PUBLIC SFU URL and `token`
 * is a short-lived, room-scoped JWT — the API secret NEVER appears here (same
 * public-only discipline as serializeRazorpayOrder's keyId).
 */
function serializeVideoToken({ url, token, roomName, session }) {
  return {
    url,
    token,
    roomName,
    session: session ? serializeVideoSession(session) : null,
  };
}

// ── Doctor portfolio child serializers ──────────────────────────────────────
function serializeSpecialization(s) {
  if (!s) return null;
  const x = plain(s);
  return { id: x.id, name: x.name, slug: x.slug };
}

/** Sub-specialty carries its parent id so pickers can group/filter by parent. */
function serializeSubSpecialization(s) {
  if (!s) return null;
  const x = plain(s);
  return { id: x.id, name: x.name, slug: x.slug, specializationId: x.specializationId };
}

/**
 * Public education timeline, most recent COMPLETION year (`yearTo`) first.
 * Entries without a completion year go last; ties keep their stored order
 * (Array#sort is stable). Display order only — the stored rows are untouched.
 * `year` keeps its old meaning (yearTo, else yearFrom) for existing clients.
 */
function serializePublicEducation(rows) {
  const validYear = (y) => (Number.isInteger(y) && y > 0 ? y : null);
  return (rows || [])
    .map((e) => {
      const x = plain(e);
      const yearFrom = validYear(x.yearFrom);
      const yearTo = validYear(x.yearTo);
      return {
        degree: x.degree,
        institution: x.institution,
        fieldOfStudy: x.fieldOfStudy ?? null,
        location: x.location || null,
        yearFrom,
        yearTo,
        year: yearTo ?? yearFrom ?? 0,
      };
    })
    .sort((a, b) => {
      if (a.yearTo == null && b.yearTo == null) return 0;
      if (a.yearTo == null) return 1;
      if (b.yearTo == null) return -1;
      return b.yearTo - a.yearTo;
    });
}

function serializeLanguage(l) {
  if (!l) return null;
  const x = plain(l);
  return { id: x.id, name: x.name };
}

function serializeAward(a) {
  const x = plain(a);
  return {
    id: String(x.id),
    title: x.title,
    issuer: x.issuer ?? null,
    description: x.description ?? null,
    awardYear: x.awardYear ?? null,
    imageUrl: x.imageUrl ?? null,
  };
}

/** A doctor-managed testimonial (migration 048), as the doctor manages it. */
function serializeTestimonial(t) {
  const x = plain(t);
  return {
    id: String(x.id),
    patientName: x.patientName,
    patientPhotoUrl: x.patientPhotoUrl ?? null,
    reviewText: x.reviewText,
    rating: Number(x.rating),
    reviewDate: x.reviewDate ?? null,
    isVisible: Boolean(x.isVisible),
    displayOrder: x.displayOrder ?? 0,
  };
}

/** Display order, then id — the order the doctor arranged. */
const byDisplayOrder = (a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0) || Number(a.id) - Number(b.id);

/**
 * The public face of the testimonials: visible ones only, in the doctor's
 * order, without the management flags. `source` tells every client these were
 * shared by the doctor — not verified patient reviews.
 */
function serializePublicTestimonials(rows) {
  return (rows || [])
    .map(serializeTestimonial)
    .filter((t) => t.isVisible)
    .sort(byDisplayOrder)
    .map(({ isVisible: _v, displayOrder: _o, ...t }) => ({ ...t, source: "doctor" }));
}

function serializeLink(l) {
  const x = plain(l);
  return { id: String(x.id), linkType: x.linkType, url: x.url };
}

function serializeDocument(d) {
  const x = plain(d);
  return {
    id: String(x.id),
    docType: x.docType,
    fileUrl: x.fileUrl,
    uploadedAt: x.uploadedAt ?? null,
  };
}

function serializeKeyword(k) {
  const x = plain(k);
  return { id: String(x.id), keyword: x.keyword, weight: x.weight, isApproved: Boolean(x.isApproved) };
}

// ── Portfolio v2 section serializers ─────────────────────────────────────────
/** A positive whole year, else null (0 / blank / garbage never sorts as a year). */
const validYearOrNull = (y) => (Number.isInteger(y) && y > 0 ? y : null);

/**
 * Newest first by `yearOf(item)`; items without a valid year go last. Stable,
 * so equal / missing years keep the incoming order (callers pre-sort by the
 * doctor's display order). Returns a NEW array — display order only, the
 * stored rows are untouched.
 */
function sortByYearDesc(items, yearOf) {
  return [...items].sort((a, b) => {
    const ya = validYearOrNull(yearOf(a));
    const yb = validYearOrNull(yearOf(b));
    if (ya == null && yb == null) return 0;
    if (ya == null) return 1;
    if (yb == null) return -1;
    return yb - ya;
  });
}

function serializeEducation(e) {
  const x = plain(e);
  return {
    id: String(x.id),
    degree: x.degree,
    institution: x.institution,
    fieldOfStudy: x.fieldOfStudy ?? null,
    location: x.location ?? null,
    yearFrom: x.yearFrom ?? null,
    yearTo: x.yearTo ?? null,
    displayOrder: x.displayOrder ?? 0,
  };
}

function serializeExperience(e) {
  const x = plain(e);
  return {
    id: String(x.id),
    organization: x.organization,
    roleTitle: x.roleTitle,
    location: x.location ?? null,
    startYear: x.startYear ?? null,
    endYear: x.endYear ?? null,
    isCurrent: Boolean(x.isCurrent),
    description: x.description ?? null,
    displayOrder: x.displayOrder ?? 0,
  };
}

function serializeService(s) {
  const x = plain(s);
  return {
    id: String(x.id),
    name: x.name,
    description: x.description ?? null,
    displayOrder: x.displayOrder ?? 0,
  };
}

function serializePublication(p) {
  const x = plain(p);
  return {
    id: String(x.id),
    title: x.title,
    authors: x.authors ?? null,
    publisher: x.publisher ?? null,
    year: x.year ?? null,
    url: x.url ?? null,
    doi: x.doi ?? null,
    abstract: x.abstract ?? null,
    category: x.category ?? null,
    displayOrder: x.displayOrder ?? 0,
  };
}

/** The doctor's own view: the membership number is always included. */
function serializeMembership(m) {
  const x = plain(m);
  return {
    id: String(x.id),
    organization: x.organization,
    roleTitle: x.roleTitle ?? null,
    membershipNumber: x.membershipNumber ?? null,
    showMembershipNumber: Boolean(x.showMembershipNumber),
    sinceYear: x.sinceYear ?? null,
    validUntilYear: x.validUntilYear ?? null,
    description: x.description ?? null,
    displayOrder: x.displayOrder ?? 0,
  };
}

/**
 * The public face of a membership: the number appears only when the doctor
 * chose to show it, and the privacy flag itself is never sent.
 */
function serializePublicMembership(m) {
  const { membershipNumber, showMembershipNumber, ...rest } = serializeMembership(m);
  return { ...rest, membershipNumber: showMembershipNumber && membershipNumber ? membershipNumber : null };
}

function serializeGalleryImage(g) {
  const x = plain(g);
  return {
    id: String(x.id),
    imageUrl: x.imageUrl,
    title: x.title ?? null,
    caption: x.caption ?? null,
    category: x.category ?? null,
    altText: x.altText ?? null,
    takenOn: x.takenOn ?? null,
    displayOrder: x.displayOrder ?? 0,
  };
}

// ── Migration 049 sections ───────────────────────────────────────────────────
function serializeAffiliation(a) {
  const x = plain(a);
  return {
    id: String(x.id),
    organization: x.organization,
    roleTitle: x.roleTitle ?? null,
    department: x.department ?? null,
    location: x.location ?? null,
    startYear: x.startYear ?? null,
    endYear: x.endYear ?? null,
    isCurrent: Boolean(x.isCurrent),
    website: x.website ?? null,
    phone: x.phone ?? null,
    displayOrder: x.displayOrder ?? 0,
  };
}

function serializeFellowship(f) {
  const x = plain(f);
  return {
    id: String(x.id),
    title: x.title,
    institution: x.institution,
    specialtyArea: x.specialtyArea ?? null,
    location: x.location ?? null,
    startYear: x.startYear ?? null,
    endYear: x.endYear ?? null,
    description: x.description ?? null,
    displayOrder: x.displayOrder ?? 0,
  };
}

function serializeExpertise(e) {
  const x = plain(e);
  return {
    id: String(x.id),
    category: x.category,
    name: x.name,
    description: x.description ?? null,
    displayOrder: x.displayOrder ?? 0,
  };
}

/**
 * Public ordering for the year-based portfolio lists. Each list first takes
 * the doctor's arranged order (display order, then id) so ties and undated
 * entries stay put, then the section's OWN year field decides:
 *   affiliations  current ones first, then most recent start;
 *   fellowships   most recent completion (end) year;
 *   publications  most recent publication year;
 *   memberships   most recent joining year;
 *   awards        most recent award year.
 */
function publicPortfolioLists(p) {
  const arranged = (rows, serialize) => (rows || []).map(serialize).sort(byDisplayOrder);
  const affiliations = sortByYearDesc(arranged(p.affiliations, serializeAffiliation), (a) => a.startYear).sort(
    (a, b) => Number(b.isCurrent) - Number(a.isCurrent)
  );
  const categoryRank = ["clinical", "scientific", "area", "interest"];
  return {
    affiliations,
    fellowships: sortByYearDesc(arranged(p.fellowships, serializeFellowship), (f) => f.endYear),
    publications: sortByYearDesc(arranged(p.publications, serializePublication), (x) => x.year),
    memberships: sortByYearDesc(arranged(p.memberships, serializePublicMembership), (m) => m.sinceYear),
    awards: sortByYearDesc(
      (p.awards || []).map(serializeAward).sort((a, b) => Number(a.id) - Number(b.id)),
      (a) => a.awardYear
    ),
    gallery: arranged(p.gallery, serializeGalleryImage),
    expertise: arranged(p.expertise, serializeExpertise).sort(
      (a, b) => categoryRank.indexOf(a.category) - categoryRank.indexOf(b.category)
    ),
  };
}

function serializeFaq(f) {
  const x = plain(f);
  return {
    id: String(x.id),
    question: x.question,
    answer: x.answer,
    displayOrder: x.displayOrder ?? 0,
  };
}

function serializeInsurance(i) {
  const x = plain(i);
  return { id: x.id, name: x.name };
}

// ── Clinics & availability serializers ──────────────────────────────────────
/** One weekly slot (clinic or online), owner-editor shape. */
function serializeWeeklySlot(s) {
  const x = plain(s);
  return {
    id: String(x.id),
    dayOfWeek: x.dayOfWeek,
    startTime: hhmm(x.startTime),
    endTime: hhmm(x.endTime),
    slotDurationMinutes: x.slotDurationMinutes ?? SLOT_DEFAULT_MINUTES,
    /**
     * The same number under the name it now means. Since the consultation queue
     * this is expected minutes PER PATIENT — it seeds the waiting estimate and
     * no longer slices the window into bookable times. Both keys are sent so
     * the rename does not have to land in three frontends on the same day.
     */
    avgConsultMinutes: x.slotDurationMinutes ?? SLOT_DEFAULT_MINUTES,
    /** NULL = unlimited, the default. */
    maxBookings: x.maxBookings ?? null,
    isActive: Boolean(x.isActive),
  };
}

/** A blocked-date exception. */
function serializeException(e) {
  const x = plain(e);
  return {
    id: String(x.id),
    clinicId: x.clinicId != null ? String(x.clinicId) : null,
    exceptionDate: x.exceptionDate,
    reason: x.reason ?? null,
  };
}

/**
 * The doctor's OWN clinic (editor shape): scalar fields as stored + the full
 * per-day `availability[]`. `lat`/`lng`/`offlineFee` are DECIMAL (string from
 * Sequelize) → coerced to Number.
 */
function serializeOwnClinic(c) {
  const x = plain(c);
  return {
    id: String(x.id),
    name: x.name,
    addressLine: x.addressLine,
    city: x.city ?? null,
    state: x.state ?? null,
    pincode: x.pincode ?? null,
    lat: x.lat != null ? Number(x.lat) : null,
    lng: x.lng != null ? Number(x.lng) : null,
    phone: x.phone ?? null,
    offlineFee: x.offlineFee != null ? Number(x.offlineFee) : null,
    isActive: Boolean(x.isActive),
    availability: (x.availability || []).map(serializeWeeklySlot),
  };
}

/** Collapse a set of weekly slots into the flat card summary the UI shows. */
function summarizeWindows(slots) {
  const active = (slots || []).filter((s) => s.isActive == null || s.isActive);
  if (!active.length) return null;
  const days = [...new Set(active.map((s) => s.dayOfWeek))].sort((a, b) => a - b).map((d) => DAYS[d]);
  const opens = active.map((s) => hhmm(s.startTime));
  const closes = active.map((s) => hhmm(s.endTime));
  return {
    days,
    openTime: opens.sort()[0], // earliest open
    closeTime: closes.sort().at(-1), // latest close
    slotMinutes: active[0].slotDurationMinutes ?? SLOT_DEFAULT_MINUTES,
  };
}

/**
 * A clinic mapped onto the frontend PUBLIC `Clinic` type
 * (frontend-doctor/src/types/doctor.ts): weekly slots flattened to
 * days/openTime/closeTime/slotMinutes for the card.
 */
function serializePublicClinic(c) {
  const x = plain(c);
  const summary = summarizeWindows((x.availability || []).map(plain)) || {
    days: [],
    openTime: "",
    closeTime: "",
    slotMinutes: SLOT_DEFAULT_MINUTES,
  };
  return {
    id: String(x.id),
    name: x.name,
    address: x.addressLine,
    city: x.city ?? "",
    stateCode: x.state ?? "",
    lat: x.lat != null ? Number(x.lat) : 0,
    lng: x.lng != null ? Number(x.lng) : 0,
    phone: x.phone ?? "",
    fee: x.offlineFee != null ? Number(x.offlineFee) : 0,
    days: summary.days,
    openTime: summary.openTime,
    closeTime: summary.closeTime,
    slotMinutes: summary.slotMinutes,
    // The ORIGINAL per-day windows (a day may have more than one). `days`/
    // `openTime`/`closeTime` above are only a flattened summary; the booking UI
    // shows these to display each day's real hours.
    hours: (x.availability || [])
      .map(plain)
      .filter((s) => s.isActive == null || s.isActive)
      .sort((a, b) => a.dayOfWeek - b.dayOfWeek || String(a.startTime).localeCompare(String(b.startTime)))
      .map((s) => ({ day: DAYS[s.dayOfWeek], openTime: hhmm(s.startTime), closeTime: hhmm(s.endTime) })),
  };
}

/** Online schedule → the frontend `OnlineAvailability` shape, or null. */
function serializeOnlineAvailability(rows) {
  return summarizeWindows((rows || []).map(plain));
}

/**
 * The doctor's OWN full draft profile (all relations, any verification status).
 * Includes documents + submission state — this is only ever returned to the
 * authenticated doctor themselves.
 */
function serializeDoctorProfile(profile) {
  if (!profile) return null;
  const p = plain(profile);
  const user = p.user || {};
  return {
    id: String(p.userId),
    slug: doctorSlug(user.name, p.userId),
    qualification: p.qualification ?? null,
    registrationNumber: p.registrationNumber ?? null,
    experienceYears: p.experienceYears ?? 0,
    bio: p.bio ?? null,
    shortIntro: p.shortIntro ?? null,
    careerSummary: p.careerSummary ?? null,
    headline: p.headline ?? null,
    gender: p.gender ?? null,
    practicePhilosophy: p.practicePhilosophy ?? null,
    publicPhone: p.publicPhone ?? null,
    publicEmail: p.publicEmail ?? null,
    showcaseImageUrl: p.showcaseImageUrl ?? null,
    heroImageUrls: heroImageList(p.heroImageUrls),
    onlineFee: p.onlineFee != null ? Number(p.onlineFee) : null,
    verificationStatus: p.verificationStatus,
    verificationNotes: p.verificationNotes ?? null,
    isSubmitted: Boolean(p.isSubmitted),
    // The admin's public-visibility toggle. Only ever surfaced to the admin app
    // and the doctor themselves — the public serializer omits it entirely.
    isListed: Boolean(p.isListed),
    avgRating: p.avgRating != null ? Number(p.avgRating) : 0,
    ratingCount: p.ratingCount ?? 0,
    name: user.name ?? null,
    email: user.email ?? null,
    photoUrl: user.profilePhotoUrl ?? null,
    specializations: (p.specializations || []).map(serializeSpecialization),
    subSpecializations: (p.subSpecializations || []).map(serializeSubSpecialization),
    languages: (p.languages || []).map(serializeLanguage),
    awards: (p.awards || []).map(serializeAward),
    testimonials: (p.testimonials || []).map(serializeTestimonial).sort(byDisplayOrder),
    links: (p.links || []).map(serializeLink),
    documents: (p.documents || []).map(serializeDocument),
    keywords: (p.keywords || []).map(serializeKeyword),
    education: (p.education || []).map(serializeEducation),
    experience: (p.experience || []).map(serializeExperience),
    services: (p.services || []).map(serializeService),
    publications: (p.publications || []).map(serializePublication),
    memberships: (p.memberships || []).map(serializeMembership),
    gallery: (p.gallery || []).map(serializeGalleryImage).sort(byDisplayOrder),
    faqs: (p.faqs || []).map(serializeFaq),
    // Migration 049 sections, in the doctor's arranged order.
    affiliations: (p.affiliations || []).map(serializeAffiliation).sort(byDisplayOrder),
    fellowships: (p.fellowships || []).map(serializeFellowship).sort(byDisplayOrder),
    expertise: (p.expertise || []).map(serializeExpertise).sort(byDisplayOrder),
    insurances: (p.insurances || []).map(serializeInsurance),
    clinics: (p.clinics || []).map(serializeOwnClinic),
    onlineAvailability: (p.onlineAvailability || []).map(serializeWeeklySlot),
  };
}

/**
 * Which clinic a card speaks for. Normally the first active one, but when the
 * patient filtered by city/state, the matching branch wins — a doctor whose main
 * practice is in Bhubaneswar and who also runs a Bengaluru clinic must not
 * render a "Bhubaneswar" card in the Bengaluru results.
 *
 * `focus` is optional and only ever passed by the discovery list. Guard against
 * a truthy non-object: `rows.map(serializePublicDoctor)` would hand us the array
 * INDEX as the second argument.
 */
function pickPrimaryClinic(clinics, focus) {
  if (!clinics.length || typeof focus !== "object" || focus === null) return clinics[0];
  const matches = (value, wanted) => value && wanted && kebab(value) === kebab(wanted);
  return (
    (focus.city && clinics.find((c) => matches(c.city, focus.city))) ||
    (focus.stateCode && clinics.find((c) => matches(c.stateCode, focus.stateCode))) ||
    clinics[0]
  );
}

/**
 * The PUBLIC portfolio shape, mapped onto the frontend `DoctorDetail` type
 * (frontend-doctor/src/types/doctor.ts) so the public page swaps mock→API with
 * zero type churn. Deliberately omits documents / submission state / internal
 * notes. Clinics + online availability arrive `[]`/`null` until the next plan.
 */
function serializePublicDoctor(profile, focus) {
  if (!profile) return null;
  const p = plain(profile);
  const user = p.user || {};
  const specializations = p.specializations || [];
  const primary = specializations[0];
  const clinics = (p.clinics || []).filter((c) => c.isActive).map(serializePublicClinic);
  const onlineAvailability = serializeOnlineAvailability(p.onlineAvailability);
  const primaryClinic = pickPrimaryClinic(clinics, focus);
  // Lowest of {online fee, clinic fees} drives the "from ₹…" listing price.
  const fees = [
    p.onlineFee != null ? Number(p.onlineFee) : null,
    ...clinics.map((c) => c.fee),
  ].filter((f) => f != null);
  const lists = publicPortfolioLists(p);
  return {
    id: String(p.userId),
    slug: doctorSlug(user.name, p.userId),
    name: user.name ?? null,
    gender: p.gender ?? "male", // real column now; default only if the doctor left it blank
    headline: p.headline ?? "",
    photoUrl: user.profilePhotoUrl ?? undefined,
    specialtySlug: primary?.slug ?? "",
    specialtyName: primary?.name ?? "",
    specialties: specializations.map(serializeSpecialization),
    subSpecializations: (p.subSpecializations || []).map(serializeSubSpecialization),
    qualifications: p.qualification ? [p.qualification] : [],
    registrationNumber: p.registrationNumber ?? "",
    experienceYears: p.experienceYears ?? 0,
    languages: (p.languages || []).map((l) => plain(l).name),
    hospital: primaryClinic?.name ?? "",
    // Derived, not stored: the discovery `city` filter speaks slugs, so a card
    // whose citySlug stayed "" could never link back to its own city results.
    citySlug: primaryClinic?.city ? kebab(primaryClinic.city) : "",
    city: primaryClinic?.city ?? "",
    stateCode: primaryClinic?.stateCode ?? "",
    stateName: "",
    lat: primaryClinic?.lat ?? 0,
    lng: primaryClinic?.lng ?? 0,
    rating: p.avgRating != null ? Number(p.avgRating) : 0,
    reviewsCount: p.ratingCount ?? 0,
    consultationFee: fees.length ? Math.min(...fees) : 0,
    onlineFee: p.onlineFee != null ? Number(p.onlineFee) : 0,
    onlineConsult: onlineAvailability != null,
    verified: p.verificationStatus === "approved",
    available: true,
    about: p.bio ?? "",
    shortIntro: p.shortIntro ?? "",
    careerSummary: p.careerSummary ?? "",
    practicePhilosophy: p.practicePhilosophy ?? "",
    showcaseImageUrl: p.showcaseImageUrl ?? null,
    // Hero background slideshow (0–3 URLs, display order). [] → plain hero.
    heroImageUrls: heroImageList(p.heroImageUrls),
    // Structured education → the frontend EducationEntry, newest completion first.
    education: serializePublicEducation(p.education),
    experience: (p.experience || []).map(serializeExperience),
    // Also the portfolio's "Procedures" (doctor-listed, not a certification).
    services: (p.services || []).map(serializeService).sort(byDisplayOrder),
    publications: lists.publications,
    // Membership numbers only when the doctor chose to show them.
    memberships: lists.memberships,
    gallery: lists.gallery,
    // Migration 049: current affiliations, fellowships/training, expertise.
    affiliations: lists.affiliations,
    fellowships: lists.fellowships,
    expertise: lists.expertise,
    faqs: (p.faqs || []).map(serializeFaq),
    insurances: (p.insurances || []).map((i) => plain(i).name),
    publicPhone: p.publicPhone ?? user.phone ?? null,
    publicEmail: p.publicEmail ?? user.email ?? null,
    symptoms: (p.keywords || []).map((k) => plain(k).keyword),
    awards: lists.awards,
    // Doctor-managed patient feedback: visible entries only (migration 048).
    testimonials: serializePublicTestimonials(p.testimonials),
    links: (p.links || []).map(serializeLink),
    // Filled by the clinics plan (clinics + availability).
    clinics,
    onlineAvailability,
    reviews: [],
  };
}

/**
 * Lean marker projection of a full public doctor card, for GET /doctors/map.
 * Only the geo + card-preview fields the map pins / result strip read — no heavy
 * portfolio data (education, reviews, clinics[]) which load on the profile fetch.
 */
function toMapDoctor(card) {
  return {
    id: card.id,
    slug: card.slug,
    name: card.name,
    photoUrl: card.photoUrl,
    specialtySlug: card.specialtySlug,
    specialtyName: card.specialtyName,
    hospital: card.hospital,
    city: card.city,
    lat: card.lat,
    lng: card.lng,
    rating: card.rating,
    reviewsCount: card.reviewsCount,
    experienceYears: card.experienceYears,
    consultationFee: card.consultationFee,
    onlineFee: card.onlineFee,
    onlineConsult: card.onlineConsult,
    available: card.available,
    verified: card.verified,
  };
}

// ── Prescription serializers (docs/prescriptions) ────────────────────────────
/**
 * The letterhead template, FLAT — the same shape the editor PATCHes back, so
 * there is no read-shape/write-shape translation to get wrong. The JSON blobs
 * pass through untouched; assets are grouped only for readability.
 */
function serializeTemplate(t) {
  if (!t) return null;
  const x = plain(t);
  const clinic = plain(x.clinic);
  return {
    id: String(x.id),
    name: x.name,
    clinicId: x.clinicId != null ? String(x.clinicId) : null,
    clinic: clinic ? { id: String(clinic.id), name: clinic.name } : null,
    isDefault: Boolean(x.isDefault),
    isActive: Boolean(x.isActive),

    assets: {
      logoUrl: x.logoUrl ?? null,
      watermarkUrl: x.watermarkUrl ?? null,
      signatureUrl: x.signatureUrl ?? null,
    },
    watermarkOpacity: Number(x.watermarkOpacity),

    headerBgColor: x.headerBgColor,
    headerTextColor: x.headerTextColor,
    footerBgColor: x.footerBgColor,
    footerTextColor: x.footerTextColor,
    accentColor: x.accentColor,
    fontFamily: x.fontFamily,
    baseFontSizePt: Number(x.baseFontSizePt),

    pageSize: x.pageSize,
    marginMmTop: x.marginMmTop,
    marginMmRight: x.marginMmRight,
    marginMmBottom: x.marginMmBottom,
    marginMmLeft: x.marginMmLeft,

    showHeader: Boolean(x.showHeader),
    showFooter: Boolean(x.showFooter),
    showSidebar: Boolean(x.showSidebar),
    showWatermark: Boolean(x.showWatermark),
    sidebarWidthPct: x.sidebarWidthPct,

    headerJson: x.headerJson,
    patientFieldsJson: x.patientFieldsJson,
    sidebarJson: x.sidebarJson,
    bodyJson: x.bodyJson,
    footerJson: x.footerJson,

    rxNumberPrefix: x.rxNumberPrefix ?? null,
    updatedAt: x.updatedAt ?? null,
  };
}

/** The template list row — enough to pick one, not enough to render one. */
function serializeTemplateSummary(t) {
  const x = plain(t);
  const clinic = plain(x.clinic);
  return {
    id: String(x.id),
    name: x.name,
    clinic: clinic ? { id: String(clinic.id), name: clinic.name } : null,
    isDefault: Boolean(x.isDefault),
    logoUrl: x.logoUrl ?? null,
    updatedAt: x.updatedAt ?? null,
  };
}

function serializeRxItem(i) {
  const x = plain(i);
  return {
    medicineId: x.medicineId != null ? String(x.medicineId) : null,
    medicineMasterId: x.medicineMasterId != null ? String(x.medicineMasterId) : null,
    medicineName: x.medicineName,
    strength: x.strength ?? null,
    dosageForm: x.dosageForm ?? null,
    dosage: x.dosage ?? null,
    route: x.route,
    frequency: x.frequency ?? null,
    timing: x.timing ?? null,
    durationDays: x.durationDays ?? null,
    durationUnit: x.durationUnit ?? "day",
    notes: x.notes ?? null,
    quantity: x.quantity ?? null,
    priority: x.priority ?? null,
    nameType: x.nameType ?? null,
  };
}

const rxVitals = (x) => ({
  heightCm: x.heightCm != null ? Number(x.heightCm) : null,
  weightKg: x.weightKg != null ? Number(x.weightKg) : null,
  bloodPressure: x.bloodPressure ?? null,
  pulseRateBpm: x.pulseRateBpm ?? null,
  temperatureF: x.temperatureF != null ? Number(x.temperatureF) : null,
  spo2Percent: x.spo2Percent ?? null,
});

const rxClinical = (x) => ({
  chiefComplaint: x.chiefComplaint ?? null,
  diagnosis: x.diagnosis ?? null,
  notes: x.notes ?? null,
  advice: x.advice ?? null,
  adviceSelected: x.adviceSelected ?? [],
  followUpDate: x.followUpDate ?? null,
  noMedication: Boolean(x.noMedication),
});

/**
 * A prescription as the DOCTOR sees it. A draft carries the LIVE `template`
 * (it's still being written); a finalized one carries its frozen `snapshot`.
 * They are the same shape and a different document — the client must not treat
 * a missing `snapshot` as a reason to go fetch the live template.
 */
function serializePrescriptionForDoctor(rx) {
  if (!rx) return null;
  const x = plain(rx);
  const booking = plain(x.booking);
  const patient = plain(x.patient) || {};
  const profile = plain(patient.patientProfile) || {};
  const finalized = x.status === "finalized";

  return {
    id: String(x.id),
    status: x.status,
    version: x.version,
    rxNumber: x.rxNumber ?? null,
    parentPrescriptionId: x.parentPrescriptionId != null ? String(x.parentPrescriptionId) : null,
    supersededById: x.supersededById != null ? String(x.supersededById) : null,
    amendReason: x.amendReason ?? null,

    booking: booking
      ? {
          id: String(booking.id),
          date: booking.slotDate,
          startTime: hhmm(booking.slotStartTime),
          mode: bookingMode(booking.bookingType),
          status: booking.status,
        }
      : null,
    patient: {
      id: patient.id != null ? String(patient.id) : null,
      regNo: regNoOf(patient.id),
      name: patient.name ?? null,
      phone: patient.phone ?? null,
      dateOfBirth: profile.dateOfBirth ?? null,
      age: ageFrom(profile.dateOfBirth),
      gender: profile.gender ?? null,
      bloodGroup: profile.bloodGroup ?? "unknown",
      addressLine: profile.addressLine ?? null,
      city: profile.city ?? null,
    },
    clinic: plain(x.clinic) ? { id: String(x.clinic.id), name: x.clinic.name } : null,

    templateId: x.templateId != null ? String(x.templateId) : null,
    template: finalized ? null : serializeTemplate(x.template),
    snapshot: finalized ? x.templateSnapshot : null,

    vitals: rxVitals(x),
    ...rxClinical(x),
    items: (x.items || []).map(serializeRxItem),
    // The Patient Workbench information it was written from (migration 059);
    // frozen at finalize. Doctor-only — patient responses never carry it.
    clinicalSnapshot: x.clinicalSnapshot ?? null,

    canEdit: x.status === "draft",
    pdfUrl: x.pdfUrl ?? null,
    finalizedAt: x.finalizedAt ?? null,
    createdAt: x.createdAt ?? null,
    updatedAt: x.updatedAt ?? null,
  };
}

/** The doctor's prescription-history row. */
function serializePrescriptionSummary(rx) {
  const x = plain(rx);
  const patient = plain(x.patient) || {};
  return {
    id: String(x.id),
    status: x.status,
    version: x.version,
    rxNumber: x.rxNumber ?? null,
    bookingId: x.bookingId != null ? String(x.bookingId) : null,
    patient: { id: patient.id != null ? String(patient.id) : null, name: patient.name ?? null },
    clinic: plain(x.clinic) ? { name: x.clinic.name } : null,
    supersededById: x.supersededById != null ? String(x.supersededById) : null,
    diagnosis: x.diagnosis ?? null,
    finalizedAt: x.finalizedAt ?? null,
    createdAt: x.createdAt ?? null,
  };
}

/**
 * A prescription as the PATIENT sees it. `notes` is the doctor's internal
 * commentary and is deliberately omitted; the patient gets the medicines, the
 * advice written for them, and the PDF.
 */
function serializePrescriptionForPatient(rx) {
  if (!rx) return null;
  const x = plain(rx);
  const doctor = plain(x.doctor) || {};
  const dUser = plain(doctor.user) || {};
  const clinic = plain(x.clinic);
  return {
    id: String(x.id),
    bookingId: x.bookingId != null ? String(x.bookingId) : null,
    rxNumber: x.rxNumber ?? null,
    version: x.version,
    doctor: { name: dUser.name ?? null, qualification: doctor.qualification ?? null },
    clinic: clinic ? { name: clinic.name, address: clinic.addressLine ?? null } : null,
    // The clinic that ARRANGED the consult — distinct from `clinic` above,
    // which is the doctor's own location where it took place. Renders as
    // "consulted Dr. A via Sunrise Clinic"; NULL when the patient booked the
    // doctor directly.
    bookedBy: serializeBookedBy(plain(x.booking)?.bookedBy),
    diagnosis: x.diagnosis ?? null,
    advice: x.advice ?? null,
    adviceSelected: x.adviceSelected ?? [],
    followUpDate: x.followUpDate ?? null,
    items: (x.items || []).map(serializeRxItem),
    pdfUrl: x.pdfUrl ?? null,
    finalizedAt: x.finalizedAt ?? null,
  };
}

// ── Dashboards & earnings (docs/dashboards-earnings/backend-plan.md §7) ──────

/**
 * The ONE place a DECIMAL-as-string becomes a number.
 *
 * mysql2 hands `DECIMAL(10,2)` back as a string ("1234.50"), and `SUM()` over
 * zero rows hands back NULL. A TypeScript `number` annotation on the frontend
 * does not catch either — it's a lie at runtime — and the first component to add
 * two of them renders `"1000" + "2000"` as ₹10002000.
 */
const money = (v) => (v == null ? 0 : Math.round(Number(v) * 100) / 100);

/** Patient tiles. `totalSpent` is GROSS — commission never surfaces to a patient. */
function serializePatientDashboard(s) {
  return {
    upcoming: s.upcoming,
    completed: s.completed,
    pendingPayment: s.pendingPayment,
    doctorsConsulted: s.doctorsConsulted,
    totalSpent: money(s.totalSpent),
    nextAppointment: s.nextAppointment ? serializeNextAppointment(s.nextAppointment) : null,
  };
}

function serializeNextAppointment(b) {
  const x = plain(b);
  const doctor = plain(x.doctor) || {};
  const dUser = plain(doctor.user) || {};
  return {
    id: String(x.id),
    date: x.slotDate,
    startTime: hhmm(x.slotStartTime),
    doctorName: dUser.name ?? null,
    mode: bookingMode(x.bookingType),
  };
}

/**
 * One in-app notification (medicine_notifications) — the same fields the
 * REST list already returns, so a pushed row and a fetched row are identical.
 */
function serializeNotification(n) {
  return {
    id: n.id,
    userId: n.userId,
    title: n.title,
    message: n.message,
    type: n.type,
    referenceId: n.referenceId ?? null,
    referenceType: n.referenceType ?? null,
    isRead: !!n.isRead,
    createdAt: n.createdAt instanceof Date ? n.createdAt.toISOString() : n.createdAt,
  };
}

/** Doctor tiles. `averageRating` passes through as null — never coerce it to 0. */
function serializeDoctorDashboard(s) {
  return {
    todaysAppointments: s.todaysAppointments,
    todaysClinic: s.todaysClinic,
    todaysVideo: s.todaysVideo,
    patientsThisMonth: s.patientsThisMonth,
    averageRating: s.averageRating,
    earnedThisMonth: money(s.earnedThisMonth),
    totalPatients: s.totalPatients,
    consultedPatients: s.consultedPatients,
    totalRevenue: money(s.totalRevenue),
    appointments: {
      today: s.appointments.today,
      total: s.appointments.total,
      pending: s.appointments.pending,
      previous: s.appointments.previous,
      upcoming: s.appointments.upcoming,
    },
  };
}

/**
 * Doctor earnings totals. `averagePerConsult` stays null at zero consults —
 * not NaN (0/0), not a misleading 0. JSON.stringify(NaN) happens to emit null,
 * but that's an accident of the spec, not a contract worth relying on.
 */
function serializeEarningsSummary(s, period) {
  return {
    period: { from: period.from.toISOString(), to: period.to.toISOString() },
    gross: money(s.gross),
    commission: money(s.commission),
    net: money(s.net),
    refunded: money(s.refunded),
    consults: s.consults,
    averagePerConsult: s.averagePerConsult == null ? null : money(s.averagePerConsult),
    awaitingCollection: money(s.awaitingCollection),
  };
}

/** One zero-filled bucket of the earnings series. `bucket` is an opaque IST label. */
function serializeEarningsBucket(b) {
  return {
    bucket: b.bucket,
    gross: money(b.gross),
    commission: money(b.commission),
    net: money(b.net),
    consults: b.consults,
  };
}

/**
 * A ledger row. `mode` here is the PAYMENT mode (online|offline), not the
 * booking mode (video|clinic) — a clinic visit can be paid online. The UI
 * labels the column "Payment" for exactly this reason.
 */
function serializeLedgerRow(p) {
  const x = plain(p);
  const booking = plain(x.booking) || {};
  const patient = plain(booking.patient) || {};
  return {
    id: String(x.id),
    paidAt: x.paidAt,
    date: booking.slotDate ?? null,
    patientName: patient.name ?? null,
    mode: x.mode,
    gross: money(x.amount),
    commission: money(x.commissionAmount),
    net: money(x.doctorPayoutAmount),
  };
}

/** Admin tiles. Ships commission, GMV and payouts adjacent, on purpose. */
function serializeAdminDashboard(s) {
  return {
    verifiedDoctors: s.verifiedDoctors,
    pendingVerifications: s.pendingVerifications,
    bookingsThisMonth: s.bookingsThisMonth,
    totalDoctors: s.totalDoctors,
    totalPatients: s.totalPatients,
    totalClinics: s.totalClinics,
    totalBookings: s.totalBookings,
    platformRevenue: money(s.platformRevenue),
    gmv: money(s.gmv),
    doctorPayouts: money(s.doctorPayouts),
  };
}

function serializeRevenueBucket(b) {
  return {
    bucket: b.bucket,
    gmv: money(b.gmv),
    commission: money(b.commission),
    payouts: money(b.payouts),
    bookings: b.bookings,
  };
}

/**
 * Public contact-form submission → the minimal shape returned to the sender.
 * Deliberately omits `ipAddress`/`handled` (internal triage fields).
 */
function serializeContactMessage(message) {
  if (!message) return null;
  const m = plain(message);
  return {
    id: String(m.id),
    name: m.name,
    email: m.email,
    createdAt: m.createdAt ?? m.created_at ?? null,
  };
}

/**
 * Admin inbox view of a contact message — the full body + the `handled` flag,
 * but still NOT the `ipAddress` (kept internal to the DB for spam triage).
 */
function serializeContactMessageForAdmin(message) {
  if (!message) return null;
  const m = plain(message);
  return {
    id: String(m.id),
    name: m.name,
    email: m.email,
    phone: m.phone ?? null,
    message: m.message,
    handled: Boolean(m.handled),
    createdAt: m.createdAt ?? m.created_at ?? null,
  };
}

/**
 * A booking as the ADMIN sees it — the full picture across all parties.
 */
function serializeBookingForAdmin(b) {
  const x = plain(b);
  const doctor = plain(x.doctor) || {};
  const dUser = plain(doctor.user) || {};
  const patient = plain(x.patient) || {};
  const clinic = plain(x.clinic);
  const payment = plain(x.payment);
  return {
    id: String(x.id),
    mode: bookingMode(x.bookingType),
    doctor: {
      id: doctor.userId != null ? String(doctor.userId) : null,
      name: dUser.name ?? null,
    },
    patient: {
      id: patient.id != null ? String(patient.id) : null,
      name: patient.name ?? null,
    },
    clinic: clinic ? { id: String(clinic.id), name: clinic.name, city: clinic.city ?? null } : null,
    date: x.slotDate,
    startTime: hhmm(x.slotStartTime),
    endTime: hhmm(x.slotEndTime),
    status: x.status,
    amount: x.amount != null ? Number(x.amount) : 0,
    paymentMode: x.paymentMode,
    payment: serializeBookingPayment(payment),
    createdAt: x.createdAt instanceof Date ? x.createdAt.toISOString() : x.createdAt,
  };
}

/**
 * A clinical note for the doctor UI. `date` is the note's creation time (the
 * timeline key); `doctorName` is the authoring doctor so any later doctor sees
 * who recorded it.
 */
function serializeClinicalNote(n) {
  const x = plain(n);
  const author = plain(x.author) || {};
  const num = (v) => (v == null ? null : Number(v)); // DECIMAL columns come back as strings
  const recordedBy = plain(x.recordedBy) || null;
  return {
    id: String(x.id),
    date: x.createdAt instanceof Date ? x.createdAt.toISOString() : x.createdAt,
    // Unchanged key, unchanged meaning: the DOCTOR who wrote it, null on a
    // clinic-written note. Existing views keep reading it exactly as before.
    doctorName: author.name ?? null,
    // Who actually wrote it, whatever their role — this is what the source chip
    // renders. Prefer it over `doctorName` in new UI.
    ...serializeRecordSource(x),
    recordedByName: recordedBy?.name ?? author.name ?? null,
    complaints: x.complaints ?? null, // c/o
    onExamination: x.onExamination ?? null, // o/e
    historyMedical: x.historyMedical ?? null, // h/o medical
    historySurgical: x.historySurgical ?? null, // h/o surgical
    diagnosis: x.diagnosis ?? null,
    treatment: x.treatment ?? null,
    vitals: {
      bloodPressure: x.bloodPressure ?? null,
      pulseRateBpm: num(x.pulseRateBpm),
      weightKg: num(x.weightKg),
      heightCm: num(x.heightCm),
      temperatureF: num(x.temperatureF),
      spo2Percent: num(x.spo2Percent),
    },
  };
}

// ── Multi-doctor referrals & care journeys (docs/multi-doctor-referrals) ─────

/**
 * A hydrated DoctorProfile (userId + user{name,photo} + specializations) → the
 * mini doctor shape referrals/journeys embed: { id, name, slug, specialization,
 * photo }. Shared by every referral/journey serializer so the shape never drifts.
 */
function serializeDoctorMini(profile) {
  const p = plain(profile);
  if (!p) return null;
  const user = plain(p.user) || {};
  const primarySpec = (p.specializations || []).map(plain)[0];
  const id = p.userId != null ? String(p.userId) : null;
  return {
    id,
    name: user.name ?? null,
    slug: p.userId != null ? doctorSlug(user.name, p.userId) : null,
    specialization: primarySpec?.name ?? null,
    photo: user.profilePhotoUrl ?? null,
  };
}

/** A referral edge as the doctor UI + the journey read consume it. */
/**
 * The two referral directions a booking can carry, for the appointment board's
 * Referral column (referral.service.mapForBookings).
 *
 * Trimmed to what a roster cell can show — who, and why — rather than the full
 * referral shape: the column is a signpost, and the case itself opens from the
 * appointment.
 */
function serializeBookingReferrals(r) {
  const x = plain(r);
  if (!x) return null;
  const mini = (ref) => {
    const y = plain(ref);
    if (!y) return null;
    const from = serializeDoctorMini(y.fromDoctor);
    const to = serializeDoctorMini(y.toDoctor);
    return {
      id: String(y.id),
      status: y.status,
      reason: y.reason ?? null,
      fromDoctor: from ? { id: from.id, name: from.name, specialization: from.specialization ?? null } : null,
      toDoctor: to ? { id: to.id, name: to.name, specialization: to.specialization ?? null } : null,
    };
  };
  const incoming = mini(x.incoming);
  const outgoing = (x.outgoing ?? []).map(mini).filter(Boolean);
  if (!incoming && !outgoing.length) return null;
  return { incoming, outgoing };
}

function serializeReferral(r) {
  const x = plain(r);
  if (!x) return null;
  const from = serializeDoctorMini(x.fromDoctor);
  return {
    id: String(x.id),
    journeyId: x.journeyId != null ? String(x.journeyId) : null,
    status: x.status,
    reason: x.reason,
    note: x.note ?? null,
    fromDoctor: from ? { id: from.id, name: from.name } : null,
    toDoctor: serializeDoctorMini(x.toDoctor),
    sourceBookingId: x.sourceBookingId != null ? String(x.sourceBookingId) : null,
    targetBookingId: x.targetBookingId != null ? String(x.targetBookingId) : null,
    createdAt: x.createdAt instanceof Date ? x.createdAt.toISOString() : x.createdAt,
  };
}

/**
 * One autocomplete suggestion. `row` is a raw SELECT row from
 * referral.service.listTargets: { id, name, photo, specs, clinicName, sameClinic }.
 * `specs` is a "||"-joined string (GROUP_CONCAT) or null; `sameClinic` is 0/1.
 */
function serializeReferralTarget(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    name: row.name ?? null,
    photo: row.photo ?? null,
    specializations: row.specs ? String(row.specs).split("||").filter(Boolean) : [],
    clinicName: row.clinicName ?? null,
    sameClinic: Boolean(Number(row.sameClinic)),
  };
}

/**
 * An incoming referral as the TARGET doctor's inbox item — "Dr. A referred
 * <patient> to you". Carries who referred, which patient, why, and the source
 * consult id so the doctor can open the shared case.
 */
function serializeIncomingReferral(r) {
  const x = plain(r);
  if (!x) return null;
  const patient = plain(x.patient) || {};
  return {
    id: String(x.id),
    status: x.status,
    reason: x.reason,
    note: x.note ?? null,
    createdAt: x.createdAt instanceof Date ? x.createdAt.toISOString() : x.createdAt,
    fromDoctor: serializeDoctorMini(x.fromDoctor),
    patient: { id: patient.id != null ? String(patient.id) : null, name: patient.name ?? null },
    sourceBookingId: x.sourceBookingId != null ? String(x.sourceBookingId) : null,
    // B's own appointment once the patient books from this referral — the anchor
    // for B's consult actions (write Rx, refer onward, complete).
    targetBookingId: x.targetBookingId != null ? String(x.targetBookingId) : null,
  };
}

/**
 * The shared case behind an incoming referral: the inbox item + the referring
 * doctor's reports (clinical notes) and their finalized prescription from the
 * source consultation. Reuses the existing note/Rx read shapes verbatim.
 */
function serializeReferralCase({ referral, reports, prescription }) {
  return {
    referral: serializeIncomingReferral(referral),
    reports: (reports || []).map(serializeClinicalNote),
    prescription: prescription ? serializePrescriptionForPatient(prescription) : null,
  };
}

/** A pending referral as the patient's inbox item ("you've been referred"). */
function serializePendingReferral(r) {
  const x = plain(r);
  if (!x) return null;
  const from = serializeDoctorMini(x.fromDoctor);
  return {
    id: String(x.id),
    reason: x.reason,
    fromDoctor: from ? { name: from.name } : null,
    toDoctor: serializeDoctorMini(x.toDoctor),
  };
}

/** One journey summary row (list + the header of a detail). */
function serializeJourneySummary(s) {
  const j = plain(s.journey) || {};
  const toIso = (d) => (d instanceof Date ? d.toISOString() : d);
  return {
    id: String(j.id),
    title: j.title ?? null,
    status: j.status,
    doctorCount: s.doctorCount ?? 0,
    consultationCount: s.consultationCount ?? 0,
    lastActivityAt: toIso(s.lastActivityAt) ?? null,
    createdAt: toIso(j.createdAt) ?? null,
  };
}

/** One consultation node: doctor + clinic + that doctor's reports + prescription. */
function serializeJourneyConsultation(c) {
  const booking = plain(c.booking) || {};
  const rx = plain(c.prescription);
  return {
    bookingId: String(booking.id),
    date: booking.slotDate,
    startTime: hhmm(booking.slotStartTime),
    status: booking.status,
    mode: bookingMode(booking.bookingType),
    doctor: serializeDoctorMini(booking.doctor),
    clinic: plain(booking.clinic) ? { id: String(booking.clinic.id), name: booking.clinic.name } : null,
    reports: (c.reports || []).map(serializeClinicalNote),
    prescription: rx ? { id: String(rx.id), rxNumber: rx.rxNumber ?? null, pdfUrl: rx.pdfUrl ?? null } : null,
  };
}

// ── Treatment timeline (docs/treatment-timeline) ─────────────────────────────
/**
 * The Issue column, resolved in ONE place so every consumer agrees on what a
 * visit was "about". Order matters (README §4): the clinical note is the
 * doctor's considered record, the prescription's diagnosis catches the very
 * common case of prescribing without writing a note, and complaints are the
 * last resort. Getting this order wrong makes most rows read "—" while the
 * data is sitting right there.
 */
function timelineIssue(note, rx) {
  const n = plain(note) || {};
  const p = plain(rx) || {};
  const pick = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
  return pick(n.diagnosis) ?? pick(p.diagnosis) ?? pick(n.complaints) ?? null;
}

/**
 * One timeline row: date · location · doctor · issue · prescription.
 *
 * `location` is null for a video consult — the LABEL ("Video consultation")
 * lives in the UI, not the API, so wording changes don't need a deploy.
 *
 * Both viewers can open the PDF (docs/treatment-timeline §7-A, decided
 * 2026-07-28): a treating doctor reading prior prescriptions matches the
 * existing precedent that clinical notes are already patient-wide. The read is
 * still authorized server-side on every request — `getPdfForDoctor` re-checks
 * that the caller either authored the prescription or has a booking with its
 * patient, so an id alone grants nothing.
 */
function serializeTimelineRow({ booking, note, prescription }, { viewer = "patient" } = {}) {
  const b = plain(booking) || {};
  const doctor = plain(b.doctor) || {};
  const dUser = plain(doctor.user) || {};
  const clinic = plain(b.clinic);
  const rx = plain(prescription);
  void viewer; // both viewers may open the PDF; kept for future policy splits
  const canView = true;

  return {
    bookingId: String(b.id),
    date: b.slotDate,
    startTime: hhmm(b.slotStartTime),
    mode: bookingMode(b.bookingType),
    location: clinic ? { name: clinic.name ?? null, city: clinic.city ?? null } : null,
    doctor: {
      id: dUser.id != null ? String(dUser.id) : String(b.doctorId),
      name: dUser.name ?? null,
      specialization: (doctor.specializations || [])[0]?.name ?? null,
    },
    issue: timelineIssue(note, prescription),
    // "Consulted Dr. A via X Clinic" — NULL when the patient booked directly,
    // which is every row created before the clinic portal existed.
    bookedBy: serializeBookedBy(b.bookedBy),
    prescription: rx
      ? {
          id: canView ? String(rx.id) : null,
          rxNumber: rx.rxNumber ?? null,
          canView,
        }
      : null,
  };
}

/** The whole timeline payload: rows + the year dropdown's options + the cap. */
function serializeTimeline(result, opts) {
  return {
    rows: (result.rows || []).map((r) => serializeTimelineRow(r, opts)),
    years: result.years || [],
    total: result.total ?? 0,
    capped: Boolean(result.capped),
  };
}

/** One My Patients roster row (grouped aggregate + the joined patient user). */
function serializeDoctorPatient(entry) {
  // listDoctorPatients wraps each aggregate row with its profile + effective
  // status; tolerate a bare row so any older caller keeps working.
  const x = plain(entry.row ?? entry);
  const patient = plain(x.patient) || {};
  const profile = plain(entry.profile) || {};
  const patientId = patient.id ?? x.patientId;
  return {
    patient: {
      id: patientId != null ? String(patientId) : null,
      regNo: regNoOf(patientId),
      name: patient.name ?? null,
      phone: patient.phone ?? null,
      photoUrl: patient.profilePhotoUrl ?? null,
      age: ageFrom(profile.dateOfBirth),
      gender: profile.gender ?? null,
    },
    address: [profile.addressLine, profile.city].filter(Boolean).join(", ") || null,
    /** Effective status: the doctor's override, else derived from visit count. */
    status: entry.status ?? null,
    // COUNT comes back as a string from mysql2 on some drivers — coerce.
    consultationCount: Number(x.consultationCount ?? 0),
    lastSeenOn: x.lastSeenOn ?? null,
    /** The latest treated booking — the row click opens the full record via it. */
    lastBookingId: x.lastBookingId != null ? String(x.lastBookingId) : null,
  };
}

/** The roster payload. */
function serializeDoctorPatients(result) {
  return {
    patients: (result.patients || []).map(serializeDoctorPatient),
    total: result.total ?? 0,
    capped: Boolean(result.capped),
    // Present only on a paginated request (`?page=`).
    ...(result.page != null ? { page: result.page, limit: result.limit, totalPages: result.totalPages } : {}),
  };
}

/** One referral edge, drawn between the consultations it connects. */
function serializeJourneyEdge(e) {
  const x = plain(e);
  return {
    referralId: String(x.id),
    fromBookingId: x.sourceBookingId != null ? String(x.sourceBookingId) : null,
    toBookingId: x.targetBookingId != null ? String(x.targetBookingId) : null,
    reason: x.reason,
    status: x.status,
  };
}

/** The whole episode: summary + consultations (reports + Rx) + edges. */
function serializeJourneyDetail(detail) {
  return {
    ...serializeJourneySummary(detail),
    consultations: (detail.consultations || []).map(serializeJourneyConsultation),
    edges: (detail.edges || []).map(serializeJourneyEdge),
  };
}

// ── Clinic portal ────────────────────────────────────────────────────────────

/** One verification document belonging to a clinic. */
function serializeClinicDocument(doc) {
  if (!doc) return null;
  const d = plain(doc);
  return {
    id: String(d.id),
    docType: d.docType,
    fileUrl: d.fileUrl,
    fileName: d.fileName ?? null,
    uploadedAt: d.uploadedAt instanceof Date ? d.uploadedAt.toISOString() : (d.uploadedAt ?? null),
  };
}

/**
 * The clinic's OWN profile (its account fields + clinic_profiles row).
 *
 * `email` is included here deliberately — this is the clinic looking at itself,
 * or an admin reviewing it. It is NOT in serializeClinicPublic.
 */
function serializeClinicProfile(profile) {
  if (!profile) return null;
  const c = plain(profile);
  const u = c.user || {};
  return {
    id: String(c.userId),
    clinicName: c.clinicName,
    email: u.email ?? null,
    // The profile's own phone wins; the account phone is the fallback so a
    // clinic that never edited its profile still shows a number.
    phone: c.phone ?? u.phone ?? null,
    registrationNumber: c.registrationNumber ?? null,
    addressLine: c.addressLine ?? null,
    city: c.city ?? null,
    state: c.state ?? null,
    pincode: c.pincode ?? null,
    lat: c.lat === null || c.lat === undefined ? null : Number(c.lat),
    lng: c.lng === null || c.lng === undefined ? null : Number(c.lng),
    logoUrl: c.logoUrl ?? u.profilePhotoUrl ?? null,
    about: c.about ?? null,
    verificationStatus: c.verificationStatus,
    isSubmitted: Boolean(c.isSubmitted),
    verificationNotes: c.verificationNotes ?? null,
    isActive: Boolean(c.isActive),
    documents: (c.documents || []).map(serializeClinicDocument),
    createdAt: c.createdAt ?? null,
    updatedAt: c.updatedAt ?? null,
  };
}

/**
 * A clinic as seen BY SOMEONE ELSE — the doctor's "booked by X Clinic" line and
 * the patient's "consulted via X Clinic" line. Contact details only; no
 * verification state, no email, no documents.
 */
function serializeClinicPublic(profile) {
  if (!profile) return null;
  const c = plain(profile);
  return {
    id: String(c.userId ?? c.id),
    name: c.clinicName ?? c.name ?? null,
    phone: c.phone ?? null,
    city: c.city ?? null,
  };
}

/**
 * ONE row of the clinic's patient directory.
 *
 * Deliberately NOT serializeUser, which returns `email`. Nothing here can
 * identify or contact the patient beyond their name: no email, no phone (it is
 * searchable but never returned — otherwise this is a reverse-phone lookup), no
 * address, and no medical data.
 */
function serializeClinicPatientRow(user) {
  if (!user) return null;
  const u = plain(user);
  const p = u.patientProfile || {};
  return {
    id: String(u.id),
    name: u.name,
    avatarUrl: u.profilePhotoUrl ?? null,
    gender: p.gender ?? null,
    age: ageFrom(p.dateOfBirth),
    city: p.city ?? null,
  };
}

// ── Doctor record-access consent (migration 045) ─────────────────────────────

/** An approval still in force — approved and not past its expiry. */
function accessGrantActive(r) {
  return r.status === "approved" && !!r.grantExpiresAt && new Date(r.grantExpiresAt) > new Date();
}

function accessRequestBase(r) {
  return {
    id: String(r.id),
    category: r.category,
    purpose: r.purpose,
    status: r.status,
    active: accessGrantActive(r),
    createdAt: isoOrNull(r.createdAt),
    requestExpiresAt: isoOrNull(r.requestExpiresAt),
    decidedAt: isoOrNull(r.decidedAt),
    decisionNote: r.decisionNote ?? null,
    grantExpiresAt: isoOrNull(r.grantExpiresAt),
    revokedAt: isoOrNull(r.revokedAt),
    sharedCount: (r.items || []).length,
  };
}

/** Record METADATA only — the storage URL is never sent to a doctor. */
function accessRecordMeta(rec) {
  if (!rec) return null;
  return {
    id: String(rec.id),
    fileType: rec.fileType,
    tag: rec.tag ?? null,
    recordDate: rec.recordDate ?? null,
    uploadedAt: isoOrNull(rec.uploadedAt),
    source: rec.source ?? null,
  };
}

/**
 * A request as its DOCTOR sees it. The shared documents are listed only while
 * the grant is in force, and only as metadata — the file itself is streamed
 * through the authorized route.
 */
function serializeAccessRequestForDoctor(request) {
  const r = plain(request);
  const active = accessGrantActive(r);
  return {
    ...accessRequestBase(r),
    patient: r.patient ? { id: String(r.patient.id), name: r.patient.name, photoUrl: r.patient.profilePhotoUrl ?? null } : null,
    records: active ? (r.items || []).map((i) => accessRecordMeta(i.record)).filter(Boolean) : [],
  };
}

/** A request as the PATIENT sees it: who is asking, and what they chose to share. */
function serializeAccessRequestForPatient(request, candidates = null) {
  const r = plain(request);
  const d = r.doctor || {};
  const dp = d.doctorProfile || {};
  return {
    ...accessRequestBase(r),
    doctor: {
      id: d.id != null ? String(d.id) : null,
      name: d.name ?? null,
      photoUrl: d.profilePhotoUrl ?? null,
      qualification: dp.qualification ?? null,
      headline: dp.headline ?? null,
      verified: dp.verificationStatus === "approved",
      specializations: (dp.specializations || []).map((x) => x.name),
    },
    sharedRecordIds: (r.items || []).map((i) => String(i.recordId)),
    // The patient's OWN documents of this category (detail view only).
    candidates: candidates
      ? candidates.map((c) => ({ ...accessRecordMeta(plain(c)), fileUrl: c.fileUrl ?? null }))
      : undefined,
  };
}

function serializeAccessRequestPage(result, rowSerializer) {
  return {
    requests: result.rows.map((row) => rowSerializer(row)),
    total: result.total,
    page: result.page,
    limit: result.limit,
    totalPages: result.totalPages,
  };
}

/** Patient search results for a doctor: the clinic-directory row + relationship. */
function serializeDoctorPatientSearch({ patients, treatedIds }) {
  return {
    patients: patients.map((u) => ({
      ...serializeClinicPatientRow(u),
      treating: treatedIds.has(String(u.id)),
    })),
  };
}

/** One searched patient for a doctor: basic card, relationship, own requests. */
function serializeDoctorPatientCard({ patient, treating, requests }) {
  return {
    patient: serializeClinicPatientRow(patient),
    treating,
    requests: requests.map((r) => serializeAccessRequestForDoctor(r)),
  };
}

// ── Admin registry (registered doctors / patients) ───────────────────────────
/** One row of the admin's registered-DOCTORS list, newest first. */
function serializeRegisteredDoctor(user) {
  if (!user) return null;
  const u = plain(user);
  const p = u.doctorProfile || {};
  // City/state come from the doctor's primary clinic (first clinic).
  const clinics = p.clinics || [];
  const primaryClinic = clinics[0] || {};
  return {
    id: String(u.id),
    name: u.name,
    email: u.email,
    phone: u.phone ?? null,
    avatarUrl: u.profilePhotoUrl ?? null,
    registeredAt: u.createdAt instanceof Date ? u.createdAt.toISOString() : (u.createdAt ?? null),
    qualification: p.qualification ?? null,
    registrationNumber: p.registrationNumber ?? null,
    experienceYears: p.experienceYears ?? null,
    headline: p.headline ?? null,
    verificationStatus: p.verificationStatus ?? "pending",
    isListed: Boolean(p.isListed),
    /** Account status (users.is_active): false = deactivated, cannot sign in. */
    isActive: u.isActive !== false,
    specializations: (p.specializations || []).map((x) => x.name).filter(Boolean),
    clinicName: primaryClinic.name ?? null,
    city: primaryClinic.city ?? null,
    state: primaryClinic.state ?? null,
  };
}

/**
 * One row of the admin's registered-PATIENTS list, newest first. Unlike the
 * clinic directory row this IS allowed to carry email/phone — the admin runs
 * the platform and needs to reach an account holder.
 *
 * `opts.conditions` is an optional array of condition names (batch-fetched by
 * the controller) to include as the diagnosis column.
 */
function serializeRegisteredPatient(user, { conditions = [] } = {}) {
  if (!user) return null;
  const u = plain(user);
  const p = u.patientProfile || {};
  return {
    id: String(u.id),
    name: u.name,
    email: u.email,
    phone: u.phone ?? null,
    avatarUrl: u.profilePhotoUrl ?? null,
    registeredAt: u.createdAt instanceof Date ? u.createdAt.toISOString() : (u.createdAt ?? null),
    gender: p.gender ?? null,
    age: ageFrom(p.dateOfBirth),
    bloodGroup: p.bloodGroup ?? "unknown",
    city: p.city ?? null,
    state: p.state ?? null,
    conditions,
  };
}

/**
 * Who authored a medical record, for the source chip. Reads the eager-loaded
 * `recordedBy` user when present; falls back to the bare `source` string so a
 * row whose author account was deleted (FK is ON DELETE SET NULL) still renders
 * "Added by a clinic" rather than nothing.
 */
function serializeRecordSource(row) {
  const r = plain(row) || {};
  const author = r.recordedBy ? plain(r.recordedBy) : null;
  return {
    source: r.source ?? "patient",
    recordedBy: author ? { id: String(author.id), name: author.name } : null,
  };
}


/**
 * One bookable DAY in the public session list (docs/consultation-queue).
 *
 * `sessionId` is null when the template exists for that date but no row has
 * been materialised yet — nobody has booked it. Clients send the DATE, never
 * the id, and the service materialises on write, so a stale id can't be booked
 * into.
 */
function serializeSessionPublic(session, { booked = 0, clinic = null } = {}) {
  const x = plain(session);
  if (!x) return null;
  const max = x.maxBookings ?? null;
  return {
    sessionId: x.id != null ? String(x.id) : null,
    date: x.sessionDate,
    startTime: hhmm(x.startTime),
    endTime: hhmm(x.endTime),
    clinic: clinic ? { id: String(clinic.id), name: clinic.name, city: clinic.city ?? null } : null,
    booked,
    maxBookings: max,
    isFull: max != null && booked >= max,
    // What the next patient's token will be — "you'll be #13" before they commit.
    nextToken: x.nextToken ?? booked + 1,
    avgConsultMinutes: x.avgConsultMinutes ?? null,
    status: x.status,
  };
}

/** The doctor's own view of a session: the same day plus how it is going. */
function serializeSessionForDoctor(session, counts = {}, clinic = null) {
  const x = plain(session);
  if (!x) return null;
  return {
    id: x.id != null ? String(x.id) : null,
    date: x.sessionDate,
    startTime: hhmm(x.startTime),
    endTime: hhmm(x.endTime),
    status: x.status,
    clinic: clinic ? { id: String(clinic.id), name: clinic.name, city: clinic.city ?? null } : null,
    maxBookings: x.maxBookings ?? null,
    nextToken: x.nextToken ?? 1,
    avgConsultMinutes: x.avgConsultMinutes ?? null,
    currentBookingId: x.currentBookingId != null ? String(x.currentBookingId) : null,
    startedAt: x.startedAt instanceof Date ? x.startedAt.toISOString() : (x.startedAt ?? null),
    endedAt: x.endedAt instanceof Date ? x.endedAt.toISOString() : (x.endedAt ?? null),
    counts: { waiting: 0, serving: 0, done: 0, skipped: 0, ...counts },
  };
}

/** One token in the doctor's queue console. */
function serializeQueueEntry(b) {
  const x = plain(b);
  if (!x) return null;
  const patient = plain(x.patient) || {};
  return {
    bookingId: String(x.id),
    token: x.queueNumber ?? null,
    queueState: x.queueState ?? null,
    status: x.status,
    mode: bookingMode(x.bookingType),
    patient: {
      id: patient.id != null ? String(patient.id) : null,
      name: patient.name ?? null,
      phone: patient.phone ?? null,
      photoUrl: patient.profilePhotoUrl ?? null,
    },
    calledAt: x.calledAt instanceof Date ? x.calledAt.toISOString() : (x.calledAt ?? null),
    consultStartedAt:
      x.consultStartedAt instanceof Date ? x.consultStartedAt.toISOString() : (x.consultStartedAt ?? null),
  };
}

// ── Doctor EMR workspace (migration 051) ─────────────────────────────────────
const { regNoOf } = require("./patientRegNo");
const {
  HISTORY_CATEGORIES,
  COMORBIDITY_CATEGORIES,
  EXAMINATION_FORMS,
  DIAGNOSIS_TYPES,
  INVESTIGATION_TYPES,
  ORDER_PRIORITIES,
  DOCTOR_NOTE_TYPES,
  MEDICINE_ROUTES,
  MEDICINE_TIMINGS,
  MEDICINE_DURATION_UNITS,
  MEDICINE_NAME_TYPES,
  MEDICINE_TYPES,
  FOLLOW_UP_INTERVAL_UNITS,
  CLINICAL_ENTRY_EDIT_HOURS,
} = require("../config/constants");

/** The compact patient identity every EMR list row carries. */
function emrPatientLite(user, profile) {
  const u = plain(user) || {};
  const p = plain(profile ?? u.patientProfile) || {};
  return {
    id: u.id != null ? String(u.id) : null,
    regNo: regNoOf(u.id),
    name: u.name ?? null,
    phone: u.phone ?? null,
    avatarUrl: u.profilePhotoUrl ?? null,
    age: ageFrom(p.dateOfBirth),
    gender: p.gender ?? null,
  };
}

/** One visit on the workbench. In-clinic vs video is the appointment TYPE only. */
function serializeWorkbenchVisit(b) {
  const x = plain(b);
  return {
    bookingId: String(x.id),
    patient: emrPatientLite(x.patient),
    date: x.slotDate,
    startTime: hhmm(x.slotStartTime),
    endTime: hhmm(x.slotEndTime),
    appointmentType: bookingMode(x.bookingType),
    status: x.status,
    queueNumber: x.queueNumber ?? null,
    queueState: x.queueState ?? null,
    clinic: x.clinic ? { id: String(x.clinic.id), name: x.clinic.name, city: x.clinic.city ?? null } : null,
    isReferral: x.referralId != null,
    // An unpaid hold does not unlock the patient's record (same rule as the
    // existing appointment detail), so the workbench can't open it yet.
    canOpen: x.status !== "pending_payment",
  };
}

function serializeRosterEntry({ row, profile }) {
  return {
    patient: emrPatientLite(row.patient, profile),
    visitCount: Number(row.get("visitCount")),
    lastVisitOn: row.get("lastVisitOn"),
    lastBookingId: String(row.get("lastBookingId")),
  };
}

function serializeWorkbench(w) {
  return {
    date: w.date,
    view: w.view,
    counts: w.counts,
    consultations: w.consultations.map(serializeWorkbenchVisit),
    today: w.today.map(serializeWorkbenchVisit),
    upcoming: { rows: w.upcoming.rows.map(serializeWorkbenchVisit), capped: w.upcoming.capped },
    previous: { rows: w.previous.rows.map(serializeRosterEntry), capped: w.previous.capped },
    all: { rows: w.all.rows.map(serializeRosterEntry), capped: w.all.capped },
  };
}

/**
 * One structured consultation entry. With `viewerId` (a doctor) it adds
 * `isMine` + `canEdit` — computed by the SAME rule the service enforces
 * (passed in as `canEdit`), so the UI never offers an edit the server refuses.
 */
function serializeClinicalEntry(e, { viewerId, canEdit } = {}) {
  if (!e) return null;
  const x = plain(e);
  const booking = plain(x.booking);
  const out = {
    id: String(x.id),
    kind: x.kind,
    category: x.category ?? null,
    title: x.title ?? null,
    code: x.code ?? null,
    // Migration 059 — the catalogue row a diagnosis was coded from + the
    // snapshot taken when it was picked (null on free-text / older entries).
    icdCodeId: x.icdCodeId != null ? String(x.icdCodeId) : null,
    codeSystem: x.codeSystem ?? null,
    codeVersion: x.codeVersion ?? null,
    codeDescription: x.codeDescription ?? null,
    details: x.details ?? null,
    remarks: x.remarks ?? null,
    recordedOn: x.recordedOn ?? null,
    patientVisible: Boolean(x.patientVisible),
    status: x.status,
    retiredReason: x.retiredReason ?? null,
    bookingId: x.bookingId != null ? String(x.bookingId) : null,
    visitDate: booking?.slotDate ?? null,
    author: x.author ? { id: String(x.author.id), name: x.author.name } : null,
    createdAt: isoOrNull(x.createdAt),
    updatedAt: isoOrNull(x.updatedAt),
  };
  if (viewerId != null) {
    out.isMine = String(x.doctorId) === String(viewerId);
    out.canEdit = Boolean(canEdit && canEdit(x, viewerId));
  }
  return out;
}

/** One ICD catalogue row (admin master + doctor search). */
function serializeIcdCode(row, { usedCount } = {}) {
  const x = plain(row);
  const out = {
    id: String(x.id),
    codingSystem: x.codingSystem,
    systemVersion: x.systemVersion,
    code: x.code,
    title: x.title,
    description: x.description ?? null,
    category: x.category ?? null,
    isActive: Boolean(x.isActive),
  };
  if (usedCount) {
    out.usedCount = usedCount(x.id);
    out.createdAt = isoOrNull(x.createdAt);
    out.updatedAt = isoOrNull(x.updatedAt);
  }
  return out;
}

function serializeIcdPage({ rows, total, page, limit, usedCount }) {
  return { rows: rows.map((r) => serializeIcdCode(r, { usedCount })), total, page, limit };
}

// ── Patient Workbench → prescription (migration 059) ─────────────────────────
const SNAP_VITAL_KEYS = [
  "bpSystolic",
  "bpDiastolic",
  "bloodPressure",
  "pulseRateBpm",
  "heartRateBpm",
  "respiratoryRate",
  "spo2Percent",
  "temperatureF",
  "heightCm",
  "weightKg",
];
const numOrNull = (v) => (v == null || v === "" || Number.isNaN(Number(v)) ? null : Number(v));

/**
 * One vitals reading for the prescription: the NEWEST non-null value of each
 * field across `rows` (all from the same source), never invented. BP is the
 * structured pair when recorded, else the legacy string; BMI is derived.
 */
function snapshotVitals(rows, source) {
  if (!rows.length) return { source: "none", values: null, recordedOn: null, recordedAt: null, readings: 0 };
  const values = {};
  for (const r of rows.map(plain)) {
    for (const k of SNAP_VITAL_KEYS) {
      if (values[k] == null && r[k] != null && r[k] !== "") values[k] = k === "bloodPressure" ? String(r[k]) : numOrNull(r[k]);
    }
  }
  if (values.bpSystolic != null && values.bpDiastolic != null) values.bloodPressure = `${values.bpSystolic}/${values.bpDiastolic}`;
  for (const k of SNAP_VITAL_KEYS) if (!(k in values)) values[k] = null;
  values.bmi =
    values.weightKg && values.heightCm ? Math.round((values.weightKg / (values.heightCm / 100) ** 2) * 10) / 10 : null;
  const newest = plain(rows[0]);
  return {
    source,
    values,
    recordedOn: newest.recordedOn ?? null,
    recordedAt: isoOrNull(newest.recordedAt ?? newest.createdAt),
    readings: rows.length,
  };
}

const plural = (n, unit) => `${n} ${unit}${Number(n) > 1 ? "s" : ""}`;
/** "1. … 2. …" on separate lines — the numbered-list text the composer and the PDF already use. */
const numberedText = (lines, max) => lines.map((l, i) => `${i + 1}. ${l}`).join(String.fromCharCode(10)).slice(0, max);

/** "Low back pain (ICD-10 M54.5) — provisional" — the line printed on the prescription. */
function diagnosisLine(d) {
  const code = d.code ? ` (${[d.codeSystem, d.code].filter(Boolean).join(" ")})` : "";
  const type = d.type && d.type !== "final" ? ` — ${d.type}` : "";
  return `${d.title}${code}${type}`;
}

/**
 * The Patient Workbench information a prescription is written from, as one
 * plain object: stored on the prescription (clinical_snapshot) and returned to
 * the composer. Only entries of THIS consultation (booking) by THIS doctor are
 * passed in. `printed` is what goes onto the prescription document: entries the
 * doctor did not mark "show to patient" are listed but never printed (the
 * patient receives the prescription).
 */
function buildWorkbenchSnapshot({
  booking,
  patient,
  entries,
  vitalRows,
  vitalSource,
  followUp,
  examForms = [],
  historyCategories = [],
  comorbidityCategories = [],
}) {
  const b = plain(booking);
  const u = plain(patient) || {};
  const p = plain(u.patientProfile) || {};
  const doctor = plain(b.doctor);
  const rows = (entries || []).map(plain);
  const ofKind = (kind) => rows.filter((e) => e.kind === kind);

  const complaints = ofKind("complaint").map((e) => ({
    id: String(e.id),
    title: e.title,
    since: e.details?.duration ? plural(e.details.duration, e.details.durationUnit || "day") : null,
    severity: e.details?.severity ?? null,
    remarks: e.remarks ?? null,
    patientVisible: Boolean(e.patientVisible),
  }));
  const formLabel = (key) => examForms.find((f) => f.key === key);
  const examinations = ofKind("examination").map((e) => {
    const form = formLabel(e.category);
    const fieldLabel = (k) => form?.fields?.find((f) => f.key === k)?.label ?? k;
    return {
      id: String(e.id),
      form: e.category,
      label: form?.label ?? e.category,
      findings: Object.entries(e.details || {})
        .filter(([, v]) => v != null && String(v).trim() !== "")
        .map(([k, v]) => ({ label: fieldLabel(k), value: String(v) })),
      remarks: e.remarks ?? null,
      patientVisible: Boolean(e.patientVisible),
    };
  });
  const diagnoses = ofKind("diagnosis").map((e) => ({
    id: String(e.id),
    title: e.title,
    code: e.code ?? null,
    icdCodeId: e.icdCodeId != null ? String(e.icdCodeId) : null,
    codeSystem: e.codeSystem ?? null,
    codeVersion: e.codeVersion ?? null,
    codeDescription: e.codeDescription ?? null,
    type: e.category ?? null,
    stage: e.details?.stage ?? null,
    remarks: e.remarks ?? null,
    patientVisible: Boolean(e.patientVisible),
  }));
  // Added in snapshot version 2. A version-1 snapshot (frozen before) has none
  // of these keys; readers treat a missing list as empty.
  const catLabel = (defs, key) => defs.find((d) => d.key === key)?.label ?? key ?? null;
  const history = ofKind("history").map((e) => {
    const def = historyCategories.find((c) => c.key === e.category);
    return {
      id: String(e.id),
      category: e.category ?? null,
      label: catLabel(historyCategories, e.category),
      findings: Object.entries(e.details || {})
        .filter(([, v]) => v != null && String(v).trim() !== "")
        .map(([k, v]) => ({ label: def?.fields?.find((f) => f.key === k)?.label ?? k, value: String(v) })),
      remarks: e.remarks ?? null,
      recordedOn: e.recordedOn ?? null,
      patientVisible: Boolean(e.patientVisible),
    };
  });
  const comorbidities = ofKind("comorbidity").map((e) => ({
    id: String(e.id),
    title: e.title,
    category: catLabel(comorbidityCategories, e.category),
    remarks: e.remarks ?? null,
    since: e.recordedOn ?? null,
    patientVisible: Boolean(e.patientVisible),
  }));
  const investigations = ofKind("investigation").map((e) => ({
    id: String(e.id),
    title: e.title,
    type: e.category ?? null,
    priority: e.details?.priority ?? null,
    quantity: e.details?.quantity != null ? Number(e.details.quantity) : null,
    instruction: e.remarks ?? null,
    patientVisible: Boolean(e.patientVisible),
  }));
  // Only published notes reach here (prescriptionWorkbench.gather): they are
  // what the doctor chose to tell the patient, so they print as Advice.
  const advice = ofKind("doctor_note")
    .filter((e) => e.patientVisible && e.remarks && String(e.remarks).trim())
    .map((e) => ({ id: String(e.id), type: e.category ?? null, text: String(e.remarks).trim(), createdAt: isoOrNull(e.createdAt) }));

  const vitals = snapshotVitals(vitalRows || [], vitalSource);
  // Only a reading of THIS consultation (or taken on its day) goes onto the
  // prescription — an older one is shown with its date, never printed as today's.
  const vitalsPrintable = vitals.source === "consultation" || vitals.source === "same_day";
  const v = vitals.values;

  const shownComplaints = complaints.filter((c) => c.patientVisible);
  const shownDiagnoses = diagnoses.filter((d) => d.patientVisible);
  const f = plain(followUp);

  const shownInvestigations = investigations.filter((i) => i.patientVisible);

  return {
    version: 2,
    syncedAt: new Date().toISOString(),
    patient: {
      id: u.id != null ? String(u.id) : null,
      regNo: regNoOf(u.id),
      name: u.name ?? null,
      dateOfBirth: p.dateOfBirth ?? null,
      age: ageFrom(p.dateOfBirth),
      gender: p.gender ?? null,
      phone: u.phone ?? null,
      bloodGroup: p.bloodGroup ?? null,
      address: [p.addressLine, p.city, p.state, p.pincode].filter(Boolean).join(", ") || null,
    },
    consultation: {
      bookingId: String(b.id),
      date: b.slotDate,
      startTime: hhmm(b.slotStartTime),
      appointmentType: bookingMode(b.bookingType),
      status: b.status,
      clinic: b.clinic ? { id: String(b.clinic.id), name: b.clinic.name, city: b.clinic.city ?? null } : null,
      doctor: doctor
        ? {
            id: String(doctor.userId),
            name: doctor.user?.name ?? null,
            qualification: doctor.qualification ?? null,
            specializations: (doctor.specializations || []).map((s) => s.name),
          }
        : null,
    },
    vitals: { ...vitals, printable: vitalsPrintable && Boolean(v) },
    complaints,
    examinations,
    diagnoses,
    history,
    comorbidities,
    investigations,
    advice,
    followUp: f
      ? {
          followUpOn: f.followUpOn ?? null,
          note: f.note ?? null,
          intervalValue: f.intervalValue ?? null,
          intervalUnit: f.intervalUnit ?? null,
          comments: f.comments ?? null,
        }
      : null,
    // What the prescription document carries. A null field = nothing in the
    // Workbench for it, so the prescription keeps the doctor's own value.
    printed: {
      chiefComplaint: shownComplaints.length
        ? numberedText(
            shownComplaints.map((c) =>
              [c.title, [c.since && `since ${c.since}`, c.severity].filter(Boolean).join(", ")].filter(Boolean).join(" — ")
            ),
            500
          )
        : null,
      diagnosis: shownDiagnoses.length ? numberedText(shownDiagnoses.map(diagnosisLine), 500) : null,
      vitals:
        vitalsPrintable && v
          ? {
              bloodPressure: v.bloodPressure,
              pulseRateBpm: v.pulseRateBpm,
              temperatureF: v.temperatureF,
              spo2Percent: v.spo2Percent,
              heightCm: v.heightCm,
              weightKg: v.weightKg,
            }
          : null,
      followUpDate: f?.followUpOn ?? null,
      // The follow-up "Note for the patient" (the instructions printed with the date).
      followUpNote: f?.note ?? null,
      advice: advice.length ? numberedText(advice.map((a) => a.text), 5000) : null,
      investigations: shownInvestigations.map((i) =>
        [
          i.title,
          [i.priority && i.priority !== "routine" ? i.priority.toUpperCase() : null, i.quantity && i.quantity > 1 ? `×${i.quantity}` : null]
            .filter(Boolean)
            .join(" "),
          i.instruction,
        ]
          .filter(Boolean)
          .join(" — ")
      ),
    },
  };
}

/** A visit header (previous-visit list, encounter chip). */
function serializeEmrVisit(b) {
  if (!b) return null;
  const x = plain(b);
  const doctor = plain(x.doctor);
  return {
    bookingId: String(x.id),
    date: x.slotDate,
    startTime: hhmm(x.slotStartTime),
    appointmentType: bookingMode(x.bookingType),
    status: x.status,
    queueNumber: x.queueNumber ?? null,
    consultStartedAt: isoOrNull(x.consultStartedAt),
    consultEndedAt: isoOrNull(x.consultEndedAt),
    clinic: x.clinic ? { id: String(x.clinic.id), name: x.clinic.name, city: x.clinic.city ?? null } : null,
    doctor: doctor
      ? {
          id: String(doctor.userId),
          name: doctor.user?.name ?? null,
          // The doctor's own profile photo (already loaded by the visit's doctorInclude).
          photoUrl: doctor.user?.profilePhotoUrl ?? null,
          qualification: doctor.qualification ?? null,
          specializations: (doctor.specializations || []).map((s) => s.name),
        }
      : null,
  };
}

/** Newest non-null value of each vital + when it was measured (never invented). */
function latestVitals(entries) {
  const out = {};
  for (const e of entries) {
    for (const [key, value] of Object.entries(e.values)) {
      if (value == null || out[key]) continue;
      out[key] = {
        value,
        recordedOn: e.recordedOn,
        recordedAt: e.recordedAt,
        status: e.statuses[key]?.status ?? "unknown",
        label: e.statuses[key]?.label ?? null,
      };
    }
  }
  return out;
}

function emrIdentity(user) {
  const u = plain(user);
  const p = plain(u.patientProfile) || {};
  const snap = serializePatientSnapshot(user);
  return {
    id: String(u.id),
    regNo: regNoOf(u.id),
    registeredAt: isoOrNull(u.createdAt),
    name: u.name,
    phone: u.phone ?? null,
    email: u.email ?? null,
    avatarUrl: u.profilePhotoUrl ?? null,
    age: snap.age,
    dateOfBirth: snap.dateOfBirth,
    gender: snap.gender,
    bloodGroup: snap.bloodGroup,
    address: [p.addressLine, p.city, p.state, p.pincode].filter(Boolean).join(", ") || null,
    emergencyContact:
      p.emergencyContactName || p.emergencyContactPhone
        ? { name: p.emergencyContactName ?? null, phone: p.emergencyContactPhone ?? null }
        : null,
    allergies: snap.allergies,
    conditions: snap.conditions,
    currentMedications: snap.currentMedications,
    noKnownAllergies: Boolean(p.noKnownAllergies),
    noKnownConditions: Boolean(p.noKnownConditions),
    noCurrentMedications: Boolean(p.noCurrentMedications),
  };
}

function serializeEmrWorkspace({ user, encounter, latestVitalRows, visits, access }, { age } = {}) {
  const vitals = serializePatientVitals(latestVitalRows, { age, fields: VITALS_EMR_FIELDS });
  const enc = plain(encounter);
  return {
    patient: emrIdentity(user),
    encounter: enc
      ? {
          ...serializeEmrVisit(encounter),
          // Writes go through THIS visit; an unpaid hold is read-only.
          canRecord: ["confirmed", "completed"].includes(enc.status),
        }
      : null,
    latestVitals: latestVitals(vitals.entries),
    vitalFields: VITALS_EMR_FIELDS,
    visits: (visits || []).map(serializeEmrVisit),
    // Which of other doctors' records this doctor may see (migration 057).
    access: access ? serializeClinicalAccess(access) : null,
  };
}

function serializeVisitSummary(
  { booking, vitals, prescription, entries, notes, followUp, locked = [] },
  { viewer, age, canEdit } = {}
) {
  const isPatient = viewer?.role === "patient";
  let rx = null;
  if (prescription) {
    rx = isPatient
      ? serializePrescriptionForPatient(prescription)
      : {
          id: String(prescription.id),
          status: prescription.status,
          rxNumber: prescription.rxNumber ?? null,
          version: prescription.version,
          finalizedAt: prescription.finalizedAt ?? null,
          ...rxClinical(plain(prescription)),
          items: (prescription.items || []).map(serializeRxItem),
        };
  }
  return {
    visit: serializeEmrVisit(booking),
    vitals: serializePatientVitals(vitals, { age, fields: VITALS_EMR_FIELDS }).entries,
    prescription: rx,
    entries: entries.map((e) => serializeClinicalEntry(e, isPatient ? {} : { viewerId: viewer.id, canEdit })),
    clinicalNotes: (notes || []).map(serializeClinicalNote),
    followUp: serializeFollowUp(followUp),
    // Parts of ANOTHER doctor's visit this doctor has not been granted (migration 057).
    locked,
  };
}

/** The static vocabulary the EMR forms render (structure only — no clinical data). */
function serializeEmrCatalog() {
  return {
    historyCategories: HISTORY_CATEGORIES,
    comorbidityCategories: COMORBIDITY_CATEGORIES,
    examinationForms: EXAMINATION_FORMS,
    diagnosisTypes: DIAGNOSIS_TYPES,
    investigationTypes: INVESTIGATION_TYPES,
    priorities: ORDER_PRIORITIES,
    noteTypes: DOCTOR_NOTE_TYPES,
    medicineRoutes: MEDICINE_ROUTES,
    medicineTimings: MEDICINE_TIMINGS,
    durationUnits: MEDICINE_DURATION_UNITS,
    medicineNameTypes: MEDICINE_NAME_TYPES,
    // Dosage forms, the catalogue's own vocabulary (medicine_masters.medicine_type).
    dosageForms: MEDICINE_TYPES,
    followUpIntervalUnits: FOLLOW_UP_INTERVAL_UNITS,
    entryEditHours: CLINICAL_ENTRY_EDIT_HOURS,
    vitalFields: VITALS_EMR_FIELDS,
  };
}

function serializeMedicineSearch({ mine, catalogue }) {
  return [
    ...mine.map((m) => ({
      source: "mine",
      medicineId: String(m.id),
      // The catalogue row this own-list entry is linked to (migration 055).
      catalogueId: m.medicineMasterId != null ? String(m.medicineMasterId) : null,
      name: m.name,
      genericName: m.genericName ?? null,
      type: m.form ?? null,
      // Dosage form (tablet, syrup, …) — `type` keeps its old meaning for older clients.
      dosageForm: m.dosageForm ?? null,
      strength: m.strength ?? null,
      manufacturer: m.manufacturer ?? null,
      // The doctor's saved defaults (migration 054); the catalogue has none.
      defaultFrequency: m.defaultFrequency || null,
      defaultTiming: m.defaultTiming ?? null,
    })),
    ...catalogue.map((m) => ({
      source: "catalogue",
      medicineId: null,
      catalogueId: String(m.id),
      name: m.medicineName,
      genericName: m.genericName ?? null,
      type: m.medicineType ?? null,
      dosageForm: m.medicineType ?? null,
      defaultFrequency: null,
      defaultTiming: null,
      strength: m.strength ?? null,
      manufacturer: m.manufacturer ?? null,
    })),
  ];
}

function serializeInvestigationSearch(rows) {
  return rows.map((r) => ({
    diagnosticTestId: String(r.id),
    name: r.name,
    labCount: Number(r.labCount),
    minPrice: r.minPrice != null ? Number(r.minPrice) : null,
  }));
}

function serializeMedicalProfile({ user, vitals, entries, visits, followUps }, { age } = {}) {
  const matrix = serializePatientVitals(vitals, { age, fields: VITALS_EMR_FIELDS });
  return {
    patient: emrIdentity(user),
    latestVitals: latestVitals(matrix.entries),
    vitals: matrix,
    entries: entries.map((e) => serializeClinicalEntry(e)),
    visits: visits.map(serializeEmrVisit),
    followUps: followUps.map((f) => ({
      ...serializeFollowUp(f),
      doctor: f.doctor ? { id: String(f.doctor.id), name: f.doctor.name } : null,
    })),
  };
}

// ── Structured clinical history (patient record + doctor workbench) ──────────
/**
 * One prescription in the history. The builder decided, per part, what this
 * viewer may see (medicines / diagnosis / complaint) — a hidden part is null
 * here and is never sent.
 */
function serializeHistoryRx({ rx, showItems, showDiagnosis, showComplaint }) {
  const x = plain(rx);
  const doctor = plain(x.doctor);
  return {
    id: String(x.id),
    rxNumber: x.rxNumber ?? null,
    status: x.status,
    version: x.version ?? 1,
    finalizedAt: isoOrNull(x.finalizedAt),
    createdAt: isoOrNull(x.createdAt),
    bookingId: x.bookingId != null ? String(x.bookingId) : null,
    visitDate: plain(x.booking)?.slotDate ?? null,
    doctor: doctor ? { id: String(doctor.userId), name: doctor.user?.name ?? null } : null,
    chiefComplaint: showComplaint ? x.chiefComplaint ?? null : null,
    diagnosis: showDiagnosis ? x.diagnosis ?? null : null,
    advice: showItems ? x.advice ?? null : null,
    noMedication: Boolean(x.noMedication),
    items: showItems ? (x.items || []).map(serializeRxItem) : [],
  };
}

/** A legacy consultation note with its diagnosis / history lines masked as decided. */
function serializeHistoryNote({ note, showDiagnosis, showHistory, showTreatment = true }) {
  const out = serializeClinicalNote(note);
  return {
    ...out,
    bookingId: note.bookingId != null ? String(note.bookingId) : null,
    diagnosis: showDiagnosis ? out.diagnosis : null,
    historyMedical: showHistory ? out.historyMedical : null,
    historySurgical: showHistory ? out.historySurgical : null,
    treatment: showTreatment ? out.treatment : null,
  };
}

function serializeHistoryFollowUp(f) {
  if (!f) return null;
  const out = serializeFollowUp(f);
  return out ? { ...out, doctor: f.doctor ? { id: String(f.doctor.id), name: f.doctor.name } : null } : null;
}

/**
 * The structured history from medicalHistory.service#build. `viewerId` (a
 * doctor) adds `isMine` on entries; `access` (a doctor) is the per-category
 * consent summary so the UI can draw locked sections and Request Access.
 */
function serializeMedicalHistory(h, { viewerId = null, age = null, access = null } = {}) {
  const entry = (e) => serializeClinicalEntry(e, viewerId != null ? { viewerId } : {});
  const entries = (rows) => (rows == null ? null : rows.map(entry));
  return {
    consultations: h.consultations.map((c) => ({
      visit: serializeEmrVisit(c.booking),
      isMine: Boolean(c.isMine),
      complaints: entries(c.complaints),
      examinations: entries(c.examinations),
      diagnoses: entries(c.diagnoses),
      rxDiagnosis: c.rxDiagnosis ?? null,
      advice: c.advice ?? null,
      investigations: entries(c.investigations),
      notes: entries(c.notes),
      consultationNotes: c.legacyNotes == null ? null : c.legacyNotes.map(serializeHistoryNote),
      prescription: c.prescription ? serializeHistoryRx(c.prescription) : null,
      vitals: serializePatientVitals(c.vitals, { age, fields: VITALS_EMR_FIELDS }).entries,
      followUp: serializeHistoryFollowUp(c.followUp),
      locked: c.locked,
    })),
    medicalHistory: entries(h.medicalHistory),
    longTermConditions: entries(h.longTermConditions),
    diagnoses: entries(h.diagnoses),
    prescriptionDiagnoses: h.rxDiagnoses.map(({ rx }) => {
      const x = plain(rx);
      const doctor = plain(x.doctor);
      return {
        prescriptionId: String(x.id),
        diagnosis: x.diagnosis,
        bookingId: x.bookingId != null ? String(x.bookingId) : null,
        visitDate: plain(x.booking)?.slotDate ?? null,
        date: isoOrNull(x.finalizedAt ?? x.createdAt),
        doctor: doctor ? { id: String(doctor.userId), name: doctor.user?.name ?? null } : null,
      };
    }),
    prescriptions: h.prescriptions.map(serializeHistoryRx),
    investigations: entries(h.investigations),
    doctorNotes: entries(h.doctorNotes),
    consultationNotes: h.legacyNotes.map(serializeHistoryNote),
    lockedCategories: h.lockedCategories,
    capped: h.capped,
    access: access ? serializeClinicalAccess(access) : null,
  };
}

/** The doctor's per-category consent summary for one patient (migration 057). */
function serializeClinicalAccess(a) {
  return {
    categories: a.categories.map((c) => ({
      category: c.category,
      label: c.label,
      description: c.description,
      status: c.status,
      granted: c.granted,
      grantExpiresAt: isoOrNull(c.grantExpiresAt),
      requestId: c.requestId,
      requestedAt: isoOrNull(c.requestedAt),
      decidedAt: isoOrNull(c.decidedAt),
      requestExpiresAt: isoOrNull(c.requestExpiresAt),
      canRequest: c.canRequest,
      retryAt: isoOrNull(c.retryAt),
    })),
    grantedCount: a.grantedCount,
    grantDays: a.grantDays,
    defaultGrantDays: a.defaultGrantDays,
    ...(a.skipped ? { skipped: a.skipped } : {}),
  };
}

module.exports = {
  buildWorkbenchSnapshot,
  serializeIcdCode,
  serializeIcdPage,
  serializeMedicalHistory,
  serializeClinicalAccess,
  serializeWorkbench,
  serializeClinicalEntry,
  serializeEmrWorkspace,
  serializeVisitSummary,
  serializeEmrCatalog,
  serializeMedicineSearch,
  serializeInvestigationSearch,
  serializeMedicalProfile,
  serializeSubSpecialization,
  serializePublicEducation,
  serializeNotification,
  serializeAccessRequestForDoctor,
  serializeAccessRequestForPatient,
  serializeAccessRequestPage,
  serializeDoctorPatientSearch,
  serializeDoctorPatientCard,
  serializeUser,
  serializeRegisteredDoctor,
  serializeRegisteredPatient,
  serializeClinicProfile,
  serializeClinicPublic,
  serializeClinicDocument,
  serializeClinicPatientRow,
  serializeRecordSource,
  serializeBookedBy,
  serializeBookingPayment,
  serializePaymentQr,
  serializeQrPaymentRequest,
  serializeReferral,
  serializeReferralTarget,
  serializeIncomingReferral,
  serializeReferralCase,
  serializePendingReferral,
  serializeJourneySummary,
  serializeJourneyDetail,
  serializeTimelineRow,
  serializeTimeline,
  serializeDoctorPatients,
  serializeClinicalNote,
  serializeFollowUpStatus,
  serializeFollowUp,
  serializeReminder,
  serializeUpcomingFollowUp,
  serializeContactMessage,
  serializeContactMessageForAdmin,
  serializeBookingForAdmin,
  serializePatientProfile,
  serializePatientDashboard,
  serializeDoctorDashboard,
  serializeEarningsSummary,
  serializeEarningsBucket,
  serializeLedgerRow,
  serializeAdminDashboard,
  serializeRevenueBucket,
  serializeTemplate,
  serializeTemplateSummary,
  serializePrescriptionForDoctor,
  serializePrescriptionSummary,
  serializePrescriptionForPatient,
  serializeBookingForPatient,
  serializeBookingForDoctor,
  serializePatientSnapshot,
  serializeDoctorDocument,
  serializePatientVitals,
  VITALS_EMR_FIELDS,
  serializeAllergyEntry,
  serializeConditionEntry,
  serializeMedication,
  serializeUploadedRecord,
  serializeRazorpayOrder,
  serializeVideoSession,
  serializeVideoToken,
  serializeSpecialization,
  serializeLanguage,
  serializeAward,
  serializeTestimonial,
  serializeLink,
  serializeDocument,
  serializeKeyword,
  serializeEducation,
  serializeExperience,
  serializeService,
  serializePublication,
  serializeMembership,
  serializePublicMembership,
  serializeGalleryImage,
  serializeAffiliation,
  serializeFellowship,
  serializeExpertise,
  sortByYearDesc,
  serializeFaq,
  serializeInsurance,
  serializeDoctorProfile,
  serializePublicDoctor,
  toMapDoctor,
  serializeWeeklySlot,
  serializeSessionPublic,
  serializeSessionForDoctor,
  serializeQueueEntry,
  serializeException,
  serializeOwnClinic,
  serializePublicClinic,
  serializeOnlineAvailability,
};
