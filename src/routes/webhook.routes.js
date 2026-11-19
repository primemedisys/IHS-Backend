/**
 * Public webhook routes (docs/booking-payments). No app auth — each handler
 * verifies a provider HMAC over the raw body instead. Mounted at `/webhooks`
 * so the final path is `POST /api/webhooks/razorpay`.
 */
const router = require("express").Router();

const paymentWebhook = require("../controllers/paymentWebhook.controller");
const videoWebhook = require("../controllers/videoWebhook.controller");

router.post("/razorpay", paymentWebhook.handle);
// LiveKit room lifecycle → video_sessions (docs/video-consultation). Verified by
// LiveKit's signed Authorization JWT over the raw body, inside the controller.
router.post("/livekit", videoWebhook.receive);

module.exports = router;
