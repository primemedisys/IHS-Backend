/**
 * Patient-facing blood-bank search and history (migration 039).
 *
 * Location: the SAME rule the pharmacy / diagnostic search uses — the
 * patient's Google city/state against the bank's registered location
 * (medicineStore.userLocationWhere). When the patient also shares coordinates
 * and the bank has them, a straight-line distance is added and used to sort.
 *
 * Availability is REAL: a count of AVAILABLE, tested, unexpired units in
 * blood_units, plus when that bank's stock last changed. Nothing is claimed
 * beyond what the rows say, and the UI labels it as indicative — only the
 * blood bank can confirm.
 */
const { Op, fn, col } = require("sequelize");
const {
  User,
  BloodBankProfile,
  BloodUnit,
  BloodDonor,
  BloodDonation,
} = require("../models");
const ApiError = require("../utils/ApiError");
const { userLocationWhere } = require("./medicineStore.service");
const bloodRequestService = require("./bloodRequest.service");
const campService = require("./bloodCamp.service");
const { ROLES } = require("../config/constants");
const B = require("../config/bloodBank");

const BANK_ATTRS = ["id", "name", "phone", "addressLine", "city", "state", "pincode", "lat", "lng"];
const PROFILE_ATTRS = ["centreType", "contactPerson", "emergencyPhone", "operatingHours", "is24x7", "componentsOffered", "district"];

const approvedProfile = {
  model: BloodBankProfile,
  as: "bloodBankProfile",
  attributes: PROFILE_ATTRS,
  where: { verificationStatus: B.BLOOD_BANK_VERIFICATION.APPROVED, isActive: true },
};

/** Great-circle distance in km (haversine). */
function distanceKm(aLat, aLng, bLat, bLng) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(bLat - aLat);
  const dLng = rad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(6371 * 2 * Math.asin(Math.sqrt(h)) * 10) / 10;
}

function shape(bank, stockByBank, lat, lng) {
  const b = bank.toJSON();
  const stock = stockByBank.get(String(b.id));
  const hasCoords = b.lat != null && b.lng != null && lat != null && lng != null;
  return {
    id: String(b.id),
    name: b.name,
    phone: b.phone,
    addressLine: b.addressLine,
    city: b.city,
    state: b.state,
    pincode: b.pincode,
    lat: b.lat == null ? null : Number(b.lat),
    lng: b.lng == null ? null : Number(b.lng),
    ...b.bloodBankProfile,
    componentsOffered: Array.isArray(b.bloodBankProfile?.componentsOffered) ? b.bloodBankProfile.componentsOffered : [],
    distanceKm: hasCoords ? distanceKm(lat, lng, Number(b.lat), Number(b.lng)) : null,
    /** Units of the requested group+component currently AVAILABLE (null when none was asked). */
    availableUnits: stock ? stock.available : 0,
    stockUpdatedAt: stock ? stock.updatedAt : null,
  };
}

/**
 * Approved blood banks in the patient's location, with live availability for
 * the requested blood group + component. Paged; one grouped query for stock.
 */
exports.nearby = async ({ city, state, lat, lng, bloodGroup, component, search, page = 1, limit = 20 } = {}) => {
  const where = { role: ROLES.BLOOD_BANK, isActive: true };
  if (search) where.name = { [Op.like]: `%${search}%` };
  const clauses = userLocationWhere({ city, state });
  if (clauses.length) where[Op.and] = clauses;

  const { rows, count } = await User.findAndCountAll({
    where,
    attributes: BANK_ATTRS,
    include: [approvedProfile],
    order: [["name", "ASC"]],
    limit,
    offset: (page - 1) * limit,
    distinct: true,
  });

  const ids = rows.map((r) => r.id);
  const stockWhere = {
    bloodBankId: { [Op.in]: ids },
    status: B.UNIT_STATUS.AVAILABLE,
    testingStatus: B.TESTING_STATUS.PASSED,
    expiresAt: { [Op.gt]: new Date() },
  };
  if (bloodGroup) stockWhere.bloodGroup = bloodGroup;
  if (component) stockWhere.component = component;
  const stock = ids.length
    ? await BloodUnit.findAll({
        attributes: ["bloodBankId", [fn("COUNT", col("id")), "available"], [fn("MAX", col("updated_at")), "updatedAt"]],
        where: stockWhere,
        group: ["bloodBankId"],
        raw: true,
      })
    : [];
  const stockByBank = new Map(stock.map((s) => [String(s.bloodBankId), { available: Number(s.available), updatedAt: s.updatedAt }]));

  const banks = rows.map((r) => shape(r, stockByBank, lat, lng));
  banks.sort((a, b) => {
    if (a.distanceKm != null && b.distanceKm != null) return a.distanceKm - b.distanceKm;
    return b.availableUnits - a.availableUnits || a.name.localeCompare(b.name);
  });
  return {
    banks,
    total: count,
    page,
    limit,
    totalPages: Math.ceil(count / limit),
    availabilityNote: "Availability is indicative and changes quickly — the blood bank confirms it when it responds.",
  };
};

/** One approved bank's public profile + its AVAILABLE stock grid. */
exports.getBank = async (id) => {
  const bank = await User.findOne({
    where: { id, role: ROLES.BLOOD_BANK, isActive: true },
    attributes: BANK_ATTRS,
    include: [approvedProfile],
  });
  if (!bank) throw ApiError.notFound("Blood bank not found");
  const stock = await BloodUnit.findAll({
    attributes: ["bloodGroup", "component", [fn("COUNT", col("id")), "available"], [fn("MAX", col("updated_at")), "updatedAt"]],
    where: {
      bloodBankId: bank.id,
      status: B.UNIT_STATUS.AVAILABLE,
      testingStatus: B.TESTING_STATUS.PASSED,
      expiresAt: { [Op.gt]: new Date() },
    },
    group: ["bloodGroup", "component"],
    raw: true,
  });
  return {
    ...shape(bank, new Map(), null, null),
    availableUnits: undefined,
    stock: stock.map((s) => ({ ...s, available: Number(s.available), componentLabel: B.BLOOD_COMPONENTS[s.component]?.label || s.component })),
    availabilityNote: "Availability is indicative — the blood bank confirms it when it responds to a request.",
  };
};

/**
 * The patient's blood history: requests, camp registrations and — when a bank
 * linked a donor record to this patient account — their donations.
 */
exports.history = async (patientId) => {
  const [requests, camps, donations] = await Promise.all([
    bloodRequestService.listForPatient(patientId, { page: 1, limit: 50 }),
    campService.myRegistrations(patientId),
    BloodDonation.findAll({
      attributes: ["id", "donationCode", "collectedAt", "volumeMl"],
      include: [
        {
          model: BloodDonor,
          as: "donor",
          attributes: ["id", "bloodGroup"],
          where: { patientUserId: patientId },
          include: [{ model: User, as: "bloodBank", attributes: ["id", "name"] }],
        },
      ],
      order: [["collectedAt", "DESC"]],
      limit: 50,
    }),
  ]);
  return { requests: requests.requests, campRegistrations: camps, donations };
};

/** Static reference data every client can render (groups, components, urgency …). */
exports.reference = () => ({
  bloodGroups: B.BLOOD_GROUPS,
  components: B.BLOOD_COMPONENT_KEYS.map((key) => ({ key, ...B.BLOOD_COMPONENTS[key] })),
  urgency: Object.values(B.BLOOD_URGENCY),
  requestStatuses: Object.values(B.BLOOD_REQUEST_STATUS),
  unitStatuses: Object.values(B.UNIT_STATUS),
  centreTypes: Object.values(B.BLOOD_CENTRE_TYPES),
  expiryWarningDays: B.BLOOD_EXPIRY_WARNING_DAYS,
  redCellCompatibility: B.RED_CELL_COMPATIBILITY,
  plasmaCompatibility: B.PLASMA_COMPATIBILITY,
  compatibilityNote:
    "Reference only. Transfusion compatibility is determined by qualified staff through cross-matching, not by this software.",
});

