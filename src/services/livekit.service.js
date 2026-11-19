/**
 * The ONE module that talks to the LiveKit SDK (docs/video-consultation). It
 * mints short-lived, room-scoped join tokens and verifies inbound webhooks.
 *
 * Lazy + gracefully-disabled, exactly like paymentService.getClient(): with
 * blank keys the API still boots and every other feature works — the token
 * endpoint just returns a clean 503 (VIDEO_NOT_CONFIGURED) instead of crashing.
 *
 * Only LIVEKIT_URL (the public wss:// SFU URL) is ever sent to the client; the
 * API key/secret never leave the backend — they only sign tokens and verify
 * webhook signatures here.
 */
const { AccessToken, WebhookReceiver } = require("livekit-server-sdk");
const env = require("../config/env");
const ApiError = require("../utils/ApiError");
const { ERROR_CODES } = require("../config/constants");

/** Whether video calling is usable (all three keys present). */
function isEnabled() {
  return Boolean(env.LIVEKIT_URL && env.LIVEKIT_API_KEY && env.LIVEKIT_API_SECRET);
}

/** Throw a clean 503 when LiveKit isn't configured — never a boot crash. */
function assertEnabled() {
  if (!isEnabled()) {
    throw new ApiError(503, "Video calling isn't configured yet", {
      code: ERROR_CODES.VIDEO_NOT_CONFIGURED,
    });
  }
}

/** The public SFU URL handed to the client (== NEXT_PUBLIC_LIVEKIT_URL). */
const url = () => env.LIVEKIT_URL;

/** Deterministic, unstored room name — always derivable from the booking id. */
const roomName = (bookingId) => `consult-${bookingId}`;

/** Inverse of roomName: "consult-<id>" → Number(id), or null if it doesn't match. */
function bookingIdFromRoom(room) {
  const m = /^consult-(\d+)$/.exec(String(room || ""));
  return m ? Number(m[1]) : null;
}

/**
 * Mint a short-lived room-scoped join token.
 * @param {object} p
 * @param {string} p.room        the LiveKit room (consult-<bookingId>)
 * @param {string} p.identity    unique participant id ("user:<id>")
 * @param {string} p.name        display name shown on the tile
 * @param {object} p.metadata    small JSON blob (role, bookingId) — stringified
 * @param {number} p.ttlSeconds  token lifetime (bounded by the join window)
 * @returns {Promise<string>}    the signed LiveKit JWT (the only credential the client sees)
 */
async function mintAccessToken({ room, identity, name, metadata, ttlSeconds }) {
  assertEnabled();
  const at = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, {
    identity,
    name,
    metadata: JSON.stringify(metadata ?? {}),
    ttl: ttlSeconds,
  });
  at.addGrant({
    roomJoin: true,
    room,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });
  return at.toJwt(); // async in livekit-server-sdk v2 — the caller awaits
}

/**
 * Verify + parse an inbound LiveKit webhook. `body` is the RAW request body
 * string and `authHeader` the request's Authorization header (a JWT LiveKit
 * signs with the API secret). Throws on a bad signature.
 * @returns {Promise<import("livekit-server-sdk").WebhookEvent>}
 */
async function receiveWebhook(body, authHeader) {
  assertEnabled();
  const receiver = new WebhookReceiver(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET);
  return receiver.receive(body, authHeader);
}

module.exports = {
  isEnabled,
  assertEnabled,
  url,
  roomName,
  bookingIdFromRoom,
  mintAccessToken,
  receiveWebhook,
};
