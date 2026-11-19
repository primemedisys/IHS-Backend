/**
 * In-app notifications for doctor appointments and doctor prescriptions.
 *
 * Writes rows to the shared `medicine_notifications` table (the same feed the
 * patient app already reads); the realtime hook then pushes each committed row
 * to its recipient's live sockets. Only the events in NOTIFICATION_TYPES
 * notify — not every booking write.
 *
 * Always called AFTER the business action has committed, and never throws: a
 * failed notification must not turn a successful booking/cancel/payment into
 * an error response. Failures are logged for ops.
 */
const { Booking, User, MedicineNotification, Prescription } = require("../models");
const { NOTIFICATION_TYPES: T, NOTIFICATION_REFS } = require("../config/constants");

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** 'YYYY-MM-DD' → '25 Oct 2026' (no timezone shift: it is a calendar date). */
function dateLabel(value) {
  const s = String(value ?? "").slice(0, 10);
  const [y, m, d] = s.split("-").map(Number);
  if (!y || !m || !d) return s;
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

function doctorLabel(name) {
  const n = String(name ?? "").trim();
  if (!n) return "Your doctor";
  return /^dr\.?\s/i.test(n) ? n : `Dr. ${n}`;
}

const rupees = (amount) => `₹${Number(amount ?? 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const modeLabel = (bookingType) => (bookingType === "online" ? "video" : "clinic");

/** Booking + both parties' names in two queries. */
async function loadContext(bookingId) {
  const booking = await Booking.findByPk(bookingId, {
    attributes: ["id", "doctorId", "patientId", "bookingType", "slotDate", "queueNumber", "amount", "status"],
  });
  if (!booking) return null;
  const users = await User.findAll({
    where: { id: [booking.doctorId, booking.patientId] },
    attributes: ["id", "name"],
  });
  const nameOf = (id) => users.find((u) => String(u.id) === String(id))?.name ?? null;
  return { booking, doctorName: nameOf(booking.doctorId), patientName: nameOf(booking.patientId) };
}

function buildRow(event, { booking, doctorName, patientName }, extra) {
  const date = dateLabel(booking.slotDate);
  const token = booking.queueNumber != null ? ` (token #${booking.queueNumber})` : "";
  const patient = patientName || "A patient";
  const doctor = doctorLabel(doctorName);
  const ref = { referenceId: booking.id, referenceType: NOTIFICATION_REFS.BOOKING };
  switch (event) {
    case T.APPOINTMENT_BOOKED:
      return {
        userId: booking.doctorId,
        type: event,
        title: "New appointment",
        message: `${patient} booked a ${modeLabel(booking.bookingType)} consultation on ${date}${token}.`,
        ...ref,
      };
    case T.APPOINTMENT_CANCELLED:
      return {
        userId: booking.doctorId,
        type: event,
        title: "Appointment cancelled",
        message: `${patient} cancelled their ${modeLabel(booking.bookingType)} appointment on ${date}.`,
        ...ref,
      };
    case T.APPOINTMENT_RESCHEDULED:
      return {
        userId: booking.patientId,
        type: event,
        title: "Appointment rescheduled",
        message: `${doctor} moved your appointment${extra.fromDate ? ` from ${dateLabel(extra.fromDate)}` : ""} to ${date}${token}.`,
        ...ref,
      };
    case T.CONSULTATION_COMPLETED:
      return {
        userId: booking.patientId,
        type: event,
        title: "Consultation completed",
        message: `Your consultation with ${doctor} on ${date} is complete.`,
        ...ref,
      };
    case T.PAYMENT_REPORTED:
      return {
        userId: booking.doctorId,
        type: event,
        title: "UPI payment reported",
        message: `${patient} says they paid ${rupees(booking.amount)} by UPI for the appointment on ${date}. Check your UPI app before confirming it.`,
        ...ref,
      };
    case T.PAYMENT_CONFIRMED:
      return {
        userId: booking.patientId,
        type: event,
        title: "Payment received",
        message: `${doctor} confirmed receiving ${rupees(booking.amount)} for your appointment on ${date}.`,
        ...ref,
      };
    default:
      return null;
  }
}

/**
 * @param {string} event one of NOTIFICATION_TYPES (appointment events)
 * @param {number|string} bookingId
 * @param {{ fromDate?: string }} [extra]
 */
async function notifyBookingEvent(event, bookingId, extra = {}) {
  try {
    const ctx = await loadContext(bookingId);
    if (!ctx) return;
    const row = buildRow(event, ctx, extra);
    if (row) await MedicineNotification.create(row);
  } catch (err) {
    console.error(`⚠️  Could not create '${event}' notification for booking ${bookingId}:`, err.message);
  }
}

/** A doctor finalized a prescription — tell the patient it is ready. */
async function notifyPrescriptionReady(prescriptionId) {
  try {
    const rx = await Prescription.findByPk(prescriptionId, {
      attributes: ["id", "doctorId", "patientId", "rxNumber"],
    });
    if (!rx?.patientId) return;
    const doctor = await User.findByPk(rx.doctorId, { attributes: ["id", "name"] });
    await MedicineNotification.create({
      userId: rx.patientId,
      type: T.PRESCRIPTION_READY,
      title: "Prescription ready",
      message: `${doctorLabel(doctor?.name)} has issued your prescription${rx.rxNumber ? ` ${rx.rxNumber}` : ""}.`,
      referenceId: rx.id,
      referenceType: NOTIFICATION_REFS.PRESCRIPTION,
    });
  } catch (err) {
    console.error(`⚠️  Could not create prescription-ready notification for ${prescriptionId}:`, err.message);
  }
}

module.exports = { notifyBookingEvent, notifyPrescriptionReady, dateLabel, doctorLabel };
