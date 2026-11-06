import { stripe } from '../services/stripe';
import { getReferralReservationToken, releaseReferralReservation } from './referralDiscount';

/** Terminal booking paths must confirm that an outstanding checkout cannot
 * settle before making its unconsumed benefit available to another booking.
 * Failed cancellation deliberately retains the reservation for a safe retry. */
export async function releaseUnpaidReferral(booking: {
  _id: { toString(): string };
  payment?: { status?: string; stripePaymentIntentId?: string; discount?: { referralReservationToken?: string } };
  milestonePayments?: ReadonlyArray<{ status?: string }>;
}): Promise<void> {
  if (booking.milestonePayments?.some(milestone => milestone.status === 'paid')) return;
  if (booking.payment && !['pending', 'failed'].includes(booking.payment.status || '')) return;
  const intentId = booking.payment?.stripePaymentIntentId;
  if (intentId) {
    const intent = await stripe.paymentIntents.retrieve(intentId);
    if (intent.status !== 'canceled') {
      if (!['requires_payment_method', 'requires_confirmation', 'requires_action'].includes(intent.status)) return;
      const cancelled = await stripe.paymentIntents.cancel(intentId);
      if (cancelled.status !== 'canceled') return;
    }
  }
  const token = intentId
    ? booking.payment?.discount?.referralReservationToken
    : await getReferralReservationToken(booking._id.toString());
  await releaseReferralReservation(booking._id.toString(), token);
}

/** Post-persist cleanup must not prevent the terminal flow from completing. */
export async function releaseUnpaidReferralSafely(
  booking: Parameters<typeof releaseUnpaidReferral>[0],
  context: string,
): Promise<void> {
  try {
    await releaseUnpaidReferral(booking);
  } catch (error) {
    // Stripe failure leaves the reservation bound, so release can be retried.
    // Do not log provider payloads or the reservation token.
    console.error('Referral release failed after terminal booking update', {
      bookingId: booking._id.toString(),
      context,
      errorType: error instanceof Error ? error.name : typeof error,
    });
  }
}
