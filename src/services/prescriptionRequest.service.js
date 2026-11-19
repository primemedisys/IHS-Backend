/**
 * Prescription request business logic. Handles the patient → provider
 * prescription upload and sharing flow, plus the availability round-trip:
 * provider checks stock manually (no OCR) and answers per medicine, patient
 * then orders the available ones through the EXISTING MedicineOrder flow.
 */
const { Op } = require("sequelize");
const {
  sequelize,
  PrescriptionRequest,
  PrescriptionRequestItem,
  MedicineStoreMedicine,
  MedicineNotification,
  User,
} = require("../models");
const { effectiveUnitPrice } = require("../utils/medicinePricing");
const ApiError = require("../utils/ApiError");
const { sameId } = require("../utils/ids");
const uploadService = require("./upload.service");
const cartService = require("./medicineCart.service");
const orderGroupService = require("./medicineOrderGroup.service");
const { rolesFor, userLocationWhere } = require("./medicineStore.service");
const {
  PRESCRIPTION_REQUEST_STATUS,
  PRESCRIPTION_ITEM_STATUS,
} = require("../config/constants");

const REQUEST_INCLUDE = [
  { model: User, as: "patient", attributes: ["id", "name", "phone"] },
  { model: User, as: "provider", attributes: ["id", "name"] },
  {
    model: PrescriptionRequestItem,
    as: "items",
    include: [
      {
        model: MedicineStoreMedicine,
        as: "medicine",
        attributes: ["id", "medicineName", "price", "stock", "medicineType", "strength", "imageUrl"],
      },
    ],
  },
];

/**
 * Patient uploads a prescription and shares it with the selected provider(s).
 *
 * The recipients are exactly the provider ids the patient left ticked — the
 * frontend auto-selects everyone in the chosen Google location, but only what
 * is submitted is used, and every id is re-validated here: it must be an
 * ACTIVE MR / Medicine Store, of the chosen provider type ("all" = both), and —
 * when a location was selected — registered in that city/state. A single
 * invalid id rejects the whole share, so nobody unselected or out-of-area
 * ever receives it. One request row per provider (existing architecture),
 * created atomically together with each provider's notification.
 *
 * @param {number|string} patientId
 * @param {object} file - multer file (buffer)
 * @param {{providerIds: Array<number|string>, providerType?: string, notes?: string, city?: string, state?: string}} share
 * @returns {Promise<PrescriptionRequest[]>}
 */
exports.uploadAndShare = async (patientId, file, { providerIds, providerType, notes, city, state }) => {
  if (!file) throw ApiError.badRequest("Prescription file is required");
  if (!providerIds || !providerIds.length) throw ApiError.badRequest("Select at least one provider");

  const uniqueProviderIds = [...new Set(providerIds.map((id) => Number(id)))];
  const validProviders = await User.findAll({
    where: {
      id: { [Op.in]: uniqueProviderIds },
      role: { [Op.in]: rolesFor(providerType) },
      isActive: true,
      [Op.and]: userLocationWhere({ city, state }),
    },
    attributes: ["id", "role"],
  });
  if (validProviders.length !== uniqueProviderIds.length) {
    throw ApiError.badRequest(
      city || state
        ? "One or more selected providers are not available in the selected location"
        : "One or more selected providers are not available"
    );
  }

  // Grouped per patient so ownership is visible in storage (older uploads sit
  // under the flat `prescriptions/` prefix and keep working unchanged).
  const opts = { keyPrefix: `prescription-requests/patients/${patientId}`, filename: file.originalname, mimetype: file.mimetype };
  return uploadService.storeThen(file.buffer, opts, ({ url }) => sequelize.transaction(async (transaction) => {
    const requests = await PrescriptionRequest.bulkCreate(
      validProviders.map((provider) => ({
        patientId,
        providerId: provider.id,
        // Taken from the provider's real role, never from the client.
        providerType: provider.role,
        fileUrl: url,
        fileName: file.originalname,
        notes: notes || null,
        status: PRESCRIPTION_REQUEST_STATUS.PENDING,
      })),
      { transaction }
    );

    await MedicineNotification.bulkCreate(
      requests.map((req) => ({
        userId: req.providerId,
        title: "New Prescription Shared",
        message: "A patient shared a prescription with you. Check availability to respond.",
        type: "prescription_shared",
        referenceId: req.id,
        referenceType: "prescription_request",
      })),
      { transaction }
    );

    return requests;
  }));
};

/**
 * Patient's own prescription requests.
 */
/** Optional request-date range on created_at (`from` inclusive, `to` exclusive). */
function createdAtRange({ from, to }) {
  if (!from && !to) return null;
  const range = {};
  if (from) range[Op.gte] = from;
  if (to) range[Op.lt] = to;
  return range;
}

exports.getMyRequests = async (patientId, { status, from, to, page = 1, limit = 20 } = {}) => {
  const where = { patientId };
  if (status) where.status = status;
  const createdAt = createdAtRange({ from, to });
  if (createdAt) where.createdAt = createdAt;

  const offset = (page - 1) * limit;
  const { rows, count } = await PrescriptionRequest.findAndCountAll({
    where,
    include: [{ model: User, as: "provider", attributes: ["id", "name"] }],
    order: [["createdAt", "DESC"]],
    limit: Math.min(limit, 100),
    offset,
  });

  return { requests: rows, total: count, page, limit, totalPages: Math.ceil(count / limit) };
};

/**
 * Provider's incoming prescription requests (only those shared with them).
 */
exports.getProviderRequests = async (providerId, { status, from, to, page = 1, limit = 20 } = {}) => {
  const where = { providerId };
  if (status) where.status = status;
  const createdAt = createdAtRange({ from, to });
  if (createdAt) where.createdAt = createdAt;

  const offset = (page - 1) * limit;
  const { rows, count } = await PrescriptionRequest.findAndCountAll({
    where,
    include: [{ model: User, as: "patient", attributes: ["id", "name", "phone"] }],
    order: [["createdAt", "DESC"]],
    limit: Math.min(limit, 100),
    offset,
  });

  return { requests: rows, total: count, page, limit, totalPages: Math.ceil(count / limit) };
};

/**
 * Get a single prescription request by ID (patient or provider only),
 * including the provider's availability answers.
 */
exports.getRequestById = async (userId, requestId) => {
  const request = await PrescriptionRequest.findByPk(requestId, { include: REQUEST_INCLUDE });
  if (!request) throw ApiError.notFound("Prescription request not found");
  if (!sameId(request.patientId, userId) && !sameId(request.providerId, userId)) {
    throw ApiError.forbidden("Not authorized");
  }
  return request;
};

/**
 * Provider updates prescription request status.
 * Only the assigned provider can update.
 */
exports.updateStatus = async (providerId, requestId, newStatus) => {
  const request = await PrescriptionRequest.findByPk(requestId);
  if (!request) throw ApiError.notFound("Prescription request not found");
  if (!sameId(request.providerId, providerId)) throw ApiError.forbidden("Not authorized");

  const allowedTransitions = {
    pending: ["viewed", "processing", "rejected"],
    viewed: ["processing", "rejected"],
    processing: ["completed", "rejected"],
  };

  const allowed = allowedTransitions[request.status];
  if (!allowed || !allowed.includes(newStatus)) {
    throw ApiError.badRequest(`Cannot transition from '${request.status}' to '${newStatus}'`);
  }

  await request.update({ status: newStatus });

  const statusMessages = {
    viewed: "Your prescription has been viewed by the provider.",
    processing: "The provider is checking availability for your prescription.",
    completed: "Your prescription request has been completed.",
    rejected: "Your prescription request was rejected by the provider.",
  };
  await MedicineNotification.create({
    userId: request.patientId,
    title: `Prescription ${newStatus.charAt(0).toUpperCase() + newStatus.slice(1)}`,
    message: statusMessages[newStatus] || `Prescription request updated to ${newStatus}.`,
    type: `prescription_${newStatus}`,
    referenceId: request.id,
    referenceType: "prescription_request",
  });

  return request;
};

/**
 * Provider submits their availability answers for a shared prescription.
 *
 * This is a manual, human stock check (NO OCR / NO AI): the provider ticks the
 * medicines they have (with quantity, price read from their own listing) and
 * states any they don't. Re-submitting REPLACES the previous answer set.
 *
 * @param {number} providerId
 * @param {number|string} requestId
 * @param {Array<{status,medicineId?,medicineName?,quantity?,reason?}>} items
 */
exports.submitAvailability = async (providerId, requestId, items) => {
  if (!Array.isArray(items) || !items.length) {
    throw ApiError.badRequest("At least one medicine answer is required");
  }

  const request = await PrescriptionRequest.findByPk(requestId);
  if (!request) throw ApiError.notFound("Prescription request not found");
  if (!sameId(request.providerId, providerId)) throw ApiError.forbidden("Not authorized");
  if ([PRESCRIPTION_REQUEST_STATUS.COMPLETED, PRESCRIPTION_REQUEST_STATUS.REJECTED].includes(request.status)) {
    throw ApiError.badRequest("This prescription request is closed");
  }

  const answers = [];
  for (const item of items) {
    if (item.status === PRESCRIPTION_ITEM_STATUS.AVAILABLE) {
      if (!item.medicineId) throw ApiError.badRequest("medicineId is required for available items");
      const medicine = await MedicineStoreMedicine.findOne({
        where: { id: item.medicineId, providerId },
      });
      if (!medicine || !medicine.isActive) throw ApiError.notFound("Medicine not found in your inventory");
      if (medicine.stock < (item.quantity || 1)) throw ApiError.badRequest(`Insufficient stock for ${medicine.medicineName}`);
      answers.push({
        medicineId: medicine.id,
        medicineName: medicine.medicineName,
        quantity: item.quantity || 1,
        // The unit price the patient will actually be charged (after the
        // pharmacy's item discount) — checkout re-prices live anyway.
        price: effectiveUnitPrice(medicine),
        status: PRESCRIPTION_ITEM_STATUS.AVAILABLE,
        reason: null,
      });
    } else if (item.status === PRESCRIPTION_ITEM_STATUS.UNAVAILABLE) {
      const name = String(item.medicineName || "").trim();
      if (!name) throw ApiError.badRequest("medicineName is required for unavailable items");
      answers.push({
        medicineId: null,
        medicineName: name,
        quantity: null,
        price: null,
        status: PRESCRIPTION_ITEM_STATUS.UNAVAILABLE,
        reason: item.reason || null,
      });
    } else {
      throw ApiError.badRequest("Each item must be 'available' or 'unavailable'");
    }
  }

  await sequelize.transaction(async (t) => {
    await PrescriptionRequestItem.destroy({
      where: { prescriptionRequestId: request.id },
      transaction: t,
    });
    await PrescriptionRequestItem.bulkCreate(
      answers.map((a) => ({ ...a, prescriptionRequestId: request.id })),
      { transaction: t }
    );
    await request.update({ status: PRESCRIPTION_REQUEST_STATUS.PROCESSING }, { transaction: t });
  });

  await MedicineNotification.create({
    userId: request.patientId,
    title: "Prescription availability ready",
    message: "The provider has checked your prescription. Order the medicines you need.",
    type: "prescription_availability_submitted",
    referenceId: request.id,
    referenceType: "prescription_request",
  });

  return exports.getRequestById(providerId, request.id);
};

/**
 * Patient orders the medicines a pharmacy marked available on their shared
 * prescription. Delegates to the ONE order-creation path (validate → group →
 * lines → stock → payment → notify), so a prescription order gets exactly the
 * same bill, payment record and tracking as a cart checkout — there is no
 * separate prescription ordering system.
 *
 * @param {number} patientId
 * @param {number|string} requestId
 * @param {Array<{itemId, quantity}>} selections - only `available` items
 * @param {object} dto - payment method + delivery location + notes
 */
exports.placeOrderFromPrescription = async (patientId, requestId, selections, dto = {}) => {
  if (!Array.isArray(selections) || !selections.length) {
    throw ApiError.badRequest("Select at least one available medicine");
  }
  return orderGroupService.orderFromPrescription(patientId, requestId, selections, dto);
};

/**
 * Patient adds the available medicines from their prescription into the
 * EXISTING cart, then checks out with everything else they are buying.
 */
exports.addPrescriptionToCart = async (patientId, requestId, selections) => {
  if (!Array.isArray(selections) || !selections.length) {
    throw ApiError.badRequest("Select at least one available medicine");
  }
  return cartService.addFromPrescription(patientId, requestId, selections);
};

/**
 * Stream the stored prescription file through the API for an authorized
 * participant, instead of handing out the public object URL (Feature 10:
 * prescription files must NOT be publicly accessible).
 *
 * @param {number} userId - the requesting patient or provider
 * @param {number|string} requestId
 * @returns {Promise<{buffer: Buffer, contentType: string, fileName: string}>}
 */
exports.streamFile = async (userId, requestId) => {
  const request = await PrescriptionRequest.findByPk(requestId, {
    attributes: ["id", "patientId", "providerId", "fileUrl", "fileName"],
  });
  if (!request) throw ApiError.notFound("Prescription request not found");
  if (!sameId(request.patientId, userId) && !sameId(request.providerId, userId)) {
    throw ApiError.forbidden("Not authorized");
  }

  const buffer = await uploadService.readByUrl(request.fileUrl);
  if (!buffer) throw ApiError.notFound("Prescription file not found");

  const ext = String(request.fileName || "").split(".").pop()?.toLowerCase();
  const contentTypes = {
    pdf: "application/pdf",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    txt: "text/plain",
  };

  return {
    buffer,
    contentType: contentTypes[ext] || "application/octet-stream",
    fileName: request.fileName || `prescription-${request.id}`,
  };
};