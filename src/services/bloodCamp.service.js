/**
 * Blood donation camps (migration 039): a blood bank schedules camps; patients
 * see upcoming camps of APPROVED banks and register to donate.
 */
const { Op } = require("sequelize");
const { sequelize, User, BloodBankProfile, BloodCamp, BloodCampRegistration } = require("../models");
const ApiError = require("../utils/ApiError");
const audit = require("./bloodAudit.service");
const { own } = require("./bloodDonor.service");
const { ROLES } = require("../config/constants");
const B = require("../config/bloodBank");

const REF = B.BLOOD_NOTIFICATION_REF.CAMP;

function localIsoDate(d = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function assertTimes({ startTime, endTime }) {
  if (startTime && endTime && endTime <= startTime) throw ApiError.badRequest("End time must be after start time");
}

// ── Blood bank ───────────────────────────────────────────────────────────

exports.list = async (bloodBankId, { status, upcoming, page = 1, limit = 20 } = {}) => {
  const where = { bloodBankId };
  if (status) where.status = status;
  if (upcoming) where.campDate = { [Op.gte]: localIsoDate() };
  const { rows, count } = await BloodCamp.findAndCountAll({
    where,
    order: [["campDate", upcoming ? "ASC" : "DESC"], ["startTime", "ASC"]],
    limit,
    offset: (page - 1) * limit,
  });
  const ids = rows.map((r) => r.id);
  const counts = ids.length
    ? await BloodCampRegistration.findAll({
        attributes: ["campId", [sequelize.fn("COUNT", sequelize.col("id")), "n"]],
        where: { campId: { [Op.in]: ids }, status: { [Op.ne]: B.CAMP_REGISTRATION_STATUS.CANCELLED } },
        group: ["campId"],
        raw: true,
      })
    : [];
  const byCamp = new Map(counts.map((c) => [String(c.campId), Number(c.n)]));
  return {
    camps: rows.map((r) => ({ ...r.toJSON(), registrations: byCamp.get(String(r.id)) || 0 })),
    total: count,
    page,
    limit,
    totalPages: Math.ceil(count / limit),
  };
};

exports.get = async (bloodBankId, id) =>
  own(BloodCamp, bloodBankId, id, "Camp", {
    include: [{ model: BloodCampRegistration, as: "registrations", separate: true, order: [["createdAt", "ASC"]] }],
  });

exports.create = async (bloodBankId, actorId, dto) => {
  assertTimes(dto);
  if (dto.campDate < localIsoDate()) throw ApiError.badRequest("Camp date cannot be in the past");
  return sequelize.transaction(async (transaction) => {
    const camp = await BloodCamp.create({ ...dto, bloodBankId, createdBy: actorId }, { transaction });
    await audit.record(
      {
        bloodBankId,
        actorUserId: actorId,
        entityType: B.BLOOD_AUDIT_ENTITY.CAMP,
        entityId: camp.id,
        action: "camp_created",
        toStatus: camp.status,
        details: { name: camp.name, campDate: camp.campDate },
      },
      transaction
    );
    return camp;
  });
};

exports.update = async (bloodBankId, actorId, id, dto) => {
  const camp = await own(BloodCamp, bloodBankId, id, "Camp");
  assertTimes({ startTime: dto.startTime || camp.startTime, endTime: dto.endTime || camp.endTime });
  const from = camp.status;
  await sequelize.transaction(async (transaction) => {
    await camp.update(dto, { transaction });
    await audit.record(
      {
        bloodBankId,
        actorUserId: actorId,
        entityType: B.BLOOD_AUDIT_ENTITY.CAMP,
        entityId: camp.id,
        action: "camp_updated",
        fromStatus: from,
        toStatus: camp.status,
        details: { fields: Object.keys(dto) },
      },
      transaction
    );
    // Tell registered donors when a camp is cancelled.
    if (dto.status === B.CAMP_STATUS.CANCELLED && from !== B.CAMP_STATUS.CANCELLED) {
      const regs = await BloodCampRegistration.findAll({
        where: { campId: camp.id, status: B.CAMP_REGISTRATION_STATUS.REGISTERED },
        attributes: ["patientId"],
        transaction,
      });
      await audit.notify(
        regs.map((r) => ({
          userId: r.patientId,
          title: "Blood donation camp cancelled",
          message: `${camp.name} on ${camp.campDate} has been cancelled by the organiser.`,
          type: "blood_camp_cancelled",
          referenceId: camp.id,
          referenceType: REF,
        })),
        transaction
      );
    }
  });
  return exports.get(bloodBankId, id);
};

exports.setRegistrationStatus = async (bloodBankId, campId, registrationId, status) => {
  await own(BloodCamp, bloodBankId, campId, "Camp");
  const reg = await BloodCampRegistration.findOne({ where: { id: registrationId, campId } });
  if (!reg) throw ApiError.notFound("Registration not found");
  if (reg.status === B.CAMP_REGISTRATION_STATUS.CANCELLED) throw ApiError.conflict("This registration was cancelled");
  await reg.update({ status });
  return reg;
};

// ── Patient ──────────────────────────────────────────────────────────────

/** Upcoming scheduled camps of approved, active blood banks. */
exports.listPublic = async ({ city, state, page = 1, limit = 20 } = {}) => {
  const where = { status: B.CAMP_STATUS.SCHEDULED, campDate: { [Op.gte]: localIsoDate() } };
  if (city) where.city = { [Op.like]: city };
  if (state) where.state = { [Op.like]: state };
  const { rows, count } = await BloodCamp.findAndCountAll({
    where,
    include: [
      {
        model: User,
        as: "bloodBank",
        attributes: ["id", "name", "phone", "city", "state"],
        where: { isActive: true, role: ROLES.BLOOD_BANK },
        include: [
          {
            model: BloodBankProfile,
            as: "bloodBankProfile",
            attributes: [],
            where: { verificationStatus: B.BLOOD_BANK_VERIFICATION.APPROVED, isActive: true },
          },
        ],
      },
    ],
    order: [["campDate", "ASC"], ["startTime", "ASC"]],
    limit,
    offset: (page - 1) * limit,
    distinct: true,
  });
  return { camps: rows, total: count, page, limit, totalPages: Math.ceil(count / limit) };
};

exports.register = async (patientId, campId, { name, phone, bloodGroup }) =>
  sequelize.transaction(async (transaction) => {
    const camp = await BloodCamp.findByPk(campId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!camp || camp.status !== B.CAMP_STATUS.SCHEDULED || camp.campDate < localIsoDate()) {
      throw ApiError.notFound("This camp is not open for registration");
    }
    const existing = await BloodCampRegistration.findOne({ where: { campId, patientId }, transaction });
    if (existing && existing.status !== B.CAMP_REGISTRATION_STATUS.CANCELLED) {
      throw ApiError.conflict("You are already registered for this camp");
    }
    if (camp.capacity) {
      const taken = await BloodCampRegistration.count({
        where: { campId, status: { [Op.ne]: B.CAMP_REGISTRATION_STATUS.CANCELLED } },
        transaction,
      });
      if (taken >= camp.capacity) throw ApiError.conflict("This camp is full");
    }
    const values = { name, phone, bloodGroup: bloodGroup || null, status: B.CAMP_REGISTRATION_STATUS.REGISTERED };
    const reg = existing
      ? await existing.update(values, { transaction })
      : await BloodCampRegistration.create({ ...values, campId, patientId }, { transaction });
    await audit.notify(
      [
        {
          userId: camp.bloodBankId,
          title: "New camp registration",
          message: `${name} registered to donate at ${camp.name} (${camp.campDate}).`,
          type: "blood_camp_registration",
          referenceId: camp.id,
          referenceType: REF,
        },
        {
          userId: patientId,
          title: "Registered for blood donation camp",
          message: `You're registered for ${camp.name} on ${camp.campDate} at ${camp.venue}. Final eligibility is decided by the camp's medical staff.`,
          type: "blood_camp_registered",
          referenceId: camp.id,
          referenceType: REF,
        },
      ],
      transaction
    );
    return reg;
  });

exports.cancelRegistration = async (patientId, campId) => {
  const reg = await BloodCampRegistration.findOne({ where: { campId, patientId } });
  if (!reg || reg.status === B.CAMP_REGISTRATION_STATUS.CANCELLED) throw ApiError.notFound("Registration not found");
  if (reg.status === B.CAMP_REGISTRATION_STATUS.ATTENDED) throw ApiError.conflict("This registration is already marked attended");
  await reg.update({ status: B.CAMP_REGISTRATION_STATUS.CANCELLED });
  return reg;
};

exports.myRegistrations = (patientId) =>
  BloodCampRegistration.findAll({
    where: { patientId },
    include: [
      {
        model: BloodCamp,
        as: "camp",
        include: [{ model: User, as: "bloodBank", attributes: ["id", "name", "phone"] }],
      },
    ],
    order: [["createdAt", "DESC"]],
  });
