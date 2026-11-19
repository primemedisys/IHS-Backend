/**
 * Ambulance bookings (migration 040): creation by a patient, the provider's
 * state machine, patient/provider cancellation, and the admin reads.
 *
 *   requested → accepted → driver_assigned → en_route → arrived
 *             → patient_picked_up → completed        (+ rejected / cancelled)
 *
 * Invariants, all enforced HERE (never by a client):
 *   - a booking is only created against a publicly visible, AVAILABLE
 *     ambulance whose service radius covers the pickup (ambulanceSearch.loadVisible);
 *   - the fare is computed server-side by utils/ambulanceFare and its inputs
 *     are snapshotted on the row;
 *   - every status move is checked against config/ambulance.js
 *     AMBULANCE_PROVIDER_TRANSITIONS under a row lock, and writes an
 *     ambulance_booking_events row + a notification in the SAME transaction;
 *   - an ambulance holds at most ONE active booking (it is `on_trip` from
 *     acceptance until completion / cancellation), and a driver at most one;
 *   - ownership: patients see only patient_id = their id, providers only
 *     provider_id = theirs; a foreign id 404s.
 *
 * Tracking is status + ETA only. There is no live vehicle position anywhere.
 */
const crypto = require("crypto");
const { Op } = require("sequelize");
const {
  sequelize,
  User,
  Ambulance,
  AmbulanceDriver,
  AmbulanceBooking,
  AmbulanceBookingEvent,
  AmbulanceProviderProfile,
} = require("../models");
const ApiError = require("../utils/ApiError");
const { ERROR_CODES } = require("../config/constants");
const A = require("../config/ambulance");
const { quote, finalFare, estimatedRoadKm } = require("../utils/ambulanceFare");
const { serializeBooking } = require("../utils/ambulanceSerializers");
const { notify } = require("./ambulanceNotification.service");
const search = require("./ambulanceSearch.service");
const fleet = require("./ambulanceFleet.service");

const S = A.AMBULANCE_BOOKING_STATUS;

/** Status groups behind the `bucket` filter both dashboards use. */
const BUCKET_STATUSES = Object.freeze({
  new: [S.REQUESTED],
  ongoing: A.AMBULANCE_ACTIVE_BOOKING,
  open: A.AMBULANCE_OPEN_BOOKING,
  completed: [S.COMPLETED],
  cancelled: [S.CANCELLED, S.REJECTED],
});

const detailInclude = (audience) => [
  {
    model: Ambulance,
    as: "ambulance",
    attributes: ["id", "vehicleNumber", "vehicleModel", "ambulanceType", "equipment", "baseCity"],
  },
  {
    model: User,
    as: "provider",
    attributes: ["id", "name", "phone", "city", "state"],
    include: [{ model: AmbulanceProviderProfile, as: "ambulanceProviderProfile", attributes: ["organizationName", "phone", "emergencyPhone", "is24x7"] }],
  },
  { model: AmbulanceDriver, as: "driver", attributes: ["id", "name", "phone", "licenseNumber"] },
  ...(audience === "admin" ? [{ model: User, as: "patient", attributes: ["id", "name", "email", "phone"] }] : []),
];

/** AMB-YYYYMMDD-XXXXXX. Random (not sequential), UNIQUE-keyed as the backstop. */
function newBookingCode() {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const rand = crypto.randomBytes(4).readUInt32BE(0).toString(36).toUpperCase().padStart(6, "0").slice(-6);
  return `${A.AMBULANCE_BOOKING_PREFIX}-${ymd}-${rand}`;
}

function event(booking, { from, to, actorUserId, actorRole, note }, transaction) {
  return AmbulanceBookingEvent.create(
    { bookingId: booking.id, fromStatus: from ?? null, toStatus: to, actorUserId: actorUserId ?? null, actorRole, note: note || null },
    { transaction }
  );
}

/** The patient-facing notification for a status change. */
function patientNotice(booking, status, { driver, etaMinutes, reason } = {}) {
  const ref = { referenceId: booking.id, referenceType: A.AMBULANCE_NOTIFICATION_REF.BOOKING, userId: booking.patientId };
  const code = booking.bookingCode;
  const eta = etaMinutes ? ` Estimated arrival: about ${etaMinutes} min.` : "";
  const messages = {
    [S.ACCEPTED]: `Your ambulance booking ${code} was accepted by the provider.${eta}`,
    [S.DRIVER_ASSIGNED]: `Driver ${driver?.name || ""} has been assigned to booking ${code}.${eta}`,
    [S.EN_ROUTE]: `Your ambulance is on the way for booking ${code}.${eta}`,
    [S.ARRIVED]: `Your ambulance has arrived at the pickup location (${code}).`,
    [S.PATIENT_PICKED_UP]: `Patient picked up — booking ${code} is heading to the destination.`,
    [S.COMPLETED]: `Booking ${code} is complete. Final fare: ₹${booking.finalFare ?? booking.estimatedFare}.`,
    [S.REJECTED]: `The provider could not take booking ${code}${reason ? `: ${reason}` : "."} Please choose another ambulance.`,
    [S.CANCELLED]: `Booking ${code} was cancelled by the provider${reason ? `: ${reason}` : "."}`,
  };
  if (!messages[status]) return null;
  return { ...ref, title: A.AMBULANCE_STATUS_LABELS[status], message: messages[status], type: `ambulance_${status}` };
}

async function reload(where, audience) {
  const booking = await AmbulanceBooking.findOne({
    where,
    include: [
      ...detailInclude(audience),
      { model: AmbulanceBookingEvent, as: "events", separate: true, order: [["createdAt", "ASC"], ["id", "ASC"]] },
    ],
  });
  if (!booking) throw ApiError.notFound("Booking not found");
  return serializeBooking(booking, audience);
}

/** Free the ambulance after its active booking ended (unless another is still active). */
async function releaseAmbulance(booking, transaction) {
  const stillActive = await AmbulanceBooking.count({
    where: { ambulanceId: booking.ambulanceId, id: { [Op.ne]: booking.id }, status: { [Op.in]: A.AMBULANCE_ACTIVE_BOOKING } },
    transaction,
  });
  if (stillActive) return;
  await Ambulance.update(
    { availabilityStatus: A.AMBULANCE_AVAILABILITY.AVAILABLE },
    { where: { id: booking.ambulanceId, availabilityStatus: A.AMBULANCE_AVAILABILITY.ON_TRIP }, transaction }
  );
}

function assertTransition(from, to) {
  const allowed = A.AMBULANCE_PROVIDER_TRANSITIONS[from] || [];
  if (!allowed.includes(to)) {
    throw ApiError.badRequest(`Cannot move a booking from '${from}' to '${to}'.`, {
      code: ERROR_CODES.INVALID_STATUS_TRANSITION,
      details: { from, allowed },
    });
  }
}

function listWhere(base, { status, bucket, search: term }) {
  const where = { ...base };
  if (status) where.status = status;
  else if (bucket) where.status = { [Op.in]: BUCKET_STATUSES[bucket] };
  if (term) {
    where[Op.or] = [
      { bookingCode: { [Op.like]: `%${term}%` } },
      { patientName: { [Op.like]: `%${term}%` } },
      { pickupAddress: { [Op.like]: `%${term}%` } },
      { dropAddress: { [Op.like]: `%${term}%` } },
    ];
  }
  return where;
}

async function list(where, audience, { page = 1, limit = 20 }) {
  const { rows, count } = await AmbulanceBooking.findAndCountAll({
    where,
    include: detailInclude(audience),
    order: [["createdAt", "DESC"], ["id", "DESC"]],
    limit,
    offset: (page - 1) * limit,
    distinct: true,
  });
  return { bookings: rows.map((b) => serializeBooking(b, audience)), total: count, page, limit, totalPages: Math.ceil(count / limit) };
}

// ── Patient ──────────────────────────────────────────────────────────────

exports.create = async (patientId, dto) => {
  const booking = await sequelize.transaction(async (transaction) => {
    // Lock the vehicle row so two patients can't race the availability check.
    await Ambulance.findByPk(dto.ambulanceId, { attributes: ["id"], transaction, lock: transaction.LOCK.UPDATE });
    const ambulance = await search.loadVisible(dto.ambulanceId, { transaction });

    if (ambulance.availabilityStatus !== A.AMBULANCE_AVAILABILITY.AVAILABLE) {
      throw ApiError.conflict("This ambulance is on another trip right now. Please choose another one.", {
        code: ERROR_CODES.AMBULANCE_UNAVAILABLE,
      });
    }
    if (dto.isEmergency && !ambulance.isEmergencyAvailable) {
      throw new ApiError(422, "This ambulance does not take emergency bookings.", {
        code: ERROR_CODES.VALIDATION_ERROR,
        details: { isEmergency: ["This ambulance does not take emergency bookings"] },
      });
    }
    const toPickupKm = estimatedRoadKm(ambulance.baseLat, ambulance.baseLng, dto.pickupLat, dto.pickupLng);
    const serviceRadius = ambulance.serviceRadiusKm || A.AMBULANCE_ESTIMATE.DEFAULT_SERVICE_RADIUS_KM;
    // The same great-circle measure the search filters on, with the route factor applied.
    if (toPickupKm > serviceRadius * A.AMBULANCE_ESTIMATE.ROUTE_FACTOR) {
      throw new ApiError(422, "The pickup location is outside this ambulance's service area.", {
        code: ERROR_CODES.OUTSIDE_SERVICE_AREA,
        details: { pickupAddress: ["Outside this ambulance's service area"] },
      });
    }
    const duplicate = await AmbulanceBooking.findOne({
      where: { patientId, ambulanceId: ambulance.id, status: { [Op.in]: A.AMBULANCE_OPEN_BOOKING } },
      attributes: ["id", "bookingCode"],
      transaction,
    });
    if (duplicate) {
      throw ApiError.conflict(`You already have an open booking (${duplicate.bookingCode}) with this ambulance.`, {
        code: ERROR_CODES.AMBULANCE_UNAVAILABLE,
        details: { bookingId: String(duplicate.id) },
      });
    }

    const q = quote(ambulance, { ...dto, emergency: Boolean(dto.isEmergency) });
    const created = await AmbulanceBooking.create(
      {
        bookingCode: newBookingCode(),
        patientId,
        providerId: ambulance.providerId,
        ambulanceId: ambulance.id,
        ambulanceType: ambulance.ambulanceType,
        isEmergency: Boolean(dto.isEmergency),
        patientName: dto.patientName,
        contactPhone: dto.contactPhone,
        pickupAddress: dto.pickupAddress,
        pickupLat: dto.pickupLat,
        pickupLng: dto.pickupLng,
        dropAddress: dto.dropAddress,
        dropLat: dto.dropLat,
        dropLng: dto.dropLng,
        notes: dto.notes || null,
        estimatedDistanceKm: q.distanceKm,
        baseFare: q.baseFare,
        perKmRate: q.perKmRate,
        emergencySurcharge: q.emergencySurcharge,
        waitingChargePerHour: q.waitingChargePerHour,
        estimatedFare: q.estimatedFare,
        etaMinutes: q.etaMinutes,
        status: S.REQUESTED,
      },
      { transaction }
    );
    await event(created, { to: S.REQUESTED, actorUserId: patientId, actorRole: A.AMBULANCE_ACTOR.PATIENT }, transaction);
    await notify(
      [
        {
          userId: patientId,
          title: "Ambulance booking requested",
          message: `Booking ${created.bookingCode} was sent to ${ambulance.provider.ambulanceProviderProfile?.organizationName || ambulance.provider.name}. You'll be notified as soon as they respond.`,
          type: "ambulance_booking_requested",
          referenceId: created.id,
          referenceType: A.AMBULANCE_NOTIFICATION_REF.BOOKING,
        },
        {
          userId: ambulance.providerId,
          title: dto.isEmergency ? "EMERGENCY ambulance request" : "New ambulance request",
          message: `${created.bookingCode}: ${dto.patientName} — pickup at ${dto.pickupAddress} (${ambulance.vehicleNumber}).`,
          type: "ambulance_booking_received",
          referenceId: created.id,
          referenceType: A.AMBULANCE_NOTIFICATION_REF.BOOKING,
        },
      ],
      transaction
    );
    return created;
  });
  return reload({ id: booking.id, patientId }, "patient");
};

exports.listForPatient = (patientId, { ambulanceId: _ignored, ...query }) => list(listWhere({ patientId }, query), "patient", query);

exports.getForPatient = (patientId, id) => reload({ id, patientId }, "patient");

exports.cancelByPatient = async (patientId, id, { reason }) => {
  await sequelize.transaction(async (transaction) => {
    const booking = await AmbulanceBooking.findOne({ where: { id, patientId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!booking) throw ApiError.notFound("Booking not found");
    if (!A.AMBULANCE_PATIENT_CANCELLABLE.includes(booking.status)) {
      throw ApiError.badRequest("This booking can no longer be cancelled — the ambulance is already on its way.", {
        code: ERROR_CODES.INVALID_STATUS_TRANSITION,
        details: { from: booking.status, allowed: [] },
      });
    }
    const from = booking.status;
    await booking.update(
      { status: S.CANCELLED, cancelledAt: new Date(), cancelledBy: A.AMBULANCE_ACTOR.PATIENT, cancelReason: reason || null },
      { transaction }
    );
    await event(booking, { from, to: S.CANCELLED, actorUserId: patientId, actorRole: A.AMBULANCE_ACTOR.PATIENT, note: reason }, transaction);
    if (A.AMBULANCE_ACTIVE_BOOKING.includes(from)) await releaseAmbulance(booking, transaction);
    await notify(
      {
        userId: booking.providerId,
        title: "Ambulance booking cancelled by patient",
        message: `${booking.bookingCode} was cancelled by the patient${reason ? `: ${reason}` : "."}`,
        type: "ambulance_booking_cancelled",
        referenceId: booking.id,
        referenceType: A.AMBULANCE_NOTIFICATION_REF.BOOKING,
      },
      transaction
    );
  });
  return reload({ id, patientId }, "patient");
};

// ── Provider ─────────────────────────────────────────────────────────────

exports.listForProvider = (providerId, { ambulanceId, ...query }) =>
  list(listWhere({ providerId, ...(ambulanceId ? { ambulanceId } : {}) }, query), "provider", query);

exports.getForProvider = (providerId, id) => reload({ id, providerId }, "provider");

/**
 * The shared provider step: lock → check transition → run the step's own
 * checks/patch → stamp → event → notify, all in one transaction.
 */
async function providerStep(providerId, id, to, { note, patch = {}, before, after, noticeExtra } = {}) {
  await sequelize.transaction(async (transaction) => {
    const booking = await AmbulanceBooking.findOne({ where: { id, providerId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!booking) throw ApiError.notFound("Booking not found");
    const from = booking.status;
    assertTransition(from, to);
    const extra = before ? await before(booking, transaction) : {};
    const stamp = A.AMBULANCE_STATUS_TIMESTAMP[to];
    await booking.update({ ...patch, ...extra, status: to, ...(stamp ? { [stamp]: new Date() } : {}) }, { transaction });
    await event(booking, { from, to, actorUserId: providerId, actorRole: A.AMBULANCE_ACTOR.PROVIDER, note }, transaction);
    if (after) await after(booking, from, transaction);
    const notice = patientNotice(booking, to, { etaMinutes: booking.etaMinutes, ...(noticeExtra ? noticeExtra(booking) : {}) });
    if (notice) await notify(notice, transaction);
  });
  return reload({ id, providerId }, "provider");
}

exports.accept = (providerId, id, { etaMinutes, note }) =>
  providerStep(providerId, id, S.ACCEPTED, {
    note,
    patch: { ...(etaMinutes ? { etaMinutes } : {}), ...(note ? { providerNote: note } : {}) },
    before: async (booking, transaction) => {
      // The vehicle must still be operable and free — lock it, then take it.
      const ambulance = await Ambulance.findOne({
        where: { id: booking.ambulanceId, providerId },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (
        !ambulance ||
        !ambulance.isActive ||
        ambulance.verificationStatus !== A.AMBULANCE_VERIFICATION.APPROVED ||
        ambulance.availabilityStatus !== A.AMBULANCE_AVAILABILITY.AVAILABLE
      ) {
        throw ApiError.conflict(
          "This ambulance isn't available (on another trip, offline, or deactivated). Reject the request or free the ambulance first.",
          { code: ERROR_CODES.AMBULANCE_UNAVAILABLE }
        );
      }
      await ambulance.update({ availabilityStatus: A.AMBULANCE_AVAILABILITY.ON_TRIP }, { transaction });
      return {};
    },
  });

exports.reject = (providerId, id, { reason }) =>
  providerStep(providerId, id, S.REJECTED, {
    note: reason,
    patch: { cancelReason: reason },
    noticeExtra: () => ({ reason }),
  });

/**
 * Assign (accepted → driver_assigned) or REASSIGN (while still
 * driver_assigned, before the ambulance leaves) a driver.
 */
exports.assignDriver = async (providerId, id, { driverId, etaMinutes }) => {
  const checkDriver = async (booking, transaction) => {
    const driver = await fleet.ownDriver(providerId, driverId, transaction);
    if (!driver.isActive) throw ApiError.conflict("This driver is inactive.");
    const busy = await AmbulanceBooking.count({
      where: { driverId: driver.id, id: { [Op.ne]: booking.id }, status: { [Op.in]: fleet.DRIVER_BUSY_STATUSES } },
      transaction,
    });
    if (busy) {
      throw ApiError.conflict(`${driver.name} is already on another trip.`, { code: ERROR_CODES.DRIVER_BUSY });
    }
    return driver;
  };

  // Reassignment keeps the status; it's recorded as a note on the history.
  const current = await AmbulanceBooking.findOne({ where: { id, providerId }, attributes: ["status"] });
  if (!current) throw ApiError.notFound("Booking not found");
  if (current.status === S.DRIVER_ASSIGNED) {
    await sequelize.transaction(async (transaction) => {
      const booking = await AmbulanceBooking.findOne({ where: { id, providerId }, transaction, lock: transaction.LOCK.UPDATE });
      if (booking.status !== S.DRIVER_ASSIGNED) assertTransition(booking.status, S.DRIVER_ASSIGNED);
      const driver = await checkDriver(booking, transaction);
      await booking.update({ driverId: driver.id, ...(etaMinutes ? { etaMinutes } : {}) }, { transaction });
      await event(
        booking,
        { from: S.DRIVER_ASSIGNED, to: S.DRIVER_ASSIGNED, actorUserId: providerId, actorRole: A.AMBULANCE_ACTOR.PROVIDER, note: `Driver changed to ${driver.name}` },
        transaction
      );
      const notice = patientNotice(booking, S.DRIVER_ASSIGNED, { driver, etaMinutes: booking.etaMinutes });
      await notify(notice, transaction);
    });
    return reload({ id, providerId }, "provider");
  }

  let assigned;
  return providerStep(providerId, id, S.DRIVER_ASSIGNED, {
    patch: etaMinutes ? { etaMinutes } : {},
    before: async (booking, transaction) => {
      assigned = await checkDriver(booking, transaction);
      return { driverId: assigned.id };
    },
    noticeExtra: () => ({ driver: assigned }),
  });
};

/** en_route / arrived / patient_picked_up — the simple forward steps. */
exports.progress = (providerId, id, { status, etaMinutes, note }) =>
  providerStep(providerId, id, status, {
    note,
    patch: etaMinutes ? { etaMinutes } : {},
  });

exports.complete = (providerId, id, { actualDistanceKm, waitingMinutes, note }) =>
  providerStep(providerId, id, S.COMPLETED, {
    note,
    before: async (booking) => ({
      actualDistanceKm: actualDistanceKm ?? null,
      waitingMinutes: waitingMinutes ?? null,
      finalFare: finalFare(booking, { actualDistanceKm, waitingMinutes }),
    }),
    after: (booking, _from, transaction) => releaseAmbulance(booking, transaction),
  });

exports.cancelByProvider = (providerId, id, { reason }) =>
  providerStep(providerId, id, S.CANCELLED, {
    note: reason,
    patch: { cancelReason: reason, cancelledBy: A.AMBULANCE_ACTOR.PROVIDER },
    after: (booking, from, transaction) =>
      A.AMBULANCE_ACTIVE_BOOKING.includes(from) ? releaseAmbulance(booking, transaction) : null,
    noticeExtra: () => ({ reason }),
  });

// ── Admin (read-only monitoring) ─────────────────────────────────────────

exports.adminList = ({ providerId, ambulanceId, from, to, ...query }) => {
  const base = {};
  if (providerId) base.providerId = providerId;
  if (ambulanceId) base.ambulanceId = ambulanceId;
  if (from || to) {
    base.createdAt = {};
    if (from) base.createdAt[Op.gte] = from;
    if (to) base.createdAt[Op.lt] = to;
  }
  return list(listWhere(base, query), "admin", query);
};

exports.adminGet = (id) => reload({ id }, "admin");

exports.BUCKET_STATUSES = BUCKET_STATUSES;
