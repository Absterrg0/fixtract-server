import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  bookingFindById: vi.fn(),
  paymentUpdate: vi.fn(),
  createIntent: vi.fn(),
  cancelIntent: vi.fn(),
}));

vi.mock('../../../models/booking', () => ({ default: { findById: mocks.bookingFindById } }));
vi.mock('../../../models/payment', () => ({ default: { findOneAndUpdate: mocks.paymentUpdate } }));
vi.mock('../../../models/user', () => ({ default: { findById: vi.fn() } }));
vi.mock('../../../models/platformSettings', () => ({ default: { getCurrentConfig: async () => ({ commissionPercent: 0 }) } }));
vi.mock('../../../models/loyaltyConfig', () => ({ default: { getCurrentConfig: async () => ({
  globalSettings: { isEnabled: true, minBookingAmount: 0 },
  tiers: [{ name: 'Silver', isActive: true, discountPercentage: 2, minSpendingAmount: 0 }],
}) } }));
vi.mock('../../../services/stripe', () => ({
  stripe: { paymentIntents: { create: mocks.createIntent, cancel: mocks.cancelIntent } },
  STRIPE_CONFIG: { environment: 'test' },
}));
vi.mock('../../../utils/support/accountGuard', () => ({
  withAnonymizationWriteFence: async (_ids: unknown, fn: (session?: unknown) => Promise<unknown>) => fn(undefined),
}));
vi.mock('../../../handlers/Stripe/payment', () => ({ captureAndTransferPayment: vi.fn() }));
vi.mock('../../../services/invoiceArtifacts', () => ({ ensureBookingInvoiceArtifacts: vi.fn() }));
vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));
vi.mock('../../../utils/notifications/notify', () => ({ notify: vi.fn(), notifyAsync: vi.fn() }));

import {
  createExtraCostPaymentIntent,
  hasOutstandingResolvedExtraCost,
} from '../../../handlers/Booking/completion';
import { getInvoicePayment } from '../../../utils/invoiceSettlement';

// BK-2026-000028 on staging: €700 checkout (−2 % loyalty) paid, extra costs
// disputed and adjusted by an admin to €150, booking completed.
const resolvedBooking = (overrides: Record<string, any> = {}) => {
  const doc: any = {
    _id: 'b6',
    bookingNumber: 'BK-2026-000028',
    status: 'completed',
    customer: { _id: 'customer-1', loyaltyLevel: 'Silver', totalSpent: 1000 },
    professional: { _id: 'pro-1', stripe: { accountId: 'acct_pro' } },
    project: { _id: 'p1', professionalId: 'pro-1' },
    extraCosts: [
      { type: 'unit_adjustment', name: 'Quantity adjustment', amount: 140, unitPrice: 35, estimatedUnits: 20, actualUnits: 24 },
      { type: 'other', name: 'Skirting repair', amount: 100 },
    ],
    extraCostTotal: 150,
    extraCostStatus: 'confirmed',
    dispute: { type: 'extra_costs', raisedAt: new Date('2026-11-20T07:50:39Z'), resolvedAt: new Date('2026-11-20T07:54:29Z'), adminAdjustedAmount: 150 },
    payment: {
      status: 'authorized', currency: 'EUR', amount: 686, netAmount: 686, vatRate: 21, vatAmount: 144.06,
      totalWithVat: 830.06, reverseCharge: false, capturedAt: new Date('2026-11-20T07:47:03Z'), stripeChargeId: 'ch_1',
    },
    ...overrides,
  };
  doc.set = vi.fn((path: string, value: unknown) => {
    const keys = path.split('.');
    let target = doc;
    for (const key of keys.slice(0, -1)) target = target[key] ??= {};
    target[keys[keys.length - 1]] = value;
  });
  doc.save = vi.fn(async () => doc);
  return doc;
};

const findReturning = (booking: unknown) => {
  const chain: any = { populate: () => chain, then: (resolve: (value: unknown) => unknown) => resolve(booking) };
  mocks.bookingFindById.mockReturnValue(chain);
};

const callHandler = async () => {
  let status = 200;
  let body: any;
  const res: any = {
    status(code: number) { status = code; return this; },
    json(payload: unknown) { body = payload; return this; },
  };
  await createExtraCostPaymentIntent({ params: { bookingId: 'b6' }, user: { _id: 'customer-1' } } as any, res);
  return { status, body };
};

describe('FT3-13a — extra cost adjusted by an admin dispute resolution is still charged', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createIntent.mockResolvedValue({ id: 'pi_extra', client_secret: 'pi_extra_secret' });
    mocks.paymentUpdate.mockResolvedValue({});
  });

  it('detects an unpaid, resolved extra-cost dispute on a completed booking only', () => {
    expect(hasOutstandingResolvedExtraCost(resolvedBooking())).toBe(true);
    expect(hasOutstandingResolvedExtraCost(resolvedBooking({ extraCostTotal: 0 }))).toBe(false);
    expect(hasOutstandingResolvedExtraCost(resolvedBooking({ dispute: { type: 'other', resolvedAt: new Date() } }))).toBe(false);
    expect(hasOutstandingResolvedExtraCost(resolvedBooking({ dispute: { type: 'extra_costs', resolvedAt: null } }))).toBe(false);
    expect(hasOutstandingResolvedExtraCost(resolvedBooking({ status: 'in_progress' }))).toBe(false);
    const paid = resolvedBooking();
    paid.payment.extraCostPaymentSucceeded = true;
    expect(hasOutstandingResolvedExtraCost(paid)).toBe(false);
  });

  it('lets the customer pay the adjusted amount (with loyalty) on the completed booking', async () => {
    const booking = resolvedBooking();
    findReturning(booking);
    const { status, body } = await callHandler();
    expect(status).toBe(200);
    // Same charge as the regular extra-cost checkout. At 0 % commission there
    // is no platform share to absorb the loyalty discount: 150 + 21 % VAT.
    expect(body.data).toMatchObject({ clientSecret: 'pi_extra_secret', extraCostTotal: 150, customerNetChargeAmount: 150, vatAmount: 31.5, customerChargeAmount: 181.5 });
    expect(mocks.createIntent).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 18150, transfer_data: { destination: 'acct_pro' } }),
      expect.anything(),
    );
    expect(booking.payment).toMatchObject({ extraCostStripePaymentIntentId: 'pi_extra', extraCostAmount: 181.5, extraCostNetAmount: 150, extraCostCustomerDiscount: 0 });
  });

  it('replaces a stale unpaid intent created for the originally requested amount', async () => {
    const booking = resolvedBooking();
    Object.assign(booking.payment, { extraCostStripePaymentIntentId: 'pi_old', extraCostClientSecret: 'pi_old_secret', extraCostNetAmount: 240 });
    findReturning(booking);
    const { status, body } = await callHandler();
    expect(status).toBe(200);
    expect(mocks.cancelIntent).toHaveBeenCalledWith('pi_old');
    expect(body.data.clientSecret).toBe('pi_extra_secret');
  });

  it('still refuses extra-cost payment on a completed booking without a resolved extra-cost dispute', async () => {
    findReturning(resolvedBooking({ dispute: undefined }));
    const { status, body } = await callHandler();
    expect(status).toBe(400);
    expect(body.error.code).toBe('INVALID_STATUS');
    expect(mocks.createIntent).not.toHaveBeenCalled();
  });

  it('states the captured checkout as paid and the extra cost as due on the customer invoice', () => {
    // Checkout 830.06 captured (payout still pending) + extra 181.50 not yet paid.
    expect(getInvoicePayment(resolvedBooking(), 'customer', 1011.56)).toEqual({ paidAmount: 830.06, settled: false });
    const uncaptured = resolvedBooking();
    uncaptured.payment = { ...uncaptured.payment, capturedAt: undefined, stripeChargeId: undefined };
    expect(getInvoicePayment(uncaptured, 'customer', 1011.56).paidAmount).toBe(0);
  });
});
