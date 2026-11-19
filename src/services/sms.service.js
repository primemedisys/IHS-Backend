/**
 * Transactional SMS (currently: password-reset OTPs).
 *
 *   SMS_PROVIDER=twilio → Twilio Programmable SMS over its REST API
 *                         (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_SMS_FROM).
 *                         Uses the built-in fetch, so no SDK dependency.
 *   SMS_PROVIDER=mock   → development only: the message is printed to the API
 *                         server's console. Refused when NODE_ENV=production.
 *   SMS_PROVIDER=none   → (default) not configured. Callers must check
 *                         `isConfigured()` and report that honestly instead of
 *                         pretending a message went out.
 */
const env = require("../config/env");
const { maskMobile } = require("../utils/phone");

function isConfigured() {
  if (env.SMS_PROVIDER === "twilio") {
    return Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_SMS_FROM);
  }
  if (env.SMS_PROVIDER === "mock") return env.NODE_ENV !== "production";
  return false;
}

/**
 * Send one SMS. Resolves `{ ok: true }` or `{ ok: false, error }` — never
 * throws, so the caller decides how a delivery failure surfaces.
 * @param {string} to   E.164 number, e.g. +919876543210
 * @param {string} body
 */
async function send(to, body) {
  if (!isConfigured()) return { ok: false, error: "SMS is not configured" };

  if (env.SMS_PROVIDER === "mock") {
    // Development only (isConfigured() refuses mock in production).
    // eslint-disable-next-line no-console
    console.log(`📩 SMS (mock) to ${maskMobile(to.slice(-10))}: ${body}`);
    return { ok: true, mock: true };
  }

  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(env.TWILIO_ACCOUNT_SID)}/Messages.json`;
    const auth = Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString("base64");
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ From: env.TWILIO_SMS_FROM, To: to, Body: body }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      // Never log the message body — it carries the OTP.
      console.error(`📩 Twilio SMS failed (${res.status}) for ${maskMobile(to.slice(-10))}: ${detail.slice(0, 200)}`);
      return { ok: false, error: `Provider responded ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    console.error(`📩 Twilio SMS error for ${maskMobile(to.slice(-10))}: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

module.exports = { isConfigured, send };
