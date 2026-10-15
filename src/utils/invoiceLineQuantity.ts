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
 */
export const reconcileUnitPrice = (
  amount: number,
  quantity?: number,
  unitPrice?: number,
): number | undefined => {
  const price = toFiniteNumber(unitPrice);
  const qty = toFiniteNumber(quantity);
  if (qty == null || qty === 0) return price;
  if (price != null && Math.abs(Math.round(qty * price * 100) / 100 - amount) < 0.005) return price;
  return Math.round((amount / qty) * 1e6) / 1e6;
};
