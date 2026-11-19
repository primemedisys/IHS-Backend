/**
 * Rate limiters. `authLimiter` guards brute-forceable endpoints (login, admin
 * login, forgot-password, refresh); `globalLimiter` is a loose blanket cap for
 * the whole API. Limits come from env so they can be tuned per environment.
 */
const rateLimit = require("express-rate-limit");
const env = require("../config/env");
const ApiError = require("../utils/ApiError");
const { verifyAccessToken } = require("../utils/accessToken");
const { ERROR_CODES } = require("../config/constants");

const handler = (_req, _res, next) =>
  next(
    new ApiError(429, "Too many requests, please try again later", {
      code: ERROR_CODES.RATE_LIMITED,
    })
  );

const windowMs = env.RATE_LIMIT_WINDOW_MIN * 60_000;

/**
 * Sign-in / token / recovery endpoints that carry their OWN, purpose-built
 * limiter (authLimiter, refreshLimiter, signupLimiter, forgotPasswordLimiter
 * below). Paths are relative to API_PREFIX, where the global limiter is mounted.
 *
 * They are kept out of the blanket per-IP cap because ordinary app traffic
 * spends that cap: one Workbench patient page is ~23 requests and an open one
 * polls every 30s, and every portal on one machine / office NAT shares the IP.
 * Once it ran out, the NEXT LOGIN was refused with 429 before its own limiter
 * (which counts only failed guesses) was even consulted. Brute-force protection
 * is unchanged: these routes are still limited by their dedicated buckets.
 */
const OWN_LIMITER_ROUTES = new Set(
  [
    "/login",
    "/google",
    "/admin/login",
    "/clinic/login",
    "/clinic/google",
    "/medicine/login",
    "/medicine/google",
    "/blood-bank/login",
    "/ambulance/login",
    "/refresh",
    "/reset-password",
    "/forgot-password",
    "/forgot-password/otp",
    "/forgot-password/otp/verify",
    "/register",
    "/blood-bank/register",
    "/ambulance/register",
  ].map((p) => `/auth${p}`)
);
const hasOwnLimiter = (req) => req.method === "POST" && OWN_LIMITER_ROUTES.has(req.path.replace(/\/+$/, ""));

/**
 * Who a request belongs to, for rate limiting: the VERIFIED signed-in user (the
 * same JWT check `authenticate` does — signature only, no database), else the
 * IP. A forged or expired token fails verification and falls back to the IP, so
 * rotating fake tokens never gets an attacker a fresh bucket.
 */
const subjectOf = (req) => {
  if (req._rlSubject !== undefined) return req._rlSubject;
  let subject = null;
  const [scheme, token] = String(req.headers.authorization || "").split(" ");
  if (scheme === "Bearer" && token) {
    try {
      subject = `u:${verifyAccessToken(token).id}`;
    } catch {
      subject = null;
    }
  }
  req._rlSubject = subject;
  return subject;
};
const isRead = (req) => req.method === "GET" || req.method === "HEAD";

/**
 * Reads by a SIGNED-IN user — dashboards, workbench pages, lists. Cheap and
 * frequent (one Workbench patient page is ~42 requests), so it has its own,
 * per-user budget: one user's navigation can't spend another user's (or an
 * office NAT's) allowance, and it can never starve writes. Read endpoints that
 * are expensive (search, PDF, downloads) keep their own dedicated limiters.
 */
const readLimiter = rateLimit({
  windowMs,
  max: env.READ_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => hasOwnLimiter(req) || !(isRead(req) && subjectOf(req)),
  keyGenerator: (req) => subjectOf(req),
  handler,
});

/**
 * Everything else: anonymous traffic (per IP) and every write (per signed-in
 * user, else IP). This is the tight backstop that protects sensitive operations.
 */
const writeLimiter = rateLimit({
  windowMs,
  max: env.RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => hasOwnLimiter(req) || (isRead(req) && Boolean(subjectOf(req))),
  keyGenerator: (req) => subjectOf(req) ?? req.ip,
  handler,
});

/** Mounted once on the API; Express flattens the array. */
const globalLimiter = [readLimiter, writeLimiter];

/**
 * Brute-force guard for credential endpoints (login, admin login,
 * forgot-password).
 *
 * `skipSuccessfulRequests` is the important part: only FAILED attempts count.
 * The threat is someone guessing a password, and a guesser is wrong by
 * definition — so a legitimate user who signs in, signs out and signs back in
 * never spends budget, while an attacker exhausts it in `max` wrong guesses.
 * Counting successes too is what turned this into "the app locked me out of
 * logging in after using it for a while".
 */
/**
 * Two buckets, both counting FAILED attempts only:
 *  - per IP + account: AUTH_RATE_LIMIT_MAX wrong guesses at one account — the
 *    brute-force guard proper;
 *  - per IP: 5× that across all accounts — stops one machine spraying many.
 *
 * A single per-IP bucket for every portal's sign-in (it was) let ten typos in
 * ANY local app — patient site, admin, clinic, a mobile emulator, all on one
 * IP in dev or one office NAT in production — lock a doctor out of logging in.
 */
const credentialOf = (req) => {
  const b = req.body || {};
  return String(b.email || b.phone || b.mobile || b.username || "").trim().toLowerCase();
};

const authAccountLimiter = rateLimit({
  windowMs,
  max: env.AUTH_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => `${req.ip}|${credentialOf(req)}`,
  handler,
});

const authIpLimiter = rateLimit({
  windowMs,
  max: env.AUTH_RATE_LIMIT_MAX * 5,
  standardHeaders: false, // the account bucket's headers are the ones a user hits
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  handler,
});

/** Express flattens arrays, so routes keep using `authLimiter` as one middleware. */
const authLimiter = [authIpLimiter, authAccountLimiter];

/**
 * Token refresh gets its OWN, far larger bucket — it is machine-driven, not
 * user-driven, and it is not the same threat surface: a caller must already
 * hold a valid refresh token, so there is nothing to guess.
 *
 * Sharing `authLimiter` was actively harmful. Access tokens live 15 minutes and
 * the rate window is 15 minutes, so every open tab spends one auth request per
 * window just staying signed in. A doctor with the dashboard, a video call, a
 * patient page and a couple of history tabs open burns the whole login budget
 * without typing anything — and then cannot log in.
 */
const refreshLimiter = rateLimit({
  windowMs,
  max: env.REFRESH_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  handler,
});

/**
 * Prescription rendering. `preview.pdf` and `finalize` each spawn a Chromium
 * page — without a cap, one held-down "Preview" button is a self-inflicted DoS.
 * Keyed per authenticated doctor, so one doctor can't starve the others.
 */
const pdfLimiter = rateLimit({
  windowMs: 60_000,
  max: env.PDF_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.user?.id ?? req.ip),
  handler,
});

/**
 * Public "Contact us" form. An unauthenticated write endpoint is a spam target,
 * so it gets its own tight per-IP cap (separate store from `authLimiter`, so
 * contact traffic never eats into a visitor's login attempts).
 */
const contactLimiter = rateLimit({
  windowMs,
  max: env.CONTACT_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  handler,
});

/**
 * Account creation (patient/doctor, blood bank, ambulance). Counts EVERY
 * request — sign-ups succeed, so `skipSuccessfulRequests` would never bite.
 */
const signupLimiter = rateLimit({
  windowMs,
  max: env.SIGNUP_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  handler,
});

/**
 * Password-reset emails. forgot-password ALWAYS answers 200 (it must not
 * reveal whether an account exists), so `authLimiter` — which only counts
 * failures — never limited it, and one script could flood a victim's inbox.
 */
const forgotPasswordLimiter = rateLimit({
  windowMs,
  max: env.FORGOT_PASSWORD_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  handler,
});

/** A per-signed-in-user limiter (keyed on the verified user id, not the IP). */
const perUserLimiter = (windowMsForUser, max) =>
  rateLimit({
    windowMs: windowMsForUser,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => String(req.user?.id ?? req.ip),
    handler,
  });

/** Doctor searching patients they don't treat — an enumeration guard. */
const patientSearchLimiter = perUserLimiter(60_000, env.PATIENT_SEARCH_RATE_LIMIT_MAX);

/** Doctor record-access requests — each one notifies a patient, so cap them. */
const accessRequestLimiter = perUserLimiter(60 * 60_000, env.ACCESS_REQUEST_RATE_LIMIT_MAX);

/** Doctors adding shared catalog sub-specialties — a spam guard on a shared list. */
const subSpecCreateLimiter = perUserLimiter(60 * 60_000, 20);

module.exports = {
  subSpecCreateLimiter,
  globalLimiter,
  authLimiter,
  refreshLimiter,
  pdfLimiter,
  contactLimiter,
  patientSearchLimiter,
  accessRequestLimiter,
  signupLimiter,
  forgotPasswordLimiter,
};
