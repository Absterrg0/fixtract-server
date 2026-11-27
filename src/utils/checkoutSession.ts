import mongoose, { Types } from 'mongoose';
import Booking from '../models/booking';
import CheckoutSession, { type ICheckoutSchedule, type ICheckoutSession } from '../models/checkoutSession';
import { stripe } from '../services/stripe';
import { releaseReferralReservation } from './referralDiscount';

/**
 * FT2-4B: helpers for wizard checkouts that are not paid yet. See
 * models/checkoutSession.ts for the lifecycle.
 */

/** How long an unpaid checkout stays open; creating a payment intent renews it. */
export const CHECKOUT_HOLD_MS = 60 * 60 * 1000;
/** TTL backstop for an open session the sweep never reached. */
const OPEN_PURGE_MS = 7 * 24 * 60 * 60 * 1000;
/** A promoted session only answers late duplicate confirmations. */
export const PROMOTED_RETENTION_MS = 24 * 60 * 60 * 1000;
/** A refunded slot conflict is kept for support. */
export const CONFLICT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const PROJECT_FIELDS =
  'title description pricing category service professionalId extraOptions postBookingQuestions termsConditions subprojects rfqQuestions timeMode priceModel executionDuration';

export const isCheckoutBooking = (booking: any): boolean =>
  Boolean(booking?.$locals?.checkoutSession);

/**
 * A Booking document built from the session, never saved. It lets the payment
 * code (pricing, VAT, discounts) and the payment page read a checkout exactly
 * like the booking it will become.
 */
export const hydrateCheckoutBooking = (checkout: Pick<ICheckoutSession, '_id' | 'bookingData' | 'payment' | 'createdAt' | 'updatedAt'>) => {
  const hasIntent = Boolean(checkout.payment?.stripePaymentIntentId);
  const doc = Booking.hydrate({
    ...checkout.bookingData,
    _id: checkout._id,
    status: hasIntent ? 'payment_pending' : 'quote_accepted',
    ...(checkout.payment ? { payment: checkout.payment } : {}),
    createdAt: checkout.createdAt,
    updatedAt: checkout.updatedAt,
  });
  doc.$locals.checkoutSession = true;
  return doc;
};

export const populateCheckoutBooking = async (checkout: ICheckoutSession) =>
  hydrateCheckoutBooking(checkout).populate([
    { path: 'customer', select: 'name username email phone customerType location businessName timeZone isAnonymized deletedAt' },
    { path: 'professional', select: '_id name username businessInfo.companyName businessInfo.city businessInfo.country businessInfo.timezone timeZone isAnonymized deletedAt' },
    { path: 'project', select: PROJECT_FIELDS },
  ]);

export const findOpenCheckoutForCustomer = async (checkoutId: unknown, customerId: unknown) => {
  if (!mongoose.Types.ObjectId.isValid(String(checkoutId)) || !customerId) return null;
  return CheckoutSession.findOne({
    _id: new Types.ObjectId(String(checkoutId)),
    customer: new Types.ObjectId(String(customerId)),
    status: 'open',
  });
};

/**
 * Persist a new payment intent on an open session. The filter is the
 * optimistic lock createPaymentIntent uses on bookings: a concurrent attempt
 * that already replaced the intent makes this write miss.
 */
export const persistCheckoutPayment = async (
  checkoutId: unknown,
  previousIntentId: string | null | undefined,
  payment: Record<string, any>,
  paymentRow: Record<string, any>,
): Promise<boolean> => {
  const now = Date.now();
  const result = await CheckoutSession.updateOne(
    {
      _id: new Types.ObjectId(String(checkoutId)),
      status: 'open',
      'payment.stripePaymentIntentId': previousIntentId ?? null,
    },
    {
      $set: {
        payment,
        paymentRow,
        expiresAt: new Date(now + CHECKOUT_HOLD_MS),
        purgeAt: new Date(now + OPEN_PURGE_MS),
      },
    },
  );
  return result.matchedCount > 0;
};

export const startCheckoutSession = async (params: {
  bookingData: Record<string, any>;
  schedule: ICheckoutSchedule;
}) => {
  const { bookingData, schedule } = params;
  // One open checkout per customer: starting a new one (for example after the
  // payment page's back button) supersedes and cleans up the previous ones.
  await abandonOpenCheckoutsForCustomer(bookingData.customer);
  const id = new Types.ObjectId();
  bookingData._id = id;
  const now = Date.now();
  return CheckoutSession.create({
    _id: id,
    customer: bookingData.customer,
    professional: bookingData.professional,
    project: bookingData.project,
    bookingData,
    schedule,
    status: 'open',
    expiresAt: new Date(now + CHECKOUT_HOLD_MS),
    purgeAt: new Date(now + OPEN_PURGE_MS),
  });
};

export type AbandonOutcome = 'abandoned' | 'promoted' | 'in_flight';

/**
 * Close an unpaid session so it leaves nothing behind: cancel its intent,
 * release the referral benefit it reserved and delete it. An intent that
 * already succeeded is promoted instead; one that is still processing is left
 * for its webhook.
 */
export const abandonCheckoutSession = async (checkout: ICheckoutSession): Promise<AbandonOutcome> => {
  const intentId: string | undefined = checkout.payment?.stripePaymentIntentId;
  if (intentId) {
    let intent: any = null;
    try {
      intent = await stripe.paymentIntents.cancel(intentId);
    } catch (error: any) {
      if (error?.code === 'payment_intent_unexpected_state') {
        intent = await stripe.paymentIntents.retrieve(intentId);
      } else if (error?.code !== 'resource_missing') {
        throw error;
      }
    }
    if (intent?.status === 'succeeded') {
      const { promoteCheckoutSession } = await import('../handlers/Stripe/checkoutPromotion');
      await promoteCheckoutSession(String(checkout._id), intent);
      return 'promoted';
    }
    if (intent && intent.status !== 'canceled') return 'in_flight';
  }
  await releaseReferralReservation(String(checkout._id), checkout.payment?.discount?.referralReservationToken);
  await CheckoutSession.deleteOne({
    _id: checkout._id,
    status: 'open',
    'payment.stripePaymentIntentId': intentId ?? null,
  });
  return 'abandoned';
};

export const abandonOpenCheckoutsForCustomer = async (customerId: unknown) => {
  if (!customerId) return;
  const open = await CheckoutSession.find({ customer: customerId, status: 'open' });
  for (const checkout of open) {
    try {
      await abandonCheckoutSession(checkout);
    } catch (error: any) {
      console.error(`[CHECKOUT] Could not close checkout ${checkout._id}:`, error?.message || error);
    }
  }
};

/** Cron sweep: close every open session past its hold. */
export const expireStaleCheckoutSessions = async (now = new Date(), limit = 200) => {
  const stale = await CheckoutSession.find({ status: 'open', expiresAt: { $lte: now } }).limit(limit);
  const result = { checked: stale.length, abandoned: 0, promoted: 0, inFlight: 0, errors: [] as string[] };
  for (const checkout of stale) {
    try {
      const outcome = await abandonCheckoutSession(checkout);
      if (outcome === 'abandoned') result.abandoned += 1;
      else if (outcome === 'promoted') result.promoted += 1;
      else result.inFlight += 1;
    } catch (error: any) {
      result.errors.push(`${checkout._id}: ${error?.message || error}`);
    }
  }
  return result;
};
