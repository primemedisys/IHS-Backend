/**
 * The provider's fleet (migration 040): ambulances and drivers, plus the
 * admin's per-ambulance review / deactivation.
 *
 * Every provider query is scoped by `providerId` (= req.providerId, set by
 * requireApprovedAmbulanceProvider), so a provider can never read or change
 * another provider's vehicle or driver — a foreign id simply 404s.
 *
 * Review rules (the admin approval can't be bypassed):
 *   - a new ambulance starts `pending` and is invisible to patients;
 *   - changing an APPROVED ambulance's identity (registration / vehicle number
 *     / type) sends it back to `pending`;
 *   - editing a REJECTED ambulance resubmits it (`pending`).
 *   Pricing, equipment, availability and base-location edits need no review.
 */
const { Op } = require("sequelize");
const { sequelize, User, Ambulance, AmbulanceDriver, AmbulanceBooking, AmbulanceProviderProfile } = require("../models");
const ApiError = require("../utils/ApiError");
const { ERROR_CODES } = require("../config/constants");
const A = require("../config/ambulance");
const { serializeAmbulance, serializeDriver } = require("../utils/ambulanceSerializers");
const { notify } = require("./ambulanceNotification.service");

const AMBULANCE_FIELDS = [
  "registrationNumber",
  "vehicleNumber",
  "ambulanceType",
  "vehicleModel",
  "vehicleDetails",
  "capacity",
  "equipment",
  "serviceArea",
  "serviceRadiusKm",
  "baseAddress",
  "baseCity",
  "baseState",
  "basePincode",
  "baseLat",
  "baseLng",
  "isEmergencyAvailable",
  "baseFare",
  "perKmRate",
  "waitingChargePerHour",
  "emergencySurcharge",
];
/** Changing any of these on an approved ambulance needs a fresh admin review. */
const IDENTITY_FIELDS = ["registrationNumber", "vehicleNumber", "ambulanceType"];
const DRIVER_FIELDS = ["name", "phone", "licenseNumber", "licenseValidUntil", "emergencyContactName", "emergencyContactPhone"];

/** Driver statuses in which a driver is out on a trip. */
const DRIVER_BUSY_STATUSES = [
  A.AMBULANCE_BOOKING_STATUS.DRIVER_ASSIGNED,
  A.AMBULANCE_BOOKING_STATUS.EN_ROUTE,
  A.AMBULANCE_BOOKING_STATUS.ARRIVED,
  A.AMBULANCE_BOOKING_STATUS.PATIENT_PICKED_UP,
];

const pick = (obj, keys) =>
  Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k] === "" ? null : obj[k]]));

const driverInclude = { model: AmbulanceDriver, as: "defaultDriver" };
const providerInclude = {
  model: User,
  as: "provider",
  attributes: ["id", "name", "email", "phone", "city", "state", "isActive"],
  include: [{ model: AmbulanceProviderProfile, as: "ambulanceProviderProfile" }],
};

/** Registration and vehicle numbers are platform-wide unique; say which one clashed. */
async function assertVehicleUnique({ registrationNumber, vehicleNumber }, excludeId, transaction) {
  const or = [];
  if (registrationNumber) or.push({ registrationNumber });
  if (vehicleNumber) or.push({ vehicleNumber });
  if (!or.length) return;
  const where = { [Op.or]: or };
  if (excludeId) where.id = { [Op.ne]: excludeId };
  const clash = await Ambulance.findOne({ where, attributes: ["registrationNumber", "vehicleNumber"], transaction });
  if (!clash) return;
  const details = {};
  if (registrationNumber && clash.registrationNumber === registrationNumber) {
    details.registrationNumber = ["This registration number is already registered"];
  }
  if (vehicleNumber && clash.vehicleNumber === vehicleNumber) {
    details.vehicleNumber = ["This vehicle number is already registered"];
  }
  throw ApiError.conflict("This ambulance is already registered on the platform.", {
    code: ERROR_CODES.VEHICLE_IN_USE,
    details,
  });
}

async function assertLicenseUnique(providerId, licenseNumber, excludeId, transaction) {
  if (!licenseNumber) return;
  const where = { providerId, licenseNumber };
  if (excludeId) where.id = { [Op.ne]: excludeId };
  if (await AmbulanceDriver.findOne({ where, attributes: ["id"], transaction })) {
    throw ApiError.conflict("A driver with this licence number already exists.", {
      code: ERROR_CODES.VALIDATION_ERROR,
      details: { licenseNumber: ["A driver with this licence number already exists"] },
    });
  }
}

async function ownDriver(providerId, driverId, transaction) {
  const driver = await AmbulanceDriver.findOne({ where: { id: driverId, providerId }, transaction });
  if (!driver) throw ApiError.notFound("Driver not found");
  return driver;
}

async function ownAmbulance(providerId, id, transaction, lock) {
  const ambulance = await Ambulance.findOne({ where: { id, providerId }, transaction, ...(lock ? { lock } : {}) });
  if (!ambulance) throw ApiError.notFound("Ambulance not found");
  return ambulance;
}

function loadAmbulance(providerId, id) {
  return Ambulance.findOne({ where: { id, providerId }, include: [driverInclude] });
}

// ── Row creators (shared by signup and the portal) ───────────────────────

/** Insert one ambulance for a provider (always `pending`). */
async function createAmbulanceRow(providerId, dto, transaction) {
  await assertVehicleUnique(dto, null, transaction);
  if (dto.defaultDriverId) await ownDriver(providerId, dto.defaultDriverId, transaction);
  return Ambulance.create(
    {
      ...pick(dto, AMBULANCE_FIELDS),
      providerId,
      defaultDriverId: dto.defaultDriverId || null,
      verificationStatus: A.AMBULANCE_VERIFICATION.PENDING,
      availabilityStatus: A.AMBULANCE_AVAILABILITY.AVAILABLE,
    },
    { transaction }
  );
}

async function createDriverRow(providerId, dto, transaction) {
  await assertLicenseUnique(providerId, dto.licenseNumber, null, transaction);
  return AmbulanceDriver.create({ ...pick(dto, DRIVER_FIELDS), providerId }, { transaction });
}

exports.createAmbulanceRow = createAmbulanceRow;
exports.createDriverRow = createDriverRow;

// ── Ambulances (provider) ────────────────────────────────────────────────

exports.listAmbulances = async (providerId, { verificationStatus, availabilityStatus, ambulanceType, search, page = 1, limit = 20 } = {}) => {
  const where = { providerId };
  if (verificationStatus) where.verificationStatus = verificationStatus;
  if (availabilityStatus) where.availabilityStatus = availabilityStatus;
  if (ambulanceType) where.ambulanceType = ambulanceType;
  if (search) {
    where[Op.or] = [
      { vehicleNumber: { [Op.like]: `%${search}%` } },
      { registrationNumber: { [Op.like]: `%${search}%` } },
      { vehicleModel: { [Op.like]: `%${search}%` } },
    ];
  }
  const { rows, count } = await Ambulance.findAndCountAll({
    where,
    include: [driverInclude],
    order: [["createdAt", "DESC"]],
    limit,
    offset: (page - 1) * limit,
  });
  return {
    ambulances: rows.map((a) => serializeAmbulance(a, "provider")),
    total: count,
    page,
    limit,
    totalPages: Math.ceil(count / limit),
  };
};

exports.getAmbulance = async (providerId, id) => {
  const ambulance = await loadAmbulance(providerId, id);
  if (!ambulance) throw ApiError.notFound("Ambulance not found");
  return serializeAmbulance(ambulance, "provider");
};

exports.createAmbulance = async (providerId, dto) => {
  const created = await sequelize.transaction((transaction) => createAmbulanceRow(providerId, dto, transaction));
  return exports.getAmbulance(providerId, created.id);
};

exports.updateAmbulance = async (providerId, id, dto) => {
  await sequelize.transaction(async (transaction) => {
    const ambulance = await ownAmbulance(providerId, id, transaction, transaction.LOCK.UPDATE);
    const patch = pick(dto, AMBULANCE_FIELDS);
    await assertVehicleUnique(
      { registrationNumber: patch.registrationNumber, vehicleNumber: patch.vehicleNumber },
      ambulance.id,
      transaction
    );

    const identityChanged = IDENTITY_FIELDS.some((f) => patch[f] !== undefined && patch[f] !== ambulance[f]);
    const status = ambulance.verificationStatus;
    if (
      status === A.AMBULANCE_VERIFICATION.REJECTED ||
      (status === A.AMBULANCE_VERIFICATION.APPROVED && identityChanged)
    ) {
      Object.assign(patch, { verificationStatus: A.AMBULANCE_VERIFICATION.PENDING, verifiedAt: null });
    }
    await ambulance.update(patch, { transaction });
  });
  return exports.getAmbulance(providerId, id);
};

/** available / offline / maintenance. `on_trip` belongs to the booking workflow. */
exports.setAvailability = async (providerId, id, { availabilityStatus }) => {
  await sequelize.transaction(async (transaction) => {
    const ambulance = await ownAmbulance(providerId, id, transaction, transaction.LOCK.UPDATE);
    if (ambulance.availabilityStatus === A.AMBULANCE_AVAILABILITY.ON_TRIP) {
      throw ApiError.conflict("This ambulance is on a trip. Complete or cancel the trip first.", {
        code: ERROR_CODES.AMBULANCE_UNAVAILABLE,
      });
    }
    await ambulance.update({ availabilityStatus }, { transaction });
  });
  return exports.getAmbulance(providerId, id);
};

exports.setDefaultDriver = async (providerId, id, { driverId }) => {
  await sequelize.transaction(async (transaction) => {
    const ambulance = await ownAmbulance(providerId, id, transaction);
    if (driverId) {
      const driver = await ownDriver(providerId, driverId, transaction);
      if (!driver.isActive) throw ApiError.conflict("This driver is inactive.");
    }
    await ambulance.update({ defaultDriverId: driverId || null }, { transaction });
  });
  return exports.getAmbulance(providerId, id);
};

// ── Drivers (provider) ───────────────────────────────────────────────────

exports.listDrivers = async (providerId, { search, isActive, page = 1, limit = 20 } = {}) => {
  const where = { providerId };
  if (isActive !== undefined) where.isActive = isActive;
  if (search) {
    where[Op.or] = [
      { name: { [Op.like]: `%${search}%` } },
      { phone: { [Op.like]: `%${search}%` } },
      { licenseNumber: { [Op.like]: `%${search}%` } },
    ];
  }
  const { rows, count } = await AmbulanceDriver.findAndCountAll({
    where,
    order: [["name", "ASC"]],
    limit,
    offset: (page - 1) * limit,
  });

  // Which of these drivers are out on a trip right now — one query for the page.
  const busy = rows.length
    ? await AmbulanceBooking.findAll({
        attributes: ["driverId", "bookingCode", "status"],
        where: { driverId: { [Op.in]: rows.map((d) => d.id) }, status: { [Op.in]: DRIVER_BUSY_STATUSES } },
        raw: true,
      })
    : [];
  const tripByDriver = new Map(busy.map((b) => [String(b.driverId), b]));
  return {
    drivers: rows.map((d) => {
      const trip = tripByDriver.get(String(d.id));
      return { ...serializeDriver(d), currentTrip: trip ? { bookingCode: trip.bookingCode, status: trip.status } : null };
    }),
    total: count,
    page,
    limit,
    totalPages: Math.ceil(count / limit),
  };
};

exports.getDriver = async (providerId, id) => serializeDriver(await ownDriver(providerId, id));

exports.createDriver = async (providerId, dto) => {
  const driver = await sequelize.transaction((transaction) => createDriverRow(providerId, dto, transaction));
  return serializeDriver(driver);
};

exports.updateDriver = async (providerId, id, dto) => {
  await sequelize.transaction(async (transaction) => {
    const driver = await ownDriver(providerId, id, transaction);
    const patch = pick(dto, [...DRIVER_FIELDS, "isActive"]);
    await assertLicenseUnique(providerId, patch.licenseNumber, driver.id, transaction);
    if (patch.isActive === false && driver.isActive) {
      const onTrip = await AmbulanceBooking.count({
        where: { driverId: driver.id, status: { [Op.in]: DRIVER_BUSY_STATUSES } },
        transaction,
      });
      if (onTrip) {
        throw ApiError.conflict("This driver is on an active trip and can't be deactivated now.", {
          code: ERROR_CODES.DRIVER_BUSY,
        });
      }
      // An inactive driver can't stay an ambulance's default.
      await Ambulance.update({ defaultDriverId: null }, { where: { providerId, defaultDriverId: driver.id }, transaction });
    }
    await driver.update(patch, { transaction });
  });
  return exports.getDriver(providerId, id);
};

exports.DRIVER_BUSY_STATUSES = DRIVER_BUSY_STATUSES;
exports.ownDriver = ownDriver;

// ── Admin: ambulances ────────────────────────────────────────────────────

exports.adminListAmbulances = async ({
  verificationStatus,
  availabilityStatus,
  ambulanceType,
  providerId,
  isActive,
  search,
  page = 1,
  limit = 20,
} = {}) => {
  const where = {};
  if (verificationStatus) where.verificationStatus = verificationStatus;
  if (availabilityStatus) where.availabilityStatus = availabilityStatus;
  if (ambulanceType) where.ambulanceType = ambulanceType;
  if (providerId) where.providerId = providerId;
  if (isActive !== undefined) where.isActive = isActive;
  if (search) {
    where[Op.or] = [
      { vehicleNumber: { [Op.like]: `%${search}%` } },
      { registrationNumber: { [Op.like]: `%${search}%` } },
      { baseCity: { [Op.like]: `%${search}%` } },
      { "$provider.name$": { [Op.like]: `%${search}%` } },
    ];
  }
  const { rows, count } = await Ambulance.findAndCountAll({
    where,
    include: [providerInclude, driverInclude],
    order: [["createdAt", "DESC"]],
    limit,
    offset: (page - 1) * limit,
    distinct: true,
    subQuery: false,
  });
  return {
    ambulances: rows.map((a) => serializeAmbulance(a, "admin")),
    total: count,
    page,
    limit,
    totalPages: Math.ceil(count / limit),
  };
};

async function adminLoadAmbulance(id) {
  const ambulance = await Ambulance.findByPk(id, { include: [providerInclude, driverInclude] });
  if (!ambulance) throw ApiError.notFound("Ambulance not found");
  return ambulance;
}

exports.adminGetAmbulance = async (id) => serializeAmbulance(await adminLoadAmbulance(id), "admin");

exports.adminVerifyAmbulance = async (_adminId, id, { decision, notes }) => {
  const ambulance = await adminLoadAmbulance(id);
  const approved = decision === A.AMBULANCE_VERIFICATION.APPROVED;
  await sequelize.transaction(async (transaction) => {
    await ambulance.update(
      { verificationStatus: decision, verificationNotes: notes || null, verifiedAt: new Date() },
      { transaction }
    );
    await notify(
      {
        userId: ambulance.providerId,
        title: approved ? `Ambulance ${ambulance.vehicleNumber} approved` : `Ambulance ${ambulance.vehicleNumber} declined`,
        message: approved
          ? "This ambulance is verified and can now receive bookings while it is marked available."
          : `This ambulance was declined${notes ? `: ${notes}` : "."} Correct its details to resubmit it.`,
        type: approved ? "ambulance_approved" : "ambulance_rejected",
        referenceId: ambulance.id,
        referenceType: A.AMBULANCE_NOTIFICATION_REF.AMBULANCE,
      },
      transaction
    );
  });
  return exports.adminGetAmbulance(id);
};

/** Deactivate / reactivate (hides it from search; its verification decision is kept). */
exports.adminSetAmbulanceActive = async (_adminId, id, isActive) => {
  const ambulance = await adminLoadAmbulance(id);
  await sequelize.transaction(async (transaction) => {
    await ambulance.update({ isActive }, { transaction });
    await notify(
      {
        userId: ambulance.providerId,
        title: isActive ? `Ambulance ${ambulance.vehicleNumber} reactivated` : `Ambulance ${ambulance.vehicleNumber} deactivated`,
        message: isActive
          ? "An administrator reactivated this ambulance."
          : "An administrator deactivated this ambulance. It is hidden from patients until it is reactivated.",
        type: isActive ? "ambulance_reactivated" : "ambulance_deactivated",
        referenceId: ambulance.id,
        referenceType: A.AMBULANCE_NOTIFICATION_REF.AMBULANCE,
      },
      transaction
    );
  });
  return exports.adminGetAmbulance(id);
};
