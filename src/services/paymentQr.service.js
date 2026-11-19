/**
 * A provider's OWN UPI QR code (migration 044) — shared by doctors and the
 * pharmacies (medicine store / pharmacy hospital).
 *
 * The provider uploads the QR their UPI app gave them; a patient scans it and
 * pays them directly. The platform never handles or verifies the money: a
 * QR payment stays pending until the PROVIDER confirms it reached them.
 *
 * Ownership: every write is keyed on the AUTHENTICATED user id the controller
 * passes in (req.user.id) — no route takes a provider id — so a provider can
 * only ever read or change its own row.
 */
const { Op } = require("sequelize");
const { ProviderPaymentQr } = require("../models");
const ApiError = require("../utils/ApiError");
const uploadService = require("./upload.service");
const {
  ERROR_CODES,
  PAYMENT_QR_IMAGE_MIME,
  PAYMENT_QR_MAX_BYTES,
} = require("../config/constants");

/** Offered to patients only while active AND carrying an image. */
const isConfigured = (row) => Boolean(row && row.isActive && row.qrImageUrl);

/** The provider's own row, or null when they never set one up. */
function getOwn(userId) {
  return ProviderPaymentQr.findByPk(userId);
}

/** Create-or-update the text fields / active flag. */
async function update(userId, dto) {
  const row = await ProviderPaymentQr.findByPk(userId);
  if (row) return row.update(dto);
  return ProviderPaymentQr.create({ userId, ...dto });
}

/**
 * Upload / replace the QR image. Only PNG / JPEG / WebP up to 2 MB — the shared
 * upload middleware admits far more (PDFs, documents) and a larger limit.
 * The previous file is deleted once the new URL is saved.
 */
async function uploadImage(userId, file) {
  if (!PAYMENT_QR_IMAGE_MIME.includes(file.mimetype)) {
    throw new ApiError(422, "Unsupported file type — upload a PNG, JPEG or WebP image of your UPI QR", {
      code: ERROR_CODES.UNSUPPORTED_FILE_TYPE,
    });
  }
  if (file.size > PAYMENT_QR_MAX_BYTES || file.buffer.length > PAYMENT_QR_MAX_BYTES) {
    throw new ApiError(422, "The QR image is too large (max 2 MB)", { code: ERROR_CODES.VALIDATION_ERROR });
  }
  const row = await ProviderPaymentQr.findByPk(userId);
  const previous = row?.qrImageUrl ?? null;
  // The previous image is deleted only after the new URL is saved.
  const saved = await uploadService.storeThen(
    file.buffer,
    { keyPrefix: `payment-qr/${userId}`, filename: file.originalname, mimetype: file.mimetype },
    ({ url }) =>
      row ? row.update({ qrImageUrl: url }) : ProviderPaymentQr.create({ userId, qrImageUrl: url, isActive: true })
  );
  const url = saved.qrImageUrl;
  if (previous && previous !== url) await uploadService.remove(uploadService.keyFromUrl(previous));
  return saved;
}

/** Remove the QR entirely: the stored image file and the row. */
async function remove(userId) {
  const row = await ProviderPaymentQr.findByPk(userId);
  if (!row) return null;
  const previous = row.qrImageUrl;
  await row.destroy();
  if (previous) await uploadService.remove(uploadService.keyFromUrl(previous));
  return null;
}

/** The provider's QR when it can take payments right now, else null. */
async function findConfigured(userId) {
  const row = await ProviderPaymentQr.findByPk(userId);
  return isConfigured(row) ? row : null;
}

/** Same, but a missing / inactive QR is the caller's 409. */
async function requireConfigured(userId, message = "This provider doesn't accept UPI QR payments right now") {
  const row = await findConfigured(userId);
  if (!row) throw ApiError.conflict(message, { code: ERROR_CODES.PAYMENT_QR_UNAVAILABLE });
  return row;
}

/** Which of these provider ids have a configured QR — ONE query, a Set of string ids. */
async function configuredIds(userIds) {
  const ids = [...new Set(userIds.map(String))];
  if (!ids.length) return new Set();
  const rows = await ProviderPaymentQr.findAll({
    where: { userId: { [Op.in]: ids }, isActive: true, qrImageUrl: { [Op.ne]: null } },
    attributes: ["userId"],
  });
  return new Set(rows.map((r) => String(r.userId)));
}

module.exports = {
  isConfigured,
  getOwn,
  update,
  uploadImage,
  remove,
  findConfigured,
  requireConfigured,
  configuredIds,
};
