# Backend Plan — Clinical Notes

**App:** `backend/` (Node/Express/Sequelize). **Legend:** 🟢 existed · 🟡 extended · 🔵 new.

All doctor FKs point at `doctor_profiles.user_id` (== `users.id` for that doctor), exactly like `bookings`/`prescriptions`.

---

## 1. `db/migrations/009_clinical_notes.sql` (🔵)

```sql
CREATE TABLE IF NOT EXISTS clinical_notes (
    id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    patient_id        BIGINT UNSIGNED NOT NULL,   -- users.id (the patient)
    doctor_id         BIGINT UNSIGNED NOT NULL,   -- doctor_profiles.user_id (author)
    booking_id        BIGINT UNSIGNED NULL,       -- the appointment it was written from
    complaints        TEXT NULL,                  -- c/o
    on_examination    TEXT NULL,                  -- o/e
    history_medical   TEXT NULL,                  -- h/o medical
    history_surgical  TEXT NULL,                  -- h/o surgical
    diagnosis         TEXT NULL,
    treatment         TEXT NULL,
    created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_clinical_notes_patient (patient_id, created_at),
    INDEX idx_clinical_notes_booking (booking_id),
    CONSTRAINT fk_clinical_notes_patient FOREIGN KEY (patient_id) REFERENCES users(id)                ON DELETE CASCADE,
    CONSTRAINT fk_clinical_notes_doctor  FOREIGN KEY (doctor_id)  REFERENCES doctor_profiles(user_id) ON DELETE CASCADE,
    CONSTRAINT fk_clinical_notes_booking FOREIGN KEY (booking_id) REFERENCES bookings(id)             ON DELETE SET NULL
) ENGINE=InnoDB;
```

`ON DELETE SET NULL` on `booking_id`: a note outlives the appointment it was taken from (the patient history is what matters). `CASCADE` on patient/doctor mirrors the rest of the schema. The runner (`db/migrate.js`) tracks applied files in `_migrations`, so `npm run migrate` applies **only 009**.

## 2. `models/clinicalNote.model.js` (🔵)

`sequelize.define("ClinicalNote", { … }, { tableName: "clinical_notes", timestamps: false })`. Global `underscored: true` maps `onExamination → on_examination`, `historyMedical → history_medical`, etc. `createdAt` is explicit (`DataTypes.NOW` default).

## 3. `models/index.js` (🟡)

```js
User.hasMany(ClinicalNote, { foreignKey: "patientId", as: "clinicalNotes", onDelete: "CASCADE" });
ClinicalNote.belongsTo(User, { foreignKey: "patientId", as: "patient" });
ClinicalNote.belongsTo(User, { foreignKey: "doctorId", as: "author" });  // doctor_id == users.id → join for the name
ClinicalNote.belongsTo(Booking, { foreignKey: "bookingId", as: "booking" });
```
Plus `const ClinicalNote = require("./clinicalNote.model")` and adding it to `module.exports`.

## 4. `validators/clinicalNote.validator.js` (🔵)

`createNote` — six `Joi.string().trim().max(4000).allow("", null)` fields, then a `.custom` that requires **at least one** non-empty field (`"Add at least one detail before saving the note."`). Append-only, so no update schema.

## 5. `services/clinicalNote.service.js` (🔵)

The gate + the two operations:

```js
const UNLOCKED = [BOOKING_STATUS.CONFIRMED, BOOKING_STATUS.COMPLETED];

async function assertBookingUnlocked(doctorId, bookingId) {
  const booking = await Booking.findOne({ where: { id: bookingId, doctorId }, attributes: ["id", "patientId", "status"] });
  if (!booking) throw ApiError.notFound("Booking not found");                 // not owned / unknown → 404
  if (!UNLOCKED.includes(booking.status)) throw ApiError.forbidden("Patient details unlock once the booking is confirmed"); // 403
  return booking;
}

listForBookingPatient(doctorId, bookingId)  // → ClinicalNote.findAll WHERE patient_id, include author, order created_at DESC
createForBookingPatient(doctorId, bookingId, data)  // → create {patientId, doctorId, bookingId, 6 fields}, return with author
```

Ownership is a WHERE clause, never a post-load `if` — another doctor's booking simply 404s (mirrors `clinic.service`).

## 6. `controllers/doctorBooking.controller.js` (🟡)

Thin: `listClinicalNotes` → `ok(res, rows.map(serializeClinicalNote))`; `addClinicalNote` → `created(res, serializeClinicalNote(note))`. (`created` added to the `apiResponse` import.)

## 7. `routes/doctorBooking.routes.js` (🟡)

```js
router.get("/bookings/:id/clinical-notes", ...guard, booking.listClinicalNotes);
router.post("/bookings/:id/clinical-notes", ...guard, validate(clinicalNoteSchema.createNote), booking.addClinicalNote);
```
`guard = [authenticate, authorize('doctor'), resolveDoctorId('self')]` — identical to the other booking routes, so `req.doctorId` is the token's user id.

## 8. `utils/serializers.js` (🟡)

```js
serializeClinicalNote(n) → {
  id: String(id), date: createdAt.toISOString(), doctorName: author?.name ?? null,
  complaints, onExamination, historyMedical, historySurgical, diagnosis, treatment  // each ?? null
}
```

## 9. Why no other changes

Reuses the existing booking model, ownership middleware (`resolveDoctorId`), error/response helpers, and the confirmed/completed status constants. No new config, rate limiter, or swagger changes required (swagger docs optional follow-up).
