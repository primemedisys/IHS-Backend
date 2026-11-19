/**
 * Donors, screenings, donations and laboratory test records (migration 039).
 *
 *   donor → screening (staff decision) → donation (+ whole-blood unit, in
 *   quarantine) → test results → testing decision (staff) → [inventory service:
 *   separate components / release]
 *
 * MEDICAL SAFETY: this service RECORDS decisions made by authorised staff. It
 * never computes eligibility from vitals and never decides a test outcome.
 * The only rules it enforces are workflow integrity: a donation needs an
 * ELIGIBLE screening of the same donor, recorded shortly before collection;
 * a failed testing decision takes every unit of that donation out of stock.
 *
 * Every query is scoped by blood_bank_id — a bank never reaches another
 * bank's donors or donations.
 */
const { Op } = require("sequelize");
const {
  sequelize,
  User,
  BloodDonor,
  BloodDonorScreening,
  BloodDonation,
  BloodTest,
  BloodUnit,
  BloodCamp,
} = require("../models");
const ApiError = require("../utils/ApiError");
const { nextBloodCode } = require("../utils/bloodCode");
const audit = require("./bloodAudit.service");
const { ROLES } = require("../config/constants");
const B = require("../config/bloodBank");

/** A screening is valid for a donation collected within this window after it. */
const SCREENING_VALID_HOURS = 24;
const DAY_MS = 24 * 60 * 60 * 1000;

const addDays = (date, days) => new Date(new Date(date).getTime() + days * DAY_MS);

/** Default expiry from the component's shelf life, or the staff's SHORTER date. */
function unitExpiry(component, collectedAt, requested) {
  const max = addDays(collectedAt, B.BLOOD_COMPONENTS[component].shelfLifeDays);
  if (!requested) return max;
  const asked = new Date(requested);
  if (asked <= new Date(collectedAt)) throw ApiError.badRequest("Expiry must be after the collection time");
  if (asked > max) {
    throw ApiError.badRequest(
      `Expiry cannot exceed the ${B.BLOOD_COMPONENTS[component].shelfLifeDays}-day shelf life of ${B.BLOOD_COMPONENTS[component].label}`
    );
  }
  return asked;
}
exports.unitExpiry = unitExpiry;

/** Load a row owned by this bank (optionally locked) or 404. */
async function own(Model, bloodBankId, id, label, options = {}) {
  const row = await Model.findOne({ where: { id, bloodBankId }, ...options });
  if (!row) throw ApiError.notFound(`${label} not found`);
  return row;
}
exports.own = own;

// ── Donors ───────────────────────────────────────────────────────────────

exports.listDonors = async (bloodBankId, { search, bloodGroup, status, page = 1, limit = 20 } = {}) => {
  const where = { bloodBankId };
  if (bloodGroup) where.bloodGroup = bloodGroup;
  if (status) where.status = status;
  if (search) {
    where[Op.or] = [
      { name: { [Op.like]: `%${search}%` } },
      { phone: { [Op.like]: `%${search}%` } },
      { donorCode: { [Op.like]: `%${search}%` } },
    ];
  }
  const { rows, count } = await BloodDonor.findAndCountAll({
    where,
    order: [["updatedAt", "DESC"]],
    limit,
    offset: (page - 1) * limit,
  });
  return { donors: rows, total: count, page, limit, totalPages: Math.ceil(count / limit) };
};

exports.getDonor = async (bloodBankId, id) => {
  const donor = await own(BloodDonor, bloodBankId, id, "Donor", {
    include: [
      { model: BloodDonorScreening, as: "screenings", separate: true, order: [["screenedAt", "DESC"]], limit: 50 },
      {
        model: BloodDonation,
        as: "donations",
        separate: true,
        order: [["collectedAt", "DESC"]],
        include: [{ model: BloodUnit, as: "units", attributes: ["id", "unitCode", "component", "status", "expiresAt"] }],
      },
    ],
  });
  return donor;
};

/** A linked account must really be a patient. */
async function assertPatient(patientUserId) {
  if (!patientUserId) return;
  const n = await User.count({ where: { id: patientUserId, role: ROLES.PATIENT } });
  if (!n) throw ApiError.badRequest("Linked account is not a registered patient");
}

exports.createDonor = async (bloodBankId, actorId, dto) => {
  await assertPatient(dto.patientUserId);
  return sequelize.transaction(async (transaction) => {
    const donorCode = await nextBloodCode(sequelize, B.BLOOD_CODE_PREFIX.DONOR, transaction);
    const donor = await BloodDonor.create(
      {
        ...dto,
        bloodBankId,
        donorCode,
        email: dto.email || null,
        consentAt: dto.consentGiven ? new Date() : null,
        createdBy: actorId,
      },
      { transaction }
    );
    await audit.record(
      {
        bloodBankId,
        actorUserId: actorId,
        entityType: B.BLOOD_AUDIT_ENTITY.DONOR,
        entityId: donor.id,
        action: "donor_registered",
        toStatus: donor.status,
        details: { donorCode },
      },
      transaction
    );
    return donor;
  });
};

exports.updateDonor = async (bloodBankId, actorId, id, dto) => {
  const donor = await own(BloodDonor, bloodBankId, id, "Donor");
  if (dto.patientUserId !== undefined) await assertPatient(dto.patientUserId);
  // Deferral is only ever set by recording a screening, never by editing.
  if (dto.status && ![B.DONOR_STATUS.ACTIVE, B.DONOR_STATUS.INACTIVE].includes(donor.status)) {
    throw ApiError.badRequest("A deferred donor's status changes only through a new screening record");
  }
  const patch = { ...dto };
  if (dto.consentGiven && !donor.consentGiven) patch.consentAt = new Date();
  if (dto.email === "") patch.email = null;
  await sequelize.transaction(async (transaction) => {
    const from = donor.status;
    await donor.update(patch, { transaction });
    await audit.record(
      {
        bloodBankId,
        actorUserId: actorId,
        entityType: B.BLOOD_AUDIT_ENTITY.DONOR,
        entityId: donor.id,
        action: "donor_updated",
        fromStatus: from,
        toStatus: donor.status,
        details: { fields: Object.keys(dto) },
      },
      transaction
    );
  });
  return donor;
};

/**
 * Record a screening. The DECISION is the staff member's; the donor's status
 * simply mirrors the latest recorded decision (eligible → active).
 */
exports.addScreening = async (bloodBankId, actorId, donorId, dto) => {
  const donor = await own(BloodDonor, bloodBankId, donorId, "Donor");
  const D = B.SCREENING_DECISION;
  const statusFor = {
    [D.ELIGIBLE]: B.DONOR_STATUS.ACTIVE,
    [D.DEFERRED_TEMPORARY]: B.DONOR_STATUS.DEFERRED_TEMPORARY,
    [D.DEFERRED_PERMANENT]: B.DONOR_STATUS.DEFERRED_PERMANENT,
  };
  return sequelize.transaction(async (transaction) => {
    const screening = await BloodDonorScreening.create(
      {
        ...dto,
        bloodBankId,
        donorId: donor.id,
        deferralReason: dto.deferralReason || null,
        deferredUntil: dto.decision === D.DEFERRED_TEMPORARY ? dto.deferredUntil : null,
        recordedBy: actorId,
      },
      { transaction }
    );
    const from = donor.status;
    await donor.update(
      {
        status: statusFor[dto.decision],
        deferredUntil: dto.decision === D.DEFERRED_TEMPORARY ? dto.deferredUntil : null,
      },
      { transaction }
    );
    await audit.record(
      {
        bloodBankId,
        actorUserId: actorId,
        entityType: B.BLOOD_AUDIT_ENTITY.SCREENING,
        entityId: screening.id,
        action: dto.decision === D.ELIGIBLE ? "screening_recorded" : "donor_deferred",
        fromStatus: from,
        toStatus: donor.status,
        details: { donorId: donor.id, decision: dto.decision, reason: dto.deferralReason || null },
      },
      transaction
    );
    return screening;
  });
};

// ── Donations ────────────────────────────────────────────────────────────

const DONATION_INCLUDE = [
  { model: BloodDonor, as: "donor", attributes: ["id", "donorCode", "name", "phone", "bloodGroup"] },
  { model: BloodDonorScreening, as: "screening" },
  { model: BloodCamp, as: "camp", attributes: ["id", "name", "campDate"] },
];

exports.listDonations = async (bloodBankId, { search, testingStatus, from, to, page = 1, limit = 20 } = {}) => {
  const where = { bloodBankId };
  if (testingStatus) where.testingStatus = testingStatus;
  if (from || to) {
    where.collectedAt = {};
    if (from) where.collectedAt[Op.gte] = from;
    if (to) where.collectedAt[Op.lt] = to;
  }
  if (search) where.donationCode = { [Op.like]: `%${search}%` };
  const { rows, count } = await BloodDonation.findAndCountAll({
    where,
    include: [{ model: BloodDonor, as: "donor", attributes: ["id", "donorCode", "name", "bloodGroup"] }],
    order: [["collectedAt", "DESC"]],
    limit,
    offset: (page - 1) * limit,
  });
  return { donations: rows, total: count, page, limit, totalPages: Math.ceil(count / limit) };
};

exports.getDonation = async (bloodBankId, id) =>
  own(BloodDonation, bloodBankId, id, "Donation", {
    include: [
      ...DONATION_INCLUDE,
      { model: BloodTest, as: "tests", separate: true, order: [["testedAt", "ASC"]] },
      { model: BloodUnit, as: "units", separate: true, order: [["id", "ASC"]] },
    ],
  });

/**
 * Record a collection. Creates the donation AND its whole-blood unit (in
 * quarantine, expiry pre-computed from the shelf life) in one transaction,
 * with server-generated DON-/UNIT- numbers.
 */
exports.createDonation = async (bloodBankId, actorId, dto) => {
  const collectedAt = new Date(dto.collectedAt || Date.now());
  if (collectedAt > new Date(Date.now() + 5 * 60 * 1000)) {
    throw ApiError.badRequest("Collection time cannot be in the future");
  }

  return sequelize.transaction(async (transaction) => {
    // Locked so two donations can't be recorded against one donor at once.
    const donor = await own(BloodDonor, bloodBankId, dto.donorId, "Donor", {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (donor.status !== B.DONOR_STATUS.ACTIVE) {
      throw new ApiError(422, "This donor is not cleared to donate (latest screening recorded a deferral)");
    }
    if (!donor.bloodGroup) throw new ApiError(422, "Record the donor's blood group before recording a donation");

    const screening = await BloodDonorScreening.findOne({
      where: { id: dto.screeningId, donorId: donor.id, bloodBankId },
      transaction,
    });
    if (!screening) throw ApiError.notFound("Screening not found for this donor");
    if (screening.decision !== B.SCREENING_DECISION.ELIGIBLE) {
      throw new ApiError(422, "The selected screening did not record the donor as eligible");
    }
    const screenedAt = new Date(screening.screenedAt);
    if (screenedAt > collectedAt || collectedAt - screenedAt > SCREENING_VALID_HOURS * 3600 * 1000) {
      throw new ApiError(422, `The screening must be recorded within ${SCREENING_VALID_HOURS} hours before collection`);
    }
    const used = await BloodDonation.count({ where: { screeningId: screening.id }, transaction });
    if (used) throw ApiError.conflict("This screening has already been used for a donation");
    if (dto.campId) await own(BloodCamp, bloodBankId, dto.campId, "Camp", { transaction });

    const expiresAt = unitExpiry("whole_blood", collectedAt, dto.expiresAt);
    const donationCode = await nextBloodCode(sequelize, B.BLOOD_CODE_PREFIX.DONATION, transaction);
    const unitCode = await nextBloodCode(sequelize, B.BLOOD_CODE_PREFIX.UNIT, transaction);

    const donation = await BloodDonation.create(
      {
        donationCode,
        bloodBankId,
        donorId: donor.id,
        screeningId: screening.id,
        campId: dto.campId || null,
        collectedAt,
        volumeMl: dto.volumeMl,
        bagType: dto.bagType || null,
        collectedByName: dto.collectedByName,
        notes: dto.notes || null,
        createdBy: actorId,
      },
      { transaction }
    );
    const unit = await BloodUnit.create(
      {
        unitCode,
        bloodBankId,
        donationId: donation.id,
        donorId: donor.id,
        bloodGroup: donor.bloodGroup,
        component: "whole_blood",
        volumeMl: dto.volumeMl,
        collectedAt,
        expiresAt,
        storageLocation: dto.storageLocation || null,
        createdBy: actorId,
        updatedBy: actorId,
      },
      { transaction }
    );
    await donor.update(
      { lastDonationAt: collectedAt, donationCount: donor.donationCount + 1 },
      { transaction }
    );
    await audit.record(
      [
        {
          bloodBankId,
          actorUserId: actorId,
          entityType: B.BLOOD_AUDIT_ENTITY.DONATION,
          entityId: donation.id,
          action: "donation_recorded",
          toStatus: donation.status,
          details: { donationCode, donorId: donor.id, screeningId: screening.id, collectedBy: dto.collectedByName },
        },
        {
          bloodBankId,
          actorUserId: actorId,
          entityType: B.BLOOD_AUDIT_ENTITY.UNIT,
          entityId: unit.id,
          action: "unit_created",
          toStatus: unit.status,
          details: { unitCode, donationCode, component: unit.component, bloodGroup: unit.bloodGroup },
        },
      ],
      transaction
    );
    return BloodDonation.findByPk(donation.id, {
      include: [...DONATION_INCLUDE, { model: BloodUnit, as: "units" }],
      transaction,
    });
  });
};

/** Record one lab result on the donation sample. */
exports.addTest = async (bloodBankId, actorId, donationId, dto) =>
  sequelize.transaction(async (transaction) => {
    const donation = await own(BloodDonation, bloodBankId, donationId, "Donation", {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (donation.testingStatus !== B.TESTING_STATUS.PENDING) {
      throw ApiError.conflict("Testing for this donation has already been decided");
    }
    const test = await BloodTest.create(
      { ...dto, bloodBankId, donationId: donation.id, resultValue: dto.resultValue || null, recordedBy: actorId },
      { transaction }
    );
    // Units waiting in quarantine are now under test.
    await BloodUnit.update(
      { status: B.UNIT_STATUS.TESTING, updatedBy: actorId },
      { where: { donationId: donation.id, status: B.UNIT_STATUS.QUARANTINE }, transaction }
    );
    await audit.record(
      {
        bloodBankId,
        actorUserId: actorId,
        entityType: B.BLOOD_AUDIT_ENTITY.TEST,
        entityId: test.id,
        action: "test_result_recorded",
        details: {
          donationId: donation.id,
          testName: dto.testName,
          result: dto.result,
          performedBy: dto.performedByName,
        },
      },
      transaction
    );
    return test;
  });

/**
 * The authorised testing DECISION for a donation (passed / failed), made by
 * staff after entering the results. Passed units still wait for an explicit
 * release (inventory service). Failed → every in-stock unit of the donation is
 * discarded in the same transaction.
 */
exports.decideTesting = async (bloodBankId, actorId, donationId, { testingStatus, decidedByName, notes }) => {
  await sequelize.transaction(async (transaction) => {
    const donation = await own(BloodDonation, bloodBankId, donationId, "Donation", {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (donation.testingStatus !== B.TESTING_STATUS.PENDING) {
      throw ApiError.conflict("Testing for this donation has already been decided");
    }
    const tests = await BloodTest.count({ where: { donationId: donation.id }, transaction });
    if (!tests) throw new ApiError(422, "Record at least one test result before deciding");

    const failed = testingStatus === B.TESTING_STATUS.FAILED;
    const now = new Date();
    const units = await BloodUnit.findAll({
      where: { donationId: donation.id },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    const discard = failed ? units.filter((u) => B.UNIT_IN_STOCK.includes(u.status)) : [];

    await donation.update(
      {
        testingStatus,
        testingDecidedByName: decidedByName,
        testingDecidedAt: now,
        status: failed ? B.DONATION_STATUS.DISCARDED : donation.status,
        notes: notes ? [donation.notes, notes].filter(Boolean).join("\n") : donation.notes,
      },
      { transaction }
    );
    await BloodUnit.update(
      { testingStatus, updatedBy: actorId },
      { where: { donationId: donation.id }, transaction }
    );
    if (discard.length) {
      await BloodUnit.update(
        {
          status: B.UNIT_STATUS.DISCARDED,
          discardReason: "Failed laboratory screening",
          discardedAt: now,
          updatedBy: actorId,
        },
        { where: { id: { [Op.in]: discard.map((u) => u.id) } }, transaction }
      );
    }
    await audit.record(
      [
        {
          bloodBankId,
          actorUserId: actorId,
          entityType: B.BLOOD_AUDIT_ENTITY.DONATION,
          entityId: donation.id,
          action: failed ? "testing_failed" : "testing_passed",
          fromStatus: B.TESTING_STATUS.PENDING,
          toStatus: testingStatus,
          details: { decidedBy: decidedByName, notes: notes || null },
        },
        ...discard.map((u) => ({
          bloodBankId,
          actorUserId: actorId,
          entityType: B.BLOOD_AUDIT_ENTITY.UNIT,
          entityId: u.id,
          action: "unit_discarded",
          fromStatus: u.status,
          toStatus: B.UNIT_STATUS.DISCARDED,
          details: { reason: "Failed laboratory screening" },
        })),
      ],
      transaction
    );
  });
  // Read back AFTER commit so the response reflects the decision.
  return exports.getDonation(bloodBankId, donationId);
};
