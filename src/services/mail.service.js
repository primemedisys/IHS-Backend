/**
 * All transactional email goes through here (password reset now; booking
 * notifications later reuse the same transport). Templates live as HTML files
 * in templates/emails/ and are cached after first read — we do NOT hit the disk
 * on every send.
 *
 * For local dev with no SMTP configured, we fall back to an Ethereal test
 * account and log the preview URL instead of really sending.
 */
const fs = require("fs");
const path = require("path");
const nodemailer = require("nodemailer");
const env = require("../config/env");

const TEMPLATE_DIR = path.join(__dirname, "..", "templates", "emails");

// Cache compiled template strings so repeated sends don't re-read files.
const templateCache = new Map();

function loadTemplate(name) {
  if (!templateCache.has(name)) {
    const file = path.join(TEMPLATE_DIR, `${name}.html`);
    templateCache.set(name, fs.readFileSync(file, "utf8"));
  }
  return templateCache.get(name);
}

/** Values are user-controlled (names, contact-form text) — never inject them as HTML. */
const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/**
 * Tiny {{key}} interpolation (HTML-escaped) plus `{{#if key}}…{{/if}}` blocks
 * that render only when the value is non-empty — no template engine needed.
 */
function render(name, vars) {
  return loadTemplate(name)
    .replace(/\{\{#if (\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (_, key, body) => (vars[key] ? body : ""))
    .replace(/\{\{(\w+)\}\}/g, (_, key) => escapeHtml(vars[key]));
}

/** CLIENT_URL is a comma-separated list (one origin per app); the patient app is first. */
const primaryClientUrl = () => String(env.CLIENT_URL).split(",")[0].trim().replace(/\/+$/, "");

// Lazily create the transport once, on first send.
let transportPromise = null;

async function getTransport() {
  if (transportPromise) return transportPromise;

  transportPromise = (async () => {
    if (env.SMTP_HOST) {
      return nodemailer.createTransport({
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        secure: env.SMTP_SECURE,
        auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD },
      });
    }
    // Production without SMTP: never route real mail (reset links!) through a
    // public test inbox. Mail is skipped and the problem logged loudly.
    if (env.NODE_ENV === "production") {
      console.error("❌ SMTP is not configured — emails are NOT being sent. Set SMTP_HOST/SMTP_USER/SMTP_PASSWORD.");
      return null;
    }
    // Dev fallback: real SMTP not configured → Ethereal preview inbox.
    const testAccount = await nodemailer.createTestAccount();
    console.warn("✉️  No SMTP configured — using Ethereal test account.");
    return nodemailer.createTransport({
      host: "smtp.ethereal.email",
      port: 587,
      secure: false,
      auth: { user: testAccount.user, pass: testAccount.pass },
    });
  })();

  return transportPromise;
}

async function send({ to, subject, html, replyTo }) {
  const transport = await getTransport();
  if (!transport) return null; // production without SMTP — already logged
  const info = await transport.sendMail({ from: env.MAIL_FROM, to, replyTo, subject, html });
  // Ethereal preview links exist only in development (they expose the whole message).
  const preview = env.NODE_ENV !== "production" ? nodemailer.getTestMessageUrl(info) : false;
  if (preview) console.log(`✉️  Preview: ${preview}`);
  return info;
}

/**
 * Notifies the platform admin of a new public contact-form submission. Sent
 * best-effort by contact.service (never awaited into the request), so a mail
 * failure can't break the visitor's submit. Replies go straight to the sender.
 */
exports.sendContactNotification = ({ name, email, phone, message }) => {
  return send({
    to: env.ADMIN_EMAIL,
    replyTo: email,
    subject: `New contact message from ${name}`,
    html: render("contact-message", { name, email, phone: phone || "—", message }),
  });
};

/** Which site's reset page a user's link opens: the doctor site for doctors (when configured). */
const resetBaseFor = (user) =>
  user?.role === "doctor" && env.DOCTOR_APP_URL ? String(env.DOCTOR_APP_URL).replace(/\/+$/, "") : primaryClientUrl();

exports.sendPasswordReset = (user, rawToken) => {
  const link = `${resetBaseFor(user)}/reset-password?token=${rawToken}`;
  return send({
    to: user.email,
    subject: "Reset your password",
    html: render("reset-password", { name: user.name, link }),
  });
};

/**
 * Can mail actually leave this server? False only in production without SMTP
 * (where `send` skips silently). Dev always "can" — it uses the Ethereal inbox.
 * Callers that would otherwise pretend a code went out check this first.
 */
exports.isConfigured = () => Boolean(env.SMTP_HOST) || env.NODE_ENV !== "production";

/** The 6-digit password reset code (the email channel of the OTP reset). Never logged. */
exports.sendPasswordResetCode = (user, code, minutes) =>
  send({
    to: user.email,
    subject: "Your Indian Health System password reset code",
    html: render("password-reset-code", { name: user.name, code, minutes }),
  });

exports.sendVerifyEmail = (user, rawToken) => {
  const link = `${primaryClientUrl()}/verify-email?token=${rawToken}`;
  return send({
    to: user.email,
    subject: "Verify your email",
    html: render("verify-email", { name: user.name, link }),
  });
};

/**
 * Sent when a doctor finalizes a prescription (docs/prescriptions §5.2).
 * CLIENT_URL is a comma-separated list (one origin per app); the patient app is
 * the first entry, and that's where the prescription lives.
 */
exports.sendPrescriptionReady = (user, { rxNumber, doctorName, date }) => {
  const link = `${primaryClientUrl()}/prescriptions`;
  const when = date ? new Date(date).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "";
  return send({
    to: user.email,
    subject: `Your prescription ${rxNumber} is ready`,
    html: render("prescription-ready", { name: user.name, rxNumber, doctorName, date: when, link }),
  });
};

/**
 * Follow-up reminder email (docs/follow-up-reminders-07-09-2026).
 * Sent automatically by the reminder scheduler before a follow-up date.
 */
exports.sendFollowUpReminder = (user, { doctorName, followUpDate, clinicName, clinicCity }) => {
  const when = followUpDate
    ? new Date(followUpDate + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })
    : "";
  const location = clinicName ? `${clinicName}${clinicCity ? `, ${clinicCity}` : ""}` : null;
  return send({
    to: user.email,
    subject: `Reminder: Your follow-up with Dr. ${doctorName}`,
    html: render("follow-up-reminder", {
      patient_name: user.name,
      doctor_name: doctorName,
      follow_up_date: when,
      clinic_name: location || "",
    }),
  });
};
