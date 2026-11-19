/**
 * Blood units and inventory (migration 039).
 *
 * Inventory is DERIVED from blood_units — never stored as editable counts —
 * so availability can't be faked: a unit is "available" only after an
 * authorised release of a donation whose testing was recorded as passed, and
 * it leaves stock only through reserve/issue/discard/expiry, each under a row
 * lock and each audited.
 *
 * Expiry is backend-driven: `expireDue()` moves every in-stock unit past its
 * expiry to `expired` (releasing any reservation on it). It runs before every
 * inventory read and before reserve/issue, and on the scheduler tick, so the
 * clock — not a person — decides when a unit expires.
 */
const { Op, fn, col, literal } = require("sequelize");
const {
  sequelize,
  BloodUnit,
  BloodDonation,
  BloodDonor,
  BloodReservation,
  BloodRequest,
  BloodCrossmatch,
  BloodIssue,
} = require("../models");
const ApiError = require("../utils/ApiError");
const { nextBloodCodes } = require("../utils/bloodCode");
const audit = require("./bloodAudit.service");
const { own, unitExpiry } = require("./bloodDonor.service");
const B = require("../config/bloodBank");

const DAY_MS = 24 * 60 * 60 * 1000;
const warningCutoff = () => new Date(Date.now() + B.BLOOD_EXPIRY_WARNING_DAYS * DAY_MS);

/**
 * After a reservation on a request goes away (released / unit expired /
 * discarded), step the request back so staff can reserve another unit.
 */
async function reopenRequestIfEmpty(requestId, transaction) {
  const request = await BloodRequest.findByPk(requestId, { transaction, lock: transaction.LOCK.UPDATE });
  if (!request) return null;
  if (![B.BLOOD_REQUEST_STATUS.RESERVED, B.BLOOD_REQUEST_STATUS.APPROVED].includes(request.status)) return request;
  const active = await BloodReservation.count({
    where: { requestId, status: B.RESERVATION_STATUS.ACTIVE },
    transaction,
  });
  const issued = await BloodIssue.count({ where: { requestId }, transaction });
  if (!active && !issued) await request.update({ status: B.BLOOD_REQUEST_STATUS.AVAILABLE }, { transaction });
  return request;
}
exports.reopenRequestIfEmpty = reopenRequestIfEmpty;

/**
 * Release every ACTIVE reservation on these units (unit expired / discarded).
 * Returns the audit entries to write.
 */
async function releaseReservationsForUnits(units, reason, actorId, transaction) {
  if (!units.length) return [];
  const reservations = await BloodReservation.findAll({
    where: { unitId: { [Op.in]: units.map((u) => u.id) }, status: B.RESERVATION_STATUS.ACTIVE },
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  if (!reservations.length) return [];
  await BloodReservation.update(
    { status: B.RESERVATION_STATUS.RELEASED, releasedAt: new Date(), releaseReason: reason },
    { where: { id: { [Op.in]: reservations.map((r) => r.id) } }, transaction }
  );
  const requestIds = [...new Set(reservations.map((r) => String(r.requestId)))];
  for (const requestId of requestIds) {
    // eslint-disable-next-line no-await-in-loop -- a handful of requests at most
    await reopenRequestIfEmpty(requestId, transaction);
  }
  return reservations.map((r) => ({
    bloodBankId: r.bloodBankId,
    actorUserId: actorId,
    entityType: B.BLOOD_AUDIT_ENTITY.RESERVATION,
    entityId: r.id,
    action: "reservation_released",
    fromStatus: B.RESERVATION_STATUS.ACTIVE,
    toStatus: B.RESERVATION_STATUS.RELEASED,
    details: { unitId: r.unitId, requestId: r.requestId, reason },
  }));
}
exports.releaseReservationsForUnits = releaseReservationsForUnits;

/**
 * Move every in-stock unit past its expiry to `expired`. Scoped to one bank,
 * or platform-wide when bloodBankId is omitted (scheduler). Idempotent.
 */
exports.expireDue = async (bloodBankId) => {
  const where = { status: { [Op.in]: B.UNIT_IN_STOCK }, expiresAt: { [Op.lte]: new Date() } };
  if (bloodBankId) where.bloodBankId = bloodBankId;
  // Cheap existence probe first: the common case is "nothing to expire".
  if (!(await BloodUnit.count({ where }))) return 0;

  return sequelize.transaction(async (transaction) => {
    const units = await BloodUnit.findAll({ where, transaction, lock: transaction.LOCK.UPDATE });
    if (!units.length) return 0;
    await BloodUnit.update(
      { status: B.UNIT_STATUS.EXPIRED },
      { where: { id: { [Op.in]: units.map((u) => u.id) } }, transaction }
    );
    const released = await releaseReservationsForUnits(units, "Unit expired", null, transaction);
    await audit.record(
      [
        ...units.map((u) => ({
          bloodBankId: u.bloodBankId,
          entityType: B.BLOOD_AUDIT_ENTITY.UNIT,
          entityId: u.id,
          action: "unit_expired",
          fromStatus: u.status,
          toStatus: B.UNIT_STATUS.EXPIRED,
          details: { expiresAt: u.expiresAt },
        })),
        ...released,
      ],
      transaction
    );
    return units.length;
  });
};

// ── Reads ────────────────────────────────────────────────────────────────

const SORTS = {
  expiresAt: [["expiresAt", "ASC"]],
  "-expiresAt": [["expiresAt", "DESC"]],
  collectedAt: [["collectedAt", "ASC"]],
  "-collectedAt": [["collectedAt", "DESC"]],
};

exports.listUnits = async (bloodBankId, q = {}) => {
  await exports.expireDue(bloodBankId);
  const { page = 1, limit = 20 } = q;
  const where = { bloodBankId };
  if (q.unitCode) where.unitCode = { [Op.like]: `%${q.unitCode}%` };
  if (q.bloodGroup) where.bloodGroup = q.bloodGroup;
  if (q.component) where.component = q.component;
  if (q.status) where.status = q.status;
  if (q.expiring) {
    where.status = { [Op.in]: [B.UNIT_STATUS.AVAILABLE, B.UNIT_STATUS.RESERVED] };
    where.expiresAt = { [Op.gt]: new Date(), [Op.lte]: warningCutoff() };
  }
  if (q.collectedFrom || q.collectedTo) {
    where.collectedAt = {};
    if (q.collectedFrom) where.collectedAt[Op.gte] = q.collectedFrom;
    if (q.collectedTo) where.collectedAt[Op.lt] = q.collectedTo;
  }
  if (!q.expiring && (q.expiresFrom || q.expiresTo)) {
    where.expiresAt = {};
    if (q.expiresFrom) where.expiresAt[Op.gte] = q.expiresFrom;
    if (q.expiresTo) where.expiresAt[Op.lt] = q.expiresTo;
  }
  const { rows, count } = await BloodUnit.findAndCountAll({
    where,
    include: [{ model: BloodDonation, as: "donation", attributes: ["id", "donationCode"] }],
    order: [...(SORTS[q.sort] || SORTS.expiresAt), ["id", "ASC"]],
    limit,
    offset: (page - 1) * limit,
  });
  return { units: rows, total: count, page, limit, totalPages: Math.ceil(count / limit) };
};

/** Full traceability for one unit: donation, donor, parent/children, reservations, cross-matches, issue, audit. */
exports.getUnit = async (bloodBankId, id) => {
  await exports.expireDue(bloodBankId);
  const unit = await own(BloodUnit, bloodBankId, id, "Blood unit", {
    include: [
      {
        model: BloodDonation,
        as: "donation",
        attributes: ["id", "donationCode", "collectedAt", "testingStatus", "testingDecidedByName", "testingDecidedAt"],
      },
      { model: BloodDonor, as: "donor", attributes: ["id", "donorCode", "name", "bloodGroup"] },
      { model: BloodUnit, as: "parentUnit", attributes: ["id", "unitCode", "component", "status"] },
      { model: BloodUnit, as: "childUnits", attributes: ["id", "unitCode", "component", "status", "expiresAt"] },
      {
        model: BloodReservation,
        as: "reservations",
        separate: true,
        order: [["reservedAt", "DESC"]],
        include: [{ model: BloodRequest, as: "request", attributes: ["id", "requestCode", "patientName", "status"] }],
      },
    ],
  });
  const [crossmatches, issue, trail] = await Promise.all([
    BloodCrossmatch.findAll({ where: { unitId: unit.id, bloodBankId }, order: [["performedAt", "DESC"]] }),
    BloodIssue.findOne({ where: { unitId: unit.id, bloodBankId } }),
    audit.forEntities(bloodBankId, [[B.BLOOD_AUDIT_ENTITY.UNIT, unit.id]]),
  ]);
  return { ...unit.toJSON(), crossmatches, issue, auditTrail: trail };
};

/**
 * The inventory grid: one row per blood group × component that the bank has
 * ever held, with available / reserved / in-testing / expiring-soon counts.
 * One GROUP BY query — the browser never loads units to count them.
 */
exports.summary = async (bloodBankId, { bloodGroup, component } = {}) => {
  await exports.expireDue(bloodBankId);
  const where = { bloodBankId, status: { [Op.in]: B.UNIT_IN_STOCK } };
  if (bloodGroup) where.bloodGroup = bloodGroup;
  if (component) where.component = component;
  const cutoff = warningCutoff();
  const rows = await BloodUnit.findAll({
    attributes: [
      "bloodGroup",
      "component",
      [fn("SUM", literal(`status = '${B.UNIT_STATUS.AVAILABLE}'`)), "available"],
      [fn("SUM", literal(`status = '${B.UNIT_STATUS.RESERVED}'`)), "reserved"],
      [fn("SUM", literal(`status IN ('${B.UNIT_STATUS.QUARANTINE}','${B.UNIT_STATUS.TESTING}')`)), "inTesting"],
      [
        fn(
          "SUM",
          literal(
            `status IN ('${B.UNIT_STATUS.AVAILABLE}','${B.UNIT_STATUS.RESERVED}') AND expires_at <= ${sequelize.escape(cutoff)}`
          )
        ),
        "expiringSoon",
      ],
      [fn("MIN", col("expires_at")), "nextExpiry"],
    ],
    where,
    group: ["bloodGroup", "component"],
    raw: true,
  });
  const order = (g) => B.BLOOD_GROUPS.indexOf(g);
  return {
    rows: rows
      .map((r) => ({
        bloodGroup: r.bloodGroup,
        component: r.component,
        componentLabel: B.BLOOD_COMPONENTS[r.component]?.label || r.component,
        available: Number(r.available || 0),
        reserved: Number(r.reserved || 0),
        inTesting: Number(r.inTesting || 0),
        expiringSoon: Number(r.expiringSoon || 0),
        nextExpiry: r.nextExpiry,
      }))
      .sort((a, b) => order(a.bloodGroup) - order(b.bloodGroup) || a.component.localeCompare(b.component)),
    expiryWarningDays: B.BLOOD_EXPIRY_WARNING_DAYS,
  };
};

// ── Writes ───────────────────────────────────────────────────────────────

function lockUnit(bloodBankId, id, transaction) {
  return own(BloodUnit, bloodBankId, id, "Blood unit", { transaction, lock: transaction.LOCK.UPDATE });
}

/**
 * Authorised release of a tested unit into AVAILABLE stock. Allowed only when
 * the donation's testing was recorded as PASSED and the unit hasn't expired.
 */
exports.release = async (bloodBankId, actorId, id, { releasedByName, storageLocation }) => {
  await exports.expireDue(bloodBankId);
  await sequelize.transaction(async (transaction) => {
    const unit = await lockUnit(bloodBankId, id, transaction);
    if (![B.UNIT_STATUS.QUARANTINE, B.UNIT_STATUS.TESTING].includes(unit.status)) {
      throw ApiError.conflict(`A ${unit.status} unit cannot be released`);
    }
    if (unit.testingStatus !== B.TESTING_STATUS.PASSED) {
      throw new ApiError(422, "Only units whose testing was recorded as passed can be released");
    }
    if (new Date(unit.expiresAt) <= new Date()) throw new ApiError(422, "This unit has expired");
    const from = unit.status;
    await unit.update(
      {
        status: B.UNIT_STATUS.AVAILABLE,
        releasedByName,
        releasedAt: new Date(),
        storageLocation: storageLocation || unit.storageLocation,
        updatedBy: actorId,
      },
      { transaction }
    );
    await audit.record(
      {
        bloodBankId,
        actorUserId: actorId,
        entityType: B.BLOOD_AUDIT_ENTITY.UNIT,
        entityId: unit.id,
        action: "unit_released",
        fromStatus: from,
        toStatus: B.UNIT_STATUS.AVAILABLE,
        details: { releasedBy: releasedByName },
      },
      transaction
    );
  });
  return exports.getUnit(bloodBankId, id);
};

exports.discard = async (bloodBankId, actorId, id, { reason, discardedByName }) => {
  await sequelize.transaction(async (transaction) => {
    const unit = await lockUnit(bloodBankId, id, transaction);
    if (!B.UNIT_DISCARDABLE.includes(unit.status)) throw ApiError.conflict(`A ${unit.status} unit cannot be discarded`);
    const from = unit.status;
    await unit.update(
      { status: B.UNIT_STATUS.DISCARDED, discardReason: reason, discardedAt: new Date(), updatedBy: actorId },
      { transaction }
    );
    const released = await releaseReservationsForUnits([unit], `Unit discarded: ${reason}`, actorId, transaction);
    await audit.record(
      [
        {
          bloodBankId,
          actorUserId: actorId,
          entityType: B.BLOOD_AUDIT_ENTITY.UNIT,
          entityId: unit.id,
          action: "unit_discarded",
          fromStatus: from,
          toStatus: B.UNIT_STATUS.DISCARDED,
          details: { reason, discardedBy: discardedByName },
        },
        ...released,
      ],
      transaction
    );
  });
  return exports.getUnit(bloodBankId, id);
};

exports.updateUnit = async (bloodBankId, actorId, id, { storageLocation }) => {
  await sequelize.transaction(async (transaction) => {
    const unit = await lockUnit(bloodBankId, id, transaction);
    const before = unit.storageLocation;
    await unit.update({ storageLocation: storageLocation || null, updatedBy: actorId }, { transaction });
    await audit.record(
      {
        bloodBankId,
        actorUserId: actorId,
        entityType: B.BLOOD_AUDIT_ENTITY.UNIT,
        entityId: unit.id,
        action: "storage_updated",
        details: { from: before, to: storageLocation || null },
      },
      transaction
    );
  });
  return exports.getUnit(bloodBankId, id);
};

/**
 * Component processing: a WHOLE-BLOOD unit is separated into component units
 * (PRBC / platelets / plasma …). Children inherit group, donation, donor,
 * testing status and (for a not-yet-released parent) its stock state; each
 * gets its own UNIT- number and a shelf-life expiry. The parent becomes
 * `processed` and stays for traceability.
 */
exports.separate = async (bloodBankId, actorId, id, { components, processedByName }) => {
  await exports.expireDue(bloodBankId);
  const childIds = await sequelize.transaction(async (transaction) => {
    const parent = await lockUnit(bloodBankId, id, transaction);
    if (parent.component !== "whole_blood") throw new ApiError(422, "Only whole-blood units can be separated");
    if (![B.UNIT_STATUS.QUARANTINE, B.UNIT_STATUS.TESTING, B.UNIT_STATUS.AVAILABLE].includes(parent.status)) {
      throw ApiError.conflict(`A ${parent.status} unit cannot be separated`);
    }
    const now = new Date();
    const codes = await nextBloodCodes(sequelize, B.BLOOD_CODE_PREFIX.UNIT, components.length, transaction);
    const children = await BloodUnit.bulkCreate(
      components.map((c, i) => ({
        unitCode: codes[i],
        bloodBankId,
        donationId: parent.donationId,
        donorId: parent.donorId,
        parentUnitId: parent.id,
        bloodGroup: parent.bloodGroup,
        component: c.component,
        volumeMl: c.volumeMl ?? null,
        collectedAt: parent.collectedAt,
        processedAt: now,
        expiresAt: unitExpiry(c.component, parent.collectedAt, c.expiresAt),
        testingStatus: parent.testingStatus,
        status: parent.status,
        releasedByName: parent.releasedByName,
        releasedAt: parent.releasedAt,
        storageLocation: c.storageLocation || parent.storageLocation,
        createdBy: actorId,
        updatedBy: actorId,
      })),
      { transaction }
    );
    const from = parent.status;
    await parent.update({ status: B.UNIT_STATUS.PROCESSED, processedAt: now, updatedBy: actorId }, { transaction });
    await BloodDonation.update(
      { status: B.DONATION_STATUS.PROCESSED },
      { where: { id: parent.donationId, status: B.DONATION_STATUS.COLLECTED }, transaction }
    );
    await audit.record(
      [
        {
          bloodBankId,
          actorUserId: actorId,
          entityType: B.BLOOD_AUDIT_ENTITY.UNIT,
          entityId: parent.id,
          action: "unit_separated",
          fromStatus: from,
          toStatus: B.UNIT_STATUS.PROCESSED,
          details: { processedBy: processedByName, children: codes },
        },
        ...children.map((c) => ({
          bloodBankId,
          actorUserId: actorId,
          entityType: B.BLOOD_AUDIT_ENTITY.UNIT,
          entityId: c.id,
          action: "unit_created",
          toStatus: c.status,
          details: { unitCode: c.unitCode, component: c.component, parentUnitId: parent.id },
        })),
      ],
      transaction
    );
    return children.map((c) => c.id);
  });
  return BloodUnit.findAll({ where: { id: { [Op.in]: childIds } }, order: [["id", "ASC"]] });
};
