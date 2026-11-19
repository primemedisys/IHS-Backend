/**
 * Admin registry — the read side of "who is on the platform".
 *
 * Two flat lists (every registered doctor / patient, NEWEST-REGISTERED FIRST)
 * plus one patient deep-read. Deliberately separate from the verification
 * queue (verification.service): that answers "who is waiting on a verdict",
 * this answers "who exists" regardless of status.
 *
 * The patient detail and the admin record upload REUSE patient.service — the
 * admin sees exactly what the patient sees, and an admin upload goes through
 * the same code path a patient's own upload does (stamped source 'admin').
 */
const { Op, QueryTypes } = require("sequelize");
const { sequelize, User, PatientProfile, DoctorProfile, Specialization, UploadedRecord, Clinic, Condition, PatientCondition, AccessAuditLog, RefreshToken } = require("../models");
const ApiError = require("../utils/ApiError");
const { ROLES, ERROR_CODES } = require("../config/constants");

/** Case-insensitive contains-match on the identity fields, when `q` is given. */
const searchWhere = (q) =>
  q
    ? {
        [Op.or]: [
          { name: { [Op.like]: `%${q}%` } },
          { email: { [Op.like]: `%${q}%` } },
          { phone: { [Op.like]: `%${q}%` } },
        ],
      }
    : {};

/**
 * Every registered doctor, newest first, with the profile facts the list shows.
 * Supports optional filtering by city, state, and experience range.
 * City/state are filtered through the doctor's primary clinic location.
 */
async function listDoctors({ q, city, state, minExperience, maxExperience, location } = {}) {
  const where = { role: ROLES.DOCTOR, ...searchWhere(q) };
  // Also match the medical registration number (lives on the joined profile).
  if (q) {
    where[Op.or].push(sequelize.where(sequelize.col("doctorProfile.registration_number"), { [Op.like]: `%${q}%` }));
  }

  const doctorWhere = {};
  if (minExperience) {
    doctorWhere.experienceYears = { ...doctorWhere.experienceYears, [Op.gte]: Number(minExperience) };
  }
  if (maxExperience) {
    doctorWhere.experienceYears = { ...doctorWhere.experienceYears, [Op.lte]: Number(maxExperience) };
  }

  // When city/state/location filtering is needed, we must require the Clinic
  // include (INNER JOIN) so non-matching doctors are excluded from results.
  // `location` matches against EITHER city or state (OR).
  const clinicFilter = city || state || location;
  const clinicWhere = clinicFilter
    ? {
        ...(city ? { city: { [Op.like]: `%${city}%` } } : {}),
        ...(state ? { state: { [Op.like]: `%${state}%` } } : {}),
        ...(location
          ? { [Op.or]: [
              { city: { [Op.like]: `%${location}%` } },
              { state: { [Op.like]: `%${location}%` } },
            ] }
          : {}),
      }
    : undefined;

  const include = [
    {
      model: DoctorProfile,
      as: "doctorProfile",
      attributes: ["qualification", "registrationNumber", "experienceYears", "headline", "verificationStatus", "isListed"],
      where: Object.keys(doctorWhere).length > 0 ? doctorWhere : undefined,
      required: Object.keys(doctorWhere).length > 0,
      include: [
        { model: Specialization, as: "specializations", through: { attributes: [] }, attributes: ["name"], required: false },
        {
          model: Clinic,
          as: "clinics",
          attributes: ["name", "city", "state"],
          where: clinicWhere,
          required: Boolean(clinicFilter),
        },
      ],
    },
  ];

  const rows = await User.findAll({
    where,
    include,
    order: [
      ["createdAt", "DESC"],
      ["id", "DESC"],
    ],
    // No GROUP BY: the hasMany includes (clinics, specializations) already collapse
    // into ONE user row with nested arrays. The old `group: ["User.id"]` selected
    // non-aggregated joined columns and failed under MySQL ONLY_FULL_GROUP_BY (500).
  });

  return rows;
}

/**
 * Every registered patient, newest first, with the profile facts the list shows.
 * Supports optional filtering by city, state, gender, location, and condition name.
 */
function listPatients({ q, city, state, gender, location, conditionName } = {}) {
  const where = { role: ROLES.PATIENT, ...searchWhere(q) };

  const profileWhere = {};
  if (city) profileWhere.city = { [Op.like]: `%${city}%` };
  if (state) profileWhere.state = { [Op.like]: `%${state}%` };
  if (gender) profileWhere.gender = gender;
  // `location` matches against EITHER city or state (OR).
  if (location) {
    profileWhere[Op.or] = [
      { city: { [Op.like]: `%${location}%` } },
      { state: { [Op.like]: `%${location}%` } },
    ];
  }

  // Condition filter: join through PatientProfile → Condition (M:N via patient_conditions).
  const conditionInclude = conditionName
    ? [
        {
          model: Condition,
          as: "conditions",
          attributes: [],
          where: { name: { [Op.like]: `%${conditionName}%` } },
          required: true,
        },
      ]
    : [];

  return User.findAll({
    where,
    include: [
      {
        model: PatientProfile,
        as: "patientProfile",
        attributes: ["dateOfBirth", "gender", "bloodGroup", "city", "state"],
        where: Object.keys(profileWhere).length > 0 ? profileWhere : undefined,
        required: Object.keys(profileWhere).length > 0,
        include: conditionInclude,
      },
    ],
    order: [
      ["createdAt", "DESC"],
      ["id", "DESC"],
    ],
  });
}

/**
 * Fetch chronic conditions for multiple patients in one batch query.
 * Returns a map of patientId -> condition names array.
 */
async function patientConditions(patientIds) {
  if (!patientIds.length) return {};
  const rows = await PatientCondition.findAll({
    where: { patientId: { [Op.in]: patientIds } },
    include: [{ model: Condition, as: "condition", attributes: ["name"] }],
    attributes: ["patientId"],
    raw: true,
    nest: true,
  });
  const map = {};
  for (const r of rows) {
    const id = String(r.patientId);
    if (!map[id]) map[id] = [];
    if (r.condition?.name) map[id].push(r.condition.name);
  }
  return map;
}

/**
 * Assert the target is a registered patient before any deep read/write. Every
 * /registry/patients/:id handler goes through this, so an admin URL pointing
 * at a doctor's id (or nothing) 404s instead of leaking a mis-joined profile.
 */
async function assertPatient(id) {
  const user = await User.findOne({ where: { id, role: ROLES.PATIENT }, attributes: ["id"] });
  if (!user) throw ApiError.notFound("Patient not found");
  return user;
}

/** How many documents each of the four buckets holds — the "uploaded vs. remaining" row. */
async function recordCounts(patientId) {
  // The four clinical buckets only — identity documents are the patient's own.
  const rows = await UploadedRecord.scope("clinical").findAll({
    where: { patientId },
    attributes: ["fileType"],
  });
  const counts = { prescription: 0, lab_report: 0, xray: 0, mri: 0, other: 0 };
  for (const r of rows) counts[r.fileType] = (counts[r.fileType] ?? 0) + 1;
  return counts;
}

/**
 * What deleting this patient would destroy.
 *
 * Shown to the admin BEFORE they confirm, because the counts are the only
 * honest description of the action: this does not hide a patient, it erases
 * consultations, prescriptions and clinical notes that DOCTORS wrote and that
 * those doctors will also lose.
 */
async function deletionPreview(patientId) {
  const [rows] = await sequelize.query(
    `SELECT
       (SELECT COUNT(*) FROM bookings          WHERE patient_id = :id) AS bookings,
       (SELECT COUNT(*) FROM prescriptions     WHERE patient_id = :id) AS prescriptions,
       (SELECT COUNT(*) FROM clinical_notes    WHERE patient_id = :id) AS clinicalNotes,
       (SELECT COUNT(*) FROM uploaded_records  WHERE patient_id = :id) AS documents,
       (SELECT COUNT(*) FROM referrals         WHERE patient_id = :id) AS referrals,
       (SELECT COUNT(*) FROM care_journeys     WHERE patient_id = :id) AS journeys,
       (SELECT COUNT(*) FROM patient_vitals pv
          JOIN patient_profiles pp ON pp.user_id = pv.patient_id
         WHERE pv.patient_id = :id) AS vitals,
       (SELECT COUNT(*) FROM payments p
          JOIN bookings b ON b.id = p.booking_id
         WHERE b.patient_id = :id) AS payments`,
    { replacements: { id: patientId }, type: QueryTypes.SELECT }
  );
  return Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, Number(v)]));
}

/**
 * Erase a patient and everything that makes them visible anywhere on the
 * platform. Irreversible.
 *
 * Not a soft delete: after this the patient is gone from the doctor's roster,
 * every appointment board, every treatment timeline, the prescription list, the
 * referral inbox and the queue — because the rows those views read are gone,
 * not hidden behind a flag that some future query forgets to apply.
 *
 * ORDER IS THE WHOLE JOB. `DELETE FROM users` on its own fails: nine foreign
 * keys pointing at a patient are RESTRICT, and two more (clinical_notes ->
 * bookings, bookings -> care_journeys) only surface once the cascade starts. So
 * the trail is dismantled deepest-first, in ONE transaction — a half-deleted
 * patient is worse than either outcome.
 *
 * Two shapes need care:
 *   - `recorded_by_user_id` points at whoever entered a reading, which for
 *     self-reported data is the patient. Those pointers are nulled rather than
 *     chased, because the rows themselves belong to other people's records.
 *   - `prescriptions.parent_prescription_id` is self-referential (an amendment
 *     points at what it superseded), so the links are cut before the rows go.
 */
async function deletePatient(patientId) {
  await assertPatient(patientId);
  const preview = await deletionPreview(patientId);

  await sequelize.transaction(async (tx) => {
    const run = (sql) =>
      sequelize.query(sql, { replacements: { id: patientId }, transaction: tx });

    // 1. Authorship pointers — null, never chase. These rows may sit in other
    //    people's records, and "who typed it" is not a reason to delete them.
    await run(`UPDATE patient_vitals      SET recorded_by_user_id = NULL WHERE recorded_by_user_id = :id`);
    await run(`UPDATE patient_allergies   SET recorded_by_user_id = NULL WHERE recorded_by_user_id = :id`);
    await run(`UPDATE patient_conditions  SET recorded_by_user_id = NULL WHERE recorded_by_user_id = :id`);
    await run(`UPDATE uploaded_records    SET recorded_by_user_id = NULL WHERE recorded_by_user_id = :id`);
    await run(`UPDATE clinical_notes      SET recorded_by_user_id = NULL WHERE recorded_by_user_id = :id`);
    await run(`UPDATE bookings            SET booked_by_user_id   = NULL WHERE booked_by_user_id   = :id`);

    // 2. The clinical trail, deepest first.
    await run(`DELETE FROM referrals WHERE patient_id = :id`);
    // Cut the amendment chain before removing the rows it links.
    await run(`UPDATE prescriptions SET parent_prescription_id = NULL WHERE patient_id = :id`);
    await run(`DELETE FROM prescriptions WHERE patient_id = :id`);  // items cascade
    await run(`DELETE FROM clinical_notes WHERE patient_id = :id`);
    await run(`DELETE FROM uploaded_records WHERE patient_id = :id`);
    // Payments, video sessions and follow-up tags cascade off the booking.
    await run(`DELETE FROM bookings WHERE patient_id = :id`);
    // Only reachable once no booking still points at a journey.
    await run(`DELETE FROM care_journeys WHERE patient_id = :id`);

    // 3. The account. Profile, family members, vitals, allergies, conditions,
    //    medications and both token tables cascade from here.
    await run(`DELETE FROM users WHERE id = :id AND role = 'patient'`);
  });

  return preview;
}

// ── Doctor deletion (admin only, rejected doctors only) ──────────────────────

/**
 * Assert the target is a registered doctor before any deep read/write. Every
 * /registry/doctors/:id handler goes through this, so an admin URL pointing
 * at a patient's id (or nothing) 404s instead of leaking a mis-joined profile.
 */
async function assertDoctor(id) {
  const user = await User.findOne({ where: { id, role: ROLES.DOCTOR }, attributes: ["id", "name"] });
  if (!user) throw ApiError.notFound("Doctor not found");
  return user;
}

/**
 * Everything that records what this doctor DID — clinical, financial or consent
 * history owned by someone else (patients) or by the platform. Read BEFORE the
 * confirm dialog and again inside the delete transaction.
 *
 * Why every one of these blocks a hard delete (checked against the live FKs):
 *   - bookings, prescriptions, consultation_sessions, reviews are NO ACTION:
 *     the database itself refuses the delete.
 *   - clinical_notes, referrals, patient_follow_ups, follow_up_reminders,
 *     doctor_access_requests, doctor_patient_statuses are ON DELETE CASCADE:
 *     they would be silently ERASED with the doctor.
 *   - clinical_entries.doctor_id, patient_medicines.prescribed_by,
 *     care_journeys.origin_doctor_id are SET NULL: the record would survive but
 *     lose who wrote it, and no name snapshot is stored.
 * Losing any of those corrupts a patient's medical history, so the doctor must
 * be DEACTIVATED (archived) instead.
 */
const TRAIL_LABELS = Object.freeze({
  bookings: "appointments",
  prescriptions: "prescriptions",
  consultationSessions: "consultation sessions",
  reviews: "patient reviews",
  clinicalNotes: "clinical notes",
  clinicalEntries: "diagnoses / examination entries",
  referrals: "referrals",
  followUps: "follow-ups",
  followUpReminders: "follow-up reminders",
  accessRequests: "patient record-access requests",
  patientStatuses: "patient status records",
  patientMedicines: "prescribed patient medicines",
  journeys: "care journeys",
  acquisitionSources: "patient acquisition records",
});

async function doctorDeletionPreview(doctorId, transaction) {
  const [rows] = await sequelize.query(
    `SELECT
       (SELECT COUNT(*) FROM bookings                  WHERE doctor_id = :id) AS bookings,
       (SELECT COUNT(*) FROM prescriptions             WHERE doctor_id = :id) AS prescriptions,
       (SELECT COUNT(*) FROM consultation_sessions     WHERE doctor_id = :id) AS consultationSessions,
       (SELECT COUNT(*) FROM reviews                   WHERE doctor_id = :id) AS reviews,
       (SELECT COUNT(*) FROM clinical_notes            WHERE doctor_id = :id) AS clinicalNotes,
       (SELECT COUNT(*) FROM clinical_entries          WHERE doctor_id = :id) AS clinicalEntries,
       (SELECT COUNT(*) FROM referrals                 WHERE from_doctor_id = :id OR to_doctor_id = :id) AS referrals,
       (SELECT COUNT(*) FROM patient_follow_ups        WHERE doctor_id = :id) AS followUps,
       (SELECT COUNT(*) FROM follow_up_reminders       WHERE doctor_id = :id) AS followUpReminders,
       (SELECT COUNT(*) FROM doctor_access_requests    WHERE doctor_id = :id) AS accessRequests,
       (SELECT COUNT(*) FROM doctor_patient_statuses   WHERE doctor_id = :id) AS patientStatuses,
       (SELECT COUNT(*) FROM patient_medicines         WHERE prescribed_by = :id) AS patientMedicines,
       (SELECT COUNT(*) FROM care_journeys             WHERE origin_doctor_id = :id) AS journeys,
       (SELECT COUNT(*) FROM patient_acquisition_sources WHERE doctor_id = :id) AS acquisitionSources`,
    { replacements: { id: doctorId }, type: QueryTypes.SELECT, transaction }
  );
  const counts = Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, Number(v)]));
  const blockedBy = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => ({ key: k, label: TRAIL_LABELS[k] ?? k, count: n }));
  return { ...counts, canDelete: blockedBy.length === 0, blockedBy };
}

/** Append-only admin action trail (access_audit_logs). Holds no clinical content. */
function auditAdmin(action, { adminId, ip, doctorId, details }, transaction) {
  return AccessAuditLog.create(
    { actorUserId: adminId, actorRole: "admin", action, doctorId, entityType: "doctor", entityId: doctorId, details, ip: ip ?? null },
    { transaction }
  );
}

/**
 * Permanently erase a doctor ACCOUNT that has no clinical or financial trail
 * (e.g. a rejected or never-used registration). Irreversible.
 *
 * A doctor with ANY dependent record is refused with 409 — see TRAIL_LABELS —
 * and must be deactivated instead; nothing is cascade-deleted from patient
 * history. The dependency check is repeated INSIDE the transaction after the
 * user row is locked, so a booking made between the preview and the delete
 * cannot slip through. Everything rolls back together on any failure.
 */
async function deleteDoctor(doctorId, { adminId, ip } = {}) {
  const user = await assertDoctor(doctorId);
  const profile = await DoctorProfile.findByPk(doctorId, { attributes: ["verificationStatus", "registrationNumber"] });
  if (!profile) throw ApiError.notFound("Doctor profile not found");

  try {
    return await sequelize.transaction(async (tx) => {
      await sequelize.query("SELECT id FROM users WHERE id = :id AND role = 'doctor' FOR UPDATE", {
        replacements: { id: doctorId },
        type: QueryTypes.SELECT,
        transaction: tx,
      });
      const preview = await doctorDeletionPreview(doctorId, tx);
      if (!preview.canDelete) {
        throw ApiError.conflict(
          "This doctor has clinical or financial records and cannot be permanently deleted. Deactivate the account instead — all history is preserved.",
          { code: ERROR_CODES.VALIDATION_ERROR, details: { blockedBy: preview.blockedBy } }
        );
      }
      // Audit first: the log row has no FK to the doctor, so it outlives the account.
      await auditAdmin(
        "admin_doctor_deleted",
        { adminId, ip, doctorId, details: { name: user.name, registrationNumber: profile.registrationNumber ?? null, verificationStatus: profile.verificationStatus } },
        tx
      );
      // Profile, specializations, languages, clinics, availability, templates, … cascade
      // from the user row; none of them is clinical history.
      await sequelize.query("DELETE FROM users WHERE id = :id AND role = 'doctor'", { replacements: { id: doctorId }, transaction: tx });
      return preview;
    });
  } catch (err) {
    if (err?.name === "SequelizeForeignKeyConstraintError") {
      // A reference we did not list: refuse rather than guess. The transaction already rolled back.
      throw ApiError.conflict("This doctor is still referenced by other records and cannot be deleted. Deactivate the account instead.", {
        code: ERROR_CODES.VALIDATION_ERROR,
      });
    }
    throw err;
  }
}

/**
 * Deactivate / reactivate a doctor ACCOUNT. Nothing is deleted: every
 * appointment, prescription and note keeps its doctor. Deactivating blocks
 * sign-in and token refresh (auth already checks users.is_active), unlists the
 * doctor so patients cannot find or book them, and revokes their refresh tokens.
 * Reactivating restores sign-in only — the doctor stays unlisted until an admin
 * lists them again, so a reinstatement never silently re-opens bookings.
 */
async function setDoctorActive(doctorId, isActive, { adminId, ip } = {}) {
  const user = await assertDoctor(doctorId);
  return sequelize.transaction(async (tx) => {
    await User.update({ isActive }, { where: { id: doctorId, role: ROLES.DOCTOR }, transaction: tx });
    if (!isActive) {
      await DoctorProfile.update({ isListed: false }, { where: { userId: doctorId }, transaction: tx });
      await RefreshToken.destroy({ where: { userId: doctorId }, transaction: tx });
    }
    const [row] = await sequelize.query(
      "SELECT COUNT(*) AS n FROM bookings WHERE doctor_id = :id AND status IN ('confirmed','pending_payment') AND slot_date >= CURDATE()",
      { replacements: { id: doctorId }, type: QueryTypes.SELECT, transaction: tx }
    );
    await auditAdmin(isActive ? "admin_doctor_reactivated" : "admin_doctor_deactivated", { adminId, ip, doctorId, details: { name: user.name } }, tx);
    return { isActive, upcomingBookings: Number(row.n) };
  });
}

module.exports = { setDoctorActive, listDoctors, listPatients, patientConditions, assertPatient, recordCounts, deletionPreview, deletePatient, assertDoctor, doctorDeletionPreview, deleteDoctor };
