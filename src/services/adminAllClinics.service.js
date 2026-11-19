/**
 * Admin "all clinics" registry — every clinic account on the platform,
 * newest registered first, with optional search and status filtering.
 *
 * Distinct from clinicPortal.service.listForReview which only shows one
 * verification status at a time. This lists ALL clinics regardless of status
 * and is the read side of "who is on the platform" for clinic accounts.
 */
const { Op } = require("sequelize");
const { ClinicProfile, User } = require("../models");

/** Case-insensitive contains-match on identity fields, when `q` is given. */
const searchWhere = (q) =>
  q
    ? {
        [Op.or]: [
          { clinicName: { [Op.like]: `%${q}%` } },
          { "$user.email$": { [Op.like]: `%${q}%` } },
          { phone: { [Op.like]: `%${q}%` } },
        ],
      }
    : {};

/**
 * Every registered clinic, newest first, with profile facts the list shows.
 * Supports optional filtering by city, state, location, and verification status.
 * `location` matches against EITHER city or state (OR).
 */
async function listAll({ q, city, state, verificationStatus, location } = {}) {
  const where = {};

  if (q) {
    Object.assign(where, searchWhere(q));
  }
  if (city) where.city = { [Op.like]: `%${city}%` };
  if (state) where.state = { [Op.like]: `%${state}%` };
  if (verificationStatus) where.verificationStatus = verificationStatus;
  // `location` matches against EITHER city or state (OR).
  if (location) {
    where[Op.or] = [
      { city: { [Op.like]: `%${location}%` } },
      { state: { [Op.like]: `%${location}%` } },
    ];
  }

  return ClinicProfile.findAll({
    where,
    include: [
      { model: User, as: "user", attributes: ["id", "name", "email", "phone", "profilePhotoUrl"] },
    ],
    order: [["createdAt", "DESC"]],
  });
}

module.exports = { listAll };
