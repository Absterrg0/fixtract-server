import PlatformSettings from '../models/platformSettings';
import LoyaltyConfig from '../models/loyaltyConfig';
import { getCurrentTier } from './loyaltySystem';
import { calculateExtraCostBreakdown } from './extraCostAccounting';
import { commissionedExtraCostTotal } from './customerPricing';

/*
 * Customer charge for a booking's extra costs (commission, loyalty discount
 * capped at the commission, VAT). Shared by the extra-cost PaymentIntent and
 * the booking details, so the amount a customer is shown before paying is
 * the amount the PaymentIntent charges (F1-3).
 */
const roundToTwo = (value: number) => Math.round(value * 100) / 100;

export const getPlatformCommissionPercent = async () => {
  try {
    const platformConfig = await PlatformSettings.getCurrentConfig();
    return platformConfig.commissionPercent;
  } catch (configError) {
    console.warn('Failed to fetch platform commission for extra-cost payment, falling back to env var:', configError);
    const parsed = Number.parseFloat(process.env.STRIPE_PLATFORM_COMMISSION_PERCENT || '0');
    return Number.isFinite(parsed) ? parsed : 0;
  }
};

const computeCustomerLoyaltyDiscount = async (customer: any, commissionInclusiveAmount: number) => {
  if (commissionInclusiveAmount <= 0) return { tier: 'Bronze', percentage: 0, amount: 0 };
  try {
    const config = await LoyaltyConfig.getCurrentConfig();
    if (!config.globalSettings?.isEnabled) return { tier: 'Bronze', percentage: 0, amount: 0 };
    const minBookingAmount = config.globalSettings.minBookingAmount || 0;
    if (commissionInclusiveAmount < minBookingAmount) return { tier: 'Bronze', percentage: 0, amount: 0 };
    const activeTiers = (config.tiers || []).filter((t: any) => t.isActive);
    if (activeTiers.length === 0) return { tier: 'Bronze', percentage: 0, amount: 0 };
    const preferredName = customer?.manualCustomerLevelOverride || customer?.loyaltyLevel;
    const preferred = preferredName ? activeTiers.find((t: any) => t.name === preferredName) : undefined;
    const tier = preferred || getCurrentTier(activeTiers, customer?.totalSpent || 0);
    const percentage = tier.discountPercentage || 0;
    if (percentage <= 0) return { tier: tier.name, percentage: 0, amount: 0 };
    let amount = roundToTwo(commissionInclusiveAmount * (percentage / 100));
    if (typeof tier.maxDiscountAmount === 'number' && Number.isFinite(tier.maxDiscountAmount) && amount > tier.maxDiscountAmount) {
      amount = tier.maxDiscountAmount;
    }
    return { tier: tier.name, percentage, amount };
  } catch (error) {
    console.error('Loyalty discount calc failed for extra-cost intent:', error);
    return { tier: 'Bronze', percentage: 0, amount: 0 };
  }
};

export const computeExtraCostCustomerCharge = async (
  customer: any,
  extraCostTotal: number,
  vatRate = 0,
  reverseCharge = false,
  extraCosts?: any[],
) => {
  const commissionPercent = await getPlatformCommissionPercent();
  const subtotalInclCommission = commissionedExtraCostTotal(extraCosts, extraCostTotal, commissionPercent);
  const loyalty = await computeCustomerLoyaltyDiscount(customer, subtotalInclCommission);
  const breakdown = calculateExtraCostBreakdown({
    extraCostNetAmount: extraCostTotal,
    commissionPercent,
    customerDiscount: loyalty.amount,
    customerSubtotal: subtotalInclCommission,
  });
  const appliedLoyalty = {
    ...loyalty,
    requestedAmount: loyalty.amount,
    amount: breakdown.customerDiscount,
  };
  const customerNetChargeAmount = breakdown.customerChargeAmount;
  const vatAmount = reverseCharge ? 0 : roundToTwo(customerNetChargeAmount * Math.max(0, vatRate) / 100);
  const customerChargeAmount = roundToTwo(customerNetChargeAmount + vatAmount);
  return {
    commissionPercent,
    subtotalInclCommission,
    loyalty: appliedLoyalty,
    cappedLoyalty: breakdown.customerDiscount,
    customerNetChargeAmount,
    vatAmount,
    customerChargeAmount,
    platformCommissionAmount: breakdown.platformCommissionAmount,
    platformFeeAmount: roundToTwo(breakdown.platformCommissionAmount + vatAmount),
  };
};

export type ExtraCostChargeDue = {
  netAmount: number;
  loyaltyDiscount: number;
  vatAmount: number;
  totalAmount: number;
};

/**
 * What the extra-cost PaymentIntent would charge the customer, for a booking
 * whose positive extra costs are payable but have no matching charge yet
 * (awaiting the customer's confirmation, or due after an admin dispute
 * resolution). Null otherwise. The booking page showed its own estimate
 * (loyalty not capped at the commission), which disagreed with the invoice's
 * amount due (F1-3: 71.15 vs 72.60).
 */
export const extraCostChargeDue = async (booking: any, customer: any): Promise<ExtraCostChargeDue | null> => {
  const extraCostTotal = Number(booking?.extraCostTotal || 0);
  if (!(extraCostTotal > 0)) return null;
  const payment = booking?.payment || {};
  if (payment.extraCostPaymentSucceeded === true || payment.extraCostStatus === 'succeeded') return null;
  const payable = booking?.status === 'professional_completed'
    || (booking?.status === 'completed'
      && booking?.dispute?.type === 'extra_costs'
      && Boolean(booking?.dispute?.resolvedAt)
      && booking?.extraCostStatus === 'confirmed');
  if (!payable) return null;
  const chargeMatches = payment.extraCostAmount != null
    && (payment.extraCostNetAmount == null || roundToTwo(Number(payment.extraCostNetAmount)) === roundToTwo(extraCostTotal));
  if (chargeMatches) return null;
  const charge = await computeExtraCostCustomerCharge(
    customer,
    extraCostTotal,
    payment.vatRate,
    payment.reverseCharge,
    booking.extraCosts,
  );
  return {
    netAmount: charge.customerNetChargeAmount,
    loyaltyDiscount: charge.cappedLoyalty,
    vatAmount: charge.vatAmount,
    totalAmount: charge.customerChargeAmount,
  };
};
