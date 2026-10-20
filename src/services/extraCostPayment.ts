import type Stripe from 'stripe';
import Booking from '../models/booking';
import Payment from '../models/payment';
import { stripe } from './stripe';

/** Persist Stripe's verified result before completion can issue an invoice. */
export async function reconcileExtraCostPayment(bookingId: string, paymentIntent: Stripe.PaymentIntent) {
  if (paymentIntent.status !== 'succeeded') return null;

  const now = new Date();
  const rawCharge = paymentIntent.latest_charge;
  const chargeId = typeof rawCharge === 'string' ? rawCharge : rawCharge?.id;
  let transferId: string | undefined;
  if (chargeId) {
    const charge = await stripe.charges.retrieve(chargeId, { expand: ['transfer'] });
    if (charge.refunded || charge.amount_refunded > 0 || charge.status !== 'succeeded') {
      return null;
    }
    const transfer = charge.transfer;
    transferId = typeof transfer === 'string' ? transfer : transfer?.id;
  }

  const fields = {
    extraCostStatus: 'succeeded' as const,
    extraCostPaymentSucceeded: true,
    extraCostPaidAt: now,
    ...(chargeId ? { extraCostStripeChargeId: chargeId } : {}),
    ...(transferId ? {
      extraCostTransferId: transferId,
      extraCostTransferStatus: 'succeeded' as const,
      extraCostTransferAttemptedAt: now,
    } : {}),
  };
  const booking = await Booking.findOneAndUpdate(
    {
      _id: bookingId,
      'payment.extraCostStripePaymentIntentId': paymentIntent.id,
      'payment.extraCostStatus': { $in: ['pending', 'failed', 'succeeded'] },
    },
    { $set: Object.fromEntries(Object.entries(fields).map(([key, value]) => [`payment.${key}`, value])) },
    { new: true },
  );
  if (!booking) return null;

  await Payment.findOneAndUpdate(
    { booking: booking._id, extraCostStripePaymentIntentId: paymentIntent.id },
    { $set: fields },
  );
  return booking;
}
