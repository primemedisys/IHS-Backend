/**
 * Medicine order READ paths plus the per-line status/cancel actions.
 *
 * Creating an order lives in medicineOrderGroup.service — there is exactly one
 * order-creation path now (validate → group → lines → stock → payment), and
 * "order this one medicine" is simply that path with a single line. Keeping
 * the creation logic in one place is what stops the direct-order button and
 * the cart checkout from drifting apart on price, stock or notifications.
 *
 * The per-line reads and actions below are unchanged in shape so the existing
 * patient and provider screens keep working; where a line belongs to a group
 * (every order placed from this phase on), the action is applied through the
 * group so a line can never end up in a different state from its order.
 */
const {
  sequelize,
  MedicineOrder,
  MedicineStoreMedicine,
  MedicineNotification,
  User,
  MedicineOrderGroup,
} = require("../models");
const ApiError = require("../utils/ApiError");
const { sameId } = require("../utils/ids");
const orderGroupService = require("./medicineOrderGroup.service");
const stockService = require("./pharmacyStock.service");
const { STOCK_MOVEMENT_TYPE } = require("../config/pharmacy");
const {
  MEDICINE_ORDER_STATUS,
  MEDICINE_ORDER_TRANSITIONS,
  MEDICINE_ORDER_CANCELLABLE,
} = require("../config/constants");

const MEDICINE_ATTRS = ["id", "medicineName", "imageUrl", "medicineType", "strength"];

/**
 * These per-line reads are served to patients too, so the pharmacy's private
 * cost snapshot (migration 043) never leaves through them. Pharmacies read
 * cost through the order-group endpoints.
 */
const LINE_ATTRS = { exclude: ["unitCost"] };

/**
 * Order one medicine directly from its detail page. Delegates to the single
 * order-creation path, so the order gets a group, a bill and a payment row
 * exactly like a cart checkout does.
 */
exports.placeOrder = async (patientId, dto) => {
  const { groups, requiresPayment } = await orderGroupService.orderDirect(patientId, dto);
  const group = groups[0];
  return { group, order: group.items[0], requiresPayment };
};

exports.getMyOrders = async (patientId, { status, page = 1, limit = 20 } = {}) => {
  const where = { patientId };
  if (status) where.status = status;

  const { rows, count } = await MedicineOrder.findAndCountAll({
    where,
    attributes: LINE_ATTRS,
    include: [
      { model: MedicineStoreMedicine, as: "medicine", attributes: MEDICINE_ATTRS },
      { model: MedicineOrderGroup, as: "group", attributes: ["id", "orderNumber", "paymentMethod", "paymentStatus", "status"] },
    ],
    order: [["createdAt", "DESC"]],
    limit: Math.min(limit, 100),
    offset: (page - 1) * limit,
  });

  return { orders: rows, total: count, page, limit, totalPages: Math.ceil(count / limit) };
};

exports.getProviderOrders = async (providerId, { status, page = 1, limit = 20 } = {}) => {
  const where = { providerId };
  if (status) where.status = status;

  const { rows, count } = await MedicineOrder.findAndCountAll({
    where,
    attributes: LINE_ATTRS,
    include: [
      { model: MedicineStoreMedicine, as: "medicine", attributes: MEDICINE_ATTRS },
      { model: User, as: "patient", attributes: ["id", "name", "phone", "email"] },
      { model: MedicineOrderGroup, as: "group", attributes: ["id", "orderNumber", "paymentMethod", "paymentStatus", "status"] },
    ],
    order: [["createdAt", "DESC"]],
    limit: Math.min(limit, 100),
    offset: (page - 1) * limit,
  });

  return { orders: rows, total: count, page, limit, totalPages: Math.ceil(count / limit) };
};

exports.getOrderById = async (userId, orderId) => {
  const order = await MedicineOrder.findByPk(orderId, {
    attributes: LINE_ATTRS,
    include: [
      { model: MedicineStoreMedicine, as: "medicine", attributes: [...MEDICINE_ATTRS, "price"] },
      { model: User, as: "patient", attributes: ["id", "name", "phone", "email"] },
      { model: MedicineOrderGroup, as: "group", attributes: ["id", "orderNumber", "paymentMethod", "paymentStatus", "status", "totalAmount"] },
    ],
  });
  if (!order) throw ApiError.notFound("Order not found");
  // Only the patient or the provider on the order can read it.
  if (!sameId(order.patientId, userId) && !sameId(order.providerId, userId)) {
    throw ApiError.forbidden("Not authorized");
  }
  return order;
};

/**
 * Provider moves one order along. When the order belongs to a group (every
 * order from this phase on) the group is the unit of work — a pharmacy
 * prepares and delivers a whole order, not half of one — so the update is
 * applied there and every line follows. Pre-group orders keep the original
 * per-row behaviour.
 */
exports.updateOrderStatus = async (providerId, orderId, newStatus) => {
  const order = await MedicineOrder.findByPk(orderId);
  if (!order) throw ApiError.notFound("Order not found");
  if (!sameId(order.providerId, providerId)) throw ApiError.forbidden("Not authorized");

  if (order.orderGroupId) {
    await orderGroupService.updateGroupStatus(providerId, order.orderGroupId, newStatus);
    return exports.getOrderById(providerId, orderId);
  }

  const allowed = MEDICINE_ORDER_TRANSITIONS[order.status] || [];
  if (!allowed.includes(newStatus)) {
    throw ApiError.badRequest(`Cannot transition from '${order.status}' to '${newStatus}'`);
  }
  await order.update({ status: newStatus });
  return exports.getOrderById(providerId, orderId);
};

/** Patient cancels. Group-backed orders cancel as a whole (stock restored there). */
exports.cancelOrder = async (patientId, orderId) => {
  const order = await MedicineOrder.findByPk(orderId);
  if (!order) throw ApiError.notFound("Order not found");
  if (!sameId(order.patientId, patientId)) throw ApiError.forbidden("Not authorized");
  if (!MEDICINE_ORDER_CANCELLABLE.includes(order.status)) {
    throw ApiError.badRequest("Cannot cancel order in current status");
  }
  if (order.orderGroupId) {
    await orderGroupService.cancelGroup(patientId, order.orderGroupId);
    return exports.getOrderById(patientId, orderId);
  }

  // Pre-group order (placed before migration 036): cancel it the way it was
  // always cancelled — status, stock and the provider notification commit
  // together, under row locks, so a cancel racing a new order cannot lose or
  // double-count stock.
  await sequelize.transaction(async (transaction) => {
    await order.update({ status: MEDICINE_ORDER_STATUS.CANCELLED }, { transaction });

    // Through the one stock writer, so the ledger records the units coming back.
    await stockService.restoreLines([order], {
      transaction,
      type: STOCK_MOVEMENT_TYPE.SALE_REVERSAL,
      note: `Order #${order.id} cancelled by patient`,
    });

    await MedicineNotification.create(
      {
        userId: order.providerId,
        title: "Order Cancelled",
        message: `Patient has cancelled order #${order.id}.`,
        type: "order_cancelled",
        referenceId: order.id,
        referenceType: "medicine_order",
      },
      { transaction }
    );
  });

  return exports.getOrderById(patientId, orderId);
};
