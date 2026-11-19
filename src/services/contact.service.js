/**
 * Public "Contact us" submissions. Persists the message (the durable record the
 * admin inbox reads), then fires a best-effort notification email to the
 * platform admin. The email is intentionally NOT awaited into the request's
 * success path: the DB row is the source of truth, so a mail hiccup — or no
 * SMTP configured in dev — never fails the submit.
 */
const { ContactMessage } = require("../models");
const mailService = require("./mail.service");
const ApiError = require("../utils/ApiError");
const { ERROR_CODES } = require("../config/constants");

async function createMessage({ name, email, phone, message, ipAddress }) {
  const record = await ContactMessage.create({
    name,
    email,
    phone: phone || null,
    message,
    ipAddress: ipAddress || null,
  });

  mailService
    .sendContactNotification({ name, email, phone, message })
    .catch((err) => console.error("Contact notification email failed:", err.message));

  return record;
}

/**
 * Admin inbox — newest first, paginated in SQL (never load the whole table).
 * `handled` is an optional filter (unread vs followed-up).
 */
async function listMessages({ page, pageSize, handled }) {
  const where = {};
  if (handled !== undefined) where.handled = handled;

  const { rows, count } = await ContactMessage.findAndCountAll({
    where,
    order: [
      ["createdAt", "DESC"],
      ["id", "DESC"],
    ],
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });

  return {
    data: rows,
    page,
    pageSize,
    total: count,
    totalPages: Math.max(1, Math.ceil(count / pageSize)),
  };
}

/** Admin flips a message's followed-up flag (the inbox's read/handled toggle). */
async function setHandled(id, handled) {
  const record = await ContactMessage.findByPk(id);
  if (!record) {
    throw ApiError.notFound("Contact message not found", { code: ERROR_CODES.NOT_FOUND });
  }
  record.handled = handled;
  await record.save();
  return record;
}

module.exports = { createMessage, listMessages, setHandled };
