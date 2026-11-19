const asyncHandler = require("../utils/asyncHandler");
const { ok, created } = require("../utils/apiResponse");
const cartService = require("../services/medicineCart.service");

exports.getCart = asyncHandler(async (req, res) => {
  const cart = await cartService.getCart(req.user.id);
  return ok(res, { cart });
});

exports.getCount = asyncHandler(async (req, res) => {
  const result = await cartService.getCount(req.user.id);
  return ok(res, result);
});

exports.getPaymentOptions = asyncHandler(async (req, res) => {
  const result = await cartService.getPaymentOptions(req.user.id);
  return ok(res, result, "Payment options");
});

exports.addItem = asyncHandler(async (req, res) => {
  const cart = await cartService.addItem(req.user.id, req.body);
  return created(res, { cart }, "Added to cart");
});

exports.updateItem = asyncHandler(async (req, res) => {
  const cart = await cartService.updateItem(req.user.id, req.params.id, req.body.quantity);
  return ok(res, { cart });
});

exports.removeItem = asyncHandler(async (req, res) => {
  const cart = await cartService.removeItem(req.user.id, req.params.id);
  return ok(res, { cart });
});

exports.clear = asyncHandler(async (req, res) => {
  const cart = await cartService.clear(req.user.id);
  return ok(res, { cart });
});
