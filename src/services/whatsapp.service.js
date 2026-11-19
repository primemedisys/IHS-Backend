/**
 * WhatsApp Business API integration (docs/follow-up-reminders-07-09-2026).
 *
 * Uses Twilio's Content API for approved business-initiated message templates.
 * In mock mode (default for development), messages are logged instead of sent.
 *
 * PROVIDER CONFIGURATION:
 *   WHATSAPP_PROVIDER=twilio   → use real Twilio WhatsApp Business API
 *   WHATSAPP_PROVIDER=mock     → log messages (default, zero setup needed)
 *
 * Production setup requires:
 *   1. Twilio account with WhatsApp Business API enabled
 *   2. Approved message template (Content SID)
 *   3. Environment variables: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
 *      TWILIO_WHATSAPP_FROM, TWILIO_CONTENT_TEMPLATE_SID
 */
const env = require("../config/env");

let twilioClient = null;

/**
 * Lazily initialize the Twilio client. Only created when actually needed
 * and only when the provider is configured as "twilio".
 */
function getClient() {
  if (twilioClient) return twilioClient;
  if (env.WHATSAPP_PROVIDER !== "twilio" || !env.TWILIO_ACCOUNT_SID) return null;

  const twilio = require("twilio");
  twilioClient = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
  return twilioClient;
}

/**
 * Send a follow-up reminder via WhatsApp.
 *
 * Uses the Twilio Content API with an approved message template.
 * Template parameters are passed as a JSON map matching the template's
 * variable placeholders.
 *
 * @param {Object} params
 * @param {string} params.to - Patient's phone number (E.164 format)
 * @param {string} params.patientName
 * @param {string} params.doctorName
 * @param {string} params.followUpDate - "YYYY-MM-DD"
 * @param {string|null} params.clinicName
 * @param {string|null} params.clinicCity
 * @returns {{ ok: boolean, mock?: boolean, sid?: string, error?: string }}
 */
async function sendReminder({ to, patientName, doctorName, followUpDate, clinicName, clinicCity }) {
  const client = getClient();

  // ── Mock mode ──────────────────────────────────────────────────────────
  if (!client) {
    // Never print a patient's phone / name / appointment to production logs.
    if (env.NODE_ENV === "production") {
      console.warn("📱 WhatsApp is in mock mode — follow-up reminder NOT sent (set WHATSAPP_PROVIDER=twilio).");
      return { ok: true, mock: true };
    }
    const formattedDate = formatDate(followUpDate);
    const location = clinicName ? `${clinicName}${clinicCity ? `, ${clinicCity}` : ""}` : "Video consult";
    console.log("📱 WhatsApp (mock):", {
      to,
      template: "follow_up_reminder",
      variables: {
        patient_name: patientName,
        doctor_name: doctorName,
        follow_up_date: formattedDate,
        clinic_name: location,
      },
    });
    return { ok: true, mock: true };
  }

  // ── Production: Twilio Content API ─────────────────────────────────────
  const formattedDate = formatDate(followUpDate);
  const location = clinicName ? `${clinicName}${clinicCity ? `, ${clinicCity}` : ""}` : "Video consult";

  try {
    const message = await client.messages.create({
      from: `whatsapp:${env.TWILIO_WHATSAPP_FROM}`,
      to: `whatsapp:${to}`,
      contentSid: env.TWILIO_CONTENT_TEMPLATE_SID,
      contentVariables: JSON.stringify({
        1: patientName,
        2: doctorName,
        3: formattedDate,
        4: location,
      }),
    });

    return { ok: true, sid: message.sid };
  } catch (err) {
    console.error("📱 WhatsApp Twilio error:", err.message);
    return { ok: false, error: err.message };
  }
}

/** Format a DATEONLY string into a human-readable format: "7 October 2026". */
function formatDate(dateStr) {
  if (!dateStr) return "your scheduled date";
  const [y, m, d] = String(dateStr).slice(0, 10).split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

module.exports = { sendReminder };
