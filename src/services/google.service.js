/**
 * Verifies a Google ID token (the `credential` the frontend gets from the
 * Google Identity button). We check the token's `aud` matches our own
 * GOOGLE_CLIENT_ID — this is what stops someone replaying a token minted for a
 * different app — and that the email is verified before we trust it.
 */
const { OAuth2Client } = require("google-auth-library");
const env = require("../config/env");
const ApiError = require("../utils/ApiError");

const client = new OAuth2Client(env.GOOGLE_CLIENT_ID);

/**
 * @returns {Promise<{googleId, email, name, picture}>}
 */
exports.verify = async (credential) => {
  if (!env.GOOGLE_CLIENT_ID) {
    throw ApiError.badRequest("Google sign-in is not configured on this server");
  }

  let ticket;
  try {
    ticket = await client.verifyIdToken({
      idToken: credential,
      audience: env.GOOGLE_CLIENT_ID, // rejects tokens issued for other apps
    });
  } catch {
    throw ApiError.unauthorized("Invalid Google credential");
  }

  const p = ticket.getPayload();
  if (!p?.email_verified) {
    throw ApiError.unauthorized("Google email is not verified");
  }

  return { googleId: p.sub, email: p.email, name: p.name, picture: p.picture };
};
