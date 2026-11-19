/**
 * Clinic management business logic (PRD §4.3a — one doctor -> many clinics). All
 * DB access for the `/doctor/clinics` surface lives here; controllers stay thin.
 *
 * Ownership is always a WHERE clause (`{ id, doctorId: userId }`), never a
 * post-load `if` — another doctor's clinic simply 404s, leaking nothing.
 */
const { Clinic, ClinicAvailability } = require("../models");
const ApiError = require("../utils/ApiError");

/** Eager-load a clinic's own weekly slots (ordered for a stable UI). */
const withAvailability = {
  model: ClinicAvailability,
  as: "availability",
  separate: true,
  order: [
    ["dayOfWeek", "ASC"],
    ["startTime", "ASC"],
  ],
};

/** All of a doctor's clinics + each clinic's weekly schedule, in one pass. */
const listClinics = (userId) =>
  Clinic.findAll({
    where: { doctorId: userId },
    include: [withAvailability],
    order: [["id", "ASC"]],
  });

/**
 * One owned clinic + its availability, or 404. This is also the ownership gate
 * that availability.service reuses before touching a clinic's schedule.
 */
async function getClinic(userId, clinicId) {
  const clinic = await Clinic.findOne({
    where: { id: clinicId, doctorId: userId },
    include: [withAvailability],
  });
  if (!clinic) throw ApiError.notFound("Clinic not found");
  return clinic;
}

/** Lightweight ownership assertion (no relations) for the availability writer. */
async function assertClinicOwned(userId, clinicId) {
  const clinic = await Clinic.findOne({
    where: { id: clinicId, doctorId: userId },
    attributes: ["id"],
  });
  if (!clinic) throw ApiError.notFound("Clinic not found");
  return clinic;
}

const addClinic = (userId, data) => Clinic.create({ ...data, doctorId: userId });

/**
 * Patch an owned clinic; returns the fresh row with availability, or 404.
 *
 * Ownership is asserted with a read first — NOT inferred from Clinic.update's
 * affected-row count. MySQL reports rows *changed*, not *matched*, so a save
 * that submits identical values (a no-op patch) returns 0 and would otherwise
 * 404 an existing, owned clinic.
 */
async function updateClinic(userId, clinicId, patch) {
  await assertClinicOwned(userId, clinicId);
  await Clinic.update(patch, { where: { id: clinicId, doctorId: userId } });
  return getClinic(userId, clinicId);
}

/** Remove an owned clinic (cascades its availability + clinic-scoped exceptions). */
async function removeClinic(userId, clinicId) {
  const count = await Clinic.destroy({ where: { id: clinicId, doctorId: userId } });
  if (!count) throw ApiError.notFound("Clinic not found");
}

module.exports = {
  listClinics,
  getClinic,
  assertClinicOwned,
  addClinic,
  updateClinic,
  removeClinic,
};
