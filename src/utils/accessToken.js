/**
 * The ONE place an access JWT is verified. Used by the HTTP `authenticate`
 * middleware and by the Socket.IO handshake, so both trust exactly the same
 * tokens. Throws on a missing, malformed, expired or forged token.
 *
 * @returns {{ id: string, role: string, email: string, exp: number|null }}
 */
const jwt = require("jsonwebtoken");
const env = require("../config/env");

function verifyAccessToken(token) {
  const payload = jwt.verify(token, env.JWT_ACCESS_SECRET);
  return {
    id: payload.sub,
    role: payload.role,
    email: payload.email,
    exp: typeof payload.exp === "number" ? payload.exp : null,
  };
}

module.exports = { verifyAccessToken };
