/**
 * Blood Bank account + profile (migration 039): signup split, own profile,
 * and the admin verification queue — the same lifecycle as the clinic portal
 * (pending → approved | rejected, plus is_active suspension).
 *
 * The centre's address/Google location stays on the users row (the columns
 * every provider uses, migration 034) so the EXISTING location matcher
 * (medicineStore.userLocationWhere) finds blood banks exactly like pharmacies.
 */
const { Op } = require("sequelize");
const { sequelize, User, BloodBankProfile } = require("../models");
const ApiError = require("../utils/ApiError");
const audit = require("./bloodAudit.service");
const { ROLES } = require("../config/constants");
const B = require("../config/bloodBank");

const USER_ATTRS = ["id", "name", "email", "phone", "addressLine", "city", "state", "pincode", "lat", "lng", "isActive", "createdAt"];
const PROFILE_FIELDS = [
  "centreType",
  "licenseNumber",
  "licenseValidUntil",
  "contactPerson",
  "emergencyPhone",
  "district",
  "operatingHours",
  "is24x7",
  "componentsOffered",
  "about",
];
const USER_FIELDS = ["name", "phone", "addressLine", "city", "state", "pincode", "lat", "lng"];

const pick = (obj, keys) =>
  Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k] === "" ? null : obj[k]]));

/** The flat shape every client reads: account + centre + location + verification. */
function serialize(user) {
  const u = user.toJSON ? user.toJSON() : user;
  const p = u.bloodBankProfile || {};
  return {
    id: String(u.id),
    name: u.name,
    email: u.email,
    phone: u.phone ?? null,
    addressLine: u.addressLine ?? null,
    city: u.city ?? null,
    state: u.state ?? null,
    pincode: u.pincode ?? null,
    lat: u.lat == null ? null : Number(u.lat),
    lng: u.lng == null ? null : Number(u.lng),
    centreName: p.centreName ?? u.name,
    centreType: p.centreType ?? null,
    licenseNumber: p.licenseNumber ?? null,
    licenseValidUntil: p.licenseValidUntil ?? null,
    contactPerson: p.contactPerson ?? null,
    emergencyPhone: p.emergencyPhone ?? null,
    district: p.district ?? null,
    operatingHours: p.operatingHours ?? null,
    is24x7: Boolean(p.is24x7),
    componentsOffered: Array.isArray(p.componentsOffered) ? p.componentsOffered : [],
    about: p.about ?? null,
    verificationStatus: p.verificationStatus ?? B.BLOOD_BANK_VERIFICATION.PENDING,
    verificationNotes: p.verificationNotes ?? null,
    verifiedAt: p.verifiedAt ?? null,
    isActive: Boolean(u.isActive) && p.isActive !== false,
    createdAt: u.createdAt,
  };
}

/**
 * Split a validated signup body into the users-row part (passed to
 * authService.registerLocal) and the profile part (its `profile` overrides).
 */
function splitRegistration(body) {
  const user = {
    ...pick(body, ["name", "email", "phone", "password", ...USER_FIELDS]),
    role: ROLES.BLOOD_BANK,
  };
  const profile = { ...pick(body, PROFILE_FIELDS), centreName: body.name, phone: body.phone };
  return { user, profile };
}

async function loadBank(userId) {
  const user = await User.findOne({
    where: { id: userId, role: ROLES.BLOOD_BANK },
    attributes: USER_ATTRS,
    include: [{ model: BloodBankProfile, as: "bloodBankProfile" }],
  });
  if (!user) throw ApiError.notFound("Blood bank not found");
  // Defensive (same as requireApprovedClinic): an account whose profile row
  // is missing gets a pending one, so the portal can always load.
  if (!user.bloodBankProfile) {
    await BloodBankProfile.create({ userId: user.id, centreName: user.name, phone: user.phone || null });
    return loadBank(userId);
  }
  return user;
}

exports.serialize = serialize;
exports.splitRegistration = splitRegistration;
exports.loadBank = loadBank;

exports.getOwn = async (userId) => serialize(await loadBank(userId));

exports.updateOwn = async (userId, dto) => {
  const user = await loadBank(userId);
  const userPatch = pick(dto, USER_FIELDS);
  const profilePatch = pick(dto, PROFILE_FIELDS);
  if (userPatch.name) profilePatch.centreName = userPatch.name;
  if (userPatch.phone) profilePatch.phone = userPatch.phone;

  await sequelize.transaction(async (transaction) => {
    if (Object.keys(userPatch).length) await user.update(userPatch, { transaction });
    if (Object.keys(profilePatch).length) await user.bloodBankProfile.update(profilePatch, { transaction });
    await audit.record(
      {
        bloodBankId: user.id,
        actorUserId: userId,
        entityType: B.BLOOD_AUDIT_ENTITY.PROFILE,
        entityId: user.id,
        action: "profile_updated",
        details: { fields: [...Object.keys(userPatch), ...Object.keys(profilePatch)] },
      },
      transaction
    );
  });
  return serialize(await loadBank(userId));
};

// ── Admin verification queue ─────────────────────────────────────────────

exports.adminList = async ({ verificationStatus, search, page = 1, limit = 20 } = {}) => {
  const where = { role: ROLES.BLOOD_BANK };
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
    include: [{ model: BloodBankProfile, as: "bloodBankProfile", where: profileWhere, required: Boolean(profileWhere) }],
    order: [["createdAt", "DESC"]],
    limit,
    offset: (page - 1) * limit,
    distinct: true,
  });
  return { banks: rows.map(serialize), total: count, page, limit, totalPages: Math.ceil(count / limit) };
};

exports.adminGet = async (id) => serialize(await loadBank(id));

/** Approve or reject. The bank is notified through the existing notification table. */
exports.adminVerify = async (adminId, id, { decision, notes }) => {
  const user = await loadBank(id);
  const profile = user.bloodBankProfile;
  const from = profile.verificationStatus;
  await sequelize.transaction(async (transaction) => {
    await profile.update(
      { verificationStatus: decision, verificationNotes: notes || null, verifiedAt: new Date() },
      { transaction }
    );
    await audit.record(
      {
        bloodBankId: user.id,
        actorUserId: adminId,
        entityType: B.BLOOD_AUDIT_ENTITY.PROFILE,
        entityId: user.id,
        action: "verification_decided",
        fromStatus: from,
        toStatus: decision,
        details: notes ? { notes } : null,
      },
      transaction
    );
    const approved = decision === B.BLOOD_BANK_VERIFICATION.APPROVED;
    await audit.notify(
      {
        userId: user.id,
        title: approved ? "Blood bank approved" : "Blood bank verification declined",
        message: approved
          ? "Your blood bank has been verified. You can now receive patient blood requests."
          : `Your verification was declined${notes ? `: ${notes}` : "."} Update your details and contact support.`,
        type: approved ? "blood_bank_approved" : "blood_bank_rejected",
        referenceId: user.id,
        referenceType: B.BLOOD_NOTIFICATION_REF.PROFILE,
      },
      transaction
    );
  });
  return serialize(await loadBank(id));
};

/** Suspend / reinstate without touching the verification decision. */
exports.adminSetActive = async (adminId, id, isActive) => {
  const user = await loadBank(id);
  await sequelize.transaction(async (transaction) => {
    await user.bloodBankProfile.update({ isActive }, { transaction });
    await audit.record(
      {
        bloodBankId: user.id,
        actorUserId: adminId,
        entityType: B.BLOOD_AUDIT_ENTITY.PROFILE,
        entityId: user.id,
        action: isActive ? "reinstated" : "suspended",
      },
      transaction
    );
  });
  return serialize(await loadBank(id));
};
