/**
 * Ambulance provider account + profile (migration 040): the signup split, the
 * provider's own profile, and the admin verification queue — the same
 * lifecycle as the blood bank (pending → approved | rejected, plus is_active
 * suspension), with one addition the blood bank lacks: a REJECTED provider can
 * correct its details and resubmit (back to pending).
 *
 * The organisation's address / Google location stays on the users row (the
 * columns every provider uses, migration 034).
 */
const { Op } = require("sequelize");
const { sequelize, User, AmbulanceProviderProfile, Ambulance, AmbulanceDriver } = require("../models");
const ApiError = require("../utils/ApiError");
const { ROLES } = require("../config/constants");
const A = require("../config/ambulance");
const { serializeProvider, serializeAmbulance, serializeDriver } = require("../utils/ambulanceSerializers");
const { notify } = require("./ambulanceNotification.service");
const fleet = require("./ambulanceFleet.service");

const USER_ATTRS = ["id", "name", "email", "phone", "addressLine", "city", "state", "pincode", "lat", "lng", "isActive", "createdAt"];
const PROFILE_FIELDS = ["contactPerson", "emergencyPhone", "district", "is24x7", "about"];
const USER_FIELDS = ["name", "phone", "addressLine", "city", "state", "pincode", "lat", "lng"];

const pick = (obj, keys) =>
  Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k] === "" ? null : obj[k]]));

const profileInclude = { model: AmbulanceProviderProfile, as: "ambulanceProviderProfile" };

/**
 * Split a validated signup body into the users-row part (for
 * authService.registerLocal), the profile overrides, and an `afterCreate` hook
 * that creates the first ambulance (+ optional driver) in the SAME transaction.
 */
function splitRegistration(body) {
  const user = {
    ...pick(body, ["name", "email", "phone", "password", ...USER_FIELDS]),
    role: ROLES.AMBULANCE_PROVIDER,
  };
  const profile = { ...pick(body, PROFILE_FIELDS), organizationName: body.name, phone: body.phone };
  const afterCreate = async (created, transaction) => {
    let driverId = null;
    if (body.driver) {
      const driver = await fleet.createDriverRow(created.id, body.driver, transaction);
      driverId = driver.id;
    }
    await fleet.createAmbulanceRow(created.id, { ...body.ambulance, defaultDriverId: driverId }, transaction);
  };
  return { user, profile, afterCreate };
}

async function loadProvider(userId) {
  const user = await User.findOne({
    where: { id: userId, role: ROLES.AMBULANCE_PROVIDER },
    attributes: USER_ATTRS,
    include: [profileInclude],
  });
  if (!user) throw ApiError.notFound("Ambulance provider not found");
  // Defensive (same as the blood bank): an account whose profile row is missing
  // gets a pending one, so the portal can always load.
  if (!user.ambulanceProviderProfile) {
    await AmbulanceProviderProfile.create({ userId: user.id, organizationName: user.name, phone: user.phone || null });
    return loadProvider(userId);
  }
  return user;
}

exports.splitRegistration = splitRegistration;
exports.loadProvider = loadProvider;

exports.getOwn = async (userId) => serializeProvider(await loadProvider(userId));

exports.updateOwn = async (userId, dto) => {
  const user = await loadProvider(userId);
  const userPatch = pick(dto, USER_FIELDS);
  const profilePatch = pick(dto, PROFILE_FIELDS);
  if (userPatch.name) profilePatch.organizationName = userPatch.name;
  if (userPatch.phone) profilePatch.phone = userPatch.phone;

  await sequelize.transaction(async (transaction) => {
    if (Object.keys(userPatch).length) await user.update(userPatch, { transaction });
    if (Object.keys(profilePatch).length) await user.ambulanceProviderProfile.update(profilePatch, { transaction });
  });
  return serializeProvider(await loadProvider(userId));
};

/** A rejected provider, after correcting its details, asks for review again. */
exports.resubmit = async (userId) => {
  const user = await loadProvider(userId);
  const profile = user.ambulanceProviderProfile;
  if (profile.verificationStatus !== A.AMBULANCE_VERIFICATION.REJECTED) {
    throw ApiError.conflict("Only a declined registration can be resubmitted.");
  }
  await profile.update({ verificationStatus: A.AMBULANCE_VERIFICATION.PENDING, verifiedAt: null });
  return serializeProvider(await loadProvider(userId));
};

// ── Admin verification queue ─────────────────────────────────────────────

exports.adminList = async ({ verificationStatus, search, page = 1, limit = 20 } = {}) => {
  const where = { role: ROLES.AMBULANCE_PROVIDER };
  if (search) {
    where[Op.or] = [
      { name: { [Op.like]: `%${search}%` } },
      { email: { [Op.like]: `%${search}%` } },
      { city: { [Op.like]: `%${search}%` } },
    ];
  }
  const profileWhere = verificationStatus ? { verificationStatus } : undefined;
  const { rows, count } = await User.findAndCountAll({
    where,
    attributes: USER_ATTRS,
    include: [{ ...profileInclude, where: profileWhere, required: Boolean(profileWhere) }],
    order: [["createdAt", "DESC"]],
    limit,
    offset: (page - 1) * limit,
    distinct: true,
  });

  // Fleet counts for the page in ONE grouped query (no per-row lookups).
  const ids = rows.map((r) => r.id);
  const counts = ids.length
    ? await Ambulance.findAll({
        attributes: [
          "providerId",
          [sequelize.fn("COUNT", sequelize.col("id")), "total"],
          [sequelize.literal(`SUM(verification_status = '${A.AMBULANCE_VERIFICATION.PENDING}')`), "pending"],
        ],
        where: { providerId: { [Op.in]: ids } },
        group: ["providerId"],
        raw: true,
      })
    : [];
  const byProvider = new Map(counts.map((c) => [String(c.providerId), c]));

  return {
    providers: rows.map((r) => {
      const c = byProvider.get(String(r.id));
      return { ...serializeProvider(r), ambulanceCount: Number(c?.total || 0), pendingAmbulances: Number(c?.pending || 0) };
    }),
    total: count,
    page,
    limit,
    totalPages: Math.ceil(count / limit),
  };
};

/** One provider with its full fleet and drivers — what the admin reviews. */
exports.adminGet = async (id) => {
  const user = await loadProvider(id);
  const [ambulances, drivers] = await Promise.all([
    Ambulance.findAll({
      where: { providerId: user.id },
      include: [{ model: AmbulanceDriver, as: "defaultDriver" }],
      order: [["createdAt", "ASC"]],
    }),
    AmbulanceDriver.findAll({ where: { providerId: user.id }, order: [["createdAt", "ASC"]] }),
  ]);
  return {
    ...serializeProvider(user),
    ambulances: ambulances.map((a) => serializeAmbulance(a, "admin")),
    drivers: drivers.map(serializeDriver),
  };
};

/**
 * Approve or reject a provider. On approval the ambulances still pending
 * review are approved with it (unless the admin opts out), so a fresh signup
 * becomes bookable in one decision. Rejection leaves ambulances untouched —
 * they are hidden anyway while the provider is not approved.
 */
exports.adminVerify = async (adminId, id, { decision, notes, approvePendingAmbulances = true }) => {
  const user = await loadProvider(id);
  const profile = user.ambulanceProviderProfile;
  const approved = decision === A.AMBULANCE_VERIFICATION.APPROVED;
  await sequelize.transaction(async (transaction) => {
    await profile.update(
      { verificationStatus: decision, verificationNotes: notes || null, verifiedAt: new Date() },
      { transaction }
    );
    if (approved && approvePendingAmbulances) {
      await Ambulance.update(
        { verificationStatus: A.AMBULANCE_VERIFICATION.APPROVED, verificationNotes: null, verifiedAt: new Date() },
        { where: { providerId: user.id, verificationStatus: A.AMBULANCE_VERIFICATION.PENDING }, transaction }
      );
    }
    await notify(
      {
        userId: user.id,
        title: approved ? "Ambulance service approved" : "Ambulance service verification declined",
        message: approved
          ? "Your ambulance service has been verified. Approved ambulances are now visible to patients and can receive bookings."
          : `Your verification was declined${notes ? `: ${notes}` : "."} Correct your details and resubmit from your profile.`,
        type: approved ? "ambulance_provider_approved" : "ambulance_provider_rejected",
        referenceId: user.id,
        referenceType: A.AMBULANCE_NOTIFICATION_REF.PROVIDER,
      },
      transaction
    );
  });
  return exports.adminGet(id);
};

/** Suspend / reinstate without touching the verification decision. */
exports.adminSetActive = async (_adminId, id, isActive) => {
  const user = await loadProvider(id);
  await user.ambulanceProviderProfile.update({ isActive });
  return exports.adminGet(id);
};
