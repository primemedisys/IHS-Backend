/**
 * OpenAPI paths for provider UPI QR payments (migration 044), merged into the
 * spec by config/swagger.js.
 *
 * A doctor / pharmacy uploads its OWN UPI QR; a patient pays it from any UPI
 * app and may report "I have paid". Nothing is verified automatically — the
 * PROVIDER confirms receipt (doctor: POST /doctor/bookings/{id}/mark-paid;
 * pharmacy: POST /medicine/orders/groups/{id}/payment/confirm-received).
 */
const { PAYMENT_QR_IMAGE_MIME } = require("./constants");

const bearer = [{ bearerAuth: [] }];
const jsonBody = (schema) => ({ content: { "application/json": { schema } } });
const errorResponse = (description) => ({ description, ...jsonBody({ $ref: "#/components/schemas/Error" }) });
const envelope = (data) => ({ type: "object", properties: { success: { type: "boolean" }, message: { type: "string" }, data } });
const ok = (description, data) => ({ description, ...jsonBody(envelope(data)) });
const idParam = { name: "id", in: "path", required: true, schema: { type: "integer" } };
const str = { type: "string" };
const nstr = { type: "string", nullable: true };

const TAG = "Payment QR (UPI)";

const PaymentQr = {
  type: "object",
  properties: {
    upiId: { ...nstr, example: "drsharma@okaxis" },
    payeeName: nstr,
    qrImageUrl: nstr,
    isActive: { type: "boolean" },
    updatedAt: { type: "string", format: "date-time", nullable: true },
    configured: { type: "boolean", description: "isActive && an image exists — only then is it offered to patients" },
  },
};

const QrPaymentRequest = (extra = {}) => ({
  type: "object",
  properties: {
    payee: { type: "object", properties: { name: nstr, upiId: nstr, qrImageUrl: nstr } },
    amount: { type: "number" },
    currency: { type: "string", enum: ["INR"] },
    reference: { ...str, description: "Put this in the UPI note so the provider can match the transfer" },
    paymentStatus: str,
    ...extra,
    reportedAt: { type: "string", format: "date-time", nullable: true },
    payerReference: { ...nstr, description: "The UPI transaction id / UTR the patient reported (unverified)" },
  },
});

const updateBody = jsonBody({
  type: "object",
  minProperties: 1,
  properties: {
    upiId: { ...nstr, pattern: "^[a-zA-Z0-9._-]{2,256}@[a-zA-Z]{2,64}$", description: "\"\" or null clears it" },
    payeeName: { ...nstr, minLength: 2, maxLength: 150, description: "\"\" or null clears it (patients then see the provider's name)" },
    isActive: { type: "boolean" },
  },
});

const imageBody = {
  content: {
    "multipart/form-data": {
      schema: {
        type: "object",
        required: ["file"],
        properties: { file: { type: "string", format: "binary", description: `${PAYMENT_QR_IMAGE_MIME.join(", ")} — max 2 MB` } },
      },
    },
  },
};

const reportBody = jsonBody({
  type: "object",
  properties: { reference: { ...str, minLength: 6, maxLength: 40, pattern: "^[A-Za-z0-9-]+$", description: "Optional UPI transaction id / UTR" } },
});

/** The four QR-management operations for one provider surface. */
function managePaths(prefix, who, role403) {
  const base = { tags: [TAG], security: bearer };
  const common = { 401: errorResponse("Not authenticated"), 403: errorResponse(role403) };
  return {
    [prefix]: {
      get: { ...base, summary: `${who}: my payment QR`, description: "Always the signed-in provider's own row; never-set-up returns the empty shape (configured=false).", responses: { 200: ok("Payment QR", PaymentQr), ...common } },
      put: { ...base, summary: `${who}: save UPI ID / payee name / active flag`, requestBody: updateBody, responses: { 200: ok("Saved", PaymentQr), ...common, 422: errorResponse("Validation failed") } },
      delete: { ...base, summary: `${who}: remove my payment QR (image file + row)`, responses: { 200: ok("Removed — the empty shape", PaymentQr), ...common } },
    },
    [`${prefix}/image`]: {
      post: { ...base, summary: `${who}: upload / replace the QR image`, description: "The previous image file is deleted. Creates the row (active) if none exists.", requestBody: imageBody, responses: { 200: ok("Uploaded", PaymentQr), ...common, 422: errorResponse("UNSUPPORTED_FILE_TYPE / too large / no file") } },
    },
  };
}

const paymentQrPaths = {
  ...managePaths("/doctor/payment-qr", "Doctor", "Not a doctor"),
  ...managePaths("/medicine/pharmacy/payment-qr", "Pharmacy", "Not a pharmacy account"),

  "/doctors/{id}/payment-options": {
    get: {
      tags: [TAG],
      summary: "Public: which payment choices a doctor's booking screen may offer",
      description: "Says only WHETHER the doctor takes UPI QR — never the QR or the UPI id. testModeAutoConfirm=true means online bookings are auto-confirmed with no money (non-production, no gateway keys).",
      parameters: [idParam],
      responses: {
        200: ok("Options", { type: "object", properties: { cashAtClinic: { type: "boolean" }, upiQr: { type: "boolean" }, onlineGateway: { type: "boolean" }, testModeAutoConfirm: { type: "boolean" } } }),
        404: errorResponse("Doctor not found / not listed"),
        422: errorResponse("Non-numeric id"),
      },
    },
  },

  "/patient/bookings/{id}/payment-qr": {
    get: {
      tags: [TAG],
      summary: "Patient: the doctor's UPI QR, amount and reference for my upi_qr booking",
      security: bearer,
      parameters: [idParam],
      responses: {
        200: ok("Payment details", QrPaymentRequest({ offlineMethod: { type: "string", enum: ["cash", "upi_qr"] } })),
        404: errorResponse("Not your booking"),
        409: errorResponse("PAYMENT_QR_UNAVAILABLE — not a UPI QR booking, or the doctor removed the QR"),
      },
    },
  },
  "/patient/bookings/{id}/payment-report": {
    post: {
      tags: [TAG],
      summary: "Patient: \"I have paid\" (optional UPI reference)",
      description: "Records the reference + time for the doctor to verify. NEVER changes the booking or payment status; re-reporting overwrites the reference. Only while the payment is pending_at_clinic and the booking isn't cancelled.",
      security: bearer,
      parameters: [idParam],
      requestBody: reportBody,
      responses: {
        200: ok("Reported", QrPaymentRequest({ offlineMethod: { type: "string", enum: ["cash", "upi_qr"] } })),
        404: errorResponse("Not your booking"),
        409: errorResponse("PAYMENT_QR_UNAVAILABLE / PAYMENT_NOT_PENDING"),
        422: errorResponse("Bad reference"),
      },
    },
  },

  "/medicine/cart/payment-options": {
    get: {
      tags: [TAG],
      summary: "Patient: COD / UPI QR availability for my cart",
      description: "upiQr is true only when EVERY pharmacy in the cart has an active QR (checkout enforces the same rule).",
      security: bearer,
      responses: {
        200: ok("Options", {
          type: "object",
          properties: {
            cod: { type: "boolean" },
            upiQr: { type: "boolean" },
            providers: { type: "array", items: { type: "object", properties: { providerId: { type: "integer" }, name: str, upiQr: { type: "boolean" } } } },
          },
        }),
      },
    },
  },
  "/medicine/orders/groups/{id}/payment-qr": {
    get: {
      tags: [TAG],
      summary: "Patient: the pharmacy's UPI QR, amount and reference (order number) for my upi_qr order",
      security: bearer,
      parameters: [idParam],
      responses: {
        200: ok("Payment details", QrPaymentRequest()),
        403: errorResponse("Not your order"),
        404: errorResponse("Order not found"),
        409: errorResponse("PAYMENT_QR_UNAVAILABLE — not a UPI QR order, or the pharmacy removed the QR"),
      },
    },
  },
  "/medicine/orders/groups/{id}/payment-report": {
    post: {
      tags: [TAG],
      summary: "Patient: \"I have paid\" (optional UPI reference)",
      description: "Records the reference + time and notifies the pharmacy. NEVER changes the order or payment status. Only while the payment is pending and the order isn't cancelled.",
      security: bearer,
      parameters: [idParam],
      requestBody: reportBody,
      responses: {
        200: ok("Reported", QrPaymentRequest()),
        403: errorResponse("Not your order"),
        409: errorResponse("PAYMENT_QR_UNAVAILABLE / PAYMENT_NOT_PENDING"),
        422: errorResponse("Bad reference"),
      },
    },
  },
  "/medicine/orders/groups/{id}/payment/confirm-received": {
    post: {
      tags: [TAG],
      summary: "Pharmacy: the UPI payment reached my account → mark the order paid",
      description: "The ONLY way a upi_qr order becomes paid (delivery doesn't). Order + lines → paid, the payment row → success (reference = the patient's reported reference, else UPI-<orderNumber>), the patient is notified. Refunds of UPI payments are handled offline by the pharmacy.",
      security: bearer,
      parameters: [idParam],
      responses: {
        200: ok("{ order } — the serialized order group", { type: "object", properties: { order: { type: "object" } } }),
        403: errorResponse("Not this pharmacy's order"),
        404: errorResponse("Order not found"),
        409: errorResponse("ORDER_NOT_PAYABLE (not upi_qr) / PAYMENT_NOT_PENDING (already paid / cancelled)"),
      },
    },
  },
};

const paymentQrTags = [
  {
    name: TAG,
    description:
      "Patients pay doctors and pharmacies straight to the provider's OWN UPI QR. Nothing is verified automatically: a payment stays pending (bookings: pending_at_clinic) until the provider confirms receipt. No gateway, no money through the platform.",
  },
];

module.exports = { paymentQrPaths, paymentQrTags };
