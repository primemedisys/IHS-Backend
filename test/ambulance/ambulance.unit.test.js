/**
 * Ambulance module — pure unit tests (NO database): validators, the fare /
 * ETA model, geo helpers, the state machine table and the serializers'
 * audience rules. Run on their own with:
 *   node --test test/ambulance/ambulance.unit.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const v = require("../../src/validators/ambulance.validator");
const A = require("../../src/config/ambulance");
const { quote, finalFare, estimatedRoadKm, etaMinutesFor } = require("../../src/utils/ambulanceFare");
const { haversineKm, boundingBox } = require("../../src/utils/geo");
const { serializeBooking, serializeAmbulance } = require("../../src/utils/ambulanceSerializers");

const opts = { abortEarly: false, stripUnknown: true, convert: true };
const ok = (schema, value) => {
  const r = schema.validate(value, opts);
  assert.equal(r.error, undefined, r.error && r.error.message);
  return r.value;
};
const fails = (schema, value, field) => {
  const r = schema.validate(value, opts);
  assert.ok(r.error, `expected ${field} to fail`);
  if (field) assert.ok(r.error.details.some((d) => d.path.join(".") === field), `no error on ${field}: ${r.error.message}`);
};

const AMB = {
  registrationNumber: "od-02 rc 55512",
  vehicleNumber: "od 02 ab 1234",
  ambulanceType: "als",
  baseCity: "Bhubaneswar",
  baseState: "Odisha",
  baseLat: 20.2961,
  baseLng: 85.8245,
  baseFare: 500,
  perKmRate: 25,
};

describe("ambulance validators", () => {
  it("normalises and accepts Indian vehicle / registration numbers", () => {
    const out = ok(v.createAmbulance, AMB);
    assert.equal(out.vehicleNumber, "OD02AB1234");
    assert.equal(out.registrationNumber, "OD02RC55512");
    ok(v.createAmbulance, { ...AMB, vehicleNumber: "22BH1234AB" });
  });

  it("rejects bad vehicle numbers, unknown types, negative pricing, missing base location", () => {
    fails(v.createAmbulance, { ...AMB, vehicleNumber: "HELLO" }, "vehicleNumber");
    fails(v.createAmbulance, { ...AMB, ambulanceType: "helicopter" }, "ambulanceType");
    fails(v.createAmbulance, { ...AMB, baseFare: -1 }, "baseFare");
    fails(v.createAmbulance, { ...AMB, baseLat: undefined }, "baseLat");
    fails(v.createAmbulance, { ...AMB, equipment: ["oxygen", "laser"] }, "equipment.1");
  });

  it("validates the provider signup (phone, email, password, nested ambulance)", () => {
    const base = {
      name: "Rapid Care",
      email: "RAPID@Example.com",
      phone: "9876543210",
      password: "Secret123",
      contactPerson: "Ravi",
      addressLine: "1 Main Road",
      city: "Bhubaneswar",
      state: "Odisha",
      ambulance: AMB,
    };
    assert.equal(ok(v.register, base).email, "rapid@example.com");
    fails(v.register, { ...base, phone: "abc" }, "phone");
    fails(v.register, { ...base, email: "nope" }, "email");
    fails(v.register, { ...base, password: "short" }, "password");
    fails(v.register, { ...base, ambulance: undefined }, "ambulance");
    fails(v.register, { ...base, driver: { name: "D", phone: "9", licenseNumber: "x" } });
  });

  it("requires a pickup for nearby search and a pair for the destination", () => {
    fails(v.nearby, {}, "lat");
    ok(v.nearby, { lat: 20.3, lng: 85.8 });
    fails(v.nearby, { lat: 20.3, lng: 85.8, dropLat: 20.2 });
    fails(v.nearby, { lat: 120, lng: 85.8 }, "lat");
  });

  it("only allows the simple forward steps on /status", () => {
    ok(v.progressBooking, { status: "en_route" });
    fails(v.progressBooking, { status: "completed" }, "status");
    fails(v.progressBooking, { status: "accepted" }, "status");
  });

  it("requires notes when an admin rejects", () => {
    fails(v.adminVerifyProvider, { decision: "rejected" }, "notes");
    ok(v.adminVerifyProvider, { decision: "approved" });
    fails(v.adminVerifyAmbulance, { decision: "pending" }, "decision");
  });
});

describe("fare + ETA model", () => {
  const ambulance = { baseFare: 500, perKmRate: 25, emergencySurcharge: 200, waitingChargePerHour: 120, baseLat: 20.2961, baseLng: 85.8245 };
  const trip = { pickupLat: 20.2961, pickupLng: 85.8245, dropLat: 20.3548, dropLng: 85.8195 };

  it("estimated fare = base + distance × per-km", () => {
    const q = quote(ambulance, trip);
    assert.equal(q.estimatedFare, Math.round((500 + q.distanceKm * 25) * 100) / 100);
    assert.equal(q.emergencySurcharge, 0);
    assert.ok(q.distanceKm > 6 && q.distanceKm < 9, `distance ${q.distanceKm}`);
  });

  it("adds the emergency surcharge only for emergencies", () => {
    const q = quote(ambulance, { ...trip, emergency: true });
    assert.equal(q.emergencySurcharge, 200);
    assert.equal(q.estimatedFare, Math.round((500 + q.distanceKm * 25 + 200) * 100) / 100);
  });

  it("final fare uses actual km and waiting time when given", () => {
    const booking = { baseFare: 500, perKmRate: 25, emergencySurcharge: 0, waitingChargePerHour: 120, estimatedDistanceKm: 8 };
    assert.equal(finalFare(booking, {}), 700);
    assert.equal(finalFare(booking, { actualDistanceKm: 10 }), 750);
    assert.equal(finalFare(booking, { actualDistanceKm: 10, waitingMinutes: 30 }), 810);
  });

  it("ETA is at least a minute and scales with distance", () => {
    assert.equal(etaMinutesFor(0), 1);
    assert.equal(etaMinutesFor(15), 30);
    assert.equal(estimatedRoadKm(0, 0, 0, 0), 0);
  });
});

describe("geo helpers", () => {
  it("haversine: Bhubaneswar → Cuttack ≈ 20–25 km", () => {
    const d = haversineKm(20.2961, 85.8245, 20.4625, 85.883);
    assert.ok(d > 18 && d < 25, `got ${d}`);
  });
  it("bounding box contains the centre and spans ~2×radius", () => {
    const b = boundingBox(20.3, 85.8, 25);
    assert.ok(b.minLat < 20.3 && b.maxLat > 20.3 && b.minLng < 85.8 && b.maxLng > 85.8);
    assert.ok(Math.abs((b.maxLat - b.minLat) * 111.045 - 50) < 0.5);
  });
});

describe("state machine", () => {
  const T = A.AMBULANCE_PROVIDER_TRANSITIONS;
  const S = A.AMBULANCE_BOOKING_STATUS;
  it("walks the happy path one step at a time", () => {
    const flow = A.AMBULANCE_BOOKING_FLOW;
    for (let i = 0; i < flow.length - 1; i += 1) {
      assert.ok(T[flow[i]].includes(flow[i + 1]), `${flow[i]} → ${flow[i + 1]}`);
    }
  });
  it("has no way out of a closed booking and no skipping", () => {
    for (const closed of A.AMBULANCE_CLOSED_BOOKING) assert.equal(T[closed], undefined);
    assert.ok(!T[S.REQUESTED].includes(S.COMPLETED));
    assert.ok(!T[S.ACCEPTED].includes(S.EN_ROUTE));
    assert.ok(!T[S.PATIENT_PICKED_UP].includes(S.CANCELLED));
  });
  it("lets the patient cancel only before the ambulance leaves", () => {
    assert.deepEqual([...A.AMBULANCE_PATIENT_CANCELLABLE], [S.REQUESTED, S.ACCEPTED, S.DRIVER_ASSIGNED]);
  });
});

describe("serializer audiences", () => {
  const ambulance = { id: 1, providerId: 2, registrationNumber: "RC123456", vehicleNumber: "OD02AB1234", ambulanceType: "bls", availabilityStatus: "available", verificationNotes: "x", equipment: ["oxygen"], baseAddress: "Depot 4", baseLat: 20.2961, baseLng: 85.8245 };
  it("public ambulance view hides the RC number and verification notes", () => {
    const pub = serializeAmbulance(ambulance, "public");
    assert.equal(pub.registrationNumber, undefined);
    assert.equal(pub.verificationNotes, undefined);
    assert.equal(pub.equipment[0].label, "Oxygen cylinder");
    assert.equal(pub.baseAddress, undefined);
    assert.deepEqual([pub.baseLat, pub.baseLng], [20.2961, 85.8245], "base coordinates position the map marker");
    assert.equal(serializeAmbulance(ambulance, "admin").registrationNumber, "RC123456");
  });
  it("patient sees the driver's phone only while the trip is live", () => {
    const b = { id: 1, status: "driver_assigned", ambulanceType: "bls", driver: { id: 3, name: "Sam", phone: "999", licenseNumber: "L" } };
    assert.equal(serializeBooking(b, "patient").driver.phone, "999");
    assert.equal(serializeBooking({ ...b, status: "completed" }, "patient").driver.phone, null);
    assert.equal(serializeBooking(b, "patient").driver.licenseNumber, undefined);
    assert.equal(serializeBooking(b, "provider").driver.licenseNumber, "L");
  });
});
