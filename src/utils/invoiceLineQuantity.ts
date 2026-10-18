/**
 * Quantity and unit price for invoice lines, shared by the PDF, the UBL and
 * the Odoo move so all three multiply back to the same line amount.
 */

const toFiniteNumber = (value: unknown): number | undefined => {
  if (value == null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

/**
 * Rounds a quantity x unit price product the way Odoo (float_round) does:
 * half away from zero, after nudging out binary error, so -2.5 x 16.43 is
 * -41.08 on both sides rather than -41.07 here and -41.08 in Odoo.
 */
export const roundLineAmount = (value: number): number =>
  Math.sign(value) * Math.round(Math.abs(value) * 100 * (1 + 4 * Number.EPSILON)) / 100;

/**
 * Billed quantity of an extra cost. A unit adjustment is charged on the
 * difference between the actual and the estimated units, so that difference
 * is the quantity; the total actual units (e.g. 35 m² instead of the extra
 * 5 m²) would bill the whole job a second time.
 */
export const getExtraCostQuantity = (cost: {
  type?: string;
  actualUnits?: unknown;
  estimatedUnits?: unknown;
}): number | undefined => {
  const actual = toFiniteNumber(cost.actualUnits);
  if (actual == null) return undefined;
  const estimated = toFiniteNumber(cost.estimatedUnits);
  if (cost.type === "unit_adjustment" && estimated != null) {
    const difference = Math.round((actual - estimated) * 1e6) / 1e6;
    return difference !== 0 ? difference : undefined;
  }
  return actual;
};

/**
 * Unit price that multiplies back to the line amount. The amount is what was
 * charged and wins: a unit price taken from the professional's catalogue, or
 * one scaled before commission/discount adjustments, no longer matches it, and
 * Odoo and UBL receivers recompute the line as quantity × unit price.
 * A whole-cent price is preferred whenever one multiplies back; only an
 * amount no cent price reaches (e.g. 492.82 for 30 units) keeps more decimals.
 */
export const reconcileUnitPrice = (
  amount: number,
  quantity?: number,
  unitPrice?: number,
): number | undefined => {
  const price = toFiniteNumber(unitPrice);
  const qty = toFiniteNumber(quantity);
  if (qty == null || qty === 0) return price;
  const multipliesBack = (candidate: number) => Math.abs(Math.round(qty * candidate * 100) / 100 - amount) < 0.005;
  const toCents = (value: number) => Math.round(value * 100) / 100;
  // A cent price must give the amount the way Odoo rounds the line: half away
  // from zero (−2.5 × 16.43 = −41.08 there, −41.07 with Math.round).
  const multipliesBackInOdoo = (candidate: number) => Math.abs(roundLineAmount(qty * candidate) - amount) < 0.005;
  const centCandidates = price != null ? [toCents(price), toCents(amount / qty)] : [toCents(amount / qty)];
  const centPrice = centCandidates.find(multipliesBackInOdoo);
  if (centPrice != null) return centPrice;
  if (price != null && multipliesBack(price)) return price;
  return Math.round((amount / qty) * 1e6) / 1e6;
};
