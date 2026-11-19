/**
 * All authentication business logic. Controllers stay thin: they hand validated
 * input to these functions and serialize the result. Nothing here reads
 * `req`/`res` beyond the small `req` needed to stamp a refresh token's IP/UA.
 *
 * Conventions enforced here:
 *  - profile rows are created in the SAME transaction as the user (atomic).
 *  - related data is eager-loaded with `include` — never queried in a loop.
 *  - the password hash is only ever loaded via the explicit `withPassword` scope.
 *  - repeated logic (login, user lookups, profile rows) lives in ONE place:
 *    the credential check is a single helper; user queries live in user.service.
 */
const crypto = require("crypto");
const { Op } = require("sequelize");
const {
  sequelize,
  User,
  DoctorProfile,
  PatientProfile,
  ClinicProfile,
  PasswordResetToken,
  PasswordResetOtp,
} = require("../models");
const env = require("../config/env");
const password = require("../utils/password");
const { randomToken, sha256 } = require("../utils/tokens");
const ApiError = require("../utils/ApiError");
const {
  ROLES,
  AUTH_PROVIDERS,
  SELF_REGISTERABLE_ROLES,
  PROVIDER_PORTAL_ROLES,
  ERROR_CODES,
} = require("../config/constants");
const tokenService = require("./token.service");
const googleService = require("./google.service");
const mailService = require("./mail.service");
const userService = require("./user.service");
const smsService = require("./sms.service");
const { toE164India } = require("../utils/phone");

/**
 * When a portal declares its `audience`, bounce a valid session that belongs to
 * a different role (a doctor on the patient app, or vice-versa) with a clear
 * WRONG_PORTAL rather than issuing a cross-portal token. Runs ONLY after the
 * account is otherwise authenticated, so it can't be used to enumerate which
 * emails are doctors vs patients. Shared by password AND Google auth so the
 * rule can never drift between the two.
 */
function assertAudience(user, audience) {
  if (audience && user.role !== audience) {
    throw new ApiError(403, `This account is registered as a ${user.role}.`, {
      code: ERROR_CODES.WRONG_PORTAL,
      details: { role: user.role },
    });
  }
}

/** Email + password → the user, or the canonical bad-login error. */
async function resolveEmailLogin(email, plain, allowedRoles) {
  const user = await userService.findByEmail(email, { withPassword: true });
  if (!user || !allowedRoles.includes(user.role)) {
    throw ApiError.invalidCredentials(ERROR_CODES.INVALID_CREDENTIALS);
  }
  if (!(await password.compare(plain, user.passwordHash))) {
    throw ApiError.invalidCredentials(ERROR_CODES.INVALID_CREDENTIALS);
  }
  return user;
}

/** Most accounts one number may front before mobile login is refused (bcrypt cost per attempt). */
const MOBILE_LOGIN_MAX_CANDIDATES = 10;

/** Same 401 as the email path, worded for a mobile number. */
const invalidMobileCredentials = () =>
  new ApiError(401, "Invalid mobile number or password", { code: ERROR_CODES.INVALID_CREDENTIALS });

/**
 * Mobile + password → the user.
 *
 * `users.phone` is not unique, so the number can front several accounts. Only
 * accounts of the calling portal's role are considered (on the patient app:
 * patients only — a doctor sharing the number can never be signed in here), and
 * the password is what picks the account. If the password fits more than one,
 * there is no safe choice, so the patient is asked to use their email — and
 * that is only ever said AFTER the password was proven, so it reveals nothing
 * to someone guessing.
 */
async function resolveMobileLogin(mobile, plain, allowedRoles, audience) {
  const roles = audience ? allowedRoles.filter((r) => r === audience) : allowedRoles;
  if (!roles.length) throw invalidMobileCredentials();

  const candidates = await userService.findByMobile(mobile, roles, {
    withPassword: true,
    limit: MOBILE_LOGIN_MAX_CANDIDATES,
  });
  if (!candidates.length || candidates.length > MOBILE_LOGIN_MAX_CANDIDATES) throw invalidMobileCredentials();

  const checks = await Promise.all(candidates.map((u) => password.compare(plain, u.passwordHash)));
  const matched = candidates.filter((_, i) => checks[i]);
  if (!matched.length) throw invalidMobileCredentials();
  if (matched.length > 1) {
    throw ApiError.conflict(
      "This mobile number is linked to more than one account. Please sign in with your email address.",
      { code: ERROR_CODES.PHONE_SHARED }
    );
  }
  return matched[0];
}

/**
 * The ONE credential-verification path, shared by every portal's login. The
 * only difference between them is which roles are allowed, so that's the only
 * parameter — everything else (generic error, active check, token issue) is
 * identical and lives here once.
 *
 * `allowedRoles` is an explicit ALLOW-LIST, deliberately. It used to be a
 * two-way flag whose non-admin branch read `user.role !== ROLES.ADMIN` — i.e.
 * "anything that is not admin". That admitted every future role by default: the
 * moment a fourth role existed, an account of that role could sign in through
 * the patient/doctor form and receive a token its own portal guard would then
 * honour. Listing the permitted roles denies by default instead.
 *
 * @param {{email, password, audience}} creds
 * @param {string[]} allowedRoles  exactly which roles this portal admits
 */
async function verifyPasswordLogin({ email, phone, password: plain, audience }, allowedRoles, req) {
  const user = phone
    ? await resolveMobileLogin(phone, plain, allowedRoles, audience)
    : await resolveEmailLogin(email, plain, allowedRoles);

  if (!user.isActive) {
    throw ApiError.forbidden("Account is disabled");
  }

  // Wrong-portal check runs ONLY after credentials verify (so it can't be used
  // to enumerate which emails are doctors vs patients). A doctor logging in on
  // the patient app — or vice-versa — is bounced to the right portal.
  assertAudience(user, audience);

  const tokens = await tokenService.issueTokens(user, req);
  return { user, tokens };
}

/**
 * Local email+password signup for doctors/patients.
 *
 * `profile` (optional) seeds extra columns on the role's profile row in the
 * SAME transaction — used by the blood-bank signup for its centre details.
 * Every other caller passes nothing, so their profile rows are unchanged.
 *
 * `afterCreate` (optional) runs inside that same transaction once the user and
 * profile rows exist — used by the ambulance signup to create its first
 * ambulance + driver atomically with the account. Omitted by every other caller.
 * @returns {Promise<{user: User, tokens}>}
 */
async function registerLocal(
  { name, email, phone, password: plain, role, addressLine, city, state, pincode, lat, lng },
  req,
  profile = {},
  afterCreate = null
) {
  if (!SELF_REGISTERABLE_ROLES.includes(role)) {
    throw ApiError.forbidden("This role cannot self-register");
  }

  const existing = await userService.findByEmail(email);
  if (existing) {
    throw ApiError.conflict("Email is already registered", { code: ERROR_CODES.EMAIL_IN_USE });
  }

  const passwordHash = await password.hash(plain);

  // User + profile row are created atomically: if the profile insert fails we
  // don't want a half-registered user with no profile.
  const user = await sequelize.transaction(async (tx) => {
    const created = await User.create(
      {
        name,
        email,
        phone: phone ?? null,
        passwordHash,
        role,
        authProvider: AUTH_PROVIDERS.LOCAL,
        // Pharmacy providers keep their Google-selected location on the users
        // row itself (they have no profile table). Safe for every role: the
        // columns are nullable, and other roles simply don't send them.
        addressLine: addressLine || null,
        city: city || null,
        state: state || null,
        pincode: pincode || null,
        lat: lat ?? null,
        lng: lng ?? null,
      },
      { transaction: tx }
    );
    await userService.createProfileRow(created, tx, profile);
    if (afterCreate) await afterCreate(created, tx);
    return created;
  });

  const tokens = await tokenService.issueTokens(user, req);
  return { user, tokens };
}

/** Local login for doctors/patients — every other role has its own portal. */
function loginLocal(creds, req) {
  return verifyPasswordLogin(creds, [ROLES.DOCTOR, ROLES.PATIENT], req);
}

/** Admin-only login. */
function loginAdmin(creds, req) {
  return verifyPasswordLogin(creds, [ROLES.ADMIN], req);
}

/** Clinic-portal-only login. */
function loginClinic(creds, req) {
  return verifyPasswordLogin(creds, [ROLES.CLINIC], req);
}

/**
 * Medicine-portal login. Every pharmacy role, legacy MR INCLUDED: MR can no
 * longer be registered and is no longer offered to patients, but an existing
 * MR must still be able to sign in and manage the inventory, prescriptions and
 * orders it already has (migration 036).
 */
function loginMedicineProvider(creds, req) {
  // PROVIDER_PORTAL_ROLES = every pharmacy role + the Diagnostic Lab Center,
  // which shares this portal (migration 038). Route-level authorization, not
  // the login, keeps the two provider families apart.
  return verifyPasswordLogin(creds, [...PROVIDER_PORTAL_ROLES], req);
}

/**
 * Blood Bank portal login (frontend-blood-bank). Its own route + allowed role,
 * like the clinic portal, so no other account type can start a session there.
 * A pending (unapproved) blood bank CAN sign in — to finish its profile and
 * see its verification status — but every operational route stays closed
 * until an admin approves it (requireApprovedBloodBank).
 */
function loginBloodBank(creds, req) {
  return verifyPasswordLogin(creds, [ROLES.BLOOD_BANK], req);
}

/**
 * Ambulance provider portal login (frontend-ambulance). Its own route + allowed
 * role, exactly like the blood bank. A pending provider CAN sign in (to finish
 * its details and see its verification status); every operational route stays
 * closed until an admin approves it (requireApprovedAmbulanceProvider).
 */
function loginAmbulanceProvider(creds, req) {
  return verifyPasswordLogin(creds, [ROLES.AMBULANCE_PROVIDER], req);
}

/**
 * Google signup/signin.
 *
 * @param {{credential, role, audience}} body
 * @param {object} req
 * @param {{ allowedRoles: string[], signupRole?: string }} portal
 *   `allowedRoles` — which roles this route admits, decided SERVER-side.
 *   `signupRole`   — the role a brand-new account is created as, when the route
 *                    fixes it (the clinic portal does); omit to fall back to the
 *                    client's `audience`/`role`.
 *
 * The `portal` argument exists because this function previously had NO role
 * check at all on the existing-user branch: `assertAudience` is a no-op when the
 * client omits `audience`, so any account whose email matched a Google identity
 * could obtain a session from any portal's Google button. That is the same hole
 * `verifyPasswordLogin` had, and it is closed the same way — an explicit
 * allow-list the caller cannot influence.
 */
async function googleAuth({ credential, role, audience }, req, portal) {
  const { allowedRoles, signupRole: fixedSignupRole } = portal;
  const profile = await googleService.verify(credential);

  // Find by google_id first, then by email (to link a pre-existing local acct).
  let user = await User.findOne({
    where: { [Op.or]: [{ googleId: profile.googleId }, { email: profile.email }] },
  });

  if (user) {
    if (!user.isActive) throw ApiError.forbidden("Account is disabled");
    // The portal's own allow-list, checked BEFORE any token is issued or any
    // google_id is linked. Unlike `assertAudience` below, this cannot be
    // sidestepped by omitting a field.
    if (!allowedRoles.includes(user.role)) {
      throw new ApiError(403, `This account is registered as a ${user.role}.`, {
        code: ERROR_CODES.WRONG_PORTAL,
        details: { role: user.role },
      });
    }
    // Bounce a wrong-portal account (e.g. a doctor signing in on the patient
    // app) BEFORE issuing any token or linking the google_id — same rule as
    // password login, so a doctor can't get a doctor session on the patient app.
    assertAudience(user, audience);
    // Link the google_id onto a local account signing in via Google the 1st time.
    if (!user.googleId) {
      user.googleId = profile.googleId;
      user.isEmailVerified = true;
      await user.save();
    }
    const tokens = await tokenService.issueTokens(user, req);
    return { user, tokens };
  }

  // New account → this is effectively a signup. A route that fixes its own
  // signup role (the clinic portal) wins; otherwise prefer the calling portal's
  // `audience` (so a Google signup on the patient app is always a patient) and
  // fall back to the explicit `role`.
  const signupRole = fixedSignupRole || audience || role;
  if (!SELF_REGISTERABLE_ROLES.includes(signupRole) || !allowedRoles.includes(signupRole)) {
    throw ApiError.badRequest("A valid role is required to sign up with Google");
  }

  user = await sequelize.transaction(async (tx) => {
    const created = await User.create(
      {
        name: profile.name,
        email: profile.email,
        role: signupRole,
        authProvider: AUTH_PROVIDERS.GOOGLE,
        googleId: profile.googleId,
        profilePhotoUrl: profile.picture ?? null,
        isEmailVerified: true,
      },
      { transaction: tx }
    );
    await userService.createProfileRow(created, tx);
    return created;
  });

  const tokens = await tokenService.issueTokens(user, req);
  return { user, tokens };
}

/** Rotate a refresh token → new pair (delegates to the token service). */
function refresh(rawToken, req) {
  return tokenService.rotateRefreshToken(rawToken, req);
}

/** Logout: revoke the presented refresh token. */
function logout(rawToken) {
  return tokenService.revokeRefreshToken(rawToken);
}

/**
 * Forgot-password. ALWAYS resolves the same way whether or not the email exists
 * (no user enumeration). Sends a reset link only when there's a real account.
 */
async function forgotPassword({ email }) {
  const user = await userService.findByEmail(email);
  if (!user) return; // silent — caller returns 200 regardless

  const raw = randomToken(32);
  const expiresAt = new Date(Date.now() + env.RESET_TOKEN_TTL_MINUTES * 60_000);
  await PasswordResetToken.create({ userId: user.id, tokenHash: sha256(raw), expiresAt });

  await mailService.sendPasswordReset(user, raw);
}

// ── Forgot password by OTP: SMS (migration 050) or email (migration 052) ─────

/**
 * HMAC of the code, bound to where it was sent, keyed by a server secret — a
 * leaked row can't be brute-forced offline. A DOCTOR code is also bound to its
 * portal ("|doctor"), so a code requested on the patient app can never reset a
 * doctor account that shares the number (and vice versa). Phone codes keep the
 * original input exactly, so codes already issued stay valid; email codes are
 * prefixed "email:" (a 10-digit phone can never collide with it).
 */
const otpHash = ({ phone, email }, code, audience = ROLES.PATIENT) =>
  crypto
    .createHmac("sha256", env.JWT_ACCESS_SECRET)
    .update(`pwd-otp:${email ? `email:${email}` : phone}${audience === ROLES.DOCTOR ? "|doctor" : ""}:${code}`)
    .digest("hex");

/** The portal an OTP reset serves → which accounts it may reset. */
const OTP_ROLES = { [ROLES.PATIENT]: [ROLES.PATIENT], [ROLES.DOCTOR]: [ROLES.DOCTOR] };

/** How long the reset token minted from a verified OTP stays usable. */
const OTP_RESET_TOKEN_TTL_MINUTES = 15;

/** The row lookup for one channel: exactly one of phone / email. */
const channelWhere = ({ phone, email }) => (email ? { email } : { phone });

/** Active accounts of the portal's role behind this phone / email. */
async function otpAccounts({ phone, email }, audience) {
  const roles = OTP_ROLES[audience] ?? [ROLES.PATIENT];
  if (email) {
    const user = await userService.findByEmail(email);
    return user && user.isActive && roles.includes(user.role) ? [user] : [];
  }
  return (await userService.findByMobile(phone, roles)).filter((u) => u.isActive);
}

/**
 * Send a 6-digit reset code to the account's registered mobile (SMS) or email.
 *
 * Resolves the same way whether or not the number / address is registered (no
 * account enumeration). The ONE thing it does say up front is when the channel
 * isn't set up at all — that's a fact about the platform, not the account, and
 * pretending a code went out would leave the user waiting for nothing.
 *
 * Abuse limits: the route's per-IP limiter, plus per number / address here — a
 * minimum gap between codes and a cap per rolling hour. Over a limit, nothing
 * is sent but the response is unchanged (again: no enumeration).
 */
async function requestPasswordOtp({ phone, email, audience = ROLES.PATIENT }) {
  const channel = email ? { email } : { phone };
  if (email ? !mailService.isConfigured() : !smsService.isConfigured()) {
    throw new ApiError(
      503,
      email
        ? "Password reset by email isn't available right now. Please try your mobile number instead."
        : "Password reset by SMS isn't available right now. Please reset with your email address instead.",
      { code: email ? ERROR_CODES.EMAIL_UNAVAILABLE : ERROR_CODES.SMS_UNAVAILABLE }
    );
  }

  const accounts = await otpAccounts(channel, audience);
  if (!accounts.length) return;

  const now = Date.now();
  const recent = await PasswordResetOtp.findAll({
    where: { ...channelWhere(channel), createdAt: { [Op.gte]: new Date(now - 60 * 60_000) } },
    attributes: ["createdAt"],
    order: [["createdAt", "DESC"]],
  });
  if (recent.length >= env.PASSWORD_OTP_MAX_PER_HOUR) return;
  if (recent[0] && now - recent[0].createdAt.getTime() < env.PASSWORD_OTP_RESEND_SECONDS * 1000) return;

  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  const row = await sequelize.transaction(async (tx) => {
    // A new code retires every earlier one for this number / address.
    await PasswordResetOtp.update(
      { consumedAt: new Date(now) },
      { where: { ...channelWhere(channel), consumedAt: null }, transaction: tx }
    );
    return PasswordResetOtp.create(
      {
        // NULL when the number fronts several accounts — see verifyPasswordOtp.
        userId: accounts.length === 1 ? accounts[0].id : null,
        phone: email ? null : phone,
        email: email ?? null,
        codeHash: otpHash(channel, code, audience),
        expiresAt: new Date(now + env.PASSWORD_OTP_TTL_MINUTES * 60_000),
      },
      { transaction: tx }
    );
  });

  let sent;
  if (email) {
    sent = await mailService
      .sendPasswordResetCode(accounts[0], code, env.PASSWORD_OTP_TTL_MINUTES)
      .then((info) => ({ ok: Boolean(info) }))
      .catch(() => ({ ok: false }));
  } else {
    sent = await smsService.send(
      toE164India(phone),
      `${code} is your Indian Health System password reset code. It expires in ${env.PASSWORD_OTP_TTL_MINUTES} minutes. Never share it with anyone.`
    );
  }
  if (!sent.ok) {
    await row.update({ consumedAt: new Date() });
    throw new ApiError(
      503,
      email
        ? "We couldn't send the email right now. Please try again in a few minutes."
        : "We couldn't send the SMS right now. Please try again in a few minutes.",
      { code: email ? ERROR_CODES.EMAIL_UNAVAILABLE : ERROR_CODES.SMS_UNAVAILABLE }
    );
  }
}

/**
 * Check a reset code. On success the code is burnt and exchanged for a normal
 * single-use reset token, which the client spends on POST /auth/reset-password
 * — so the password change itself (hashing, revoking every session) stays the
 * one existing implementation.
 * @returns {Promise<{ resetToken: string }>}
 */
async function verifyPasswordOtp({ phone, email, otp, audience = ROLES.PATIENT }) {
  const channel = email ? { email } : { phone };
  const invalid = () =>
    ApiError.badRequest("The code is incorrect or has expired. Please request a new one.", {
      code: ERROR_CODES.OTP_INVALID,
    });

  const row = await PasswordResetOtp.findOne({
    where: { ...channelWhere(channel), consumedAt: null },
    order: [["createdAt", "DESC"]],
  });
  if (!row || row.expiresAt.getTime() < Date.now() || row.attempts >= env.PASSWORD_OTP_MAX_ATTEMPTS) {
    throw invalid();
  }

  const presented = Buffer.from(otpHash(channel, otp, audience), "hex");
  const stored = Buffer.from(row.codeHash, "hex");
  if (presented.length !== stored.length || !crypto.timingSafeEqual(presented, stored)) {
    // Count the miss atomically; the last allowed miss burns the code.
    await PasswordResetOtp.update(
      {
        // consumed_at FIRST: MySQL applies SET left-to-right with updated values,
        // so this must read `attempts` before it is incremented.
        consumedAt: sequelize.literal(
          `IF(attempts + 1 >= ${Number(env.PASSWORD_OTP_MAX_ATTEMPTS)}, NOW(), consumed_at)`
        ),
        attempts: sequelize.literal("attempts + 1"),
      },
      { where: { id: row.id, consumedAt: null } }
    );
    throw invalid();
  }

  // Burn it — conditionally, so two racing requests can't both redeem one code.
  const [burnt] = await PasswordResetOtp.update(
    { consumedAt: new Date() },
    { where: { id: row.id, consumedAt: null } }
  );
  if (!burnt) throw invalid();

  if (!row.userId) {
    throw ApiError.conflict(
      "This mobile number is linked to more than one account. Please reset your password with your email address.",
      { code: ERROR_CODES.PHONE_SHARED }
    );
  }

  const raw = randomToken(32);
  await PasswordResetToken.create({
    userId: row.userId,
    tokenHash: sha256(raw),
    expiresAt: new Date(Date.now() + OTP_RESET_TOKEN_TTL_MINUTES * 60_000),
  });
  return { resetToken: raw };
}

/** Consume a reset token, set the new password, and kill all sessions. */
async function resetPassword({ token, password: plain }) {
  const row = await PasswordResetToken.findOne({ where: { tokenHash: sha256(token) } });
  if (!row || row.usedAt || row.expiresAt.getTime() < Date.now()) {
    throw ApiError.badRequest("Reset link is invalid or has expired", {
      code: ERROR_CODES.TOKEN_INVALID,
    });
  }

  const passwordHash = await password.hash(plain);

  await sequelize.transaction(async (tx) => {
    await User.update({ passwordHash }, { where: { id: row.userId }, transaction: tx });
    row.usedAt = new Date();
    await row.save({ transaction: tx });
  });

  // Reset invalidates every existing session.
  await tokenService.revokeAllForUser(row.userId);
}

/** Change password while logged in (local accounts). */
async function changePassword(userId, { currentPassword, newPassword }) {
  const user = await User.scope("withPassword").findByPk(userId);
  if (!user) throw ApiError.notFound("User not found");

  const matches = await password.compare(currentPassword, user.passwordHash);
  if (!matches) {
    throw ApiError.badRequest("Current password is incorrect", {
      code: ERROR_CODES.INVALID_CREDENTIALS,
    });
  }

  user.passwordHash = await password.hash(newPassword);
  await user.save();
  await tokenService.revokeAllForUser(userId); // force re-login elsewhere
}

/** Current user + role profile, in a single query via `include`. */
async function getMe(userId, role) {
  let user = await userService.findWithProfile(userId, role);
  if (!user) throw ApiError.notFound("User not found");

  // Defensive: if the role-specific profile row is missing (e.g. migration was
  // run after the user was created, or the profile creation failed silently),
  // create it now so the portal can load instead of 404-ing.
  if (role === ROLES.CLINIC && !user.clinicProfile) {
    await ClinicProfile.create({ userId: user.id, clinicName: user.name, phone: user.phone || null });
    user = await userService.findWithProfile(userId, role);
  } else if (role === ROLES.DOCTOR && !user.doctorProfile) {
    await DoctorProfile.create({ userId: user.id, registrationNumber: `PENDING-${user.id}` });
    user = await userService.findWithProfile(userId, role);
  } else if (role === ROLES.PATIENT && !user.patientProfile) {
    await PatientProfile.create({ userId: user.id });
    user = await userService.findWithProfile(userId, role);
  }

  return user;
}

/**
 * Update own profile. Only whitelisted fields are writable; the shared user
 * fields and the role-specific profile row are updated together atomically.
 */
async function updateProfile(userId, role, patch) {
  const userFields = {};
  if (patch.name !== undefined) userFields.name = patch.name;
  if (patch.phone !== undefined) userFields.phone = patch.phone;
  if (patch.avatarUrl !== undefined) userFields.profilePhotoUrl = patch.avatarUrl;

  await sequelize.transaction(async (tx) => {
    if (Object.keys(userFields).length) {
      await User.update(userFields, { where: { id: userId }, transaction: tx });
    }
    if (role === ROLES.DOCTOR && patch.doctor) {
      await DoctorProfile.update(patch.doctor, { where: { userId }, transaction: tx });
    }
    if (role === ROLES.PATIENT && patch.patient) {
      await PatientProfile.update(patch.patient, { where: { userId }, transaction: tx });
    }
    if (role === ROLES.CLINIC && patch.clinic) {
      await ClinicProfile.update(patch.clinic, { where: { userId }, transaction: tx });
    }
  });

  return getMe(userId, role);
}

module.exports = {
  registerLocal,
  loginLocal,
  loginAdmin,
  loginClinic,
  loginMedicineProvider,
  loginBloodBank,
  loginAmbulanceProvider,
  googleAuth,
  refresh,
  logout,
  forgotPassword,
  requestPasswordOtp,
  verifyPasswordOtp,
  resetPassword,
  changePassword,
  getMe,
  updateProfile,
};
