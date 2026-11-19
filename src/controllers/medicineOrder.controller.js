const asyncHandler = require("../utils/asyncHandler");
const { ok, created } = require("../utils/apiResponse");
const medicineOrderService = require("../services/medicineOrder.service");
const orderGroupService = require("../services/medicineOrderGroup.service");
const { serializeQrPaymentRequest } = require("../utils/serializers");

exports.placeOrder = asyncHandler(async (req, res) => {
  const result = await medicineOrderService.placeOrder(req.user.id, req.body);
  return created(res, result, "Order placed");
});

// ── Checkout, payment and the bill (order groups) ────────────────────────

exports.checkout = asyncHandler(async (req, res) => {
  const result = await orderGroupService.checkout(req.user.id, req.body);
  return created(res, result, "Order placed");
});

exports.payOrder = asyncHandler(async (req, res) => {
  const result = await orderGroupService.payGroup(req.user.id, req.params.id, req.body);
  return ok(res, result, "Payment successful");
});

exports.getMyOrderGroups = asyncHandler(async (req, res) => {
  const result = await orderGroupService.getMyGroups(req.user.id, req.validatedQuery);
  return ok(res, result);
});

exports.getProviderOrderGroups = asyncHandler(async (req, res) => {
  const result = await orderGroupService.getProviderGroups(req.user.id, req.validatedQuery);
  return ok(res, result);
});

exports.getOrderGroupById = asyncHandler(async (req, res) => {
  const order = await orderGroupService.getGroupById(req.user.id, req.params.id);
  return ok(res, { order });
});

exports.updateOrderGroupStatus = asyncHandler(async (req, res) => {
  const order = await orderGroupService.updateGroupStatus(req.user.id, req.params.id, req.body.status);
  return ok(res, { order });
});

exports.cancelOrderGroup = asyncHandler(async (req, res) => {
  const order = await orderGroupService.cancelGroup(req.user.id, req.params.id);
  return ok(res, { order });
});

// ── UPI QR payments to the pharmacy's own QR (migration 044) ─────────────

exports.getPaymentQr = asyncHandler(async (req, res) => {
  const request = await orderGroupService.getPaymentQrForPatient(req.user.id, req.params.id);
  return ok(res, serializeQrPaymentRequest(request), "Payment details");
});

exports.reportPayment = asyncHandler(async (req, res) => {
  const request = await orderGroupService.reportPaymentForPatient(req.user.id, req.params.id, req.body);
  return ok(res, serializeQrPaymentRequest(request), "Payment reported — the pharmacy will confirm once received");
});

exports.confirmPaymentReceived = asyncHandler(async (req, res) => {
  const order = await orderGroupService.confirmPaymentReceived(req.user.id, req.params.id);
  return ok(res, { order }, "Payment marked as received");
});

exports.getInvoice = asyncHandler(async (req, res) => {
  const invoice = await orderGroupService.getInvoice(req.user.id, req.params.id);
  return ok(res, { invoice });
});

exports.getMyOrders = asyncHandler(async (req, res) => {
  const result = await medicineOrderService.getMyOrders(req.user.id, req.validatedQuery);
  return ok(res, result);
});

exports.getProviderOrders = asyncHandler(async (req, res) => {
  const result = await medicineOrderService.getProviderOrders(req.user.id, req.validatedQuery);
  return ok(res, result);
});

exports.getOrderById = asyncHandler(async (req, res) => {
  const order = await medicineOrderService.getOrderById(req.user.id, req.params.id);
  return ok(res, { order });
});

exports.updateOrderStatus = asyncHandler(async (req, res) => {
  const order = await medicineOrderService.updateOrderStatus(req.user.id, req.params.id, req.body.status);
  return ok(res, { order });
});

exports.cancelOrder = asyncHandler(async (req, res) => {
  const order = await medicineOrderService.cancelOrder(req.user.id, req.params.id);
  return ok(res, { order });
});
