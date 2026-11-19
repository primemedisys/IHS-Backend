/**
 * Joi schemas for provider UPI QR payments (migration 044).
 *
 * A provider sends only its own QR's text fields — never a user id (the row is
 * keyed on the authenticated user). A patient's payment report carries only
 * the UPI transaction id they saw; it never carries a status or an amount.
 */
const Joi = require("joi");

/** handle@bank — the shape of every UPI virtual payment address. */
const UPI_ID = Joi.string()
  .trim()
  .pattern(/^[a-zA-Z0-9._-]{2,256}@[a-zA-Z]{2,64}$/)
  .messages({ "string.pattern.base": "Enter a valid UPI ID, e.g. name@okbank" });

/** PUT /doctor/payment-qr, PUT /medicine/pharmacy/payment-qr. `null` / "" clears a field. */
const updatePaymentQr = Joi.object({
  upiId: UPI_ID.allow(null, ""),
  payeeName: Joi.string().trim().min(2).max(150).allow(null, ""),
  isActive: Joi.boolean(),
})
  .min(1)
  .custom((value) => {
    // "" means "clear it" — stored as NULL, never as an empty string.
    const out = { ...value };
    for (const key of ["upiId", "payeeName"]) if (out[key] === "") out[key] = null;
    return out;
  });

/**
 * POST …/payment-report — "I have paid". The UPI transaction id / UTR is
 * optional (some apps hide it); re-reporting overwrites it.
 */
const reportPayment = Joi.object({
  reference: Joi.string()
    .trim()
    .min(6)
    .max(40)
    .pattern(/^[A-Za-z0-9-]+$/)
    .messages({ "string.pattern.base": "The UPI reference may only contain letters, digits and '-'" }),
});

module.exports = { updatePaymentQr, reportPayment };
