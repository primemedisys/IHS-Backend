/**
 * Output shaping for patient medicine routines, doses and reminder settings
 * (migration 055). Kept beside serializers.js the same way
 * ambulanceSerializers.js is — every response goes through these, never a raw
 * Sequelize instance.
 */
const { normalizeTimes, normalizeDays, suggestedDailyCount } = require("./medicineSchedule");
const { DOSE_SNOOZE_MINUTES } = require("../config/constants");

const id = (v) => (v == null ? null : String(v));
const iso = (v) => (v ? new Date(v).toISOString() : null);
const plainOf = (m) => (m && typeof m.get === "function" ? m.get({ plain: true }) : m);
const dateOnly = (v) => (v ? String(v).slice(0, 10) : null);

function serializeRoutine(row) {
  const r = plainOf(row);
  if (!r) return null;
  const reminderTimes = normalizeTimes(r.reminderTimes);
  const prescribed = r.source === "prescription";
  return {
    id: id(r.id),
    source: r.source,
    /** True only for a doctor's finalized prescription — patient entries are unverified. */
    verified: prescribed,
    prescriptionId: id(r.prescriptionId),
    prescription: r.prescription
      ? { id: id(r.prescription.id), rxNumber: r.prescription.rxNumber ?? null, finalizedAt: iso(r.prescription.finalizedAt) }
      : null,
    prescriber: r.prescriber ? { id: id(r.prescriber.id), name: r.prescriber.name } : null,
    medicineMasterId: id(r.medicineMasterId),
    medicineName: r.medicineName,
    genericName: r.genericName ?? null,
    strength: r.strength ?? null,
    dosageForm: r.dosageForm ?? null,
    dose: r.dose ?? null,
    frequency: r.frequency ?? null,
    foodTiming: r.foodTiming ?? null,
    reminderTimes,
    daysOfWeek: normalizeDays(r.daysOfWeek),
    timezone: r.timezone,
    startDate: dateOnly(r.startDate),
    durationDays: r.durationDays ?? null,
    endDate: dateOnly(r.endDate),
    instructions: r.instructions ?? null,
    /** The doctor's original line, exactly as signed (null for the patient's own medicines). */
    prescribed: prescribed ? r.prescribedSnapshot ?? null : null,
    reminderEnabled: Boolean(r.reminderEnabled),
    status: r.status,
    statusReason: r.statusReason ?? null,
    statusChangedAt: iso(r.statusChangedAt),
    supersededById: id(r.supersededById),
    /** Active but no reminder times yet — the UI asks the patient to set them. */
    needsSetup: r.status === "active" && reminderTimes.length === 0,
    /** How many times a day the frequency implies — a hint, never enforced. */
    suggestedReminderCount: suggestedDailyCount(r.frequency),
    createdAt: iso(r.createdAt),
    updatedAt: iso(r.updatedAt),
  };
}

function serializeDose(row) {
  const d = plainOf(row);
  if (!d) return null;
  const m = d.medicine;
  return {
    id: id(d.id),
    patientMedicineId: id(d.patientMedicineId),
    scheduledDate: dateOnly(d.scheduledDate),
    scheduledTime: d.scheduledTime,
    scheduledAt: iso(d.scheduledAt),
    dueAt: iso(d.dueAt),
    status: d.status,
    snoozeCount: d.snoozeCount ?? 0,
    actionAt: iso(d.actionAt),
    actionSource: d.actionSource ?? null,
    medicine: m
      ? {
          id: id(m.id),
          source: m.source,
          medicineName: m.medicineName,
          strength: m.strength ?? null,
          dosageForm: m.dosageForm ?? null,
          dose: m.dose ?? null,
          foodTiming: m.foodTiming ?? null,
          instructions: m.instructions ?? null,
          status: m.status,
          reminderEnabled: Boolean(m.reminderEnabled),
          timezone: m.timezone,
        }
      : null,
  };
}

function serializeMedicineSettings(row) {
  const s = plainOf(row);
  return {
    privacyMode: Boolean(s.privacyMode),
    webReminders: Boolean(s.webReminders),
    defaultSnoozeMinutes: Number(s.defaultSnoozeMinutes),
    timezone: s.timezone,
    snoozeOptions: DOSE_SNOOZE_MINUTES,
  };
}

function serializeCatalogueHit(row) {
  const m = plainOf(row);
  return {
    id: id(m.id),
    medicineName: m.medicineName,
    genericName: m.genericName ?? null,
    dosageForm: m.medicineType ?? null,
    strength: m.strength ?? null,
    manufacturer: m.manufacturer ?? null,
  };
}

function serializeMedicineSummary(s) {
  return { ...s, nextDose: s.nextDose ? serializeDose(s.nextDose) : null };
}

module.exports = {
  serializeRoutine,
  serializeDose,
  serializeMedicineSettings,
  serializeCatalogueHit,
  serializeMedicineSummary,
};
