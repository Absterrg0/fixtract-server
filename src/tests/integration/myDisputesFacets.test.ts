import mongoose, { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// FT2 #10a: the participant disputes dashboard filters by status/service and
// returns counts, against a real aggregation engine.
vi.mock('../../utils/notifications/notify', () => ({ notify: vi.fn(), notifyAsync: vi.fn() }));

import Booking from '../../models/booking';
import Project from '../../models/project';
import { getMyDisputes } from '../../handlers/Booking';

const testUri = process.env.FIXERA_TEST_MONGODB_URI;
const describeDb = testUri && /test/i.test(testUri) ? describe : describe.skip;

describeDb('getMyDisputes facets (disposable MongoDB)', () => {
  const customer = new Types.ObjectId();
  const professional = new Types.ObjectId();
  const raisedAt = new Date('2026-11-01T10:00:00.000Z');

  beforeAll(async () => {
    await mongoose.connect(testUri!, { dbName: `ft2_disputes_${process.pid}_${Date.now().toString(36)}` });
    const plumbingProject = new Types.ObjectId();
    await Project.collection.insertOne({ _id: plumbingProject, title: 'Pipes', service: 'Plumbing' } as any);
    const dispute = (extra: Record<string, unknown> = {}) => ({ raisedBy: customer, reason: 'r', description: 'd', raisedAt, ...extra });
    await Booking.collection.insertMany([
      // Legacy booking: service from the live project.
      { _id: new Types.ObjectId(), customer, professional, project: plumbingProject, status: 'dispute', dispute: dispute() },
      // Snapshot service wins over the project.
      { _id: new Types.ObjectId(), customer, professional, project: plumbingProject, status: 'completed', bookingSnapshot: { project: { service: 'Painting' } }, dispute: dispute({ resolvedAt: new Date() }) },
      { _id: new Types.ObjectId(), customer, professional, status: 'refunded', rfqData: { serviceType: 'Painting' }, dispute: dispute({ resolvedAt: new Date() }) },
      // Someone else's dispute and a phantom dispute are never listed.
      { _id: new Types.ObjectId(), customer: new Types.ObjectId(), professional, status: 'dispute', rfqData: { serviceType: 'Painting' }, dispute: dispute() },
      { _id: new Types.ObjectId(), customer, professional, status: 'completed', dispute: { raisedAt } },
    ] as any[]);
  });
  afterAll(async () => {
    await mongoose.connection.db?.dropDatabase();
    await mongoose.disconnect();
  });

  const call = async (query: Record<string, string>) => {
    const res: any = { status: vi.fn(() => res), json: vi.fn((body: any) => { res.body = body; return res; }) };
    const next = vi.fn();
    await getMyDisputes({ user: { _id: customer, role: 'customer' }, query } as any, res, next);
    expect(next).not.toHaveBeenCalled();
    return res.body.data;
  };

  it('counts by status and service and filters the list', async () => {
    const all = await call({});
    expect(all.pagination.total).toBe(3);
    expect(all.statusCounts).toEqual({ open: 1, resolved: 2 });
    expect(all.serviceCounts).toEqual({ Plumbing: 1, Painting: 2 });

    const resolvedPainting = await call({ status: 'resolved', service: 'Painting' });
    expect(resolvedPainting.items).toHaveLength(2);
    expect(resolvedPainting.statusCounts).toEqual({ open: 0, resolved: 2 });
    expect(resolvedPainting.serviceCounts).toEqual({ Painting: 2 });

    const open = await call({ status: 'open' });
    expect(open.items).toHaveLength(1);
    expect(open.serviceCounts).toEqual({ Plumbing: 1 });
  });
});
