import mongoose, { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/notifications/notify', () => ({ notify: vi.fn(async () => undefined), notifyAsync: vi.fn() }));
vi.mock('../../utils/notifications/milestonePaymentDue', () => ({ notifyMilestonePaymentDue: vi.fn(async () => undefined) }));

import Booking from '../../models/booking';
import User from '../../models/user';
import { updateMilestoneWorkStatus } from '../../handlers/Quotation';

const uri = process.env.FIXERA_TEST_MONGODB_URI;
const describeDb = uri && /test/i.test(uri) ? describe : describe.skip;
const proId = new Types.ObjectId();
const customerId = new Types.ObjectId();

const response = () => ({
  statusCode: 200, body: undefined as any,
  status(code: number) { this.statusCode = code; return this; },
  json(body: unknown) { this.body = body; return this; },
});

describeDb('FT3-19x — quote milestone Start/Complete', () => {
  beforeAll(async () => {
    await mongoose.connect(uri!, { dbName: `milestone_work_${process.pid}_${Date.now().toString(36)}` });
  });
  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });
  beforeEach(async () => {
    await Promise.all([Booking.collection.deleteMany({}), User.collection.deleteMany({})]);
    await User.collection.insertMany([
      { _id: proId, role: 'professional', name: 'Pro', email: 'pro@milestone.test' },
      { _id: customerId, role: 'customer', name: 'Customer', email: 'customer@milestone.test' },
    ] as any[]);
  });

  const seed = async () => {
    const id = new Types.ObjectId();
    await Booking.collection.insertOne({
      _id: id, bookingNumber: 'BK-MS-1', bookingType: 'professional', customer: customerId, professional: proId,
      status: 'booked', location: { type: 'Point', coordinates: [4.35, 50.85], country: 'BE' },
      rfqData: { serviceType: 'Kitchen', description: 'Quote' },
      quote: { amount: 8000, currency: 'EUR' },
      milestonePayments: [
        { title: 'Deposit', amount: 3000, order: 0, status: 'paid', dueCondition: 'on_start', workStatus: 'pending' },
        { title: 'Cabinets installed', amount: 5000, order: 1, status: 'pending', dueCondition: 'on_milestone_completion', workStatus: 'pending' },
      ],
      payment: { status: 'authorized', currency: 'EUR', amount: 3000, netAmount: 3000, totalWithVat: 3618.65 },
      statusHistory: [], createdAt: new Date(), updatedAt: new Date(),
    } as any);
    return id;
  };

  const call = async (id: Types.ObjectId, index: number, action: string) => {
    const res = response();
    await updateMilestoneWorkStatus({ user: { _id: proId, role: 'professional' }, params: { bookingId: String(id), index: String(index) }, body: { action } } as any, res as any);
    return res;
  };

  it('starts and completes milestones with HTTP 200 and returns the updated milestone', async () => {
    const id = await seed();
    const started = await call(id, 0, 'start');
    expect(started.statusCode).toBe(200);
    expect(() => JSON.stringify(started.body)).not.toThrow();
    expect(started.body.data.milestone.workStatus).toBe('in_progress');
    expect(started.body.data.booking.status).toBe('in_progress');
    const completed = await call(id, 0, 'complete');
    expect(completed.statusCode).toBe(200);
    expect(() => JSON.stringify(completed.body)).not.toThrow();
    expect(completed.body.data.milestone.workStatus).toBe('completed');
    const stored: any = await Booking.findById(id).lean();
    expect(stored.milestonePayments[0].workStatus).toBe('completed');
  });
});
