# API Reference - Auth, Public and Platform Endpoints

Conventions that apply to every table below:

* Paths are shown with the mount prefix already applied (`/api` = `API_PREFIX`). Auth column: the role(s) admitted by `authenticate` + `authorize(...)`; "Public" = no `authenticate`. Rate limiting: every route also passes the global limiter (reads by a signed-in user: `READ_RATE_LIMIT_MAX` per user; writes and anonymous traffic: `RATE_LIMIT_MAX`); route-specific limiters are named in the "Validation / middleware" column.
* "body: X" / "query: X" / "params: X" name the Joi schema applied (`validate`, `validateQuery` -> `req.validatedQuery`). Unknown keys are stripped, values coerced; failures are `422 VALIDATION_ERROR` with `details` per field.
* Success envelope `{ success, message, data }`; errors `{ error: { message, code, details? } }`. Binary/stream routes (PDF, files) return the bytes directly.
* The tables were generated from the router source by a static scan (route registration order preserved within each file). Route-ordering caveat: where a literal path (e.g. `/order`, `/count`) shares a prefix with a `/:id` route the literal one is declared first in the source.

Notes:

* `POST /api/auth/register` accepts the role list in [AUTHENTICATION-AND-AUTHORIZATION.md](AUTHENTICATION-AND-AUTHORIZATION.md); the blood-bank and ambulance registrations have their own bodies.
* The auth routes that are **not** guarded by `authenticate` are excluded from the blanket per-IP limiter (`OWN_LIMITER_ROUTES` in `rateLimiters.js`) because they carry their own limiter.
* `GET /api/files/:token/:name` is unauthenticated by design: the HMAC token (minted only inside an already-authorised response) is the credential. Forged token -> 404; expired -> `403 FILE_LINK_EXPIRED`.
* `POST /api/webhooks/razorpay` verifies `X-Razorpay-Signature` over the raw body (400 on mismatch, 503 if the webhook secret is empty); `POST /api/webhooks/livekit` verifies LiveKit's signed Authorization JWT and **always answers 200** (errors are logged only).
* `GET /api/doctors/:slug` is the public portfolio: slug = `dr-<name-kebab>-<userId>`; the trailing id is the real key (primary-key lookup). `/api/doctors/:id/sessions` and `/payment-options` take the numeric id (payment-options never exposes the QR itself).
* `GET /api/ambulances/*` public routes are in the Diagnostic/Blood/Ambulance file.

Also available without any router: `GET /api/health` -> `{"status":"ok"}`.


### `routes/auth.routes.js`

| Method | Path | Auth / role | Validation / middleware | Handler |
|---|---|---|---|---|
| POST | `/api/auth/register` | Public | body: schema.register; limiter: signupLimiter | `auth.register` |
| POST | `/api/auth/login` | Public | body: schema.loginLocal; limiter: authLimiter | `auth.login` |
| POST | `/api/auth/google` | Public | body: schema.google; limiter: authLimiter | `auth.google` |
| POST | `/api/auth/admin/login` | Public | body: schema.login; limiter: authLimiter | `adminAuth.login` |
| POST | `/api/auth/clinic/login` | Public | body: schema.login; limiter: authLimiter | `clinicAuth.login` |
| POST | `/api/auth/clinic/google` | Public | body: schema.google; limiter: authLimiter | `clinicAuth.google` |
| POST | `/api/auth/medicine/login` | Public | body: schema.login; limiter: authLimiter | `medicineAuth.login` |
| POST | `/api/auth/medicine/google` | Public | body: schema.google; limiter: authLimiter | `medicineAuth.google` |
| POST | `/api/auth/blood-bank/register` | Public | body: bloodBankSchema.register; limiter: signupLimiter | `bloodBank.register` |
| POST | `/api/auth/blood-bank/login` | Public | body: schema.login; limiter: authLimiter | `bloodBank.login` |
| POST | `/api/auth/ambulance/register` | Public | body: ambulanceSchema.register; limiter: signupLimiter | `ambulance.register` |
| POST | `/api/auth/ambulance/login` | Public | body: schema.login; limiter: authLimiter | `ambulance.login` |
| POST | `/api/auth/refresh` | Public | body: schema.refresh; limiter: refreshLimiter | `auth.refresh` |
| POST | `/api/auth/forgot-password` | Public | body: schema.forgotPassword; limiter: forgotPasswordLimiter | `auth.forgotPassword` |
| POST | `/api/auth/reset-password` | Public | body: schema.resetPassword; limiter: authLimiter | `auth.resetPassword` |
| POST | `/api/auth/forgot-password/otp` | Public | body: schema.requestPasswordOtp; limiter: forgotPasswordLimiter | `auth.requestPasswordOtp` |
| POST | `/api/auth/forgot-password/otp/verify` | Public | body: schema.verifyPasswordOtp; limiter: authLimiter | `auth.verifyPasswordOtp` |
| GET | `/api/auth/me` | any signed-in user | - | `auth.me` |
| PATCH | `/api/auth/profile` | any signed-in user | body: schema.updateProfile | `auth.updateProfile` |
| POST | `/api/auth/change-password` | any signed-in user | body: schema.changePassword | `auth.changePassword` |
| POST | `/api/auth/logout` | any signed-in user | body: schema.logout | `auth.logout` |

### `routes/contact.routes.js`

| Method | Path | Auth / role | Validation / middleware | Handler |
|---|---|---|---|---|
| POST | `/api/contact` | Public | body: schema.createMessage; limiter: contactLimiter | `contact.create` |

### `routes/doctorsPublic.routes.js`

| Method | Path | Auth / role | Validation / middleware | Handler |
|---|---|---|---|---|
| GET | `/api/specializations` | Public | - | `publicDoctor.listSpecializations` |
| GET | `/api/sub-specializations` | Public | - | `publicDoctor.listSubSpecializations` |
| GET | `/api/languages` | Public | - | `publicDoctor.listLanguages` |
| GET | `/api/insurances` | Public | - | `publicDoctor.listInsurances` |
| GET | `/api/doctors` | Public | query: schema.listDoctors | `publicDoctor.listDoctors` |
| GET | `/api/doctors/map` | Public | - | `publicDoctor.listMapDoctors` |
| GET | `/api/doctors/:id/sessions` | Public | - | `session.publicSessions` |
| GET | `/api/doctors/:id/payment-options` | Public | params: schema.doctorIdParam | `publicDoctor.paymentOptions` |
| GET | `/api/doctors/:slug/related` | Public | - | `publicDoctor.related` |
| GET | `/api/doctors/:slug` | Public | - | `publicDoctor.getBySlug` |

### `routes/file.routes.js`

| Method | Path | Auth / role | Validation / middleware | Handler |
|---|---|---|---|---|
| GET | `/api/files/:token/:name` | Public | - | `file.open` |

### `routes/webhook.routes.js`

| Method | Path | Auth / role | Validation / middleware | Handler |
|---|---|---|---|---|
| POST | `/api/webhooks/razorpay` | Public | - | `paymentWebhook.handle` |
| POST | `/api/webhooks/livekit` | Public | - | `videoWebhook.receive` |

