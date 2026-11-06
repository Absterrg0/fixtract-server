import { stripe } from '../services/stripe';
import { releaseReferralReservation } from './referralDiscount';

/** Terminal booking paths must confirm that an outstanding checkout cannot
 * settle before making its unconsumed benefit available to another booking.
 * Failed cancellation deliberately retains the reservation for a safe retry. */
export async function releaseUnpaidReferral(booking: {
  _id: { toString(): string };
  payment?: { status?: string; stripePaymentIntentId?: string };
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
  await releaseReferralReservation(booking._id.toString());
}
