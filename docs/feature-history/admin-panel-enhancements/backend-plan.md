# Backend Plan — Admin Panel Enhancements

**Date:** 04-09-2026
**Scope:** Backend changes to support admin panel navigation, filtering, appointments, and diagnosis display.

---

## 1. Overview

The backend changes are additive and minimal:
- Enhanced registry search with multi-criteria filtering (doctors and patients)
- Conditions data added to patient list response
- City/state added to doctor list response (via clinics join)
- New admin bookings endpoint for appointment visibility

**No database migrations required.** All data already exists in the schema.

---

## 2. Enhanced Doctor Registry Search

### Current Behavior
`GET /admin/registry/doctors?q=search_term` searches `users.name`, `users.email`, `users.phone` via `Op.like`.

### New Behavior
`GET /admin/registry/doctors?q=&city=&state=&minExperience=&maxExperience=`

All params are optional. When provided, results must match ALL selected criteria (AND logic).

### Files to Modify

**`backend/src/services/adminRegistry.service.js`**

Current `listDoctors` function:
```js
function listDoctors({ q } = {}) {
  return User.findAll({
    where: { role: ROLES.DOCTOR, ...searchWhere(q) },
    include: [{ model: DoctorProfile, as: "doctorProfile", attributes: [...] }],
    order: [["createdAt", "DESC"], ["id", "DESC"]],
  });
}
```

Enhanced version:
```js
function listDoctors({ q, city, state, minExperience, maxExperience } = {}) {
  const where = { role: ROLES.DOCTOR, ...searchWhere(q) };
  const doctorWhere = {};
  if (city) doctorWhere[Op.or] = [{ "$clinic.city$": city }, { "$clinic.city$": { [Op.like]: `%${city}%` } }];
  if (state) doctorWhere[Op.or] = [{ "$clinic.state$": state }, { "$clinic.state$": { [Op.like]: `%${state}%` } }];
  if (minExperience) doctorWhere.experienceYears = { ...doctorWhere.experienceYears, [Op.gte]: Number(minExperience) };
  if (maxExperience) doctorWhere.experienceYears = { ...doctorWhere.experienceYears, [Op.lte]: Number(maxExperience) };

  return User.findAll({
    where,
    include: [
      { model: DoctorProfile, as: "doctorProfile", attributes: [...], required: Object.keys(doctorWhere).length > 0 },
      { model: Clinic, as: "clinic", attributes: ["city", "state"], required: false },
    ],
    where: Object.keys(doctorWhere).length > 0 ? { ...where, ...doctorWhere } : where,
    order: [["createdAt", "DESC"], ["id", "DESC"]],
  });
}
```

**Note:** The `Clinic` model needs to be imported. The association `User -> DoctorProfile -> Clinic` already exists in `models/index.js`.

**`backend/src/controllers/adminRegistry.controller.js`**

Update `listDoctors` to pass filter params:
```js
exports.listDoctors = asyncHandler(async (req, res) => {
  const rows = await registryService.listDoctors({
    q: req.query.q,
    city: req.query.city,
    state: req.query.state,
    minExperience: req.query.minExperience,
    maxExperience: req.query.maxExperience,
  });
  return ok(res, rows.map(serializeRegisteredDoctor), "Registered doctors");
});
```

**`backend/src/utils/serializers.js`**

Update `serializeRegisteredDoctor` to include location:
```js
function serializeRegisteredDoctor(user) {
  if (!user) return null;
  const u = plain(user);
  const p = u.doctorProfile || {};
  const clinic = plain(u.clinic) || {};
  return {
    id: String(u.id),
    name: u.name,
    email: u.email,
    phone: u.phone ?? null,
    avatarUrl: u.profilePhotoUrl ?? null,
    registeredAt: u.createdAt instanceof Date ? u.createdAt.toISOString() : (u.createdAt ?? null),
    qualification: p.qualification ?? null,
    experienceYears: p.experienceYears ?? null,
    headline: p.headline ?? null,
    verificationStatus: p.verificationStatus ?? "pending",
    isListed: Boolean(p.isListed),
    city: clinic.city ?? null,          // NEW
    state: clinic.state ?? null,        // NEW
  };
}
```

### Existing API Behavior Preserved
- `q` parameter still works as before (name/email/phone search)
- Response envelope `{ success, message, data }` unchanged
- New fields are additive (city, state) — no existing fields removed

---

## 3. Enhanced Patient Registry Search

### Current Behavior
`GET /admin/registry/patients?q=search_term` searches `users.name`, `users.email`, `users.phone`.

### New Behavior
`GET /admin/registry/patients?q=&city=&state=`

### Files to Modify

**`backend/src/services/adminRegistry.service.js`**

Current `listPatients` function:
```js
function listPatients({ q } = {}) {
  return User.findAll({
    where: { role: ROLES.PATIENT, ...searchWhere(q) },
    include: [{ model: PatientProfile, as: "patientProfile", attributes: [...] }],
    order: [["createdAt", "DESC"], ["id", "DESC"]],
  });
}
```

Enhanced version:
```js
function listPatients({ q, city, state } = {}) {
  const where = { role: ROLES.PATIENT, ...searchWhere(q) };
  const profileWhere = {};
  if (city) profileWhere.city = { [Op.like]: `%${city}%` };
  if (state) profileWhere.state = { [Op.like]: `%${state}%` };

  return User.findAll({
    where,
    include: [{
      model: PatientProfile,
      as: "patientProfile",
      attributes: ["dateOfBirth", "gender", "bloodGroup", "city", "state"],
      where: Object.keys(profileWhere).length > 0 ? profileWhere : undefined,
      required: Object.keys(profileWhere).length > 0,
    }],
    order: [["createdAt", "DESC"], ["id", "DESC"]],
  });
}
```

**`backend/src/controllers/adminRegistry.controller.js`**

Update `listPatients` to pass filter params:
```js
exports.listPatients = asyncHandler(async (req, res) => {
  const rows = await registryService.listPatients({
    q: req.query.q,
    city: req.query.city,
    state: req.query.state,
  });
  return ok(res, rows.map(serializeRegisteredPatient), "Registered patients");
});
```

### Patient Diagnosis (Conditions in List)

The patient list currently does NOT include conditions. To support the Diagnosis column, we need to add conditions to the list response.

**Option A (Preferred):** Add a raw SQL query to fetch conditions per patient in batch, avoiding N+1.

**`backend/src/services/adminRegistry.service.js`**

Add a function to fetch conditions for multiple patients:
```js
async function patientConditions(patientIds) {
  if (!patientIds.length) return {};
  const rows = await PatientCondition.findAll({
    where: { patientId: { [Op.in]: patientIds } },
    include: [{ model: Condition, as: "condition", attributes: ["name"] }],
    attributes: ["patientId"],
    raw: true,
    nest: true,
  });
  const map = {};
  for (const r of rows) {
    const id = String(r.patientId);
    if (!map[id]) map[id] = [];
    if (r.condition?.name) map[id].push(r.condition.name);
  }
  return map;
}
```

**`backend/src/controllers/adminRegistry.controller.js`**

Update `listPatients` to include conditions:
```js
exports.listPatients = asyncHandler(async (req, res) => {
  const rows = await registryService.listPatients({
    q: req.query.q,
    city: req.query.city,
    state: req.query.state,
  });
  const ids = rows.map((r) => r.id);
  const conditionsMap = await registryService.patientConditions(ids);
  const result = rows.map((r) => {
    const serialized = serializeRegisteredPatient(r);
    serialized.conditions = conditionsMap[String(r.id)] ?? [];
    return serialized;
  });
  return ok(res, result, "Registered patients");
});
```

**`backend/src/utils/serializers.js`**

The serializer itself does NOT need to handle conditions — the controller adds it. This keeps the serializer reusable for other contexts.

---

## 4. Admin Bookings Endpoint

### Current State
No `/admin/bookings` endpoint exists. The `AppointmentsView` in the frontend is a documented placeholder.

### New Endpoint
`GET /admin/bookings` — Returns all bookings across the platform (newest first), with patient and doctor info.

### Files to Modify

**`backend/src/routes/adminDashboard.routes.js`**

Add the new route:
```js
router.get("/bookings", ...guard, dashboard.adminBookings);
```

**`backend/src/controllers/dashboard.controller.js`**

Add the handler:
```js
exports.adminBookings = asyncHandler(async (req, res) => {
  const bookings = await dashboardService.adminBookings({
    page: Number(req.query.page) || 1,
    pageSize: Number(req.query.pageSize) || 20,
  });
  return ok(res, bookings, "Platform bookings");
});
```

**`backend/src/services/dashboard.service.js`**

Add the service function:
```js
async function adminBookings({ page = 1, pageSize = 20 } = {}) {
  const offset = (page - 1) * pageSize;
  const { rows, count } = await Booking.findAndCountAll({
    include: [
      { model: User, as: "patient", attributes: ["id", "name"] },
      {
        model: DoctorProfile,
        as: "doctor",
        attributes: ["userId"],
        include: [{ model: User, as: "user", attributes: ["id", "name"] }],
      },
      { model: Clinic, as: "clinic", attributes: ["id", "name"] },
      { model: Payment, as: "payment", attributes: ["status", "mode", "amount"] },
    ],
    order: [["createdAt", "DESC"]],
    limit: pageSize,
    offset,
  });
  return {
    data: rows.map(serializeBookingForAdmin),
    meta: { page, pageSize, total: count, totalPages: Math.ceil(count / pageSize) },
  };
}
```

**`backend/src/utils/serializers.js`**

Add a new serializer for admin bookings:
```js
function serializeBookingForAdmin(booking) {
  const x = plain(booking);
  const patient = plain(x.patient) || {};
  const doctor = plain(x.doctor) || {};
  const doctorUser = plain(doctor.user) || {};
  const clinic = plain(x.clinic);
  const payment = plain(x.payment);
  return {
    id: String(x.id),
    patient: { id: String(patient.id), name: patient.name },
    doctor: { id: String(doctorUser.id), name: doctorUser.name },
    clinic: clinic ? { id: String(clinic.id), name: clinic.name } : null,
    date: x.slotDate,
    time: hhmm(x.slotStartTime),
    endTime: hhmm(x.slotEndTime),
    mode: x.bookingType === "online" ? "video" : "clinic",
    status: x.status,
    paymentMode: x.paymentMode,
    amount: payment ? Number(payment.amount) : Number(x.amount),
    paymentStatus: payment?.status ?? null,
    createdAt: x.createdAt instanceof Date ? x.createdAt.toISOString() : x.createdAt,
  };
}
```

---

## 5. Summary of All Backend Changes

| File | Change Type | Description |
|------|-------------|-------------|
| `services/adminRegistry.service.js` | Modify | Add filter params to `listDoctors` and `listPatients`, add `patientConditions` function |
| `controllers/adminRegistry.controller.js` | Modify | Pass filter params, add conditions to patient list |
| `utils/serializers.js` | Modify | Add city/state to `serializeRegisteredDoctor`, add `serializeBookingForAdmin` |
| `routes/adminDashboard.routes.js` | Modify | Add `GET /admin/bookings` route |
| `controllers/dashboard.controller.js` | Modify | Add `adminBookings` handler |
| `services/dashboard.service.js` | Modify | Add `adminBookings` function |

### Existing Behavior Preserved
- All existing endpoints return the same shape (new fields are additive)
- All existing `q` search parameters continue to work
- No existing API contracts broken
- No authentication/authorization changes
- No database schema changes
- No new migrations

---

## 6. Testing Checklist

- [ ] `GET /admin/registry/doctors?q=&city=Bhubaneswar` returns only Bhubaneswar doctors
- [ ] `GET /admin/registry/doctors?minExperience=5` returns only 5+ year doctors
- [ ] `GET /admin/registry/doctors?q=&city=Bhubaneswar&minExperience=5` returns intersection
- [ ] `GET /admin/registry/patients?q=&city=Mumbai` returns only Mumbai patients
- [ ] `GET /admin/registry/patients` response includes `conditions` array per patient
- [ ] `GET /admin/bookings` returns paginated bookings with patient and doctor names
- [ ] `GET /admin/registry/doctors` response includes `city` and `state` fields
- [ ] All existing endpoints still return correct data (regression)
- [ ] No TypeScript/build errors in backend
