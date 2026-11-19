/**
 * ID equality across the two shapes an id arrives in.
 *
 * `req.user.id` comes from the JWT `sub` claim, which is ALWAYS a string
 * (token.service signs `String(user.id)`), while Sequelize returns BIGINT
 * columns as JS numbers. A strict `row.patientId !== req.user.id` is therefore
 * always true and turns every ownership check into a 403. Compare through here.
 */
function sameId(a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  return String(a) === String(b);
}

module.exports = { sameId };
