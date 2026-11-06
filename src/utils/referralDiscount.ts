import Referral from '../models/referral';
import ReferralConfig from '../models/referralConfig';
import type { DiscountBreakdown } from './discountEngine';

const round = (value: number) => Math.round(value * 100) / 100;

/** Only the referred customer's configured price reduction is a saving.
 * Referrer rewards and points balances are never attributed as discounts.
 * Bind the benefit to one booking atomically before creating an intent; the
 * same booking retains it across retries and proportional milestone charges.
 * Preview/quote calls never reserve or consume a benefit.
 */
export async function withReferralDiscount(
  discount: DiscountBreakdown, customerId: string, bookingId: string, reserve = false,
): Promise<DiscountBreakdown> {
  const referral = await Referral.findOne({
    referredUser: customerId,
    $or: [
      { discountBooking: bookingId, status: { $in: ['pending', 'completed'] } },
      { discountBooking: null, referredUserDiscountApplied: { $ne: true }, status: 'pending', expiresAt: { $gt: new Date() } },
    ],
  }).lean();
  if (!referral) return discount;
  const config = await ReferralConfig.getCurrentConfig();
  if (!config.isEnabled || discount.originalAmount < config.minBookingAmountForTrigger) return discount;
  const requested = config.referredCustomerDiscountType === 'percentage'
    ? discount.originalAmount * config.referredCustomerDiscountValue / 100
    : config.referredCustomerDiscountValue;
  const amount = round(Math.max(0, Math.min(requested, config.referredCustomerDiscountMaxAmount, discount.finalAmount - 0.5)));
  if (!Number.isFinite(amount) || amount <= 0) return discount;
  if (reserve) {
    const bound = await Referral.findOneAndUpdate({
      _id: referral._id,
      $or: [
        { discountBooking: bookingId, status: { $in: ['pending', 'completed'] } },
        { discountBooking: null, referredUserDiscountApplied: { $ne: true }, status: 'pending', expiresAt: { $gt: new Date() } },
      ],
    }, { $set: { discountBooking: bookingId } }, { new: true });
    if (!bound) throw new Error('Referral benefit was reserved by another checkout. Refresh before paying.');
  }
  return {
    ...discount,
    referralDiscount: { amount, referralId: String(referral._id) },
    totalDiscount: round(discount.totalDiscount + amount),
    finalAmount: round(discount.finalAmount - amount),
  };
}

/** Release only this booking's unconsumed benefit. A delayed release cannot
 * clear a different booking's concurrent reservation or a settled benefit. */
export async function releaseReferralReservation(bookingId: string): Promise<void> {
  await Referral.updateOne({
    discountBooking: bookingId,
    referredUserDiscountApplied: { $ne: true },
  }, { $unset: { discountBooking: 1 } });
}
