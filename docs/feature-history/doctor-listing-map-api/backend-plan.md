# Backend — Doctor Map Endpoint

The one new public read the map needs. Everything rides the existing public-doctor stack (`doctorsPublic.routes.js` → `publicDoctor.controller.js` → `verification.service.js` → `serializers.js`). No migration, no model change — the data (`clinic.lat/lng`, `avgRating`, fees) already exists. Read `README.md §4–5` first.

**Legend:** 🟢 exists · 🟡 extend · 🔵 new.

---

## 1. Service — `verification.service.listMapDoctors()` 🔵

Add alongside the existing `listPublicDoctors` in `backend/src/services/verification.service.js`. It reuses the exact same query as `listPublicDoctors` (approved-only, `doctorService.cardInclude`, `serializePublicDoctor`), then **keeps only located doctors** and projects to the lean marker shape.

```js
/**
 * All approved doctors that have a real clinic location, as lean markers for the
 * homepage hero + /map page. No pagination (MVP scale). Un-located doctors
 * (no active clinic → lat/lng 0) are dropped so no null-island pin renders.
 */
async function listMapDoctors() {
  const rows = await DoctorProfile.findAll({
    where: { verificationStatus: "approved" },
    include: doctorService.cardInclude,
  });
  return rows
    .map(serializePublicDoctor)
    .filter((d) => d.lat && d.lng) // drops null / 0 coords (no located clinic)
    .map(toMapDoctor);
}
```

Export it in the module's `module.exports` block next to `listPublicDoctors`.

> **Why reuse `serializePublicDoctor` then trim, rather than a bespoke query?** The card serializer already resolves the primary clinic's `lat`/`lng`, the lowest fee, rating, and photo — replicating that in a leaner query duplicates logic that must stay in sync. At MVP scale the map-then-trim is cheap; swap for a projected SQL query only if the roster grows large (see `README §7.2`).

---

## 2. Serializer — `toMapDoctor` (lean projection) 🔵

Add to `backend/src/utils/serializers.js` and export it. Picks the marker fields from a full public card (see `README.md §5`):

```js
/** Lean marker projection of a public doctor card (GET /doctors/map). */
function toMapDoctor(card) {
  return {
    id: card.id,
    slug: card.slug,
    name: card.name,
    photoUrl: card.photoUrl,
    specialtySlug: card.specialtySlug,
    specialtyName: card.specialtyName,
    hospital: card.hospital,
    city: card.city,
    lat: card.lat,
    lng: card.lng,
    rating: card.rating,
    reviewsCount: card.reviewsCount,
    experienceYears: card.experienceYears,
    consultationFee: card.consultationFee,
    onlineFee: card.onlineFee,
    onlineConsult: card.onlineConsult,
    available: card.available,
    verified: card.verified,
  };
}
```

> Keeping the projection here (not inline in the service) means the marker contract lives with the other serializers, and a future projected query can reuse the same shape.

---

## 3. Controller — `publicDoctor.listMapDoctors` 🔵

Thin wrapper in `backend/src/controllers/publicDoctor.controller.js`, mirroring the existing `listDoctors`:

```js
exports.listMapDoctors = asyncHandler(async (_req, res) => {
  const rows = await verificationService.listMapDoctors();
  return ok(res, rows, "Map doctors");
});
```

No query validation needed — the endpoint takes no params (client-side specialty filter + distance sort operate over the returned set, matching current behaviour).

---

## 4. Route — `GET /doctors/map` 🟡

In `backend/src/routes/doctorsPublic.routes.js`, register **before** `/doctors/:slug`, next to the other two-segment paths:

```js
router.get("/doctors", publicDoctor.listDoctors);
router.get("/doctors/map", publicDoctor.listMapDoctors);      // NEW — literal, before :slug
router.get("/doctors/:id/slots", publicDoctor.slots);
router.get("/doctors/:slug/related", publicDoctor.related);
router.get("/doctors/:slug", publicDoctor.getBySlug);
```

`map` is a literal single segment; declared before `/doctors/:slug` it can never be captured as a slug — the same ordering discipline already documented in the file's header comment.

---

## 5. Swagger 🟡 (optional, match convention)

Add a `GET /doctors/map` entry to `backend/src/config/swagger.js` alongside the existing `/doctors` docs — response `200 { success, message, data: MapDoctor[] }`. Non-blocking; do it if the other public reads are documented there.

---

## 6. What we deliberately do **not** touch

- **`listPublicDoctors`** — unchanged; the paginated discovery list keeps its 50-cap and filter set.
- **No new filters on `/doctors`** — `stateCode`/`city`/`symptomSlug`/`available`/`verified` remain unimplemented (frontend types declare them, backend ignores unknown keys). Out of scope; add later if a filter UI needs them.
- **No migration / model change** — pins come from existing `clinics.lat/lng`.

---

## 7. Test at this point (before any frontend)

```bash
# All located approved doctors as lean markers
curl -s localhost:PORT/api/doctors/map | jq '.data | length, .data[0]'
```
- [ ] Returns `{ success, data: [...] }`.
- [ ] Every item has non-zero `lat` **and** `lng`.
- [ ] A doctor with no active clinic is **absent** from the list.
- [ ] Payload carries only the §5 marker fields (no `education`/`reviews`/`clinics`).
- [ ] `/doctors/map` resolves to the list, **not** a 404 "doctor not found" (route ordering correct).
</content>
