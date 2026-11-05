import mongoose, { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';

/**
 * Real-Mongo end-to-end coverage for the dashboard bookings list money
 * (`GET /api/bookings/my-bookings` -> getMyBookings -> `booking.overview`).
 * Refund facts are seeded as actual stored Payment ledger rows
 * (`Payment.refunds[]` on the booking-level row), never as a
 * `booking.payment.refunds` field, which the Booking model does not have.
 * No payment is processed and no provider is called.
 */

const testUri = process.env.FIXERA_TEST_MONGODB_URI;
const hasDisposableMongo = Boolean(testUri && /test/i.test(testUri));
const describeDb = hasDisposableMongo ? describe : describe.skip;

vi.hoisted(() => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
  process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_overview_money';
});

import Booking from '../../models/booking';
import Payment from '../../models/payment';
import Project from '../../models/project';
import User from '../../models/user';
import { getMyBookings } from '../../handlers/Booking';

const response = () => {
  const res: any = { statusCode: 200, body: undefined };
  res.status = vi.fn((code: number) => { res.statusCode = code; return res; });
  res.json = vi.fn((body: any) => { res.body = body; return res; });
  return res;
};

const CUSTOMER = new Types.ObjectId();
const OTHER_CUSTOMER = new Types.ObjectId();
const PRO = new Types.ObjectId();
const PROJECT = new Types.ObjectId();

const NOT_RECORDED = { amount: null, currency: null, source: 'not_recorded' };
const money = (amount: number) => ({ amount, currency: 'EUR', source: 'recorded' });

const list = async (user: { _id: Types.ObjectId }) => {
  const res = response();
  const next = vi.fn();
  await getMyBookings({ user: { _id: user._id }, query: { limit: '50' } } as unknown as Request, res, next);
  expect(next).not.toHaveBeenCalled();
  expect(res.statusCode).toBe(200);
  return res.body as { bookings: any[] };
};

let seq = 0;
const ids: Record<string, Types.ObjectId> = {};
const paidPayment = (extra: Record<string, unknown> = {}) => ({
  status: 'completed',
  currency: 'EUR',
  amount: 1000, // pre-VAT net, never the paid price
  netAmount: 1000,
  totalWithVat: 1210,
  professionalPayout: 900,
  stripePaymentIntentId: `pi_overview_${seq}`,
  ...extra,
});
const seedBooking = async (key: string, fields: Record<string, unknown>) => {
  seq += 1;
  const _id = new Types.ObjectId();
  ids[key] = _id;
  await Booking.collection.insertOne({
    _id,
    bookingNumber: `BK-2026-9${String(seq).padStart(5, '0')}`,
    bookingType: 'project',
    customer: CUSTOMER,
    project: PROJECT, // professional only through the owned project
    status: 'completed',
    createdAt: new Date(Date.UTC(2026, 9, 1, 0, seq)),
    updatedAt: new Date(Date.UTC(2026, 9, 1, 0, seq)),
    ...fields,
  });
  return _id;
};
const seedLedger = async (booking: Types.ObjectId, refunds: Array<Record<string, unknown>>, milestoneIndex?: null) => {
  await Payment.collection.insertOne({
    booking,
    customer: CUSTOMER,
    professional: PRO,
    status: 'completed',
    currency: 'EUR',
    amount: 1000,
    ...(milestoneIndex === null ? { milestoneIndex: null } : {}),
    refunds: refunds.map((refund, index) => ({
      refundId: `re_${String(booking)}_${index}`,
      refundedAt: new Date('2026-10-15T10:00:00.000Z'),
      source: 'platform',
      notes: 'internal ledger note',
      ...refund,
    })),
  });
};

describeDb('bookings list overview money from the stored Payment ledger (disposable Mongo)', () => {
  beforeAll(async () => {
    await mongoose.connect(testUri!, { dbName: 'fixera_booking_list_overview_test' });
    await Promise.all([Booking, Payment, Project, User].map((model) => model.init()));
    await mongoose.connection.dropDatabase();
  });

  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    seq = 0;
    await Promise.all([
      Booking.collection.deleteMany({}),
      Payment.collection.deleteMany({}),
      Project.collection.deleteMany({}),
      User.collection.deleteMany({}),
    ]);
    await User.collection.insertMany([
      { _id: CUSTOMER, name: 'Customer', email: 'overview-customer@example.test', role: 'customer' },
      { _id: OTHER_CUSTOMER, name: 'Other', email: 'overview-other@example.test', role: 'customer' },
      { _id: PRO, name: 'Pro', email: 'overview-pro@example.test', role: 'professional', professionalStatus: 'approved' },
    ]);
    await Project.collection.insertOne({ _id: PROJECT, professionalId: PRO, title: 'Overview money project', service: 'Painting' });

    // Settled extra-cost charge, no refunds: + gross charge (not the net 100).
    await seedBooking('charged', { payment: paidPayment({ extraCostAmount: 121, extraCostNetAmount: 100, extraCostStatus: 'succeeded' }) });
    await seedLedger(ids.charged, [], null);
    // Charge, then full refund of it: nets to 0, never -121.
    await seedBooking('fullyRefunded', { payment: paidPayment({ extraCostAmount: 121, extraCostStatus: 'refunded' }) });
    await seedLedger(ids.fullyRefunded, [{ amount: 121, kind: 'extra_cost', status: 'succeeded' }], null);
    // Charge, then partial refund: remainder.
    await seedBooking('partiallyRefunded', { payment: paidPayment({ extraCostAmount: 121, extraCostStatus: 'refunded' }) });
    await seedLedger(ids.partiallyRefunded, [{ amount: 40, kind: 'extra_cost', status: 'succeeded' }]);
    // Negative-only adjustment returned against the base charge; a failed
    // attempt returned nothing. Legacy row without milestoneIndex.
    await seedBooking('credit', { payment: paidPayment() });
    await seedLedger(ids.credit, [
      { amount: 30, kind: 'extra_cost', status: 'succeeded' },
      { amount: 99, kind: 'extra_cost', status: 'failed' },
    ]);
    // Legacy extra-cost row without status counts; canceled does not.
    await seedBooking('legacyCredit', { payment: paidPayment() });
    await seedLedger(ids.legacyCredit, [
      { amount: 15, kind: 'extra_cost' },
      { amount: 40, kind: 'extra_cost', status: 'canceled' },
    ]);
    // Refund still in flight: unknown, not zero.
    await seedBooking('pendingCredit', { payment: paidPayment() });
    await seedLedger(ids.pendingCredit, [{ amount: 30, kind: 'extra_cost', status: 'pending' }]);
    // Booking-price refund only: its own column, never the addition.
    await seedBooking('bookingRefund', { status: 'refunded', payment: paidPayment({ status: 'refunded', refundAmount: 200 }) });
    await seedLedger(ids.bookingRefund, [{ amount: 200, kind: 'booking', status: 'succeeded' }]);
    // Refunded extra-cost charge whose refund is not in the ledger: unknown.
    await seedBooking('refundedNoRow', { payment: paidPayment({ extraCostAmount: 121, extraCostStatus: 'refunded' }) });
    // Awaiting payment, no Payment row: nothing paid, nothing added.
    await seedBooking('awaiting', {
      status: 'payment_pending',
      payment: { status: 'pending', currency: 'EUR', amount: 1000, totalWithVat: 1210 },
    });
    // Another customer's booking with ledger rows, outside both scopes.
    await Booking.collection.insertOne({
      _id: (ids.foreign = new Types.ObjectId()),
      bookingNumber: 'BK-2026-999999',
      bookingType: 'professional',
      customer: OTHER_CUSTOMER,
      professional: new Types.ObjectId(),
      status: 'completed',
      payment: paidPayment({ extraCostAmount: 50, extraCostStatus: 'succeeded' }),
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
    });
    await seedLedger(ids.foreign, [{ amount: 50, kind: 'extra_cost', status: 'succeeded' }]);
  });

  const expected = () => new Map<string, { paidPrice: any; completionAddition: any }>([
    [String(ids.charged), { paidPrice: money(1210), completionAddition: money(121) }],
    [String(ids.fullyRefunded), { paidPrice: money(1210), completionAddition: money(0) }],
    [String(ids.partiallyRefunded), { paidPrice: money(1210), completionAddition: money(81) }],
    [String(ids.credit), { paidPrice: money(1210), completionAddition: money(-30) }],
    [String(ids.legacyCredit), { paidPrice: money(1210), completionAddition: money(-15) }],
    [String(ids.pendingCredit), { paidPrice: money(1210), completionAddition: NOT_RECORDED }],
    [String(ids.bookingRefund), { paidPrice: money(1210), completionAddition: NOT_RECORDED }],
    [String(ids.refundedNoRow), { paidPrice: money(1210), completionAddition: NOT_RECORDED }],
    [String(ids.awaiting), { paidPrice: NOT_RECORDED, completionAddition: NOT_RECORDED }],
  ]);

  it('attaches the ledger-derived overview to the customer and project-owner lists, in one ledger read', async () => {
    const paymentFind = vi.spyOn(Payment, 'find');
    for (const viewer of [{ _id: CUSTOMER }, { _id: PRO }]) {
      paymentFind.mockClear();
      const body = await list(viewer);
      const byId = new Map(body.bookings.map((booking) => [String(booking._id), booking]));
      expect([...byId.keys()].sort()).toEqual([...expected().keys()].sort());
      for (const [id, overview] of expected()) {
        const row = byId.get(id);
        // Exactly the computed money fields, nothing else.
        expect(row.overview).toEqual(overview);
        // No ledger rows, provider ids or notes reach the payload.
        expect(row.payment?.refunds).toBeUndefined();
        expect(JSON.stringify(row)).not.toContain('re_');
        expect(JSON.stringify(row)).not.toContain('internal ledger note');
      }
      // The booking-price refund stays in its own (pro-side) column source.
      const refunded = byId.get(String(ids.bookingRefund));
      expect(refunded.payment.refundAmount).toBe(200);
      // One batched ledger query for the whole page, scoped to its bookings.
      expect(paymentFind).toHaveBeenCalledTimes(1);
      const filter: any = paymentFind.mock.calls[0][0];
      expect(filter.milestoneIndex).toBeNull();
      expect(filter.booking.$in.map(String).sort()).toEqual([...expected().keys()].sort());
    }
    // Customer payloads never carry the pro payout summary.
    const customerBody = await list({ _id: CUSTOMER });
    expect(customerBody.bookings.every((booking) => booking.payment?.professionalPayout === undefined)).toBe(true);
  });

  it('keeps other customers out of scope and never reads their ledger', async () => {
    const paymentFind = vi.spyOn(Payment, 'find');
    const body = await list({ _id: OTHER_CUSTOMER });
    expect(body.bookings.map((booking) => String(booking._id))).toEqual([String(ids.foreign)]);
    expect(body.bookings[0].overview).toEqual({ paidPrice: money(1210), completionAddition: money(0) });
    const filter: any = paymentFind.mock.calls[0][0];
    expect(filter.booking.$in.map(String)).toEqual([String(ids.foreign)]);
  });

  it('leaves ledger-dependent money unknown, not zero, when the ledger read fails', async () => {
    vi.spyOn(Payment, 'find').mockImplementation((() => { throw new Error('ledger unavailable'); }) as any);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const body = await list({ _id: CUSTOMER });
    const charged = body.bookings.find((booking) => String(booking._id) === String(ids.charged));
    expect(charged.overview).toEqual({ paidPrice: money(1210), completionAddition: NOT_RECORDED });
    const credit = body.bookings.find((booking) => String(booking._id) === String(ids.credit));
    expect(credit.overview.completionAddition).toEqual(NOT_RECORDED);
  });
});
