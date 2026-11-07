import { randomUUID } from 'crypto';
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
  const reservationToken = reserve ? randomUUID() : undefined;
  if (reserve) {
    const bound = await Referral.findOneAndUpdate({
      _id: referral._id,
      $or: [
        { discountBooking: bookingId, status: { $in: ['pending', 'completed'] } },
        { discountBooking: null, referredUserDiscountApplied: { $ne: true }, status: 'pending', expiresAt: { $gt: new Date() } },
      ],
    }, { $set: { discountBooking: bookingId, discountReservationToken: reservationToken } }, { new: true });
    if (!bound) throw new Error('Referral benefit was reserved by another checkout. Refresh before paying.');
  }
  return {
    ...discount,
    referralDiscount: { amount, referralId: String(referral._id), ...(reservationToken && { reservationToken }) },
    totalDiscount: round(discount.totalDiscount + amount),
    finalAmount: round(discount.finalAmount - amount),
  };
}

/** Promote an attempt nonce to its intent id. Concurrent idempotent creators
 * may share an intent; only the current attempt (or that same intent) binds.
 * A superseded creator must never expose its discounted client secret. */
export async function bindReferralReservation(bookingId: string, token: string, intentId: string): Promise<boolean> {
  const result = await Referral.updateOne({
    discountBooking: bookingId,
    discountReservationToken: { $in: [token, intentId] },
  }, { $set: { discountReservationToken: intentId } });
  return result.matchedCount > 0;
}

/** Read the current token only for a terminal booking with no outstanding
 * intent. Intent-owned cleanup must always use its original snapshot. */
export async function getReferralReservationToken(bookingId: string): Promise<string | undefined> {
  const referral = await Referral.findOne({ discountBooking: bookingId }).lean();
  return referral?.discountReservationToken;
}

/** Compare-and-release this checkout only, including legacy tokenless records.
 * A delayed release cannot clear a same-booking retry or a settled benefit. */
export async function releaseReferralReservation(bookingId: string, token: string | undefined): Promise<void> {
  await Referral.updateOne({
    discountBooking: bookingId,
    discountReservationToken: token ?? null,
    referredUserDiscountApplied: { $ne: true },
  }, { $unset: { discountBooking: 1, discountReservationToken: 1 } });
}
