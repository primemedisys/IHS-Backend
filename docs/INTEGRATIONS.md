# Integrations

Every third-party dependency is isolated behind **one** backend module and degrades gracefully when unconfigured. No credential is ever sent to a client except the two public values noted.

| Integration | Module | Config | If not configured | Status |
|---|---|---|---|---|
| Razorpay (online consultation payment) | `services/payment.service.js` | `RAZORPAY_KEY_ID/SECRET/WEBHOOK_SECRET` | dev: booking auto-confirms (bypass); production: keys required at boot | Implemented (verified) |
| LiveKit (video) | `services/livekit.service.js`, `videoSession.service.js` | `LIVEKIT_URL/API_KEY/API_SECRET` | `503 VIDEO_NOT_CONFIGURED` on token endpoints; production: required | Implemented (verified) |
| Cloudinary | `services/cloudinaryStorage.service.js`, `config/cloudinary.js` | `CLOUDINARY_*` | only needed when `STORAGE_DRIVER=cloudinary` | Implemented (verified) |
| AWS S3 | `services/upload.service.js` | `S3_*`, `AWS_*` | only when `STORAGE_DRIVER=s3` | Partially implemented (no signed-link model, see storage doc) |
| SMTP / Ethereal | `services/mail.service.js` | `SMTP_*`, `MAIL_FROM` | dev: Ethereal; production: no e-mail, loud error | Implemented (verified) |
| Twilio SMS | `services/sms.service.js` | `SMS_PROVIDER=twilio`, `TWILIO_ACCOUNT_SID/AUTH_TOKEN/SMS_FROM` | `none` -> OTP endpoint 503 | Implemented (verified; REST via `fetch`) |
| Twilio WhatsApp | `services/whatsapp.service.js` | `WHATSAPP_PROVIDER`, `TWILIO_*`, `TWILIO_CONTENT_TEMPLATE_SID` | default `mock` (logs) | Partially implemented - requires the undeclared `twilio` npm package |
| Google sign-in | `services/google.service.js` | `GOOGLE_CLIENT_ID` | endpoint answers 400 "not configured" | Implemented (verified) |
| Puppeteer / Chromium | `services/prescriptionPdf.service.js` | `PDF_*`, `PUPPETEER_EXECUTABLE_PATH` | `PDF_ENGINE=none` -> 503 on PDF routes | Implemented (verified) |
| Swagger UI | `app.js`, `config/swagger*.js` | `API_DOCS_ENABLED` | off in production | Implemented (verified) |
| Socket.IO | `realtime/socket.js` | `CLIENT_URL` | n/a | Implemented (verified) |
| Google Maps | not used by the backend | - | - | n/a (clients only; distance maths in `utils/geo.js` and SQL) |

## 1. Razorpay

* `createOrder(booking)` creates an order (amount = the server-computed fee x 100 in paise, currency INR; the receipt is `booking_<id>` and notes carry the booking id) and the response to the client contains the order plus **only** `RAZORPAY_KEY_ID`.
* Confirm paths (both call `confirmPaid`, which is a no-op if the payment is already `success`):
  1. `POST /api/patient/bookings/:id/pay/verify` with `{ razorpayOrderId, razorpayPaymentId, razorpaySignature }`: order id must equal the booking's stored order id; signature = HMAC-SHA256(`orderId|paymentId`, key secret), constant-time compared.
  2. `POST /api/webhooks/razorpay`: HMAC-SHA256 of the raw body with the webhook secret (header `x-razorpay-signature`); only `payment.captured` and `order.paid` confirm. Dashboard setup (from `.env.example`): webhook URL `/api/webhooks/razorpay`, events `payment.captured` + `order.paid`.
* On success: `applySplit` stores `commission_amount` (15 %, `PLATFORM_COMMISSION_PCT`) and `doctor_payout_amount`; video consults get a room + `meetLink`; the doctor is notified.
* **Not implemented:** refunds/cancellation payouts (no code sets `refunded` / `refund_amount`; analytics read them), payouts to doctors (the split is bookkeeping only), payment retry/expiry beyond the 10-minute hold sweep.
* A different gateway for medicine orders does not exist: medicine "online" payments are simulated (`gateway = simulated`).

## 2. LiveKit

Rooms are named `consult-<bookingId>` (unstored, derivable). `mintAccessToken` grants `roomJoin, canPublish, canSubscribe, canPublishData` for one room, identity `user:<id>`, TTL bounded by the join window (10 min before start to 30 min after end). The webhook (`application/webhook+json`, signed JWT in `Authorization`) updates `video_sessions` (`room_started`/join/`room_finished` -> `live`/`ended`, durations). The SFU URL returned to clients must equal their `NEXT_PUBLIC_LIVEKIT_URL`. A local open-source LiveKit server can be used in development (see the `.env.example` comments). Mobile apps open the website call page in a WebView (client-side detail, outside this backend).

## 3. Storage providers
See [FILE-STORAGE-AND-UPLOADS.md](FILE-STORAGE-AND-UPLOADS.md).

## 4. E-mail
Templates in `src/templates/emails/` (`reset-password`, `password-reset-code`, `verify-email`, `prescription-ready`, `follow-up-reminder`, `contact-message`) rendered with a tiny `{{key}}` / `{{#if key}}` engine that HTML-escapes every value. Senders actually called in code: password reset link (`auth.service`), contact notification to `ADMIN_EMAIL` (`contact.service`, best effort, never blocks the response), prescription ready (`prescription.service`), follow-up reminder (`notificationService`), password reset code by e-mail (`auth.service`). `sendVerifyEmail` exists but has no caller. A doctor's reset link points at `DOCTOR_APP_URL` when set, otherwise the first `CLIENT_URL`.

## 5. SMS and WhatsApp
SMS is used only for password-reset OTPs (message: "<code> is your Indian Health System password reset code. It expires in N minutes. Never share it with anyone."). `toE164India` converts the stored 10-digit number to `+91...`; logs mask the number. WhatsApp is used only for follow-up reminders through Twilio's Content API with an approved template.

## 6. Swagger / OpenAPI
`config/swagger.js` (3,214 lines) is a plain JS object; module files `swagger.{ambulance,bloodBank,clinicalCoding,doctorAnalytics,emr,patientMedicine,paymentQr,pharmacy,recordAccess}.js` export `*Paths` / `*Tags` merged into it (the diagnostic and medicine paths are merged from inside `swagger.js`). Server URL = `API_PREFIX`. Enums are imported from `config/*` so docs cannot drift from validators. It is documentation only (no request validation is derived from it) and can lag the routers: use the generated tables in this folder as the route list.

## 7. Webhook endpoints summary

| Endpoint | Signature | Response |
|---|---|---|
| `POST /api/webhooks/razorpay` | HMAC-SHA256 raw body, secret `RAZORPAY_WEBHOOK_SECRET` | 200 `{received:true}` on handled/ignored events; 400 invalid signature; 503 secret not set |
| `POST /api/webhooks/livekit` | LiveKit signed JWT | always 200 |
