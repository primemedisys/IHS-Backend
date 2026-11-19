/**
 * Blood requests (migration 039): patient → blood bank → reservation →
 * cross-match → authorised approval → issue → completed.
 *
 * What the software does: carries the request, keeps inventory consistent
 * (row locks + transactions, so a unit is never reserved or issued twice),
 * enforces the workflow gates, audits every step and notifies both sides.
 *
 * What it never does: decide compatibility, approve a transfusion or promise
 * availability. Reference compatibility is SHOWN to staff; a unit can be
 * issued only after staff RECORD a compatible cross-match and an authorised
 * person approves the request.
 *
 * Scoping: patients reach only rows with their patient_id; a bank only rows
 * with its blood_bank_id. Pharmacies and labs have no route here at all.
 */
const { Op, fn, col } = require("sequelize");
const {
  sequelize,
  User,
  BloodBankProfile,
  BloodRequest,
  BloodReservation,
  BloodCrossmatch,
  BloodIssue,
  BloodUnit,
} = require("../models");
const ApiError = require("../utils/ApiError");
const { sameId } = require("../utils/ids");
const { nextBloodCode } = require("../utils/bloodCode");
const uploadService = require("./upload.service");
const audit = require("./bloodAudit.service");
const inventory = require("./bloodInventory.service");
const { ROLES } = require("../config/constants");
const B = require("../config/bloodBank");

const S = B.BLOOD_REQUEST_STATUS;
const REF = B.BLOOD_NOTIFICATION_REF.REQUEST;
/** documentUrl never leaves the server — the file is streamed. */
const REQUEST_ATTRIBUTES = { exclude: ["documentUrl"] };
const BANK_ATTRS = ["id", "name", "phone", "addressLine", "city", "state", "pincode", "lat", "lng"];

const componentLabel = (c) => B.BLOOD_COMPONENTS[c]?.label || c;
const describe = (r) => `${r.unitsRequired} unit(s) of ${r.bloodGroup} ${componentLabel(r.component)}`;

/** An approved, active blood bank (the only kind a patient may send to). */
async function assertBankOpen(bloodBankId, transaction) {
  const bank = await User.findOne({
    where: { id: bloodBankId, role: ROLES.BLOOD_BANK, isActive: true },
    attributes: ["id", "name"],
    include: [
      {
        model: BloodBankProfile,
        as: "bloodBankProfile",
        where: { verificationStatus: B.BLOOD_BANK_VERIFICATION.APPROVED, isActive: true },
        attributes: ["componentsOffered"],
      },
    ],
    transaction,
  });
  if (!bank) throw ApiError.badRequest("This blood bank is not available");
  return bank;
}

function auditEntry(request, actorUserId, action, extra = {}) {
  return {
    bloodBankId: request.bloodBankId,
    actorUserId,
    entityType: B.BLOOD_AUDIT_ENTITY.REQUEST,
    entityId: request.id,
    action,
    ...extra,
  };
}

// ── Patient ──────────────────────────────────────────────────────────────

/**
 * A patient sends a request to ONE approved blood bank. The optional
 * supporting document goes through the EXISTING storage driver and is only
 * ever streamed back to the two participants.
 */
exports.create = async (patientId, file, dto) => {
  const bank = await assertBankOpen(dto.bloodBankId);
  const offered = bank.bloodBankProfile.componentsOffered;
  if (Array.isArray(offered) && offered.length && !offered.includes(dto.component)) {
    throw new ApiError(422, `${bank.name} does not list ${componentLabel(dto.component)} among its services`);
  }
  if (dto.requiredBy && new Date(dto.requiredBy) < new Date(Date.now() - 60 * 60 * 1000)) {
    throw ApiError.badRequest("'Required by' cannot be in the past");
  }

  const stored = file
    ? await uploadService.put(file.buffer, {
        keyPrefix: `blood/patients/${patientId}/requests`,
        filename: file.originalname,
        mimetype: file.mimetype,
      })
    : null;
  const isEmergency = dto.urgency === B.BLOOD_URGENCY.EMERGENCY;

  try {
    const request = await sequelize.transaction(async (transaction) => {
      const requestCode = await nextBloodCode(sequelize, B.BLOOD_CODE_PREFIX.REQUEST, transaction);
      const row = await BloodRequest.create(
        {
          ...dto,
          requestCode,
          patientId,
          bloodBankId: bank.id,
          isEmergency,
          requiredBy: dto.requiredBy || null,
          documentUrl: stored ? stored.url : null,
          documentName: file ? file.originalname : null,
          status: S.PENDING,
        },
        { transaction }
      );
      await audit.record(
        auditEntry(row, patientId, "request_created", {
          toStatus: S.PENDING,
          details: { requestCode, isEmergency, bloodGroup: dto.bloodGroup, component: dto.component, units: dto.unitsRequired },
        }),
        transaction
      );
      await audit.notify(
        [
          {
            userId: bank.id,
            title: isEmergency ? "EMERGENCY blood request" : "New blood request",
            message: `${requestCode}: ${describe(row)} for ${dto.patientName} at ${dto.hospitalName}.`,
            type: isEmergency ? "blood_emergency_request" : "blood_request_received",
            referenceId: row.id,
            referenceType: REF,
          },
          {
            userId: patientId,
            title: "Blood request sent",
            message: `Your request ${requestCode} was sent to ${bank.name}. You'll be notified when they respond.`,
            type: "blood_request_sent",
            referenceId: row.id,
            referenceType: REF,
          },
        ],
        transaction
      );
      return row;
    });
    return exports.getForPatient(patientId, request.id);
  } catch (err) {
    if (stored) await uploadService.remove(stored.key).catch(() => {});
    throw err;
  }
};

exports.listForPatient = async (patientId, { status, page = 1, limit = 20 } = {}) => {
  const where = { patientId };
  if (status) where.status = status;
  const { rows, count } = await BloodRequest.findAndCountAll({
    where,
    attributes: REQUEST_ATTRIBUTES,
    include: [{ model: User, as: "bloodBank", attributes: BANK_ATTRS }],
    order: [["createdAt", "DESC"]],
    limit,
    offset: (page - 1) * limit,
  });
  return { requests: rows, total: count, page, limit, totalPages: Math.ceil(count / limit) };
};

/** A patient sees their request, the bank, and what was reserved / issued (unit codes only). */
exports.getForPatient = async (patientId, id) => {
  const request = await BloodRequest.findOne({
    where: { id, patientId },
    attributes: REQUEST_ATTRIBUTES,
    include: [
      { model: User, as: "bloodBank", attributes: BANK_ATTRS },
      {
        model: BloodReservation,
        as: "reservations",
        attributes: ["id", "status", "reservedAt", "releasedAt"],
        include: [{ model: BloodUnit, as: "unit", attributes: ["id", "unitCode", "bloodGroup", "component"] }],
      },
      {
        model: BloodIssue,
        as: "issues",
        attributes: ["id", "issueCode", "issuedAt", "hospitalName"],
        include: [{ model: BloodUnit, as: "unit", attributes: ["id", "unitCode", "bloodGroup", "component"] }],
      },
    ],
  });
  if (!request) throw ApiError.notFound("Blood request not found");
  return request;
};

exports.cancel = async (patientId, id, { reason } = {}) => {
  await sequelize.transaction(async (transaction) => {
    const request = await BloodRequest.findOne({
      where: { id, patientId },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!request) throw ApiError.notFound("Blood request not found");
    if (!B.BLOOD_REQUEST_PATIENT_CANCELLABLE.includes(request.status)) {
      throw ApiError.conflict("This request can no longer be cancelled — please contact the blood bank");
    }
    const from = request.status;
    await request.update({ status: S.CANCELLED, cancelledAt: new Date() }, { transaction });
    await audit.record(
      auditEntry(request, patientId, "request_cancelled", { fromStatus: from, toStatus: S.CANCELLED, details: { reason: reason || null } }),
      transaction
    );
    await audit.notify(
      {
        userId: request.bloodBankId,
        title: "Blood request cancelled",
        message: `${request.requestCode} was cancelled by the patient.${reason ? ` Reason: ${reason}` : ""}`,
        type: "blood_request_cancelled",
        referenceId: request.id,
        referenceType: REF,
      },
      transaction
    );
  });
  return exports.getForPatient(patientId, id);
};

/** Stream the supporting document to the request's patient or its blood bank. */
exports.streamDocument = async (userId, id) => {
  const request = await BloodRequest.findByPk(id, {
    attributes: ["id", "patientId", "bloodBankId", "documentUrl", "documentName"],
  });
  if (!request) throw ApiError.notFound("Blood request not found");
  if (!sameId(request.patientId, userId) && !sameId(request.bloodBankId, userId)) {
    throw ApiError.forbidden("Not authorized");
  }
  if (!request.documentUrl) throw ApiError.notFound("No document was attached to this request");
  const buffer = await uploadService.readByUrl(request.documentUrl);
  if (!buffer) throw ApiError.notFound("Document not found");
  return {
    buffer,
    contentType: uploadService.contentTypeFor(request.documentName || request.documentUrl),
    fileName: request.documentName || `blood-request-${request.id}`,
  };
};

// ── Blood bank ───────────────────────────────────────────────────────────

exports.listForBank = async (bloodBankId, { status, emergency, bloodGroup, search, from, to, page = 1, limit = 20 } = {}) => {
  const where = { bloodBankId };
  if (status) where.status = status;
  if (emergency !== undefined) where.isEmergency = emergency;
  if (bloodGroup) where.bloodGroup = bloodGroup;
  if (search) {
    where[Op.or] = [
      { requestCode: { [Op.like]: `%${search}%` } },
      { patientName: { [Op.like]: `%${search}%` } },
      { hospitalName: { [Op.like]: `%${search}%` } },
    ];
  }
  if (from || to) {
    where.createdAt = {};
    if (from) where.createdAt[Op.gte] = from;
    if (to) where.createdAt[Op.lt] = to;
  }
  const { rows, count } = await BloodRequest.findAndCountAll({
    where,
    attributes: REQUEST_ATTRIBUTES,
    // Open emergencies first, then newest.
    order: [["isEmergency", "DESC"], ["createdAt", "DESC"]],
    limit,
    offset: (page - 1) * limit,
  });
  return { requests: rows, total: count, page, limit, totalPages: Math.ceil(count / limit) };
};

async function findForBank(bloodBankId, id, options = {}) {
  const request = await BloodRequest.findOne({ where: { id, bloodBankId }, ...options });
  if (!request) throw ApiError.notFound("Blood request not found");
  return request;
}

/**
 * The request as the bank works it: reservations, cross-matches, issues, plus
 * REFERENCE data to help staff check stock — the reference-compatible groups
 * for this component and how many AVAILABLE units of each the bank holds.
 */
exports.getForBank = async (bloodBankId, id) => {
  await inventory.expireDue(bloodBankId);
  const request = await findForBank(bloodBankId, id, {
    attributes: REQUEST_ATTRIBUTES,
    include: [
      { model: User, as: "patient", attributes: ["id", "name"] },
      {
        model: BloodReservation,
        as: "reservations",
        include: [{ model: BloodUnit, as: "unit", attributes: ["id", "unitCode", "bloodGroup", "component", "status", "expiresAt"] }],
      },
      { model: BloodCrossmatch, as: "crossmatches", include: [{ model: BloodUnit, as: "unit", attributes: ["id", "unitCode"] }] },
      { model: BloodIssue, as: "issues", include: [{ model: BloodUnit, as: "unit", attributes: ["id", "unitCode"] }] },
    ],
  });
  const table = request.component === "plasma" ? B.PLASMA_COMPATIBILITY : B.RED_CELL_COMPATIBILITY;
  const referenceGroups = table[request.bloodGroup] || [request.bloodGroup];
  const stock = await BloodUnit.findAll({
    attributes: ["bloodGroup", [fn("COUNT", col("id")), "n"]],
    where: {
      bloodBankId,
      component: request.component,
      status: B.UNIT_STATUS.AVAILABLE,
      testingStatus: B.TESTING_STATUS.PASSED,
      expiresAt: { [Op.gt]: new Date() },
      bloodGroup: { [Op.in]: referenceGroups },
    },
    group: ["bloodGroup"],
    raw: true,
  });
  const byGroup = new Map(stock.map((s) => [s.bloodGroup, Number(s.n)]));
  const trail = await audit.forEntities(bloodBankId, [[B.BLOOD_AUDIT_ENTITY.REQUEST, request.id]]);
  return {
    ...request.toJSON(),
    reference: {
      note: "Reference only — final compatibility is decided by qualified staff through cross-matching.",
      table: request.component === "plasma" ? "plasma" : "red_cell",
      groups: referenceGroups.map((g) => ({ bloodGroup: g, identical: g === request.bloodGroup, available: byGroup.get(g) || 0 })),
    },
    auditTrail: trail,
  };
};

const STATUS_NOTE = {
  [S.VIEWED]: ["Blood bank viewed your request", "blood_request_viewed"],
  [S.PROCESSING]: ["Blood bank is processing your request", "blood_request_processing"],
  [S.AVAILABLE]: ["Blood bank responded: stock available", "blood_request_available"],
  [S.REJECTED]: ["Blood request rejected", "blood_request_rejected"],
};

/**
 * Manual status steps (viewed / processing / available / rejected). Rejecting
 * releases any active reservation so the units return to stock.
 */
exports.setStatus = async (bloodBankId, actorId, id, { status, note }) => {
  await sequelize.transaction(async (transaction) => {
    const request = await findForBank(bloodBankId, id, { transaction, lock: transaction.LOCK.UPDATE });
    const allowed = B.BLOOD_REQUEST_BANK_TRANSITIONS[request.status] || [];
    if (!allowed.includes(status)) throw ApiError.badRequest(`Cannot move a '${request.status}' request to '${status}'`);
    const from = request.status;

    const extraAudit = [];
    if (status === S.REJECTED) {
      const active = await BloodReservation.findAll({
        where: { requestId: request.id, status: B.RESERVATION_STATUS.ACTIVE },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      for (const r of active) {
        // eslint-disable-next-line no-await-in-loop -- bounded by units_required
        extraAudit.push(...(await releaseOne(r, actorId, "Request rejected", transaction)));
      }
    }
    await request.update({ status, bankNote: note || request.bankNote }, { transaction });
    await audit.record(
      [auditEntry(request, actorId, "request_status_changed", { fromStatus: from, toStatus: status, details: note ? { note } : null }), ...extraAudit],
      transaction
    );
    const [title, type] = STATUS_NOTE[status];
    await audit.notify(
      {
        userId: request.patientId,
        title,
        message: `${request.requestCode}: ${describe(request)}.${note ? ` ${note}` : ""}`,
        type,
        referenceId: request.id,
        referenceType: REF,
      },
      transaction
    );
  });
  return exports.getForBank(bloodBankId, id);
};

/** Release one active reservation: unit back to available (or expired). Returns audit entries. */
async function releaseOne(reservation, actorId, reason, transaction) {
  const unit = await BloodUnit.findByPk(reservation.unitId, { transaction, lock: transaction.LOCK.UPDATE });
  await reservation.update(
    { status: B.RESERVATION_STATUS.RELEASED, releasedAt: new Date(), releaseReason: reason },
    { transaction }
  );
  const entries = [
    {
      bloodBankId: reservation.bloodBankId,
      actorUserId: actorId,
      entityType: B.BLOOD_AUDIT_ENTITY.RESERVATION,
      entityId: reservation.id,
      action: "reservation_released",
      fromStatus: B.RESERVATION_STATUS.ACTIVE,
      toStatus: B.RESERVATION_STATUS.RELEASED,
      details: { unitId: reservation.unitId, requestId: reservation.requestId, reason },
    },
  ];
  if (unit && unit.status === B.UNIT_STATUS.RESERVED) {
    const to = new Date(unit.expiresAt) <= new Date() ? B.UNIT_STATUS.EXPIRED : B.UNIT_STATUS.AVAILABLE;
    await unit.update({ status: to, updatedBy: actorId }, { transaction });
    entries.push({
      bloodBankId: reservation.bloodBankId,
      actorUserId: actorId,
      entityType: B.BLOOD_AUDIT_ENTITY.UNIT,
      entityId: unit.id,
      action: to === B.UNIT_STATUS.AVAILABLE ? "unit_returned_to_stock" : "unit_expired",
      fromStatus: B.UNIT_STATUS.RESERVED,
      toStatus: to,
    });
  }
  return entries;
}

const RESERVABLE = [S.VIEWED, S.PROCESSING, S.AVAILABLE, S.RESERVED];

/**
 * Reserve one AVAILABLE unit for this request. The unit row is locked
 * (SELECT … FOR UPDATE) and its status re-checked inside the transaction, so
 * two staff (or two requests) racing for the same unit: the second waits for
 * the first to commit, then sees `reserved` and gets 409.
 */
exports.reserve = async (bloodBankId, actorId, id, { unitId, reservedByName }) => {
  await inventory.expireDue(bloodBankId);
  await sequelize.transaction(async (transaction) => {
    const request = await findForBank(bloodBankId, id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!RESERVABLE.includes(request.status)) {
      throw ApiError.conflict(`Units cannot be reserved for a '${request.status}' request`);
    }
    const [active, issued] = await Promise.all([
      BloodReservation.count({ where: { requestId: request.id, status: B.RESERVATION_STATUS.ACTIVE }, transaction }),
      BloodIssue.count({ where: { requestId: request.id }, transaction }),
    ]);
    if (active + issued >= request.unitsRequired) {
      throw ApiError.conflict(`All ${request.unitsRequired} required unit(s) are already reserved or issued`);
    }

    const unit = await BloodUnit.findOne({
      where: { id: unitId, bloodBankId },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!unit) throw ApiError.notFound("Blood unit not found");
    if (unit.status !== B.UNIT_STATUS.AVAILABLE) throw ApiError.conflict(`This unit is ${unit.status} and cannot be reserved`);
    if (unit.testingStatus !== B.TESTING_STATUS.PASSED) throw new ApiError(422, "This unit has not passed testing");
    if (new Date(unit.expiresAt) <= new Date()) throw new ApiError(422, "This unit has expired");
    if (unit.component !== request.component) {
      throw new ApiError(422, `The request is for ${componentLabel(request.component)}, this unit is ${componentLabel(unit.component)}`);
    }

    const now = new Date();
    const reservation = await BloodReservation.create(
      { bloodBankId, requestId: request.id, unitId: unit.id, reservedByName, reservedAt: now, recordedBy: actorId },
      { transaction }
    );
    await unit.update({ status: B.UNIT_STATUS.RESERVED, updatedBy: actorId }, { transaction });
    const from = request.status;
    if (request.status !== S.RESERVED) await request.update({ status: S.RESERVED }, { transaction });

    await audit.record(
      [
        {
          bloodBankId,
          actorUserId: actorId,
          entityType: B.BLOOD_AUDIT_ENTITY.RESERVATION,
          entityId: reservation.id,
          action: "reservation_created",
          toStatus: B.RESERVATION_STATUS.ACTIVE,
          details: { unitId: unit.id, unitCode: unit.unitCode, requestId: request.id, reservedBy: reservedByName, unitGroup: unit.bloodGroup, requestGroup: request.bloodGroup },
        },
        {
          bloodBankId,
          actorUserId: actorId,
          entityType: B.BLOOD_AUDIT_ENTITY.UNIT,
          entityId: unit.id,
          action: "unit_reserved",
          fromStatus: B.UNIT_STATUS.AVAILABLE,
          toStatus: B.UNIT_STATUS.RESERVED,
          details: { requestId: request.id, requestCode: request.requestCode },
        },
        ...(from !== S.RESERVED ? [auditEntry(request, actorId, "request_status_changed", { fromStatus: from, toStatus: S.RESERVED })] : []),
      ],
      transaction
    );
    if (from !== S.RESERVED) {
      await audit.notify(
        {
          userId: request.patientId,
          title: "Blood unit reserved",
          message: `${request.requestCode}: the blood bank has reserved unit(s) for you. Compatibility testing and approval follow before issue.`,
          type: "blood_unit_reserved",
          referenceId: request.id,
          referenceType: REF,
        },
        transaction
      );
    }
  });
  return exports.getForBank(bloodBankId, id);
};

/** Cancel a reservation: the unit returns to available stock. */
exports.releaseReservation = async (bloodBankId, actorId, reservationId, { reason }) => {
  let requestId;
  await sequelize.transaction(async (transaction) => {
    const reservation = await BloodReservation.findOne({
      where: { id: reservationId, bloodBankId },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!reservation) throw ApiError.notFound("Reservation not found");
    if (reservation.status !== B.RESERVATION_STATUS.ACTIVE) throw ApiError.conflict(`This reservation is already ${reservation.status}`);
    requestId = reservation.requestId;
    const entries = await releaseOne(reservation, actorId, reason, transaction);
    await inventory.reopenRequestIfEmpty(reservation.requestId, transaction);
    await audit.record(entries, transaction);
  });
  return exports.getForBank(bloodBankId, requestId);
};

/**
 * Record the cross-match RESULT performed by qualified staff for a reserved
 * unit. The software stores the result; it never infers it.
 */
exports.recordCrossmatch = async (bloodBankId, actorId, id, dto) => {
  await sequelize.transaction(async (transaction) => {
    const request = await findForBank(bloodBankId, id, { transaction, lock: transaction.LOCK.UPDATE });
    const reservation = await BloodReservation.findOne({
      where: { requestId: request.id, unitId: dto.unitId, status: B.RESERVATION_STATUS.ACTIVE },
      transaction,
    });
    if (!reservation) throw new ApiError(422, "Cross-match is recorded against a unit reserved for this request");
    const record = await BloodCrossmatch.create(
      {
        bloodBankId,
        requestId: request.id,
        unitId: dto.unitId,
        reservationId: reservation.id,
        result: dto.result,
        method: dto.method || null,
        performedAt: dto.performedAt,
        performedByName: dto.performedByName,
        notes: dto.notes || null,
        recordedBy: actorId,
      },
      { transaction }
    );
    await audit.record(
      {
        bloodBankId,
        actorUserId: actorId,
        entityType: B.BLOOD_AUDIT_ENTITY.CROSSMATCH,
        entityId: record.id,
        action: "crossmatch_recorded",
        toStatus: dto.result,
        details: { requestId: request.id, unitId: dto.unitId, performedBy: dto.performedByName, method: dto.method || null },
      },
      transaction
    );
  });
  return exports.getForBank(bloodBankId, id);
};

/** The latest cross-match per reserved unit on a request. */
async function latestCrossmatches(requestId, transaction) {
  const rows = await BloodCrossmatch.findAll({
    where: { requestId },
    order: [["performedAt", "DESC"], ["id", "DESC"]],
    transaction,
  });
  const latest = new Map();
  rows.forEach((r) => {
    if (!latest.has(String(r.unitId))) latest.set(String(r.unitId), r);
  });
  return latest;
}

/**
 * Authorised approval to issue. Every ACTIVE reservation must have a latest
 * cross-match recorded as compatible — the gate the spec calls for.
 */
exports.approve = async (bloodBankId, actorId, id, { approvedByName, note }) => {
  await sequelize.transaction(async (transaction) => {
    const request = await findForBank(bloodBankId, id, { transaction, lock: transaction.LOCK.UPDATE });
    if (request.status !== S.RESERVED) throw ApiError.conflict("Only a request with reserved units can be approved");
    const active = await BloodReservation.findAll({
      where: { requestId: request.id, status: B.RESERVATION_STATUS.ACTIVE },
      transaction,
    });
    if (!active.length) throw new ApiError(422, "Reserve at least one unit first");
    const latest = await latestCrossmatches(request.id, transaction);
    const missing = active.filter((r) => latest.get(String(r.unitId))?.result !== B.CROSSMATCH_RESULT.COMPATIBLE);
    if (missing.length) {
      throw new ApiError(422, "Every reserved unit needs a compatible cross-match recorded before approval");
    }
    await request.update(
      { status: S.APPROVED, approvedByName, approvedAt: new Date(), bankNote: note || request.bankNote },
      { transaction }
    );
    await audit.record(
      auditEntry(request, actorId, "request_approved", { fromStatus: S.RESERVED, toStatus: S.APPROVED, details: { approvedBy: approvedByName } }),
      transaction
    );
    await audit.notify(
      {
        userId: request.patientId,
        title: "Blood request approved",
        message: `${request.requestCode} has been approved by the blood bank. Units will be issued to ${request.hospitalName}.`,
        type: "blood_request_approved",
        referenceId: request.id,
        referenceType: REF,
      },
      transaction
    );
  });
  return exports.getForBank(bloodBankId, id);
};

/**
 * Issue one reserved, cross-matched unit against an approved request. In ONE
 * transaction: unit → issued, reservation → issued, issue record written,
 * request → completed once every required unit has been issued. An expired
 * unit is refused even if the sweep hasn't run yet.
 */
exports.issue = async (bloodBankId, actorId, id, dto) => {
  await inventory.expireDue(bloodBankId);
  await sequelize.transaction(async (transaction) => {
    const request = await findForBank(bloodBankId, id, { transaction, lock: transaction.LOCK.UPDATE });
    if (request.status !== S.APPROVED) throw ApiError.conflict("Units can be issued only for an approved request");
    const reservation = await BloodReservation.findOne({
      where: { requestId: request.id, unitId: dto.unitId, status: B.RESERVATION_STATUS.ACTIVE },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!reservation) throw new ApiError(422, "This unit is not reserved for this request");
    const unit = await BloodUnit.findOne({
      where: { id: dto.unitId, bloodBankId },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!unit || unit.status !== B.UNIT_STATUS.RESERVED) throw ApiError.conflict("This unit is not in a reserved state");
    if (new Date(unit.expiresAt) <= new Date()) throw new ApiError(422, "This unit has expired and cannot be issued");
    if (unit.testingStatus !== B.TESTING_STATUS.PASSED) throw new ApiError(422, "This unit has not passed testing");
    const crossmatch = (await latestCrossmatches(request.id, transaction)).get(String(unit.id));
    if (!crossmatch || crossmatch.result !== B.CROSSMATCH_RESULT.COMPATIBLE) {
      throw new ApiError(422, "A compatible cross-match must be recorded for this unit before issue");
    }

    const issueCode = await nextBloodCode(sequelize, B.BLOOD_CODE_PREFIX.ISSUE, transaction);
    const issue = await BloodIssue.create(
      {
        issueCode,
        bloodBankId,
        requestId: request.id,
        unitId: unit.id,
        reservationId: reservation.id,
        crossmatchId: crossmatch.id,
        issuedToName: dto.issuedToName,
        hospitalName: request.hospitalName,
        issuedByName: dto.issuedByName,
        verifiedByName: dto.verifiedByName,
        issuedAt: dto.issuedAt,
        notes: dto.notes || null,
        recordedBy: actorId,
      },
      { transaction }
    );
    await unit.update({ status: B.UNIT_STATUS.ISSUED, updatedBy: actorId }, { transaction });
    await reservation.update({ status: B.RESERVATION_STATUS.ISSUED }, { transaction });

    const issuedCount = await BloodIssue.count({ where: { requestId: request.id }, transaction });
    const done = issuedCount >= request.unitsRequired;
    if (done) await request.update({ status: S.COMPLETED, completedAt: new Date() }, { transaction });

    await audit.record(
      [
        {
          bloodBankId,
          actorUserId: actorId,
          entityType: B.BLOOD_AUDIT_ENTITY.ISSUE,
          entityId: issue.id,
          action: "unit_issued",
          details: { issueCode, unitId: unit.id, unitCode: unit.unitCode, requestId: request.id, issuedBy: dto.issuedByName, verifiedBy: dto.verifiedByName, crossmatchId: crossmatch.id },
        },
        {
          bloodBankId,
          actorUserId: actorId,
          entityType: B.BLOOD_AUDIT_ENTITY.UNIT,
          entityId: unit.id,
          action: "unit_issued",
          fromStatus: B.UNIT_STATUS.RESERVED,
          toStatus: B.UNIT_STATUS.ISSUED,
          details: { issueCode, requestCode: request.requestCode },
        },
        ...(done ? [auditEntry(request, actorId, "request_completed", { fromStatus: S.APPROVED, toStatus: S.COMPLETED })] : []),
      ],
      transaction
    );
    await audit.notify(
      {
        userId: request.patientId,
        title: done ? "Blood request completed" : "Blood unit issued",
        message: done
          ? `${request.requestCode}: all ${request.unitsRequired} unit(s) have been issued to ${request.hospitalName}.`
          : `${request.requestCode}: ${issuedCount} of ${request.unitsRequired} unit(s) issued to ${request.hospitalName}.`,
        type: done ? "blood_request_completed" : "blood_unit_issued",
        referenceId: request.id,
        referenceType: REF,
      },
      transaction
    );
  });
  return exports.getForBank(bloodBankId, id);
};

// ── Bank registers (reservations / cross-matches / issues) ───────────────

function paged(key, rows, count, page, limit) {
  return { [key]: rows, total: count, page, limit, totalPages: Math.ceil(count / limit) };
}

exports.listReservations = async (bloodBankId, { status, page = 1, limit = 20 } = {}) => {
  const where = { bloodBankId };
  if (status) where.status = status;
  const { rows, count } = await BloodReservation.findAndCountAll({
    where,
    include: [
      { model: BloodUnit, as: "unit", attributes: ["id", "unitCode", "bloodGroup", "component", "expiresAt", "status"] },
      { model: BloodRequest, as: "request", attributes: ["id", "requestCode", "patientName", "hospitalName", "isEmergency", "status"] },
    ],
    order: [["reservedAt", "DESC"]],
    limit,
    offset: (page - 1) * limit,
  });
  return paged("reservations", rows, count, page, limit);
};

exports.listCrossmatches = async (bloodBankId, { result, page = 1, limit = 20 } = {}) => {
  const where = { bloodBankId };
  if (result) where.result = result;
  const { rows, count } = await BloodCrossmatch.findAndCountAll({
    where,
    include: [
      { model: BloodUnit, as: "unit", attributes: ["id", "unitCode", "bloodGroup", "component"] },
      { model: BloodRequest, as: "request", attributes: ["id", "requestCode", "patientName", "bloodGroup"] },
    ],
    order: [["performedAt", "DESC"]],
    limit,
    offset: (page - 1) * limit,
  });
  return paged("crossmatches", rows, count, page, limit);
};

exports.listIssues = async (bloodBankId, { from, to, page = 1, limit = 20 } = {}) => {
  const where = { bloodBankId };
  if (from || to) {
    where.issuedAt = {};
    if (from) where.issuedAt[Op.gte] = from;
    if (to) where.issuedAt[Op.lt] = to;
  }
  const { rows, count } = await BloodIssue.findAndCountAll({
    where,
    include: [
      { model: BloodUnit, as: "unit", attributes: ["id", "unitCode", "bloodGroup", "component"] },
      { model: BloodRequest, as: "request", attributes: ["id", "requestCode", "patientName"] },
    ],
    order: [["issuedAt", "DESC"]],
    limit,
    offset: (page - 1) * limit,
  });
  return paged("issues", rows, count, page, limit);
};
