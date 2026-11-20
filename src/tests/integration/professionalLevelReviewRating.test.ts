import mongoose, { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// FT3 #11: a professional could never level up because the rating metric
// matched `customerReview.rating`, a field the review form never stores.
const notifyAsync = vi.fn();
vi.mock('../../utils/notifications/notify', () => ({ notifyAsync: (...args: unknown[]) => notifyAsync(...args), notify: vi.fn() }));

import Booking from '../../models/booking';
import User from '../../models/user';
import ProfessionalLevelConfig from '../../models/professionalLevelConfig';
import { getProfessionalMetrics, updateProfessionalLevel } from '../../utils/professionalLevelSystem';

const testUri = process.env.FIXERA_TEST_MONGODB_URI;
const hasDisposableMongo = Boolean(testUri && /test/i.test(testUri));
const describeDb = hasDisposableMongo ? describe : describe.skip;

const review = (score: number, extra: Record<string, unknown> = {}) => ({
  communicationLevel: score,
  valueOfDelivery: score,
  qualityOfService: score,
  reviewedAt: new Date(),
  ...extra,
});

describeDb('professional level rating metric (disposable MongoDB)', () => {
  beforeAll(async () => {
    await mongoose.connect(testUri!, { dbName: `ft3_pro_level_${process.pid}_${Date.now().toString(36)}` });
  });
  afterAll(async () => {
    await mongoose.connection.db?.dropDatabase();
    await mongoose.disconnect();
  });
  beforeEach(async () => {
    notifyAsync.mockClear();
    await Promise.all([
      Booking.collection.deleteMany({}),
      User.collection.deleteMany({}),
      ProfessionalLevelConfig.collection.deleteMany({}),
    ]);
  });

  const seedProfessional = async (daysActive: number) => {
    const _id = new Types.ObjectId();
    await User.collection.insertOne({
      _id,
      name: 'Marcus Pro',
      email: `pro-${_id.toString()}@example.test`,
      role: 'professional',
      phone: '+32470000000',
      password: 'x'.repeat(60),
      professionalLevel: 'New',
      createdAt: new Date(Date.now() - daysActive * 24 * 60 * 60 * 1000),
    } as any);
    return _id;
  };

  const seedCompleted = async (professional: Types.ObjectId, count: number, reviews: Array<Record<string, unknown> | undefined>) => {
    await Booking.collection.insertMany(
      Array.from({ length: count }, (_, index) => ({
        _id: new Types.ObjectId(),
        professional,
        customer: new Types.ObjectId(),
        status: 'completed',
        ...(reviews[index] ? { customerReview: reviews[index] } : {}),
      })) as any[],
    );
  };

  it('averages the three stored review scores (the form never stores customerReview.rating)', async () => {
    const pro = await seedProfessional(10);
    await seedCompleted(pro, 3, [review(5), review(4), undefined]);
    const metrics = await getProfessionalMetrics(pro);
    expect(metrics.completedBookings).toBe(3);
    expect(metrics.avgRating).toBe(4.5);
  });

  it('levels a qualifying professional up and sends the level-up notification', async () => {
    const pro = await seedProfessional(70);
    await seedCompleted(pro, 5, [review(5)]);
    const result = await updateProfessionalLevel(pro);
    expect(result).toMatchObject({ oldLevel: 'New', newLevel: 'Level 1', levelChanged: true, leveledUp: true });
    const saved = await User.findById(pro).select('professionalLevel').lean();
    expect(saved?.professionalLevel).toBe('Level 1');
    expect(notifyAsync).toHaveBeenCalledWith(expect.objectContaining({
      userId: pro.toString(),
      eventKey: 'professional.leveling_up',
      context: { levelName: 'Level 1' },
    }));
  });

  it('keeps a professional without a qualifying rating at New', async () => {
    const pro = await seedProfessional(70);
    await seedCompleted(pro, 5, [review(3)]);
    const result = await updateProfessionalLevel(pro);
    expect(result.newLevel).toBe('New');
    expect(notifyAsync).not.toHaveBeenCalled();
  });
});
