import mongoose, { Types } from 'mongoose';
import type Stripe from 'stripe';
import { stripe } from '../../services/stripe';
import Booking, { type IBooking } from '../../models/booking';
import Payment from '../../models/payment';
import CheckoutSession, { type ICheckoutSession } from '../../models/checkoutSession';
import { buildProjectScheduleWindow, validateProjectScheduleSelection } from '../../utils/scheduleEngine';
import { reserveBookingCalendar } from '../../utils/support/bookingCalendar';
import { withAnonymizationWriteFence } from '../../utils/support/accountGuard';
import { releaseReferralReservation } from '../../utils/referralDiscount';
import { CONFLICT_RETENTION_MS, PROMOTED_RETENTION_MS } from '../../utils/checkoutSession';
import { applyScheduleWindowToBookingData } from '../../utils/bookingHelpers';
import { buildPaymentUpsertBase } from './payment';

/**
 * FT2-4B: turn a paid wizard checkout into its Booking.
 *
 * Runs on the first confirmed-payment signal (payment_intent.succeeded webhook,
 * the confirm endpoint or the expiry sweep). The created Booking is exactly
 * what the old flow had at this point — status payment_pending with the
 * pending card payment — so the existing success handlers then apply every
 * paid-booking effect once (booked status, points, discount-code usage,
 * referral, discount ledger, notifications), guarded by their own filters.
 *
 * Idempotent: the Booking reuses the session id, so a concurrent promotion
 * loses on the duplicate _id and reads the winner's booking.
 *
 * Double booking: availability is re-checked with a fresh engine run and the
 * calendar keys are reserved in the same transaction as the insert. A slot
 * that was taken meanwhile is refunded in full and no booking is created.
 */
export type CheckoutPromotionResult =
  | { status: 'promoted'; booking: IBooking }
  | { status: 'conflict'; message: string }
  | { status: 'superseded'; currentIntentId?: string }
  | { status: 'not_found' };

export const CHECKOUT_SLOT_UNAVAILABLE_MESSAGE =
  'The selected time slot was booked by someone else before your payment completed. Your payment has been refunded in full. Please choose another date.';

const sameInstant = (a: unknown, b: unknown) => {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return new Date(a as any).getTime() === new Date(b as any).getTime();
};

const markPromoted = (checkoutId: Types.ObjectId | string) =>
  CheckoutSession.updateOne(
    { _id: checkoutId, status: 'open' },
    { $set: { status: 'promoted', promotedAt: new Date(), purgeAt: new Date(Date.now() + PROMOTED_RETENTION_MS) } },
  );

/** A fresh engine run for the paid selection, or the reason it is gone. */
const recheckAvailability = async (checkout: ICheckoutSession, bookingData: Record<string, any>): Promise<string | null> => {
  const schedule = checkout.schedule;
  if (!schedule?.startDate) return null;
  const input = {
    projectId: schedule.projectId,
    subprojectIndex: schedule.subprojectIndex,
    startDate: schedule.startDate,
    startTime: schedule.startTime,
    customerBlocks: schedule.customerBlocks,
    quantity: schedule.quantity,
    requestTimeZone: schedule.requestTimeZone,
  };
  const validation = await validateProjectScheduleSelection(input);
  if (!validation.valid) return validation.reason || 'Selected schedule is no longer available';
  const window = await buildProjectScheduleWindow(input);
  if (!window) return 'Unable to schedule the selected window';
  // The customer paid for this window; a different one is not the same booking.
  if (
    !sameInstant(window.scheduledStartDate, bookingData.scheduledStartDate)
    || !sameInstant(window.scheduledExecutionEndDate, bookingData.scheduledExecutionEndDate)
  ) {
    return 'Selected schedule is no longer available';
  }
  // Fresh team assignment: the members chosen at checkout may be busy now
  // while others of the team are free.
  applyScheduleWindowToBookingData(bookingData, window);
  return null;
};

const insertPromotedBooking = async (checkout: ICheckoutSession, bookingData: Record<string, any>) => {
  const now = new Date();
  const data: Record<string, any> = {
    ...bookingData,
    _id: checkout._id,
    status: 'payment_pending',
    payment: { ...(checkout.payment || {}) },
    statusHistory: (Array.isArray(bookingData.statusHistory) ? bookingData.statusHistory : []).map((entry: any) => ({
      ...entry,
      timestamp: now,
    })),
  };
  const calendarBooking = {
    _id: checkout._id,
    professional: data.professional,
    assignedTeamMembers: data.assignedTeamMembers,
    resourcePlan: data.resourcePlan,
    scheduledStartDate: data.scheduledStartDate,
    scheduledExecutionEndDate: data.scheduledExecutionEndDate,
    scheduledBufferEndDate: data.scheduledBufferEndDate,
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await withAnonymizationWriteFence(
        [data.customer, data.professional].filter(Boolean),
        async (session) => {
          await reserveBookingCalendar(calendarBooking, session);
          const [created] = await Booking.create([data], session ? { session } : undefined);
          return created;
        },
      );
    } catch (error: any) {
      if (error?.code === 11000 && error.keyPattern?.bookingNumber && attempt < 2) continue;
      throw error;
    }
  }
  throw new Error('Checkout promotion failed unexpectedly');
};

const refundConflictedCheckout = async (
  checkout: ICheckoutSession,
  paymentIntent: Stripe.PaymentIntent,
  reason: string,
) => {
  await stripe.refunds.create(
    {
      payment_intent: paymentIntent.id,
      reason: 'requested_by_customer',
      metadata: { checkoutSessionId: String(checkout._id), reason: 'checkout_slot_unavailable' },
    },
    { idempotencyKey: `checkout-conflict-refund:${paymentIntent.id}` },
  );
  await releaseReferralReservation(String(checkout._id), checkout.payment?.discount?.referralReservationToken);
  await CheckoutSession.updateOne(
    { _id: checkout._id, status: 'open' },
    {
      $set: {
        status: 'conflict',
        conflictAt: new Date(),
        conflictReason: reason,
        purgeAt: new Date(Date.now() + CONFLICT_RETENTION_MS),
      },
    },
  );
  console.warn(`[CHECKOUT] ${checkout._id}: slot taken before payment ${paymentIntent.id} completed; refunded (${reason})`);
};

export const promoteCheckoutSession = async (
  checkoutId: string,
  paymentIntent: Stripe.PaymentIntent,
): Promise<CheckoutPromotionResult> => {
  if (!mongoose.Types.ObjectId.isValid(checkoutId)) return { status: 'not_found' };

  const existing = await Booking.findById(checkoutId);
  if (existing) {
    await markPromoted(checkoutId);
    return { status: 'promoted', booking: existing };
  }

  const checkout = await CheckoutSession.findById(checkoutId);
  if (!checkout) return { status: 'not_found' };
  if (checkout.status === 'conflict') {
    return { status: 'conflict', message: CHECKOUT_SLOT_UNAVAILABLE_MESSAGE };
  }
  const currentIntentId = checkout.payment?.stripePaymentIntentId;
  if (currentIntentId !== paymentIntent.id) return { status: 'superseded', currentIntentId };

  const bookingData = { ...checkout.bookingData };
  let conflict = await recheckAvailability(checkout, bookingData);
  let booking: IBooking | null = null;
  if (!conflict) {
    try {
      booking = await insertPromotedBooking(checkout, bookingData);
    } catch (error: any) {
      if (error?.code === 11000 && error.keyPattern?._id) {
        const winner = await Booking.findById(checkoutId);
        if (winner) return { status: 'promoted', booking: winner };
      }
      if (error?.code === 'SLOT_UNAVAILABLE') {
        conflict = error?.message || 'Selected schedule is no longer available';
      } else {
        throw error;
      }
    }
  }

  if (conflict || !booking) {
    await refundConflictedCheckout(checkout, paymentIntent, conflict || 'unavailable');
    return { status: 'conflict', message: CHECKOUT_SLOT_UNAVAILABLE_MESSAGE };
  }

  // The pending Payment row createPaymentIntent writes for a booking.
  await Payment.findOneAndUpdate(
    { booking: booking._id },
    buildPaymentUpsertBase(booking, checkout.paymentRow || {}),
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  await markPromoted(checkout._id);

  // Best effort: give the charge its booking number in the Stripe dashboard.
  try {
    await stripe.paymentIntents.update(paymentIntent.id, {
      description: `Fixtract Booking #${booking.bookingNumber}`,
      metadata: { bookingNumber: booking.bookingNumber || '' },
    });
  } catch (error: any) {
    console.warn(`[CHECKOUT] Could not label intent ${paymentIntent.id}:`, error?.message || error);
  }

  return { status: 'promoted', booking };
};
