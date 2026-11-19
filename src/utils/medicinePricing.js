/**
 * The ONE place medicine money is computed — cart, checkout, the bill,
 * purchases, returns and reports all call these, so a figure shown in one
 * screen can never disagree with the figure charged or reported in another.
 *
 * Everything is done in integer PAISE and rounded half-up to 2dp only at the
 * edges, so there is no float drift (0.1 + 0.2) in any total.
 *
 * Conventions (config/pharmacy.js):
 *   SALE      price is GST-INCLUSIVE. lineTotal = price × qty − discount; the
 *             GST is the part of lineTotal above its taxable value:
 *             taxable = lineTotal / (1 + rate/100), gst = lineTotal − taxable.
 *   PURCHASE  buying price is GST-EXCLUSIVE (as on a supplier's bill):
 *             taxable = qty × rate − discount, gst = taxable × rate/100.
 */

const toPaise = (value) => Math.round((Number(value) || 0) * 100);
const fromPaise = (paise) => Math.round(paise) / 100;
/** Round any money value to 2dp (half-up on the paise). */
const money = (value) => fromPaise(toPaise(value));
const pct = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/**
 * Price ONE sale line from an inventory row's live price data.
 *
 * @param {{price, discountPercent?, gstRate?}} item  inventory row (or its snapshot)
 * @param {number} quantity
 */
function priceSaleLine(item, quantity) {
  const qty = Number(quantity) || 0;
  const discountPercent = Math.min(pct(item.discountPercent), 100);
  const gstRate = pct(item.gstRate);

  const unit = toPaise(item.price);
  const gross = unit * qty;
  const discount = Math.round((gross * discountPercent) / 100);
  const total = Math.max(gross - discount, 0);
  const taxable = Math.round(total / (1 + gstRate / 100));

  return {
    unitPrice: fromPaise(unit),
    quantity: qty,
    grossAmount: fromPaise(gross),
    discountPercent,
    discountAmount: fromPaise(discount),
    lineTotal: fromPaise(total),
    gstRate,
    taxableAmount: fromPaise(taxable),
    gstAmount: fromPaise(total - taxable),
  };
}

/** What ONE unit costs the patient after the item discount (display only — lines use priceSaleLine). */
function effectiveUnitPrice(item) {
  return priceSaleLine(item, 1).lineTotal;
}

/**
 * Header totals of a set of priced sale lines (the output of priceSaleLine,
 * or stored order lines with the same field names).
 */
function sumSaleLines(lines) {
  const sum = (key) => fromPaise(lines.reduce((acc, l) => acc + toPaise(l[key]), 0));
  return {
    subtotal: sum("grossAmount"),
    discountTotal: sum("discountAmount"),
    total: sum("lineTotal"),
    taxableTotal: sum("taxableAmount"),
    gstTotal: sum("gstAmount"),
  };
}

/**
 * Price ONE purchase line (supplier bill): GST is added on top of the
 * discounted taxable value. Free units carry no cost.
 *
 * @param {{quantity, buyingPrice, discountPercent?, gstRate?}} line
 */
function pricePurchaseLine(line) {
  const qty = Number(line.quantity) || 0;
  const discountPercent = Math.min(pct(line.discountPercent), 100);
  const gstRate = pct(line.gstRate);

  const gross = toPaise(line.buyingPrice) * qty;
  const discount = Math.round((gross * discountPercent) / 100);
  const taxable = gross - discount;
  const gst = Math.round((taxable * gstRate) / 100);

  return {
    grossAmount: fromPaise(gross),
    discountPercent,
    discountAmount: fromPaise(discount),
    taxableAmount: fromPaise(taxable),
    gstRate,
    gstAmount: fromPaise(gst),
    lineTotal: fromPaise(taxable + gst),
  };
}

function sumPurchaseLines(lines) {
  const sum = (key) => fromPaise(lines.reduce((acc, l) => acc + toPaise(l[key]), 0));
  return {
    subtotal: sum("grossAmount"),
    discountTotal: sum("discountAmount"),
    taxableTotal: sum("taxableAmount"),
    gstTotal: sum("gstAmount"),
    total: sum("lineTotal"),
  };
}

/**
 * GST summary by rate — the table printed under a tax invoice / credit note.
 * Lines without a recorded taxable value (orders placed before GST data
 * existed) are left out rather than guessed.
 *
 * @param {Array<{gstRate, taxableAmount, gstAmount}>} lines
 */
function gstBreakup(lines) {
  const byRate = new Map();
  for (const line of lines) {
    if (line.taxableAmount === null || line.taxableAmount === undefined) continue;
    const rate = pct(line.gstRate);
    const row = byRate.get(rate) || { gstRate: rate, taxable: 0, gst: 0 };
    row.taxable += toPaise(line.taxableAmount);
    row.gst += toPaise(line.gstAmount);
    byRate.set(rate, row);
  }
  return [...byRate.values()]
    .sort((a, b) => a.gstRate - b.gstRate)
    .map((r) => ({ gstRate: r.gstRate, taxableAmount: fromPaise(r.taxable), gstAmount: fromPaise(r.gst) }));
}

/**
 * Per-unit margin of an inventory row: what one unit earns EXCLUDING GST
 * (the sale's taxable value after discount) minus its buying price (also
 * excl. GST). NULL when no buying price is recorded — a margin is never
 * guessed. This is GROSS margin; it knows nothing of rent, salaries etc.
 */
function unitMargin(item) {
  if (item.buyingPrice === null || item.buyingPrice === undefined || item.buyingPrice === "") return null;
  const sale = priceSaleLine(item, 1);
  return fromPaise(toPaise(sale.taxableAmount) - toPaise(item.buyingPrice));
}

module.exports = {
  money,
  toPaise,
  fromPaise,
  priceSaleLine,
  effectiveUnitPrice,
  sumSaleLines,
  pricePurchaseLine,
  sumPurchaseLines,
  gstBreakup,
  unitMargin,
};
