/**
 * The single owner of token issuing, refresh rotation, and revocation. Nothing
 * else in the app signs a JWT or touches the refresh_tokens table directly.
 *
 * Access token  = short-lived JWT (stateless, no DB hit on normal requests).
 * Refresh token = opaque random string; only its SHA-256 hash is stored, so it
 *                 can be rotated, revoked, and reuse-detected.
 */
const jwt = require("jsonwebtoken");
const { Op, fn, col } = require("sequelize");
const env = require("../config/env");
const { RefreshToken, User } = require("../models");
const { randomToken, sha256 } = require("../utils/tokens");
const ApiError = require("../utils/ApiError");
const { ERROR_CODES } = require("../config/constants");

/** Sign a stateless access token. Claims are kept minimal on purpose. */
function signAccessToken(user) {
  return jwt.sign(
    { sub: String(user.id), role: user.role, email: user.email },
    env.JWT_ACCESS_SECRET,
    { expiresIn: env.JWT_ACCESS_TTL }
  );
}

/** ms since epoch for "now + N days", used for the refresh expiry column. */
function refreshExpiryDate() {
  const d = new Date();
  d.setDate(d.getDate() + env.JWT_REFRESH_TTL_DAYS);
  return d;
}

/**
 * Issue a fresh access+refresh pair and persist the (hashed) refresh row.
 * @returns {Promise<{accessToken: string, refreshToken: string}>}
 */
async function issueTokens(user, req) {
  const accessToken = signAccessToken(user);

  const raw = randomToken(48);
  await RefreshToken.create({
    userId: user.id,
    tokenHash: sha256(raw),
    expiresAt: refreshExpiryDate(),
    userAgent: req?.headers?.["user-agent"]?.slice(0, 255) ?? null,
    ipAddress: req?.ip ?? null,
  });

  return { accessToken, refreshToken: raw };
}

/**
 * How long after rotation a token may be presented again WITHOUT being treated
 * as theft.
 *
 * Two browser tabs share one refresh token (same localStorage). When the access
 * token expires they both call /auth/refresh within milliseconds of each other:
 * the first rotates and revokes the old row, the second then presents a token
 * that is already revoked. That is a benign RACE, not an attacker — but the
 * old code could not tell them apart and ran `revokeAllForUser`, destroying
 * every session the user had. Symptom: the app freezes mid-use and a reload
 * lands on the sign-in screen, for no reason the user can see.
 *
 * This app makes that race routine, not rare: the doctor flow deliberately
 * opens extra tabs (treatment history, patient details, the video call), and
 * each one refreshes on its own schedule.
 *
 * Real theft still gets caught. A stolen token is replayed minutes or hours
 * later — well outside this window — and still nukes the family.
 */
const REFRESH_REUSE_GRACE_MS = 30_000;

/**
 * Rotate a refresh token (README.md §3). Detects reuse of an already-rotated
 * token and, when it is genuinely suspicious, revokes the whole family.
 * @returns {Promise<{user: User, tokens: {accessToken, refreshToken}}>}
 */
async function rotateRefreshToken(rawToken, req) {
  const row = await RefreshToken.findOne({ where: { tokenHash: sha256(rawToken) } });

  if (!row) {
    throw ApiError.unauthorized("Invalid refresh token", { code: ERROR_CODES.TOKEN_INVALID });
  }

  if (row.revokedAt) {
    const sinceRotation = Date.now() - new Date(row.revokedAt).getTime();
    // Presented long after it was rotated → assume theft, kill every session.
    if (sinceRotation > REFRESH_REUSE_GRACE_MS) {
      await revokeAllForUser(row.userId);
      throw ApiError.unauthorized("Refresh token reuse detected", {
        code: ERROR_CODES.TOKEN_INVALID,
      });
    }
    // Inside the window → the losing side of a concurrent refresh. Fall
    // through and mint a pair for it, exactly as if it had arrived first.
    // Revoking here would log the user out of every tab they have open.
  }

  if (row.expiresAt.getTime() < Date.now()) {
    throw ApiError.unauthorized("Refresh token expired", { code: ERROR_CODES.TOKEN_INVALID });
  }

  const user = await User.findByPk(row.userId);
  if (!user || !user.isActive) {
    throw ApiError.unauthorized("Account is not active", { code: ERROR_CODES.UNAUTHENTICATED });
  }

  // Mark the presented token used, then mint a new pair. Guarded so a
  // grace-window replay doesn't move the original rotation timestamp forward —
  // otherwise a token could be replayed indefinitely, 30s at a time, and the
  // theft detection above would never fire.
  if (!row.revokedAt) {
    row.revokedAt = new Date();
    await row.save();
  }

  const tokens = await issueTokens(user, req);
  return { user, tokens };
}

/**
 * An EXPLICIT revocation (logout, password reset/change, theft) must be final.
 * `revokedAt` alone isn't: it is also the "rotated" stamp, and a token rotated
 * under 30s ago is deliberately replayable (REFRESH_REUSE_GRACE_MS). So these
 * paths also expire the row, which rotateRefreshToken refuses even inside the
 * grace window. COALESCE keeps an earlier rotation time intact, so reuse
 * detection still measures from the real rotation.
 */
const revokedForGood = () => ({
  revokedAt: fn("COALESCE", col("revoked_at"), fn("NOW")),
  expiresAt: new Date(),
});

/** Logout: revoke a single presented refresh token (no error if unknown). */
async function revokeRefreshToken(rawToken) {
  if (!rawToken) return;
  await RefreshToken.update(revokedForGood(), {
    where: { tokenHash: sha256(rawToken), expiresAt: { [Op.gt]: new Date() } },
  });
}

/**
 * Revoke every refresh token of a user that could still mint a session (reset /
 * theft) — including ones rotated inside the grace window, which `revokedAt:
 * null` alone would miss.
 */
async function revokeAllForUser(userId) {
  await RefreshToken.update(revokedForGood(), {
    where: { userId, expiresAt: { [Op.gt]: new Date() } },
  });
}

module.exports = {
  signAccessToken,
  issueTokens,
  rotateRefreshToken,
  revokeRefreshToken,
  revokeAllForUser,
};
