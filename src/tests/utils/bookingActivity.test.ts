import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';
import Booking from '../../models/booking';
import {
  hasRecordedCancellation,
  hasRecordedCustomerReview,
  hasRecordedDispute,
  hasRecordedProfessionalReview,
  phantomBookingActivityUnset,
  withoutPhantomBookingActivity,
} from '../../utils/bookingActivity';

const createdAt = new Date('2026-01-20T09:00:00.000Z');
const legacyPhantom = {
  _id: new Types.ObjectId(),
  status: 'booked',
  customerReview: { images: [], isHidden: false, reviewedAt: createdAt },
  professionalReview: { reviewedAt: createdAt },
  cancellation: { cancelledAt: createdAt },
  dispute: { type: 'extra_costs', attachments: [], resolutionAttachments: [], raisedAt: createdAt },
};

describe('Booking schema activity defaults', () => {
  it('builds a new booking without review, cancellation or dispute activity', () => {
    const plain: any = new Booking({ customer: new Types.ObjectId(), status: 'rfq' }).toObject();
    expect(plain.customerReview).toBeUndefined();
    expect(plain.professionalReview).toBeUndefined();
    expect(plain.cancellation).toBeUndefined();
    expect(plain.dispute).toBeUndefined();
  });

  it('hydrates a sparse stored booking without inventing activity timestamps', () => {
    const plain: any = Booking.hydrate({ _id: new Types.ObjectId(), status: 'quoted' }).toObject();
    expect(plain.customerReview?.reviewedAt).toBeUndefined();
    expect(plain.professionalReview?.reviewedAt).toBeUndefined();
    expect(plain.cancellation?.cancelledAt).toBeUndefined();
    expect(plain.dispute?.raisedAt).toBeUndefined();
    expect(plain.dispute?.type).toBeUndefined();
  });

  it('keeps explicitly recorded activity on construction', () => {
    const raisedAt = new Date('2026-02-01T10:00:00.000Z');
    const plain: any = new Booking({
      status: 'dispute',
      dispute: { raisedBy: new Types.ObjectId(), reason: 'r', description: 'd', raisedAt, type: 'reschedule' },
    }).toObject();
    expect(plain.dispute.raisedAt).toEqual(raisedAt);
    expect(plain.dispute.type).toBe('reschedule');
  });
});

describe('recorded activity predicates', () => {
  it('treats legacy default-only sub-objects as phantom', () => {
    expect(hasRecordedDispute(legacyPhantom)).toBe(false);
    expect(hasRecordedCancellation(legacyPhantom)).toBe(false);
    expect(hasRecordedCustomerReview(legacyPhantom)).toBe(false);
    expect(hasRecordedProfessionalReview(legacyPhantom)).toBe(false);
    const cleaned: any = withoutPhantomBookingActivity(legacyPhantom);
    expect(cleaned).not.toHaveProperty('dispute');
    expect(cleaned).not.toHaveProperty('cancellation');
    expect(cleaned).not.toHaveProperty('customerReview');
    expect(cleaned).not.toHaveProperty('professionalReview');
    expect(cleaned.status).toBe('booked');
    expect(legacyPhantom.dispute.raisedAt).toBe(createdAt);
    expect(phantomBookingActivityUnset(legacyPhantom)).toEqual({
      dispute: '', cancellation: '', customerReview: '', professionalReview: '',
    });
  });

  it('keeps every recorded kind of activity', () => {
    const recorded = {
      dispute: { raisedBy: new Types.ObjectId(), reason: 'Late', raisedAt: createdAt, type: 'reschedule' },
      cancellation: { cancelledBy: new Types.ObjectId(), reason: 'Customer request', cancelledAt: createdAt },
      customerReview: { communicationLevel: 4, valueOfDelivery: 4, qualityOfService: 5, reviewedAt: createdAt },
      professionalReview: { rating: 5, reviewedAt: createdAt },
    };
    expect(withoutPhantomBookingActivity(recorded)).toEqual(recorded);
    expect(phantomBookingActivityUnset(recorded)).toBeNull();
    expect(hasRecordedCancellation({ cancellation: { refundAmount: 0, cancelledAt: createdAt } })).toBe(true);
    expect(hasRecordedCustomerReview({ customerReview: { comment: 'ok' } })).toBe(true);
  });

  it('strips phantom activity from a hydrated legacy document', () => {
    const doc = Booking.hydrate(legacyPhantom);
    const cleaned: any = withoutPhantomBookingActivity(doc);
    expect(cleaned.dispute).toBeUndefined();
    expect(cleaned.customerReview).toBeUndefined();
    expect(String(cleaned._id)).toBe(String(legacyPhantom._id));
  });
});


it('does not manufacture a quote creation timestamp when hydrating a legacy version', () => {
  const hydrated = Booking.hydrate({ _id: new Types.ObjectId(), quoteVersions: [{ version: 1, scope: 'Legacy quote' }] });
  expect(hydrated.quoteVersions[0].createdAt).toBeUndefined();
});


it('does not manufacture a legacy status-history timestamp', () => {
  const hydrated = Booking.hydrate({ _id: new Types.ObjectId(), statusHistory: [{ status: 'quoted' }] });
  expect(hydrated.statusHistory[0].timestamp).toBeUndefined();
});

describe('undated recorded disputes follow hasRecordedDispute', () => {
  it('keeps a dispute with a recorded actor in the dispute filters and cohort count, even without raisedAt', async () => {
    const { RECORDED_DISPUTE_FILTER, RECORDED_DISPUTE_EXPR, hasRecordedDispute } = await import('../../utils/bookingActivity');
    const undated = { dispute: { raisedBy: '6650a0000000000000000001' } };
    expect(hasRecordedDispute(undated)).toBe(true);
    expect(RECORDED_DISPUTE_FILTER).toEqual({ 'dispute.raisedBy': { $exists: true, $ne: null } });
    expect(RECORDED_DISPUTE_EXPR).toEqual({ $ne: [{ $ifNull: ['$dispute.raisedBy', null] }, null] });
  });
});
