import PlatformSettings from "../models/platformSettings";
import { calculateExtraCostBreakdown } from './extraCostAccounting';
import { normalizeInvoiceBasis } from './milestoneInvoice';

const finite = (value: unknown): number | undefined =>
  value != null && value !== '' && Number.isFinite(Number(value)) ? Number(value) : undefined;

const roundMoney = (value: number): number =>
  Math.round((Number(value) + Number.EPSILON) * 100) / 100;

/**
 * Final amount for the dispute-resolved email, or undefined when it cannot be
 * computed. A failure must omit the amount line rather than fall back to the
 * bare net delta, which would contradict the "never the bare net" rule.
 */
export const resolveDisputeEmailAmount = async (
  booking: any,
  originalExtraCostTotal: number,
  finalExtraCostAmount: number,
): Promise<number | undefined> => {
  try {
    return await resolveDisputeExtraCostFinalCharge(booking, originalExtraCostTotal, finalExtraCostAmount);
  } catch (error) {
    console.error(
      "Failed to resolve dispute final charge; omitting the amount from the resolution email:",
      error instanceof Error ? error.message : error,
    );
    return undefined;
  }
};

/**
 * Final customer-facing amount for an extra-costs dispute resolution. The
 * stored decision amount is a net delta; the customer email must show what is
 * actually paid, including commission, VAT and discount, and must never
 * mention the platform percentage. When the decision scales the original
 * charge, the persisted VAT-inclusive charge scales with it so every
 * component stays included.
 */
export const resolveDisputeExtraCostFinalCharge = async (
  booking: any,
  originalExtraCostTotal: number,
  finalExtraCostAmount: number,
): Promise<number> => {
  if (!booking) throw new Error("Booking is required to resolve the dispute final charge.");
  if (!(finalExtraCostAmount > 0)) return 0;
  const originalCharge = Number(booking?.payment?.extraCostAmount);
  if (originalExtraCostTotal > 0 && Number.isFinite(originalCharge) && originalCharge > 0) {
    return roundMoney((originalCharge * finalExtraCostAmount) / originalExtraCostTotal);
  }
  const originalNet = finite(booking.payment?.extraCostCustomerNetAmount);
  if (originalExtraCostTotal > 0 && originalNet != null) {
    const originalVat = finite(booking.payment?.extraCostVatAmount)
      ?? (booking.payment?.reverseCharge ? 0 : originalNet * (Number(booking.payment?.vatRate) || 0) / 100);
    return roundMoney((originalNet + originalVat) * finalExtraCostAmount / originalExtraCostTotal);
  }
  // Never silently replace missing configuration with zero commission.
  const commissionPercent = (await PlatformSettings.getCurrentConfig()).commissionPercent;
  const reverseCharge = Boolean(booking?.payment?.reverseCharge);
  const vatRate = reverseCharge ? 0 : Math.max(0, Number(booking?.payment?.vatRate) || 0);
  const subtotal = finalExtraCostAmount * (1 + Math.max(0, commissionPercent) / 100);
  const recordedDiscount = finite(booking.payment?.extraCostCustomerDiscount);
  const percentage = finite(booking.payment?.extraCostLoyaltyPercentage)
    ?? finite(booking.payment?.discount?.loyaltyPercentage) ?? 0;
  const discount = recordedDiscount != null
    ? recordedDiscount * (originalExtraCostTotal > 0 ? finalExtraCostAmount / originalExtraCostTotal : 1)
    : subtotal * percentage / 100;
  const net = calculateExtraCostBreakdown({
    extraCostNetAmount: finalExtraCostAmount, commissionPercent, customerDiscount: discount,
  }).customerChargeAmount;
  return roundMoney(net + (reverseCharge ? 0 : (net * vatRate) / 100));
};

/** Remaining customer invoice amount for non-extra-cost resolutions. No live
 * loyalty or commission recalculation replaces the recorded booking facts. */
export const resolveDisputeBookingFinalCharge = async (booking: any): Promise<number | undefined> => {
  if (!booking) return undefined;
  const payment = booking.payment || {};
  let serviceTotal = finite(payment.totalWithVat);
  const versions = booking.quoteVersions || [];
  const quote = versions.find((version: any) => version.version === (booking.acceptedQuoteVersion ?? booking.currentQuoteVersion));
  if (booking.milestonePayments?.length) {
    const commission = finite(quote?.customerTotals?.commissionPercent);
    if (commission == null) return undefined;
    // The same full-scope basis as FIX/SUP, including all milestones, options,
    // recorded discounts and the partial refund (never the latest slice alone).
    serviceTotal = normalizeInvoiceBasis(booking, commission).serviceTotal;
  } else if (serviceTotal != null && payment.status === 'partially_refunded') {
    serviceTotal = Math.max(0, serviceTotal - (finite(payment.refundAmount) ?? 0));
  }
  if (payment.status === 'refunded') serviceTotal = 0;
  if (serviceTotal == null) serviceTotal = finite(quote?.customerTotals?.totalWithVat);
  if (serviceTotal == null) return undefined;
  const extraTotal = finite(booking.extraCostTotal) ?? 0;
  if (extraTotal <= 0) return roundMoney(serviceTotal);
  const extra = await resolveDisputeEmailAmount(booking, extraTotal, extraTotal);
  return extra == null ? undefined : roundMoney(serviceTotal + extra);
};
