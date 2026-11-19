/**
 * Medicine routines (migration 055) — DB-free contract tests: schedule math
 * (time zones, windows, end dates), the request contract (Joi), reminder text
 * privacy, and that the boot guard reads every new table out of the migration.
 *
 *   node --test test/patientMedicine/medicineContract.test.js
 */
process.env.NODE_ENV = process.env.NODE_ENV || "test";
require("dotenv").config({ path: require("path").join(__dirname, "..", "..", ".env") });
const test = require("node:test");
const assert = require("node:assert/strict");

const sched = require("../../src/utils/medicineSchedule");
const v = require("../../src/validators/patientMedicine.validator");
const ensure = require("../../src/db/ensurePatientMedicines");
const { reminderText } = require("../../src/services/medicineReminder.service");
const { serializeRoutine } = require("../../src/utils/patientMedicineSerializers");

const run = (schema, value) => schema.validate(value, { abortEarly: false, stripUnknown: true, convert: true });

test("local wall-clock times convert to the right UTC instant", () => {
  assert.equal(sched.zonedToUtc("2026-10-31", "08:00", "Asia/Kolkata").toISOString(), "2026-10-31T02:30:00.000Z");
  assert.equal(sched.zonedToUtc("2026-07-01", "09:00", "America/New_York").toISOString(), "2026-07-01T13:00:00.000Z", "DST");
  assert.equal(sched.zonedToUtc("2026-01-01", "09:00", "America/New_York").toISOString(), "2026-01-01T14:00:00.000Z", "standard time");
  assert.equal(sched.localDate(new Date("2026-10-31T20:00:00Z"), "Asia/Kolkata"), "2026-11-01", "after IST midnight");
});

test("occurrences respect start / end dates, weekdays and sort times", () => {
  const r = { reminderTimes: ["20:00", "08:00"], timezone: "Asia/Kolkata", startDate: "2026-10-30", endDate: "2026-11-01", daysOfWeek: null };
  const occ = sched.occurrencesFor(r, "2026-10-31", "2026-11-10");
  assert.deepEqual(occ.map((o) => `${o.scheduledDate} ${o.scheduledTime}`), ["2026-10-31 08:00", "2026-10-31 20:00", "2026-11-01 08:00", "2026-11-01 20:00"]);
  const weekly = sched.occurrencesFor({ ...r, endDate: null, daysOfWeek: [0] }, "2026-11-01", "2026-11-14"); // Sundays
  assert.deepEqual([...new Set(weekly.map((o) => o.scheduledDate))], ["2026-11-01", "2026-11-08"]);
  assert.equal(sched.occurrencesFor({ ...r, reminderTimes: [] }, "2026-10-31", "2026-11-01").length, 0, "no times → no doses");
});

test("durations, end dates and frequency hints", () => {
  assert.equal(sched.endDateFor("2026-10-31", 5), "2026-11-04");
  assert.equal(sched.endDateFor("2026-10-31", null), null);
  assert.equal(sched.durationToDays(2, "week"), 14);
  assert.equal(sched.durationToDays(1, "month"), 30);
  assert.equal(sched.durationToDays(null, "day"), null);
  assert.equal(sched.suggestedDailyCount("TDS"), 3);
  assert.equal(sched.suggestedDailyCount("1-0-1"), 2);
  assert.equal(sched.suggestedDailyCount("SOS"), null);
  assert.equal(sched.baseMedicineName("Pan 40 40 mg", "40 mg"), "Pan 40");
  assert.deepEqual(sched.normalizeTimes('["20:00","08:00","08:00","9:00"]'), ["08:00", "20:00"], "JSON strings, dedupe, drop bad");
});

test("create contract: catalogue pick or typed name, valid times and dates", () => {
  assert.equal(run(v.createMedicines, { items: [{ medicineMasterId: "5", startDate: "2026-10-31" }] }).error, undefined);
  assert.ok(run(v.createMedicines, { items: [{ startDate: "2026-10-31" }] }).error, "name or catalogue id required");
  assert.ok(run(v.createMedicines, { items: [{ medicineName: "X1", startDate: "2026-10-31", reminderTimes: ["24:00"] }] }).error);
  assert.ok(run(v.createMedicines, { items: [{ medicineName: "X1", startDate: "2026-10-31", reminderTimes: ["08:00", "08:00"] }] }).error, "duplicate times");
  assert.ok(run(v.createMedicines, { items: [{ medicineName: "X1", startDate: "2026-10-31" }], timezone: "Mars/Base" }).error, "bad zone");
  assert.ok(run(v.createMedicines, { items: [] }).error);
  const stripped = run(v.createMedicines, { patientId: 9, items: [{ medicineName: "X1", startDate: "2026-10-31" }] });
  assert.equal(stripped.value.patientId, undefined, "a patient id in the body is dropped");
});

test("dose action contract: snooze lengths are fixed and only for snooze", () => {
  assert.equal(run(v.doseAction, { action: "snooze", snoozeMinutes: 15 }).error, undefined);
  assert.ok(run(v.doseAction, { action: "snooze" }).error);
  assert.ok(run(v.doseAction, { action: "snooze", snoozeMinutes: 7 }).error);
  assert.ok(run(v.doseAction, { action: "taken", snoozeMinutes: 5 }).error);
  assert.equal(run(v.doseAction, { action: "taken" }).value.source, "web");
});

test("dose range is capped at 8 days", () => {
  assert.equal(run(v.dosesQuery, { from: "2026-10-31T00:00:00Z", to: "2026-11-03T00:00:00Z" }).error, undefined);
  assert.ok(run(v.dosesQuery, { from: "2026-10-31T00:00:00Z", to: "2026-11-30T00:00:00Z" }).error);
});

test("reminder text: privacy mode hides the medicine", () => {
  const dose = { scheduledTime: "20:00", status: "pending" };
  const routine = { medicineName: "Paracetamol", strength: "500 mg", dose: "1 tablet", foodTiming: "after_food" };
  assert.equal(reminderText(dose, routine, false).message, "Paracetamol 500 mg — 1 tablet, after food (8:00 PM).");
  const hidden = reminderText(dose, routine, true);
  assert.doesNotMatch(`${hidden.title} ${hidden.message}`, /Paracetamol|500 mg|tablet/);
  assert.match(hidden.message, /8:00 PM/);
});

test("serializer: patient entries are unverified and carry no prescription", () => {
  const out = serializeRoutine({ id: 1, source: "patient", status: "active", reminderTimes: [], prescribedSnapshot: { x: 1 }, timezone: "Asia/Kolkata", startDate: "2026-10-31" });
  assert.equal(out.verified, false);
  assert.equal(out.prescribed, null);
  assert.equal(out.needsSetup, true);
});

test("boot guard reads every new table out of migration 055", () => {
  const tables = ensure.createStatements().map((s) => s.match(/CREATE TABLE IF NOT EXISTS (\w+)/i)[1]);
  assert.deepEqual(tables, ["patient_medicines", "medicine_dose_logs", "medicine_dose_events", "patient_medicine_settings"]);
});
