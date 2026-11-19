# Backend — Contact feature (public submit + admin inbox) (`backend/src/`)

A new **`contact`** feature, built to the layered convention (`route → rateLimiter/validate → authenticate?/authorize? → controller → service → model`; validation is Joi-only; controllers stay thin; output goes through a serializer; responses use the standard envelope). Two surfaces: a **public** submit endpoint and an **admin-guarded** inbox (list + mark-handled). **Legend:** 🟢 exists · 🟡 extend · 🔵 new.

---

## 1. Schema 🔵 — `db/migrations/008_contact_messages.sql` + `models/contactMessage.model.js`

`contact_messages` — a public submission needs no account and no FK.

| Column | Type | Notes |
|---|---|---|
| `id` | `BIGINT UNSIGNED` PK AI | |
| `name` | `VARCHAR(150)` NOT NULL | |
| `email` | `VARCHAR(255)` NOT NULL | |
| `phone` | `VARCHAR(30)` NULL | optional on the form |
| `message` | `TEXT` NOT NULL | |
| `ip_address` | `VARCHAR(45)` NULL | spam triage only — **never** serialized to any client (not even admin) |
| `handled` | `TINYINT(1)` NOT NULL DEFAULT 0 | admin-inbox "followed-up?" flag |
| `created_at` | `DATETIME` DEFAULT `CURRENT_TIMESTAMP` | |

Indexes: `idx_contact_created (created_at)`, `idx_contact_handled (handled)`. Migration is `CREATE TABLE IF NOT EXISTS` (idempotent, forward-only, tracked in `_migrations`). The model uses the project define-defaults (`underscored`, `freezeTableName`); registered + exported in `models/index.js` 🟡.

## 2. Validator 🔵 — `validators/contact.validator.js`

```js
createMessage  = { name≥2, email(lowercased), phone? (""|str≤30), message 20..5000 }  // mirrors the frontend zod schema
listMessages   = { page≥1 (def 1), pageSize 1..100 (def 20), handled? boolean }       // admin inbox query (validateQuery)
updateMessage  = { handled: boolean (required) }                                        // admin mark-handled body
```

`createMessage`/`updateMessage` run via `validate(...)`; `listMessages` via `validateQuery(...)` (Express 5 `req.query` is read-only → coerced value lands on `req.validatedQuery`).

## 3. Service 🔵 — `services/contact.service.js`

- **`createMessage({ name, email, phone, message, ipAddress })`** — `ContactMessage.create(...)` (empty `phone`/`ipAddress` → `null`); then fires `mailService.sendContactNotification(...)` **without awaiting** (`.catch` logs), so a mail hiccup can't fail the submit. Returns the record.
- **`listMessages({ page, pageSize, handled })`** — `findAndCountAll` ordered `created_at DESC, id DESC`, `limit`/`offset` from the page (no full-table load). Optional `handled` `where`. Returns `{ data, page, pageSize, total, totalPages }`.
- **`setHandled(id, handled)`** — `findByPk` → `404 NOT_FOUND` if missing (`ApiError.notFound`), else set `handled` + save. Returns the record.

## 4. Controllers 🔵 — `controllers/contact.controller.js` (public) · `controllers/adminContact.controller.js` (admin)

- **Public `create`** — thin `asyncHandler`: validated body **+ `req.ip`** → service → `created(res, serializeContactMessage(record), "Message received")` (`201`).
- **Admin `list`** — `contactService.listMessages(req.validatedQuery)` → `ok(res, { ...result, data: result.data.map(serializeContactMessageForAdmin) }, "Contact messages")`.
- **Admin `update`** — `contactService.setHandled(req.params.id, req.body.handled)` → `ok(res, serializeContactMessageForAdmin(record), "Message updated")`.

## 5. Routes + mount 🔵🟡 — `routes/contact.routes.js`, `routes/adminContact.routes.js`, `routes/index.js`

```js
// contact.routes.js (public)
router.post("/", contactLimiter, validate(schema.createMessage), contact.create);          // → POST /api/contact

// adminContact.routes.js (guard = [authenticate, authorize(ROLES.ADMIN)])
router.get  ("/contact-messages",     ...guard, validateQuery(schema.listMessages), adminContact.list);
router.patch("/contact-messages/:id", ...guard, validate(schema.updateMessage),     adminContact.update);
```

Mounted: `router.use("/contact", contactRoutes)` and `router.use("/admin", adminContactRoutes)` → `GET/PATCH /api/admin/contact-messages`.

## 6. Rate limiter 🟡 + env 🟡 — `middlewares/rateLimiters.js`, `config/env.js`

The public write is a spam target, so it gets its **own** limiter (separate store from `authLimiter`, so contact traffic never eats a visitor's login attempts): `contactLimiter = rateLimit({ windowMs, max: env.CONTACT_RATE_LIMIT_MAX, ... })`. `windowMs` reuses `RATE_LIMIT_WINDOW_MIN` (15 min); `CONTACT_RATE_LIMIT_MAX` added to the Joi env schema (default **5**). Over-limit → `429 RATE_LIMITED`. *(The admin inbox rides the global limiter + admin auth — no extra cap.)*

## 7. Mail 🟡 — `services/mail.service.js` + `templates/emails/contact-message.html` 🔵

`sendContactNotification({ name, email, phone, message })` renders the new template and sends **to `env.ADMIN_EMAIL`** with **`replyTo` = the sender** (a reply goes straight back to the visitor). `send(...)` extended to forward `replyTo`. In dev with no SMTP, the existing Ethereal fallback logs a preview URL. Best-effort by design (§3).

## 8. Serializers 🟡 — `utils/serializers.js`

- `serializeContactMessage(m)` → `{ id, name, email, createdAt }` (the sender's receipt).
- `serializeContactMessageForAdmin(m)` → `{ id, name, email, phone, message, handled, createdAt }` — the inbox view. **Both** omit `ipAddress` (kept internal for triage).

## 9. Swagger 🟡 — `config/swagger.js`

Tag **"Contact (public)"**: `POST /contact` (body + `201`/`422`/`429`), `GET /admin/contact-messages` (bearer; `page`/`pageSize`/`handled`; paginated envelope of `ContactMessage`), `PATCH /admin/contact-messages/{id}` (bearer; `{ handled }`; `200`/`404`). New `ContactMessage` component schema added.

---

## 10. Build order (backend)

1. `contactMessage.model.js` + `008_contact_messages.sql` → register in `models/index.js` → `npm run migrate`.
2. `contact.validator.js` (3 schemas) → `contact.service.js` (3 fns) → `contact.controller.js` + `adminContact.controller.js` → routes → mount.
3. `contactLimiter` + `CONTACT_RATE_LIMIT_MAX`; `sendContactNotification` + template + `replyTo`; serializers; swagger.

## 11. Testing checklist (backend)

- [x] `npm run migrate` applies `008` (idempotent; earlier migrations skipped).
- [x] `POST /api/contact` valid → `201` `{ data:{ id, name, email, createdAt } }`; row present in `contact_messages`.
- [x] Invalid body → `422` with `details.{name,email,message}`.
- [x] `GET /api/admin/contact-messages` **without** a token → `401 UNAUTHENTICATED` (mounted + guarded, not `404`).
- [ ] With an admin token: `GET` returns newest-first paginated `{ data, page, pageSize, total, totalPages }`; `?handled=false` filters; `PATCH :id { handled:true }` flips the flag; `PATCH` unknown id → `404`.
- [ ] > `CONTACT_RATE_LIMIT_MAX` submissions from one IP within the window → `429`.
- [ ] Admin notification arrives (or Ethereal preview URL logged in dev); reply-to is the sender.
