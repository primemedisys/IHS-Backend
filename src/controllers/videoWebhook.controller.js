/**
 * LiveKit webhook receiver (docs/video-consultation). Public + unauthenticated —
 * trust comes from LiveKit's signed Authorization JWT over the RAW body (captured
 * by app.js's json `verify`, which also matches `application/webhook+json`).
 *
 * Best-effort by design: it ALWAYS answers 200 (a bad signature or an event for
 * an unknown room is just logged and ignored) so LiveKit never retry-storms, and
 * the live call — which relies on client-side presence, not this table — is never
 * affected by a webhook hiccup.
 */
const asyncHandler = require("../utils/asyncHandler");
const livekitService = require("../services/livekit.service");
const videoSessionService = require("../services/videoSession.service");

exports.receive = asyncHandler(async (req, res) => {
  try {
    const event = await livekitService.receiveWebhook(
      req.rawBody ? req.rawBody.toString("utf8") : "",
      req.headers.authorization
    );
    await videoSessionService.applyWebhookEvent(event);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[video] livekit webhook rejected:", err.message);
  }
  return res.status(200).json({ received: true });
});
