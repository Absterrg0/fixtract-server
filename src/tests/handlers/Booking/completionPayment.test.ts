import { beforeEach, describe, expect, it, vi } from 'vitest';
import { inflateSync } from 'node:zlib';

const mocks = vi.hoisted(() => ({
  bookingFindById: vi.fn(),
  bookingFindOneAndUpdate: vi.fn(),
  paymentUpdate: vi.fn(),
  retrieveIntent: vi.fn(),
  retrieveCharge: vi.fn(),
  captureAndTransfer: vi.fn(),
  invoiceArtifacts: vi.fn(),
  waitUntil: vi.fn(),
  constructEvent: vi.fn(),
  stripeEventUpdate: vi.fn(),
}));

vi.mock('../../../models/booking', () => ({ default: {
  findById: mocks.bookingFindById,
  findOneAndUpdate: mocks.bookingFindOneAndUpdate,
} }));
vi.mock('../../../models/payment', () => ({ default: { findOneAndUpdate: mocks.paymentUpdate } }));
vi.mock('../../../models/stripeEvent', () => ({ default: { updateOne: mocks.stripeEventUpdate } }));
vi.mock('../../../models/user', () => ({ default: {
  findById: () => ({ select: () => ({ lean: async () => null }) }),
} }));
vi.mock('../../../services/stripe', () => ({
  stripe: {
    paymentIntents: { retrieve: mocks.retrieveIntent }, charges: { retrieve: mocks.retrieveCharge },
    webhooks: { constructEvent: mocks.constructEvent },
  },
  STRIPE_CONFIG: { environment: 'test' },
}));
vi.mock('../../../handlers/Stripe/payment', () => ({ captureAndTransferPayment: mocks.captureAndTransfer }));
vi.mock('../../../services/invoiceArtifacts', () => ({ ensureBookingInvoiceArtifacts: mocks.invoiceArtifacts }));
vi.mock('../../../models/platformSettings', () => ({ default: {
  getCurrentConfig: async () => ({
    companyAddress: { name: 'Fixtract', country: 'BE' }, companyVatNumber: 'BE1002103337',
  }),
} }));
vi.mock('../../../models/invoiceSequence', () => ({ default: {
  findOneAndUpdate: async () => ({ value: 20 }),
} }));
vi.mock('@vercel/functions', () => ({ waitUntil: mocks.waitUntil }));
vi.mock('../../../utils/referralSystem', () => ({ processReferralCompletion: vi.fn() }));
vi.mock('../../../utils/professionalLevelSystem', () => ({ updateProfessionalLevel: vi.fn() }));
vi.mock('../../../utils/loyaltySystem', () => ({ getCurrentTier: vi.fn(), updateUserLoyalty: vi.fn() }));
vi.mock('../../../utils/bookingHelpers', () => ({
  getUnpaidMilestoneCount: () => 0,
  markMilestonesCompleted: vi.fn(),
  ensureWarrantyCoverageSnapshot: vi.fn(),
  getProfessionalId: async () => null,
  awardBookingCompletionPoints: vi.fn(),
}));
vi.mock('../../../utils/notifications/notify', () => ({ notify: vi.fn(), notifyAsync: vi.fn() }));

import { customerConfirmCompletion } from '../../../handlers/Booking/completion';
import { finalizeBookingCompletion } from '../../../utils/notifications/runCompletionAutoAccept';
import { getInvoicePayment } from '../../../utils/invoiceSettlement';
import { generateBookingInvoice } from '../../../services/invoiceGenerator';
import { handleWebhook } from '../../../handlers/Stripe/webhooks';

const pdfText = (pdf: Buffer) => {
  const streams = pdf.toString('latin1').matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g);
  return [...streams].flatMap((stream) => {
    try {
      return [...inflateSync(Buffer.from(stream[1], 'latin1')).toString('latin1').matchAll(/<([0-9a-f]+)>/gi)]
        .map((match) => Buffer.from(match[1], 'hex').toString('latin1'));
    } catch {
      return [];
    }
  }).join('');
};

describe.each(['customer confirmation', 'automatic acceptance'] as const)('%s with paid extras', (flow) => {
  let booking: any;
  let invoicePayment: ReturnType<typeof getInvoicePayment> | undefined;
  let generatedPdf: Buffer | undefined;
  let generatedXml: string | undefined;

  const deliverSuccessWebhook = async (expectedError?: string) => {
    const json = vi.fn();
    const status = vi.fn().mockReturnThis();
    mocks.constructEvent.mockReturnValue({
      id: 'evt_extra', type: 'payment_intent.succeeded', created: 1792454400,
      data: { object: {
        id: 'pi_extra', status: 'succeeded', latest_charge: 'ch_extra',
        metadata: { type: 'extra_cost', bookingId: 'booking-1' },
      } },
    });
    await handleWebhook({ headers: { 'stripe-signature': 'test-signature' }, body: Buffer.from('{}') } as any, { json, status } as any);
    if (expectedError) {
      expect(json).toHaveBeenCalledWith({ received: false, error: expectedError });
      expect(status).toHaveBeenCalledWith(500);
    } else {
      expect(json).toHaveBeenCalledWith({ received: true });
      expect(status).not.toHaveBeenCalled();
    }
  };

  const complete = async () => {
    let result: unknown;
    if (flow === 'automatic acceptance') {
      result = await finalizeBookingCompletion({ bookingId: 'booking-1' });
    } else {
      const json = vi.fn();
      const status = vi.fn().mockReturnThis();
      await customerConfirmCompletion({
        params: { bookingId: 'booking-1' }, user: { _id: 'customer-1' },
      } as any, { json, status } as any);
      result = json.mock.calls[0]?.[0];
    }
    await Promise.all(mocks.waitUntil.mock.calls.map(([work]) => work));
    return result;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    invoicePayment = undefined;
    generatedPdf = undefined;
    generatedXml = undefined;
    booking = {
      _id: 'booking-1', customer: 'customer-1', status: 'professional_completed',
      extraCostTotal: 35.71, extraCosts: [{ amount: 35.71 }],
      payment: {
        status: 'completed', totalWithVat: 522.3, currency: 'EUR',
        netAmount: 492.74, vatAmount: 29.56, vatRate: 6, reverseCharge: false,
        extraCostCustomerNetAmount: 38.33, extraCostVatAmount: 2.3,
        extraCostAmount: 40.63, extraCostStripePaymentIntentId: 'pi_extra',
        extraCostStatus: 'pending', extraCostPaymentSucceeded: false,
      },
      save: vi.fn(),
    };
    mocks.bookingFindById.mockImplementation(async () => booking);
    mocks.bookingFindOneAndUpdate.mockImplementation(async (filter, update) => {
      for (const [path, condition] of Object.entries(filter)) {
        const value = path.split('.').reduce((target, key) => target?.[key], booking);
        const matches = typeof condition === 'object' && condition !== null && '$in' in condition
          ? (condition.$in as unknown[]).includes(value)
          : condition === value;
        if (!matches) return null;
      }
      for (const [path, value] of Object.entries(update.$set || {})) {
        const keys = path.split('.');
        let target = booking;
        for (const key of keys.slice(0, -1)) target = target[key] ??= {};
        target[keys[keys.length - 1]] = value;
      }
      return booking;
    });
    mocks.retrieveIntent.mockResolvedValue({ id: 'pi_extra', status: 'succeeded', latest_charge: 'ch_extra' });
    mocks.retrieveCharge.mockResolvedValue({
      id: 'ch_extra', transfer: 'tr_extra', status: 'succeeded', refunded: false, amount_refunded: 0,
    });
    mocks.paymentUpdate.mockResolvedValue({});
    mocks.stripeEventUpdate.mockResolvedValue({ upsertedCount: 1 });
    mocks.captureAndTransfer.mockResolvedValue({ success: true });
    mocks.invoiceArtifacts.mockImplementation(async () => {
      invoicePayment = getInvoicePayment(booking, 'customer', 562.93);
      const invoiceBooking = {
        ...booking,
        bookingNumber: 'BK-2026-000107',
        customer: { name: 'Customer', companyAddress: { country: 'BE' } },
        professional: { name: 'Professional', businessInfo: { country: 'NL' } },
      };
      generatedPdf = (await generateBookingInvoice(invoiceBooking, { kind: 'customer' })).pdfBuffer;
      const { buildUblInvoiceXml } = await vi.importActual<typeof import('../../../services/invoiceArtifacts')>('../../../services/invoiceArtifacts');
      generatedXml = buildUblInvoiceXml(invoiceBooking, 'FIX-2026-000020', new Date(), {
        selfBilling: false, platform: { name: 'Fixtract', country: 'BE', vatNumber: 'BE1002103337' },
      });
    });
  });

  it('invoices the full amount as paid even before the success webhook arrives', async () => {
    await complete();

    expect(mocks.invoiceArtifacts).toHaveBeenCalledWith('booking-1');
    expect(invoicePayment).toEqual({ paidAmount: 562.93, settled: true });
    expect(booking.payment.extraCostStatus).toBe('succeeded');
    expect(booking.payment.extraCostPaymentSucceeded).toBe(true);
    expect(mocks.paymentUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ booking: 'booking-1', extraCostStripePaymentIntentId: 'pi_extra' }),
      expect.objectContaining({ $set: expect.objectContaining({ extraCostStatus: 'succeeded', extraCostPaymentSucceeded: true }) }),
    );
    // The actual customer artifacts agree with the payment state at issuance.
    expect(generatedXml).toBeDefined();
    expect(pdfText(generatedPdf!)).toMatch(/TOTAL[^]*562\.93PAID via Fixtract[^]*562\.93Amount due[^]*0\.00/);
    expect(generatedXml).toContain('<cbc:PrepaidAmount currencyID="EUR">562.93</cbc:PrepaidAmount>');
    expect(generatedXml).toContain('<cbc:PayableAmount currencyID="EUR">0.00</cbc:PayableAmount>');
    expect(booking.payment.extraCostStripeChargeId).toBe('ch_extra');
    expect(booking.payment.extraCostTransferId).toBe('tr_extra');
  });

  it('also invoices as paid when the webhook reconciles the payment first', async () => {
    await deliverSuccessWebhook();
    await complete();

    expect(invoicePayment).toEqual({ paidAmount: 562.93, settled: true });
    expect(booking.payment.extraCostTransferId).toBe('tr_extra');
  });

  it('keeps a completed booking paid when the webhook arrives afterwards', async () => {
    await complete();
    await deliverSuccessWebhook();

    expect(getInvoicePayment(booking, 'customer', 562.93)).toEqual({ paidAmount: 562.93, settled: true });
    expect(booking.status).toBe('completed');
    expect(mocks.invoiceArtifacts).toHaveBeenCalledTimes(1);
  });

  it('reconciles a successful retry of a previously failed extra payment', async () => {
    booking.payment.extraCostStatus = 'failed';
    await complete();

    expect(invoicePayment).toEqual({ paidAmount: 562.93, settled: true });
  });

  it('does not finalize a payment that was refunded before reconciliation', async () => {
    booking.payment.extraCostStatus = 'refunded';
    await complete();

    expect(mocks.invoiceArtifacts).not.toHaveBeenCalled();
    expect(mocks.captureAndTransfer).not.toHaveBeenCalled();
    expect(mocks.paymentUpdate).not.toHaveBeenCalled();
    expect(booking.payment.extraCostStatus).toBe('refunded');
  });

  it.each([
    { name: 'fully refunded', status: 'succeeded', refunded: true, amount_refunded: 4063 },
    { name: 'partly refunded', status: 'succeeded', refunded: false, amount_refunded: 100 },
    { name: 'pending', status: 'pending', refunded: false, amount_refunded: 0 },
    { name: 'failed', status: 'failed', refunded: false, amount_refunded: 0 },
  ])('does not finalize a $name charge even if the intent still succeeded', async (charge) => {
    mocks.retrieveCharge.mockResolvedValue({ id: 'ch_extra', transfer: 'tr_extra', ...charge });
    await complete();

    expect(mocks.invoiceArtifacts).not.toHaveBeenCalled();
    expect(mocks.captureAndTransfer).not.toHaveBeenCalled();
    expect(mocks.bookingFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mocks.paymentUpdate).not.toHaveBeenCalled();
    expect(booking.status).toBe('professional_completed');
    expect(booking.payment.extraCostStatus).toBe('pending');
  });

  it('does not complete or invoice when the charge cannot be verified', async () => {
    mocks.retrieveCharge.mockRejectedValueOnce(new Error('Stripe unavailable'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      if (flow === 'automatic acceptance') {
        await expect(complete()).rejects.toThrow('Stripe unavailable');
      } else {
        expect(await complete()).toMatchObject({ success: false, error: { code: 'SERVER_ERROR' } });
      }
    } finally {
      consoleError.mockRestore();
    }

    expect(mocks.invoiceArtifacts).not.toHaveBeenCalled();
    expect(mocks.captureAndTransfer).not.toHaveBeenCalled();
    expect(mocks.bookingFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mocks.paymentUpdate).not.toHaveBeenCalled();
    expect(booking.payment.extraCostStatus).toBe('pending');
  });

  it('does not let a late success webhook mark a refunded charge as paid', async () => {
    mocks.retrieveCharge.mockResolvedValue({
      id: 'ch_extra', status: 'succeeded', refunded: true, amount_refunded: 4063,
    });
    await deliverSuccessWebhook();

    expect(mocks.bookingFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mocks.paymentUpdate).not.toHaveBeenCalled();
    expect(booking.payment.extraCostStatus).toBe('pending');
  });

  it('returns a retryable webhook error when the charge cannot be verified', async () => {
    mocks.retrieveCharge.mockRejectedValueOnce(new Error('Stripe unavailable'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await deliverSuccessWebhook('Stripe unavailable');
    } finally {
      consoleError.mockRestore();
    }

    expect(mocks.bookingFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mocks.paymentUpdate).not.toHaveBeenCalled();
  });

  it('does not finalize a replaced payment intent', async () => {
    mocks.retrieveIntent.mockImplementationOnce(async () => {
      booking.payment.extraCostStripePaymentIntentId = 'pi_replacement';
      return { id: 'pi_extra', status: 'succeeded' };
    });
    await complete();

    expect(mocks.invoiceArtifacts).not.toHaveBeenCalled();
    expect(mocks.captureAndTransfer).not.toHaveBeenCalled();
    expect(mocks.paymentUpdate).not.toHaveBeenCalled();
    expect(booking.payment.extraCostStatus).toBe('pending');
  });

  it.each(['processing', 'requires_payment_method'])('does not complete or invoice an extra payment that is %s', async (status) => {
    mocks.retrieveIntent.mockResolvedValue({ id: 'pi_extra', status });
    await complete();

    expect(mocks.invoiceArtifacts).not.toHaveBeenCalled();
    expect(mocks.captureAndTransfer).not.toHaveBeenCalled();
    expect(booking.payment.extraCostStatus).toBe('pending');
  });
});
