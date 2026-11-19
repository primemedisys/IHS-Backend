/**
 * Channel abstraction for follow-up reminders (docs/follow-up-reminders-07-09-2026).
 *
 * Dispatches notifications through the configured channels (email, WhatsApp)
 * independently. Each channel succeeds or fails on its own — a WhatsApp failure
 * does not prevent the email from being sent.
 */
const emailProvider = require("./mail.service");
const whatsappProvider = require("./whatsapp.service");

/**
 * Send a follow-up reminder through all configured channels.
 * Returns { email: { ok, mock? }, whatsapp: { ok, mock? } }.
 */
async function send(reminder) {
  const patient = reminder.patient;
  const doctor = reminder.doctor;
  const booking = reminder.booking;
  const clinic = booking?.clinic;
  const doctorUser = booking?.doctor?.user;

  const doctorName = doctorUser?.name || doctor?.name || "your doctor";
  const clinicName = clinic?.name || null;
  const clinicCity = clinic?.city || null;
  const patientName = patient?.name || "Patient";
  const followUpDate = reminder.followUpOn;

  const result = { email: null, whatsapp: null };

  // ── Email ──────────────────────────────────────────────────────────────
  if (reminder.emailStatus === "pending" && patient?.email) {
    try {
      await emailProvider.sendFollowUpReminder(
        { name: patientName, email: patient.email },
        { doctorName, followUpDate, clinicName, clinicCity }
      );
      result.email = { ok: true };
    } catch (err) {
      console.error(`📧 Email reminder failed for ${patient.email}:`, err.message);
      result.email = { ok: false, error: err.message };
    }
  } else if (reminder.emailStatus === "pending" && !patient?.email) {
    result.email = { ok: false, error: "No email address" };
  }

  // ── WhatsApp ───────────────────────────────────────────────────────────
  if (reminder.whatsappStatus === "pending" && patient?.phone) {
    try {
      const whatsappResult = await whatsappProvider.sendReminder({
        to: patient.phone,
        patientName,
        doctorName,
        followUpDate,
        clinicName,
        clinicCity,
      });
      result.whatsapp = whatsappResult;
    } catch (err) {
      console.error(`📱 WhatsApp reminder failed for ${patient.phone}:`, err.message);
      result.whatsapp = { ok: false, error: err.message };
    }
  } else if (reminder.whatsappStatus === "pending" && !patient?.phone) {
    result.whatsapp = { ok: false, error: "No phone number" };
  }

  return result;
}

module.exports = { send };
