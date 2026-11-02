import mongoose, { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Booking from '../../models/booking';
import { RECORDED_CUSTOMER_REVIEW_FILTER, RECORDED_DISPUTE_FILTER } from '../../utils/bookingActivity';
import { clearPhantomBookingActivity, PHANTOM_GUARDS } from '../../scripts/migrate/clearPhantomBookingActivity';

const testUri = process.env.FIXERA_TEST_MONGODB_URI;
const hasDisposableMongo = Boolean(testUri && /test/i.test(testUri));
const describeDb = hasDisposableMongo ? describe : describe.skip;

const createdAt = new Date('2026-01-20T09:00:00.000Z');
const phantomFields = {
  customerReview: { images: [], isHidden: false, reviewedAt: createdAt },
  professionalReview: { reviewedAt: createdAt },
  cancellation: { cancelledAt: createdAt },
  dispute: { type: 'extra_costs', attachments: [], resolutionAttachments: [], raisedAt: createdAt },
};

describeDb('booking activity persistence (disposable MongoDB)', () => {
  beforeAll(async () => {
    // Own database: other integration files run in parallel on the same server.
    await mongoose.connect(testUri!, { dbName: `fixera_phantom_activity_it_${Date.now()}` });
  });
  afterAll(async () => {
    await mongoose.connection.db?.dropDatabase();
    await mongoose.disconnect();
  });
  beforeEach(async () => {
    await Booking.collection.deleteMany({});
  });

  it('saves a new booking without review, cancellation or dispute sub-objects', async () => {
    const booking = new Booking({
      customer: new Types.ObjectId(),
      bookingType: 'professional',
      status: 'rfq',
      bookingNumber: `BK-TEST-${Date.now()}`,
    });
    await booking.save({ validateBeforeSave: false });
    const raw: any = await Booking.collection.findOne({ _id: booking._id });
    expect(raw.customerReview).toBeUndefined();
    expect(raw.professionalReview).toBeUndefined();
    expect(raw.cancellation).toBeUndefined();
    expect(raw.dispute).toBeUndefined();
    expect(await Booking.countDocuments({ _id: booking._id, 'dispute.raisedAt': { $exists: true } })).toBe(0);
  });

  it('dispute and review filters ignore legacy phantom rows', async () => {
    const recordedId = new Types.ObjectId();
    await Booking.collection.insertMany([
      { _id: new Types.ObjectId(), status: 'booked', ...phantomFields },
      {
        _id: recordedId,
        status: 'dispute',
        dispute: { raisedBy: new Types.ObjectId(), reason: 'Late', description: 'd', raisedAt: createdAt, type: 'reschedule' },
        customerReview: { communicationLevel: 5, valueOfDelivery: 5, qualityOfService: 5, reviewedAt: createdAt },
      },
    ] as any[]);
    expect(await Booking.countDocuments({ 'dispute.raisedAt': { $exists: true } })).toBe(2);
    const disputes = await Booking.find({ ...RECORDED_DISPUTE_FILTER }).select('_id').lean();
    expect(disputes.map((row) => String(row._id))).toEqual([String(recordedId)]);
    expect(await Booking.countDocuments({ ...RECORDED_CUSTOMER_REVIEW_FILTER })).toBe(1);
  });

  it('migration reports in dry run, then removes only phantom sub-objects', async () => {
    const phantomId = new Types.ObjectId();
    const mixedId = new Types.ObjectId();
    const cancelledBy = new Types.ObjectId();
    await Booking.collection.insertMany([
      { _id: phantomId, status: 'booked', ...phantomFields },
      {
        _id: mixedId,
        status: 'cancelled',
        ...phantomFields,
        cancellation: { cancelledBy, reason: 'Customer request', cancelledAt: createdAt },
        professionalReview: { rating: 4, reviewedAt: createdAt },
      },
      { _id: new Types.ObjectId(), status: 'rfq' },
    ] as any[]);

    const dryRun = await clearPhantomBookingActivity(Booking.collection as any);
    expect(dryRun).toMatchObject({
      applied: false,
      scanned: 2,
      affectedBookings: 2,
      modified: 0,
      fields: { dispute: 2, cancellation: 1, customerReview: 2, professionalReview: 1 },
    });
    expect((await Booking.collection.findOne({ _id: phantomId }))?.dispute).toBeDefined();

    const applied = await clearPhantomBookingActivity(Booking.collection as any, { apply: true });
    expect(applied.modified).toBe(6);
    const phantom: any = await Booking.collection.findOne({ _id: phantomId });
    expect(phantom.dispute).toBeUndefined();
    expect(phantom.cancellation).toBeUndefined();
    expect(phantom.customerReview).toBeUndefined();
    expect(phantom.professionalReview).toBeUndefined();
    const mixed: any = await Booking.collection.findOne({ _id: mixedId });
    expect(mixed.dispute).toBeUndefined();
    expect(mixed.customerReview).toBeUndefined();
    expect(String(mixed.cancellation.cancelledBy)).toBe(String(cancelledBy));
    expect(mixed.professionalReview.rating).toBe(4);

    const again = await clearPhantomBookingActivity(Booking.collection as any, { apply: true });
    expect(again.affectedBookings).toBe(0);
  });

  it('write guard never removes a dispute recorded after the scan', async () => {
    const id = new Types.ObjectId();
    await Booking.collection.insertOne({
      _id: id,
      status: 'dispute',
      dispute: { raisedBy: new Types.ObjectId(), reason: 'Now real', raisedAt: new Date(), type: 'reschedule' },
    } as any);
    const result = await Booking.collection.updateOne(
      { _id: id, dispute: { $exists: true }, ...PHANTOM_GUARDS.dispute },
      { $unset: { dispute: '' } },
    );
    expect(result.modifiedCount).toBe(0);
    expect((await Booking.collection.findOne({ _id: id }))?.dispute?.reason).toBe('Now real');
  });
});
