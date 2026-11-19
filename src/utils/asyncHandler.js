/**
 * Wraps an async route handler so a rejected promise is forwarded to Express's
 * error middleware instead of crashing the process. Without this, every
 * controller would need its own try/catch just to call `next(err)`.
 *
 *   router.post("/login", asyncHandler(auth.login));
 */
module.exports = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);
