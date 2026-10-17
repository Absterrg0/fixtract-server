/**
 * Whether the money behind an invoice has already moved through Stripe, so
 * e-invoices can state it as prepaid instead of asking for a bank transfer.
 * - Customer invoice (FIX): the customer paid at checkout and, when extra
 *   costs were charged, paid those too.
 * - Supplier self-bill (SUP): the platform transferred the payout (and the
 *   extra-cost payout) to the professional.
 */
const CAPTURED_PAYMENT_STATUSES = new Set(["completed", "partially_refunded", "refunded"]);

const hasChargedExtraCosts = (booking: any): boolean =>
  (booking?.extraCosts || []).reduce((sum: number, cost: any) => sum + (Number(cost?.amount) || 0), 0) > 0;

export const isInvoiceSettled = (booking: any, side: "customer" | "supplier"): boolean => {
  const payment = booking?.payment || {};
  if (side === "supplier") {
    if (payment.transferStatus !== "succeeded") return false;
    return !hasChargedExtraCosts(booking) || payment.extraCostTransferStatus === "succeeded";
  }
  if (!CAPTURED_PAYMENT_STATUSES.has(String(payment.status || ""))) return false;
  return !hasChargedExtraCosts(booking)
    || payment.extraCostStatus === "succeeded"
    || payment.extraCostPaymentSucceeded === true;
};

/**
 * What the customer already paid at checkout while extra costs are still
 * open, so the e-invoice asks only for the rest. That is the VAT-inclusive
 * charge (`payment.amount` excludes VAT). Milestone bookings charge in parts,
 * so one stored charge says nothing about the whole invoice. Self-bills are
 * only stated as paid once settled: a payout is not their VAT-inclusive total.
 */
export const getInvoicePrepaidAmount = (booking: any, side: "customer" | "supplier"): number | undefined => {
  if (side !== "customer" || isInvoiceSettled(booking, side)) return undefined;
  if (Array.isArray(booking?.milestonePayments) && booking.milestonePayments.length > 0) return undefined;
  const payment = booking?.payment || {};
  if (!CAPTURED_PAYMENT_STATUSES.has(String(payment.status || ""))) return undefined;
  const charged = Number(payment.totalWithVat);
  return Number.isFinite(charged) && charged > 0 ? charged : undefined;
};
