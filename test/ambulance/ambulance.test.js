/**
 * Ambulance module — end-to-end API tests against the LOCAL test database.
 *
 * Runs the real Express app in-process over HTTP (no mocks), so every layer is
 * exercised: validation → auth → role gate → approval gate → service →
 * transaction → DB. Prepare the DB first:  npm run test:db
 *
 * The scenarios run in order and share state (one provider's life story):
 * register (pending) → hidden from search → admin approves → public search →
 * patient books → provider accepts → assigns driver → en route → arrived →
 * picked up → completed → patient sees it all; plus authorization and
 * invalid-request checks along the way.
 */
require("../testEnv");
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

const app = require("../../src/app");
const {
  sequelize,
  Ambulance,
  AmbulanceBooking,
  AmbulanceBookingEvent,
  MedicineNotification,
} = require("../../src/models");

const RUN = Date.now().toString(36).toUpperCase();
let server;
let base;

async function call(method, path, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${base}/api${path}`, { method, headers, body: payload });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, body: json, data: json?.data };
}
const get = (p, o) => call("GET", p, o);
const post = (p, o) => call("POST", p, o);
const put = (p, o) => call("PUT", p, o);
const patch = (p, o) => call("PATCH", p, o);

function expectStatus(res, status, label) {
  assert.equal(res.status, status, `${label}: expected ${status}, got ${res.status} ${JSON.stringify(res.body)}`);
}

// A unique pickup point per run (a remote spot), so earlier runs' ambulances
// never show up in this run's radius search.
const seed = parseInt(RUN.slice(-4), 36) % 1000;
const BASE = { lat: 10 + seed / 100, lng: 70 + seed / 100 };
const PICKUP = { lat: BASE.lat + 0.02, lng: BASE.lng + 0.02 };
const DROP = { lat: BASE.lat + 0.08, lng: BASE.lng + 0.05 };
const plate = (n) => `OD${String(10 + (seed % 80)).padStart(2, "0")}${["AB", "CD", "EF"][n]}${String(1000 + (parseInt(RUN.slice(-3), 36) % 9000)).slice(-4)}`;

const S = {};

before(async () => {
  await sequelize.authenticate();
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await sequelize.close();
});

describe("Ambulance module", () => {
  it("1–2. registers a provider (+ first ambulance + driver) in PENDING state", async () => {
    const invalid = await post("/auth/ambulance/register", {
      body: { name: "X", email: "bad", phone: "abc", password: "short", ambulance: { vehicleNumber: "NOPE" } },
    });
    expectStatus(invalid, 422, "invalid signup");
    for (const f of ["email", "phone", "password", "ambulance.vehicleNumber", "contactPerson"]) {
      assert.ok(invalid.body.error.details[f], `validation detail for ${f}`);
    }

    const res = await post("/auth/ambulance/register", {
      body: {
        name: `Rapid Care ${RUN}`,
        email: `amb-${RUN}@test.local`,
        phone: "9876500011",
        password: "Ambulance123",
        contactPerson: "Ravi Kumar",
        emergencyPhone: "9876500012",
        is24x7: true,
        addressLine: "1 Test Road",
        city: `Testpur${RUN}`,
        state: "Odisha",
        pincode: "751001",
        lat: BASE.lat,
        lng: BASE.lng,
        ambulance: {
          registrationNumber: `RC${RUN}01`,
          vehicleNumber: plate(0),
          ambulanceType: "als",
          vehicleModel: "Force Traveller",
          capacity: 2,
          equipment: ["oxygen", "defibrillator", "stretcher"],
          serviceRadiusKm: 30,
          baseAddress: "Base depot",
          baseCity: `Testpur${RUN}`,
          baseState: "Odisha",
          baseLat: BASE.lat,
          baseLng: BASE.lng,
          isEmergencyAvailable: true,
          baseFare: 500,
          perKmRate: 25,
          waitingChargePerHour: 120,
          emergencySurcharge: 200,
        },
        driver: { name: "Sanjay Driver", phone: "9876500013", licenseNumber: `OD02${RUN}DL` },
      },
    });
    expectStatus(res, 201, "register");
    assert.equal(res.data.user.role, "ambulance_provider");
    assert.equal(res.data.profile.verificationStatus, "pending");
    S.providerId = res.data.user.id;

    const [ambulance] = await Ambulance.findAll({ where: { providerId: S.providerId } });
    assert.equal(ambulance.verificationStatus, "pending");
    assert.equal(ambulance.vehicleNumber, plate(0));
    assert.ok(ambulance.defaultDriverId, "first driver linked as default");
    S.ambulanceId = String(ambulance.id);
    S.driverId = String(ambulance.defaultDriverId);

    const duplicate = await post("/auth/ambulance/register", {
      body: {
        name: `Copycat ${RUN}`,
        email: `amb2-${RUN}@test.local`,
        phone: "9876500021",
        password: "Ambulance123",
        contactPerson: "Someone",
        addressLine: "2 Road",
        city: "X",
        state: "Y",
        ambulance: { ...{ registrationNumber: `RC${RUN}99`, vehicleNumber: plate(0), ambulanceType: "bls", baseCity: "X", baseState: "Y", baseLat: 1, baseLng: 1, baseFare: 1, perKmRate: 1 } },
      },
    });
    expectStatus(duplicate, 409, "duplicate vehicle number");
    assert.ok(duplicate.body.error.details.vehicleNumber);
  });

  it("pending provider can sign in and read its profile, but not operate; is not public", async () => {
    const bad = await post("/auth/ambulance/login", { body: { email: `amb-${RUN}@test.local`, password: "wrong-pass1" } });
    expectStatus(bad, 401, "wrong password");
    const res = await post("/auth/ambulance/login", { body: { email: `amb-${RUN}@test.local`, password: "Ambulance123" } });
    expectStatus(res, 200, "login");
    S.providerToken = res.data.tokens.accessToken;

    expectStatus(await get("/ambulance/profile", { token: S.providerToken }), 200, "pending profile");
    const gated = await get("/ambulance/dashboard", { token: S.providerToken });
    expectStatus(gated, 403, "pending cannot operate");
    assert.equal(gated.body.error.code, "ONBOARDING_INCOMPLETE");

    const search = await get(`/ambulances/nearby?lat=${PICKUP.lat}&lng=${PICKUP.lng}`);
    expectStatus(search, 200, "public search");
    assert.ok(!search.data.ambulances.some((a) => a.id === S.ambulanceId), "pending ambulance must not be public");
    expectStatus(await get(`/ambulances/${S.ambulanceId}`), 404, "pending ambulance details hidden");
  });

  it("17. rejects unauthorized access (no token, wrong role, wrong portal, self-approval)", async () => {
    expectStatus(await get("/ambulance/ambulances"), 401, "no token");

    const patient = await post("/auth/register", {
      body: { name: `Pat ${RUN}`, email: `apat-${RUN}@test.local`, password: "Patient123", role: "patient", phone: "9000000011" },
    });
    expectStatus(patient, 201, "patient register");
    S.patientToken = patient.data.tokens.accessToken;
    S.patientId = patient.data.user.id;

    expectStatus(await get("/ambulance/ambulances", { token: S.patientToken }), 403, "patient on provider route");
    expectStatus(
      await post("/auth/ambulance/login", { body: { email: `apat-${RUN}@test.local`, password: "Patient123" } }),
      401,
      "patient on ambulance login"
    );
    // A provider cannot approve itself: every verify route is admin-only.
    expectStatus(
      await post(`/admin/ambulance-providers/${S.providerId}/verify`, { token: S.providerToken, body: { decision: "approved" } }),
      403,
      "provider self-approval"
    );
    expectStatus(await post("/ambulances/bookings", { token: S.providerToken, body: {} }), 403, "provider cannot book");
  });

  it("3–6. admin logs in, sees the pending provider, approves it; the ambulance becomes active", async () => {
    const admin = await post("/auth/admin/login", { body: { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD } });
    expectStatus(admin, 200, "admin login");
    S.adminToken = admin.data.tokens.accessToken;

    const queue = await get(`/admin/ambulance-providers?verificationStatus=pending&search=${encodeURIComponent(`Rapid Care ${RUN}`)}`, { token: S.adminToken });
    expectStatus(queue, 200, "pending queue");
    const row = queue.data.providers.find((p) => p.id === S.providerId);
    assert.ok(row, "admin sees the pending provider");
    assert.equal(row.pendingAmbulances, 1);

    const detail = await get(`/admin/ambulance-providers/${S.providerId}`, { token: S.adminToken });
    expectStatus(detail, 200, "provider detail");
    assert.equal(detail.data.provider.ambulances.length, 1);
    assert.equal(detail.data.provider.drivers.length, 1);
    assert.equal(detail.data.provider.ambulances[0].registrationNumber, `RC${RUN}01`);

    expectStatus(
      await post(`/admin/ambulance-providers/${S.providerId}/verify`, { token: S.adminToken, body: { decision: "rejected" } }),
      422,
      "rejection needs notes"
    );
    const verify = await post(`/admin/ambulance-providers/${S.providerId}/verify`, { token: S.adminToken, body: { decision: "approved" } });
    expectStatus(verify, 200, "approve");
    assert.equal(verify.data.provider.verificationStatus, "approved");
    assert.equal(verify.data.provider.ambulances[0].verificationStatus, "approved");

    expectStatus(await get("/ambulance/dashboard", { token: S.providerToken }), 200, "approved provider operates");
    const note = await MedicineNotification.findOne({ where: { userId: S.providerId, type: "ambulance_provider_approved" } });
    assert.ok(note, "provider notified of approval");
  });

  it("a second ambulance added later stays hidden until the admin approves it", async () => {
    const add = await post("/ambulance/ambulances", {
      token: S.providerToken,
      body: {
        registrationNumber: `RC${RUN}02`,
        vehicleNumber: plate(1),
        ambulanceType: "bls",
        baseCity: `Testpur${RUN}`,
        baseState: "Odisha",
        baseLat: BASE.lat,
        baseLng: BASE.lng,
        baseFare: 300,
        perKmRate: 15,
      },
    });
    expectStatus(add, 201, "add ambulance");
    assert.equal(add.data.ambulance.verificationStatus, "pending");
    S.secondAmbulanceId = add.data.ambulance.id;

    const search = await get(`/ambulances/nearby?lat=${PICKUP.lat}&lng=${PICKUP.lng}`);
    assert.ok(!search.data.ambulances.some((a) => a.id === S.secondAmbulanceId), "new ambulance hidden before approval");

    const other = await post("/auth/ambulance/register", {
      body: {
        name: `Other Provider ${RUN}`,
        email: `amb3-${RUN}@test.local`,
        phone: "9876500031",
        password: "Ambulance123",
        contactPerson: "Other",
        addressLine: "3 Road",
        city: "Z",
        state: "Odisha",
        ambulance: { registrationNumber: `RC${RUN}03`, vehicleNumber: plate(2), ambulanceType: "bls", baseCity: "Z", baseState: "Odisha", baseLat: 1, baseLng: 1, baseFare: 1, perKmRate: 1 },
      },
    });
    expectStatus(other, 201, "second provider");
    S.otherProviderToken = other.data.tokens.accessToken;
    await post(`/admin/ambulance-providers/${other.data.user.id}/verify`, { token: S.adminToken, body: { decision: "approved" } });
    // Another provider can't read or edit this provider's ambulance.
    expectStatus(await get(`/ambulance/ambulances/${S.ambulanceId}`, { token: S.otherProviderToken }), 404, "foreign ambulance read");
    expectStatus(
      await put(`/ambulance/ambulances/${S.ambulanceId}`, { token: S.otherProviderToken, body: { baseFare: 1 } }),
      404,
      "foreign ambulance edit"
    );
  });

  it("7. public nearby search returns the approved ambulance with distance, ETA and fare", async () => {
    const res = await get(`/ambulances/nearby?lat=${PICKUP.lat}&lng=${PICKUP.lng}&dropLat=${DROP.lat}&dropLng=${DROP.lng}&radiusKm=25`);
    expectStatus(res, 200, "nearby");
    const found = res.data.ambulances.find((a) => a.id === S.ambulanceId);
    assert.ok(found, "approved ambulance is public");
    assert.equal(found.registrationNumber, undefined, "RC number not public");
    assert.equal(found.baseAddress, undefined, "street address not public");
    assert.equal(found.baseLat, BASE.lat, "map marker uses the registered base latitude");
    assert.equal(found.baseLng, BASE.lng, "map marker uses the registered base longitude");
    assert.equal(found.typeLabel, "Advanced Life Support (ALS)");
    assert.ok(found.distanceKm > 0 && found.etaMinutes >= 1);
    assert.equal(found.estimate.estimatedFare, Math.round((500 + found.estimate.distanceKm * 25) * 100) / 100);
    assert.ok(res.data.estimateNote);

    // Provider goes OFFLINE → hidden from the patient map / search; back ONLINE → shown again.
    const setAvail = (availabilityStatus) =>
      put(`/ambulance/ambulances/${S.ambulanceId}/availability`, { token: S.providerToken, body: { availabilityStatus } });
    const nearbyIds = async () =>
      (await get(`/ambulances/nearby?lat=${PICKUP.lat}&lng=${PICKUP.lng}&radiusKm=25`)).data.ambulances.map((a) => a.id);
    expectStatus(await setAvail("offline"), 200, "go offline");
    assert.ok(!(await nearbyIds()).includes(S.ambulanceId), "offline ambulance not public");
    expectStatus(await setAvail("available"), 200, "go online");
    assert.ok((await nearbyIds()).includes(S.ambulanceId), "online ambulance public again");
    expectStatus(
      await put(`/ambulance/ambulances/${S.ambulanceId}/availability`, { token: S.otherProviderToken, body: { availabilityStatus: "offline" } }),
      404,
      "cannot toggle another provider's ambulance"
    );

    const far = await get(`/ambulances/nearby?lat=${PICKUP.lat + 5}&lng=${PICKUP.lng + 5}`);
    assert.ok(!far.data.ambulances.some((a) => a.id === S.ambulanceId), "outside radius not returned");
    expectStatus(await get("/ambulances/nearby"), 422, "pickup required");

    const types = await get("/ambulances/reference");
    expectStatus(types, 200, "reference");
    assert.ok(types.data.types.some((t) => t.key === "neonatal"));
  });

  it("8–9. patient views the ambulance and creates a booking (REQUESTED)", async () => {
    const detail = await get(`/ambulances/${S.ambulanceId}?lat=${PICKUP.lat}&lng=${PICKUP.lng}&dropLat=${DROP.lat}&dropLng=${DROP.lng}`);
    expectStatus(detail, 200, "details");
    S.quotedFare = detail.data.ambulance.estimate.estimatedFare;

    const booking = {
      ambulanceId: S.ambulanceId,
      patientName: "Asha Patient",
      contactPhone: "9000000011",
      pickupAddress: "12 Pickup Lane",
      pickupLat: PICKUP.lat,
      pickupLng: PICKUP.lng,
      dropAddress: "City Hospital",
      dropLat: DROP.lat,
      dropLng: DROP.lng,
      notes: "Second floor",
    };
    expectStatus(await post("/ambulances/bookings", { body: booking }), 401, "booking needs login");
    const invalid = await post("/ambulances/bookings", { token: S.patientToken, body: { ...booking, pickupLat: undefined, contactPhone: "x" } });
    expectStatus(invalid, 422, "invalid booking");
    const outside = await post("/ambulances/bookings", {
      token: S.patientToken,
      body: { ...booking, pickupLat: PICKUP.lat + 1, pickupLng: PICKUP.lng + 1 },
    });
    expectStatus(outside, 422, "outside service area");
    assert.equal(outside.body.error.code, "OUTSIDE_SERVICE_AREA");
    expectStatus(
      await post("/ambulances/bookings", { token: S.patientToken, body: { ...booking, ambulanceId: S.secondAmbulanceId } }),
      404,
      "cannot book a pending ambulance"
    );

    const res = await post("/ambulances/bookings", { token: S.patientToken, body: booking });
    expectStatus(res, 201, "create booking");
    assert.equal(res.data.booking.status, "requested");
    assert.match(res.data.booking.bookingCode, /^AMB-\d{8}-[0-9A-Z]{6}$/);
    assert.equal(res.data.booking.fare.estimatedFare, S.quotedFare, "booked fare = quoted fare");
    assert.equal(res.data.booking.fare.emergencySurcharge, 0);
    S.bookingId = res.data.booking.id;

    expectStatus(await post("/ambulances/bookings", { token: S.patientToken, body: booking }), 409, "no duplicate open booking");
  });

  it("10–11. provider receives the booking and accepts it (ambulance goes on trip)", async () => {
    const list = await get("/ambulance/bookings?bucket=new", { token: S.providerToken });
    expectStatus(list, 200, "provider requests");
    const row = list.data.bookings.find((b) => b.id === S.bookingId);
    assert.ok(row, "provider sees the request");
    assert.equal(row.contactPhone, "9000000011");
    assert.ok(await MedicineNotification.findOne({ where: { userId: S.providerId, type: "ambulance_booking_received", referenceId: S.bookingId } }));

    expectStatus(await get(`/ambulance/bookings/${S.bookingId}`, { token: S.otherProviderToken }), 404, "foreign provider can't see booking");
    expectStatus(
      await post(`/ambulance/bookings/${S.bookingId}/status`, { token: S.providerToken, body: { status: "en_route" } }),
      400,
      "cannot skip to en_route"
    );

    const accept = await post(`/ambulance/bookings/${S.bookingId}/accept`, { token: S.providerToken, body: { etaMinutes: 12 } });
    expectStatus(accept, 200, "accept");
    assert.equal(accept.data.booking.status, "accepted");
    assert.equal(accept.data.booking.etaMinutes, 12);
    const amb = await Ambulance.findByPk(S.ambulanceId);
    assert.equal(amb.availabilityStatus, "on_trip");

    // An on-trip ambulance can't take another booking and can't be set available by hand.
    const other = await post("/ambulances/bookings", {
      token: S.patientToken,
      body: {
        ambulanceId: S.ambulanceId,
        patientName: "Someone Else",
        contactPhone: "9000000099",
        pickupAddress: "Elsewhere",
        pickupLat: PICKUP.lat,
        pickupLng: PICKUP.lng,
        dropAddress: "Hospital",
        dropLat: DROP.lat,
        dropLng: DROP.lng,
      },
    });
    expectStatus(other, 409, "on-trip ambulance not bookable");
    expectStatus(
      await put(`/ambulance/ambulances/${S.ambulanceId}/availability`, { token: S.providerToken, body: { availabilityStatus: "available" } }),
      409,
      "availability locked while on trip"
    );
  });

  it("12. provider assigns the driver", async () => {
    const res = await post(`/ambulance/bookings/${S.bookingId}/assign-driver`, { token: S.providerToken, body: { driverId: S.driverId } });
    expectStatus(res, 200, "assign driver");
    assert.equal(res.data.booking.status, "driver_assigned");
    assert.equal(res.data.booking.driver.name, "Sanjay Driver");

    const drivers = await get("/ambulance/drivers", { token: S.providerToken });
    assert.ok(drivers.data.drivers.find((d) => d.id === S.driverId).currentTrip, "driver shows as on a trip");
    expectStatus(
      await put(`/ambulance/drivers/${S.driverId}`, { token: S.providerToken, body: { isActive: false } }),
      409,
      "busy driver can't be deactivated"
    );
  });

  it("13–14. status updates, and the patient sees them (with the driver while live)", async () => {
    for (const status of ["en_route", "arrived"]) {
      const res = await post(`/ambulance/bookings/${S.bookingId}/status`, { token: S.providerToken, body: { status } });
      expectStatus(res, 200, status);
      assert.equal(res.data.booking.status, status);
    }
    const mine = await get(`/ambulances/bookings/${S.bookingId}`, { token: S.patientToken });
    expectStatus(mine, 200, "patient booking");
    assert.equal(mine.data.booking.status, "arrived");
    assert.equal(mine.data.booking.driver.phone, "9876500013", "driver phone visible while live");
    assert.equal(mine.data.booking.driver.licenseNumber, undefined);
    assert.deepEqual(
      mine.data.booking.events.map((e) => e.toStatus),
      ["requested", "accepted", "driver_assigned", "en_route", "arrived"]
    );
    // Too late for the patient to cancel once the ambulance has left.
    expectStatus(await post(`/ambulances/bookings/${S.bookingId}/cancel`, { token: S.patientToken, body: {} }), 400, "late cancel");

    const otherPatient = await post("/auth/register", {
      body: { name: `Pat2 ${RUN}`, email: `apat2-${RUN}@test.local`, password: "Patient123", role: "patient" },
    });
    expectStatus(await get(`/ambulances/bookings/${S.bookingId}`, { token: otherPatient.data.tokens.accessToken }), 404, "other patient blocked");

    const notes = await MedicineNotification.findAll({ where: { userId: S.patientId, referenceId: S.bookingId } });
    const types = notes.map((n) => n.type);
    for (const t of ["ambulance_booking_requested", "ambulance_accepted", "ambulance_driver_assigned", "ambulance_en_route", "ambulance_arrived"]) {
      assert.ok(types.includes(t), `patient notified: ${t}`);
    }
  });

  it("15–16. pickup + completion; final fare stored; ambulance freed; records consistent", async () => {
    expectStatus(
      await post(`/ambulance/bookings/${S.bookingId}/status`, { token: S.providerToken, body: { status: "patient_picked_up" } }),
      200,
      "picked up"
    );
    const done = await post(`/ambulance/bookings/${S.bookingId}/complete`, {
      token: S.providerToken,
      body: { actualDistanceKm: 10, waitingMinutes: 30 },
    });
    expectStatus(done, 200, "complete");
    assert.equal(done.data.booking.status, "completed");
    assert.equal(done.data.booking.fare.finalFare, 500 + 10 * 25 + 60); // base + km × rate + 30 min × ₹120/h

    const row = await AmbulanceBooking.findByPk(S.bookingId);
    assert.equal(row.status, "completed");
    assert.ok(row.acceptedAt && row.driverAssignedAt && row.enRouteAt && row.arrivedAt && row.pickedUpAt && row.completedAt);
    assert.equal(String(row.patientId), S.patientId);
    assert.equal(await AmbulanceBookingEvent.count({ where: { bookingId: S.bookingId } }), 7);
    assert.equal((await Ambulance.findByPk(S.ambulanceId)).availabilityStatus, "available");

    const mine = await get(`/ambulances/bookings/${S.bookingId}`, { token: S.patientToken });
    assert.equal(mine.data.booking.driver.phone, null, "driver phone hidden after the trip");
    expectStatus(
      await post(`/ambulance/bookings/${S.bookingId}/cancel`, { token: S.providerToken, body: { reason: "late" } }),
      400,
      "closed booking can't change"
    );
  });

  it("patient cancel + provider reject paths", async () => {
    const booking = {
      ambulanceId: S.ambulanceId,
      patientName: "Asha Patient",
      contactPhone: "9000000011",
      pickupAddress: "12 Pickup Lane",
      pickupLat: PICKUP.lat,
      pickupLng: PICKUP.lng,
      dropAddress: "City Hospital",
      dropLat: DROP.lat,
      dropLng: DROP.lng,
      isEmergency: true,
    };
    const first = await post("/ambulances/bookings", { token: S.patientToken, body: booking });
    expectStatus(first, 201, "emergency booking");
    assert.equal(first.data.booking.fare.emergencySurcharge, 200);
    const cancel = await post(`/ambulances/bookings/${first.data.booking.id}/cancel`, { token: S.patientToken, body: { reason: "Found a ride" } });
    expectStatus(cancel, 200, "patient cancel");
    assert.equal(cancel.data.booking.status, "cancelled");
    assert.equal(cancel.data.booking.cancelledBy, "patient");

    const second = await post("/ambulances/bookings", { token: S.patientToken, body: booking });
    expectStatus(second, 201, "rebook");
    expectStatus(await post(`/ambulance/bookings/${second.data.booking.id}/reject`, { token: S.providerToken, body: {} }), 422, "reject needs reason");
    const reject = await post(`/ambulance/bookings/${second.data.booking.id}/reject`, { token: S.providerToken, body: { reason: "Vehicle under service" } });
    expectStatus(reject, 200, "reject");
    assert.equal(reject.data.booking.status, "rejected");
  });

  it("admin monitoring, deactivation hides the ambulance, summary counts", async () => {
    const bookings = await get(`/admin/ambulance-bookings?ambulanceId=${S.ambulanceId}`, { token: S.adminToken });
    expectStatus(bookings, 200, "admin bookings");
    const done = bookings.data.bookings.find((b) => b.id === S.bookingId);
    assert.equal(done.patient.id, S.patientId);
    assert.equal(done.driver.name, "Sanjay Driver");
    assert.equal(done.provider.id, S.providerId);

    const off = await patch(`/admin/ambulances/${S.ambulanceId}/active`, { token: S.adminToken, body: { isActive: false } });
    expectStatus(off, 200, "deactivate");
    const search = await get(`/ambulances/nearby?lat=${PICKUP.lat}&lng=${PICKUP.lng}`);
    assert.ok(!search.data.ambulances.some((a) => a.id === S.ambulanceId), "deactivated ambulance hidden");
    expectStatus(await patch(`/admin/ambulances/${S.ambulanceId}/active`, { token: S.adminToken, body: { isActive: true } }), 200, "reactivate");

    // Suspending the provider hides its fleet too.
    await patch(`/admin/ambulance-providers/${S.providerId}/active`, { token: S.adminToken, body: { isActive: false } });
    const hidden = await get(`/ambulances/nearby?lat=${PICKUP.lat}&lng=${PICKUP.lng}`);
    assert.ok(!hidden.data.ambulances.some((a) => a.id === S.ambulanceId), "suspended provider hidden");
    expectStatus(await get("/ambulance/dashboard", { token: S.providerToken }), 403, "suspended provider can't operate");
    await patch(`/admin/ambulance-providers/${S.providerId}/active`, { token: S.adminToken, body: { isActive: true } });

    const summary = await get("/admin/ambulances/summary", { token: S.adminToken });
    expectStatus(summary, 200, "summary");
    assert.ok(summary.data.providers.total >= 2);
    assert.ok(summary.data.bookings.completed >= 1);
    assert.equal(summary.data.charts.bookingTrend.length, 14);

    const dash = await get("/ambulance/dashboard", { token: S.providerToken });
    expectStatus(dash, 200, "provider dashboard");
    assert.equal(dash.data.ambulances.total, 2);
    assert.equal(dash.data.ambulances.pendingApproval, 1);
    assert.equal(dash.data.bookings.completed, 1);
  });

  it("18. invalid ids and bodies are rejected cleanly", async () => {
    expectStatus(await get("/ambulances/999999999"), 404, "unknown ambulance");
    expectStatus(await get("/ambulances/999999999/estimate?pickupLat=1&pickupLng=1&dropLat=2&dropLng=2"), 404, "estimate unknown");
    expectStatus(await get(`/ambulances/${S.ambulanceId}/estimate`), 422, "estimate needs coordinates");
    expectStatus(
      await put(`/ambulance/ambulances/${S.ambulanceId}`, { token: S.providerToken, body: { perKmRate: -5 } }),
      422,
      "negative pricing"
    );
    expectStatus(await put(`/ambulance/ambulances/${S.ambulanceId}`, { token: S.providerToken, body: {} }), 422, "empty update");

    // Editing the vehicle's identity sends it back for review (and out of search).
    const edit = await put(`/ambulance/ambulances/${S.ambulanceId}`, { token: S.providerToken, body: { ambulanceType: "bls" } });
    expectStatus(edit, 200, "identity edit");
    assert.equal(edit.data.ambulance.verificationStatus, "pending");
    const pricing = await put(`/ambulance/ambulances/${S.secondAmbulanceId}`, { token: S.providerToken, body: { perKmRate: 18 } });
    assert.equal(pricing.data.ambulance.verificationStatus, "pending", "still pending (never approved)");
  });
});
