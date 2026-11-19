/**
 * A pharmacy's store profile (migration 043): the GSTIN / drug licence number
 * printed on its bills, a bill footer note, and its own "expiring soon"
 * window. The name, phone and address stay on the `users` row they already
 * live on (registration / Google location) — they are read here, not copied.
 */
const { PharmacyProfile, User } = require("../models");
const { DEFAULT_EXPIRY_ALERT_DAYS } = require("../config/pharmacy");

const STORE_ATTRS = ["id", "name", "email", "phone", "role", "addressLine", "city", "state", "pincode"];

/** The saved profile, or the defaults when the pharmacy has never saved one. */
async function getProfile(providerId, { transaction } = {}) {
  const row = await PharmacyProfile.findByPk(providerId, { transaction });
  return {
    gstin: row?.gstin ?? null,
    drugLicenseNumber: row?.drugLicenseNumber ?? null,
    expiryAlertDays: row?.expiryAlertDays ?? DEFAULT_EXPIRY_ALERT_DAYS,
    invoiceNote: row?.invoiceNote ?? null,
  };
}

/** Just the expiry window — used by every "expiring soon" query. */
async function expiryAlertDays(providerId) {
  return (await getProfile(providerId)).expiryAlertDays;
}

/** Store details for a bill header: the registered store + its tax/licence profile. */
async function getStore(providerId, { transaction } = {}) {
  const [user, profile] = await Promise.all([
    User.findByPk(providerId, { attributes: STORE_ATTRS, transaction }),
    getProfile(providerId, { transaction }),
  ]);
  return user ? { ...user.toJSON(), id: Number(user.id), ...profile } : null;
}

exports.getSettings = async (providerId) => {
  const store = await getStore(providerId);
  return { store };
};

exports.updateSettings = async (providerId, dto) => {
  const existing = await PharmacyProfile.findByPk(providerId);
  if (existing) await existing.update(dto);
  else await PharmacyProfile.create({ providerId, ...dto });
  return exports.getSettings(providerId);
};

exports.getProfile = getProfile;
exports.getStore = getStore;
exports.expiryAlertDays = expiryAlertDays;
