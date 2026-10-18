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

const money = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : 0;
};

/**
 * What has already been paid on an invoice through Stripe, capped at its
 * total, and whether that covers it. One rule for the PDF, the UBL and the
 * Odoo payment.
 * - Customer: the VAT-inclusive checkout charge, plus the extra-cost charge
 *   once paid. Milestone bookings charge in parts, so they only count once
 *   settled.
 * - Supplier self-bill: what was transferred to the professional. A payout
 *   carries no VAT, so a self-bill with VAT is not covered by it.
 */
export const getInvoicePayment = (
  booking: any,
  side: "customer" | "supplier",
  invoiceTotal: number,
): { paidAmount: number; settled: boolean } => {
  const total = Math.abs(money(invoiceTotal));
  const payment = booking?.payment || {};
  if (side === "supplier") {
    if (payment.transferStatus !== "succeeded") return { paidAmount: 0, settled: false };
    const paidOut = money(payment.professionalPayout)
      + (payment.extraCostTransferStatus === "succeeded" ? money(payment.extraCostProfessionalPayout) : 0);
    const paidAmount = Math.min(total, money(paidOut));
    return { paidAmount, settled: isInvoiceSettled(booking, side) && paidAmount >= total - 0.005 };
  }
  if (isInvoiceSettled(booking, side)) return { paidAmount: total, settled: true };
  if (Array.isArray(booking?.milestonePayments) && booking.milestonePayments.length > 0) {
    return { paidAmount: 0, settled: false };
  }
  if (!CAPTURED_PAYMENT_STATUSES.has(String(payment.status || ""))) return { paidAmount: 0, settled: false };
  return { paidAmount: Math.min(total, money(payment.totalWithVat)), settled: false };
};
