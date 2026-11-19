/**
 * Joi schemas for every auth endpoint body. This is the ONLY place request
 * shapes are validated — controllers assume `req.body` is already clean and
 * typed. Each schema is passed to the `validate()` middleware in the routes.
 *
 * `.strip()`/`stripUnknown` behaviour is handled by the middleware; here we
 * just describe what a valid body looks like.
 */
const Joi = require("joi");
const { SELF_REGISTERABLE_ROLES } = require("../config/constants");
const { normalizeIndianMobile } = require("../utils/phone");

// ── Reusable field rules ──────────────────────────────────────────────────
const email = Joi.string().trim().lowercase().email().max(190).required();

// Min 8 chars, at least one letter and one number (matches README §7 policy).
const strongPassword = Joi.string()
  .min(8)
  .max(128)
  .pattern(/[A-Za-z]/, "letter")
  .pattern(/\d/, "number")
  .required()
  .messages({
    "string.pattern.name": "Password must include at least one {#name}",
    "string.min": "Password must be at least 8 characters",
  });

const phone = Joi.string()
  .trim()
  .pattern(/^[+]?[\d\s-]{7,20}$/)
  .messages({ "string.pattern.base": "Phone number is not valid" });

const name = Joi.string().trim().min(2).max(150).required();
const role = Joi.string().valid(...SELF_REGISTERABLE_ROLES);

// Structured Google location, mirroring the clinic/patient address columns.
// Optional: only MR / Medicine Store registrations currently submit it.
const locationFields = {
  addressLine: Joi.string().trim().max(255).allow("", null),
  city: Joi.string().trim().max(100).allow("", null),
  state: Joi.string().trim().max(100).allow("", null),
  pincode: Joi.string().trim().max(20).allow("", null),
  lat: Joi.number().min(-90).max(90).allow(null),
  lng: Joi.number().min(-180).max(180).allow(null),
};

// ── Endpoint schemas ──────────────────────────────────────────────────────
const register = Joi.object({
  name,
  email,
  phone: phone.optional().allow("", null),
  password: strongPassword,
  role: role.required(),
  ...locationFields,
});

const login = Joi.object({
  email,
  password: Joi.string().required(), // never reveal the policy on login
  // Which portal is asking. When set, a valid-but-wrong-role account is rejected
  // with WRONG_PORTAL so a doctor can't start a session in the patient app.
  audience: Joi.string().valid("doctor", "patient").optional(),
});

/**
 * An Indian mobile number, coerced to its canonical 10 digits (accepts "+91",
 * "0", spaces and dashes). Anything else is a 422 here, before any lookup.
 */
const mobile = Joi.string()
  .trim()
  .max(20)
  .custom((value, helpers) => normalizeIndianMobile(value) ?? helpers.error("any.invalid"))
  .messages({ "any.invalid": "Enter a valid 10-digit Indian mobile number" });

/**
 * The patient/doctor app's login (`POST /auth/login`): email OR mobile number,
 * exactly one. Every other portal keeps the email-only `login` schema.
 */
const loginLocal = Joi.object({
  email: Joi.string().trim().lowercase().email().max(190),
  phone: mobile,
  password: Joi.string().required(),
  audience: Joi.string().valid("doctor", "patient").optional(),
})
  .xor("email", "phone")
  .messages({
    "object.missing": "Enter your email or mobile number",
    "object.xor": "Use either email or mobile number, not both",
  });

/** Where a reset code goes: the registered mobile (SMS) OR the registered email — exactly one. */
const otpChannelMessages = {
  "object.missing": "Enter your registered email or mobile number",
  "object.xor": "Use either email or mobile number, not both",
};

/** Forgot password by OTP: request a code for a registered mobile or email. */
const requestPasswordOtp = Joi.object({
  phone: mobile,
  email: Joi.string().trim().lowercase().email().max(190),
  // Which portal's account to reset. Default "patient" keeps every existing
  // client unchanged; the doctor website/app send "doctor".
  audience: Joi.string().valid("doctor", "patient").default("patient"),
})
  .xor("phone", "email")
  .messages(otpChannelMessages);

/** Forgot password by OTP: exchange the code for a reset token. */
const verifyPasswordOtp = Joi.object({
  phone: mobile,
  email: Joi.string().trim().lowercase().email().max(190),
  otp: Joi.string()
    .trim()
    .pattern(/^\d{6}$/)
    .required()
    .messages({ "string.pattern.base": "The code is 6 digits" }),
  audience: Joi.string().valid("doctor", "patient").default("patient"),
})
  .xor("phone", "email")
  .messages(otpChannelMessages);

const google = Joi.object({
  credential: Joi.string().required(),
  role: role.optional(), // required only for a brand-new account (checked in service)
  // Which portal is asking. When set, a valid-but-wrong-role account is rejected
  // with WRONG_PORTAL (parity with `login`), so a doctor can't start a session
  // in the patient app via Google. Also picks the role for a brand-new signup.
  audience: Joi.string().valid("doctor", "patient").optional(),
});

const refresh = Joi.object({
  refreshToken: Joi.string().required(),
});

const forgotPassword = Joi.object({
  email,
});

const resetPassword = Joi.object({
  token: Joi.string().required(),
  password: strongPassword,
});

const changePassword = Joi.object({
  currentPassword: Joi.string().required(),
  newPassword: strongPassword,
});

const logout = Joi.object({
  refreshToken: Joi.string().optional(),
});

const updateProfile = Joi.object({
  name: Joi.string().trim().min(2).max(150),
  phone: phone.allow("", null),
  avatarUrl: Joi.string().uri({ scheme: ["http", "https"] }).max(500).allow("", null),
  // role-specific nested patches (validated loosely here; service whitelists)
  doctor: Joi.object({
    qualification: Joi.string().max(255),
    registrationNumber: Joi.string().max(100),
    experienceYears: Joi.number().integer().min(0).max(80),
    bio: Joi.string().max(5000),
    onlineFee: Joi.number().min(0),
  }),
  patient: Joi.object({
    dateOfBirth: Joi.date().iso(),
    gender: Joi.string().valid("male", "female", "other"),
    bloodGroup: Joi.string().valid("A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-", "unknown"),
    addressLine: Joi.string().max(255),
    city: Joi.string().max(100),
    state: Joi.string().max(100),
    pincode: Joi.string().max(20),
  }),
  // Only the display fields a clinic can change from Settings. The full profile
  // (address, map location, registration number) is edited through
  // PUT /clinic/profile, which also re-derives the onboarding checklist —
  // deliberately NOT reachable from here, so verification can't be bypassed.
  clinic: Joi.object({
    clinicName: Joi.string().trim().min(2).max(150),
    phone: phone.allow("", null),
  }),
}).min(1); // at least one field must be present

module.exports = {
  register,
  login,
  loginLocal,
  requestPasswordOtp,
  verifyPasswordOtp,
  google,
  refresh,
  forgotPassword,
  resetPassword,
  changePassword,
  logout,
  updateProfile,
};
