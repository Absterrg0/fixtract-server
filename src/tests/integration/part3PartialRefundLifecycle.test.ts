import mongoose, { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ refund: vi.fn(), invoices: vi.fn(), credits: vi.fn(), notify: vi.fn() }));
vi.mock('../../services/stripe', () => ({ stripe: {
  refunds: { create: mocks.refund }, transfers: { createReversal: vi.fn() },
}, STRIPE_CONFIG: { supportedCurrencies: ['EUR'], defaultCurrency: 'EUR', environment: 'test' } }));
vi.mock('../../services/invoiceArtifacts', () => ({
  ensurePartialRefundCreditArtifacts: mocks.credits, ensureBookingInvoiceArtifacts: mocks.invoices,
}));
vi.mock('../../utils/notifications/notify', () => ({ notify: mocks.notify }));
vi.mock('../../utils/auditLogger', () => ({ auditLog: vi.fn(async () => undefined) }));
import Booking from '../../models/booking';
import User from '../../models/user';
import CalendarReservation from '../../models/calendarReservation';
import Payment from '../../models/payment';
import CancellationRequest from '../../models/cancellationRequest';
import { customerRespondToCounterOffer } from '../../handlers/Booking/refundNegotiation';
import { refundPayment } from '../../handlers/Stripe/payment';
import { resolveDispute } from '../../handlers/Admin/disputeManagement';
import { replaceBookingCalendar } from '../../utils/support/bookingCalendar';

const uri = process.env.FIXERA_TEST_MONGODB_URI;
const describeDb = uri && /test/i.test(uri) ? describe : describe.skip;
const proId = new Types.ObjectId(), customerId = new Types.ObjectId(), adminId = new Types.ObjectId();
const utcDay = (offset: number) => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offset));
};
const response = () => {
  const res = { statusCode: 200, body: undefined as any,
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.body = body; return this; } };
  return res;
};

describeDb('Part 3 partial refund lifecycle with isolated Mongo and provider fakes', () => {
  beforeAll(async () => {
    await mongoose.connect(uri!, { dbName: `ft3_refund_${process.pid}_${Date.now().toString(36)}` });
    await CalendarReservation.createIndexes();
  });
  afterAll(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });
  beforeEach(async () => {
    vi.clearAllMocks();
    await Promise.all([Booking.collection.deleteMany({}), User.collection.deleteMany({}),
      CalendarReservation.collection.deleteMany({}), Payment.collection.deleteMany({}), CancellationRequest.collection.deleteMany({})]);
    await User.collection.insertMany([
      { _id: proId, role: 'professional', name: 'Professional', email: 'pro@ft3.test' },
      { _id: customerId, role: 'customer', name: 'Customer', email: 'customer@ft3.test' },
      { _id: adminId, role: 'admin', name: 'Admin', email: 'admin@ft3.test' },
    ] as any[]);
    mocks.refund.mockResolvedValue({ id: 're_ft3_partial', status: 'succeeded', created: Math.floor(Date.now() / 1000) });
    mocks.credits.mockResolvedValue('generate');
    // Actual routing is exercised; actual PDF/UBL builders have their own
    // finance suites. These artifact writes never contact Odoo or S3.
    mocks.invoices.mockImplementation(async (id: string) => Booking.updateOne({ _id: id }, { $set: {
      'payment.invoiceNumber': 'FIX-FT3-TEST', 'payment.supplierInvoiceNumber': 'SUP-FT3-TEST',
    } }));
  });

  for (const path of ['direct', 'dispute', 'negotiated'] as const) {
    for (const hasPast of [true, false]) {
      it(`${path}: cancels a partial refund, keeps ${hasPast ? 'past days' : 'no phantom window'}, and issues both artifacts`, async () => {
        const id = new Types.ObjectId();
        const plan = [{ resourceId: proId, days: [...(hasPast ? [utcDay(-1)] : []), utcDay(1)] }];
        const booking = { _id: id, bookingNumber: `BK-FT3-${id}`, bookingType: 'professional',
          professional: proId, customer: customerId, status: path === 'dispute' ? 'dispute' : 'in_progress',
          statusBeforeDispute: 'in_progress', scheduleTimeZone: 'UTC',
          location: { type: 'Point', coordinates: [4.35, 50.85], country: 'BE' },
          vatDecision: { action: 'standard_rate', country: 'BE', standardRate: 21, appliedRate: 21, reverseCharge: false },
          rfqData: { serviceType: 'Plumbing', description: 'Partial refund regression fixture' },
          dispute: { type: 'refund_request', raisedAt: new Date(), raisedBy: customerId, reason: 'Cancelled after work began' },
          scheduledStartDate: utcDay(-2), scheduledExecutionEndDate: utcDay(3),
          assignedTeamMembers: [proId], resourcePlan: plan, quote: { amount: 100, currency: 'EUR' },
          payment: { status: 'completed', stripePaymentIntentId: 'pi_ft3_partial', currency: 'EUR',
            amount: 100, netAmount: 100, vatAmount: 21, vatRate: 21, totalWithVat: 121 } };
        await Booking.collection.insertOne(booking as any);
        await replaceBookingCalendar(booking);
        const res = response();
        if (path === 'direct') await refundPayment({ user: { _id: adminId }, body: { bookingId: String(id), amount: 50, reason: 'Partial cancellation' } } as any, res as any);
        else if (path === 'dispute') await resolveDispute({ user: { _id: adminId }, params: { bookingId: String(id) },
          body: { forceStatus: 'refunded', action: 'adjust', adjustedAmount: 50, resolution: 'Partial cancellation' } } as any, res as any);
        else {
          await CancellationRequest.create({ booking: id, requestedBy: customerId, requestedRole: 'customer',
            status: 'negotiating', reason: 'Partial cancellation', counterOfferAmount: 50 });
          await customerRespondToCounterOffer({ user: { _id: customerId }, params: { bookingId: String(id) },
            body: { decision: 'accept' } } as any, res as any);
        }
        expect(res.statusCode).toBe(200);
        expect(mocks.refund).toHaveBeenCalledWith(expect.objectContaining({ amount: 5000 }), expect.anything());
        await vi.waitFor(async () => {
          const current = await Booking.findById(id).lean();
          expect(current?.payment?.invoiceNumber).toBe('FIX-FT3-TEST');
          expect(current?.payment?.supplierInvoiceNumber).toBe('SUP-FT3-TEST');
        }, { timeout: 10000 });
        const current = await Booking.findById(id);
        expect(current?.status).toBe('cancelled');
        expect(current?.payment?.status).toBe('partially_refunded');
        expect(current?.resourcePlan?.[0]?.days.map(day => day.toISOString())).toEqual(hasPast ? [utcDay(-1).toISOString()] : []);
        if (path === 'dispute') expect(res.body.data.booking.status).toBe('cancelled');
        const initialReservations = await CalendarReservation.find({ sourceType: 'booking', sourceId: id }).lean();
        expect(initialReservations.length > 0).toBe(hasPast);
        expect(initialReservations.every((row: any) => new Date(row.startAt) < utcDay(0))).toBe(true);
        // A later save used to release the retained historical reservations.
        await current!.save();
        const reservations = await CalendarReservation.find({ sourceType: 'booking', sourceId: id }).lean();
        expect(reservations.length > 0).toBe(hasPast);
        expect(reservations.every((row: any) => new Date(row.startAt) < utcDay(0))).toBe(true);
        expect(mocks.credits).toHaveBeenCalledWith(String(id));
        const refunds = await Payment.findOne({ booking: id }).lean();
        expect(refunds?.refunds?.[0]?.amount).toBe(50);
      }, 30000);
    }
  }
});
