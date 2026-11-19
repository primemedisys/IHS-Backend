/**
 * /auth routes. Each line reads as a contract: path → rate limit? → validate →
 * auth? → controller. All validation and guarding is declared HERE via
 * middleware, so controllers stay thin.
 */
const router = require("express").Router();

const auth = require("../controllers/auth.controller");
const adminAuth = require("../controllers/adminAuth.controller");
const clinicAuth = require("../controllers/clinicAuth.controller");
const medicineAuth = require("../controllers/medicineAuth.controller");
const bloodBank = require("../controllers/bloodBank.controller");
const bloodBankSchema = require("../validators/bloodBank.validator");
const ambulance = require("../controllers/ambulanceProvider.controller");
const ambulanceSchema = require("../validators/ambulance.validator");
const validate = require("../middlewares/validate");
const authenticate = require("../middlewares/authenticate");
const { authLimiter, refreshLimiter, signupLimiter, forgotPasswordLimiter } = require("../middlewares/rateLimiters");
const schema = require("../validators/auth.validator");

// ── Public ────────────────────────────────────────────────────────────────
router.post("/register", signupLimiter, validate(schema.register), auth.register);
// Email OR mobile number (`loginLocal`); every other portal stays email-only.
router.post("/login", authLimiter, validate(schema.loginLocal), auth.login);
router.post("/google", authLimiter, validate(schema.google), auth.google);
router.post("/admin/login", authLimiter, validate(schema.login), adminAuth.login);
// The clinic portal. Its own login AND its own Google route: the allowed roles
// belong to the ROUTE, not to a client-supplied `audience` string, so a doctor
// pressing the clinic app's Google button is rejected server-side.
router.post("/clinic/login", authLimiter, validate(schema.login), clinicAuth.login);
router.post("/clinic/google", authLimiter, validate(schema.google), clinicAuth.google);
// Medicine portal (MR / Medicine Store).
router.post("/medicine/login", authLimiter, validate(schema.login), medicineAuth.login);
router.post("/medicine/google", authLimiter, validate(schema.google), medicineAuth.google);
// Blood Bank portal: its own signup (centre details) and its own login.
router.post("/blood-bank/register", signupLimiter, validate(bloodBankSchema.register), bloodBank.register);
router.post("/blood-bank/login", authLimiter, validate(schema.login), bloodBank.login);
// Ambulance provider portal: its own signup (organisation + first ambulance +
// optional driver, created atomically) and its own login.
router.post("/ambulance/register", signupLimiter, validate(ambulanceSchema.register), ambulance.register);
router.post("/ambulance/login", authLimiter, validate(schema.login), ambulance.login);
// `refreshLimiter`, NOT `authLimiter`. Refresh is machine-driven: every open
// tab spends one per window just staying signed in, and when several tabs
// refresh at once, rotation means only one wins — the losers 401, which
// `authLimiter` counted as failed CREDENTIAL attempts. Ten of those and the
// user was locked out of /auth/login itself, which is exactly the "auto logout
// everywhere and then 429 on login" report.
router.post("/refresh", refreshLimiter, validate(schema.refresh), auth.refresh);
router.post("/forgot-password", forgotPasswordLimiter, validate(schema.forgotPassword), auth.forgotPassword);
router.post("/reset-password", authLimiter, validate(schema.resetPassword), auth.resetPassword);
// Forgot password by SMS (patients). Requesting a code shares the forgot-password
// bucket (every request counts); verifying uses authLimiter (failed guesses
// count), on top of the per-code attempt cap in the service.
router.post("/forgot-password/otp", forgotPasswordLimiter, validate(schema.requestPasswordOtp), auth.requestPasswordOtp);
router.post("/forgot-password/otp/verify", authLimiter, validate(schema.verifyPasswordOtp), auth.verifyPasswordOtp);

// ── Authenticated ───────────────────────────────────────────────────────────
router.get("/me", authenticate, auth.me);
router.patch("/profile", authenticate, validate(schema.updateProfile), auth.updateProfile);
router.post("/change-password", authenticate, validate(schema.changePassword), auth.changePassword);
router.post("/logout", authenticate, validate(schema.logout), auth.logout);

module.exports = router;
