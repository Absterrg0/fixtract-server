import mongoose, { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadSettledMilestoneTotals } from '../../utils/paymentRefundLedger';

const uri = process.env.FIXERA_TEST_MONGODB_URI;
const describeDb = uri && /test/i.test(uri) ? describe : describe.skip;

describeDb('FT2-13 — settled milestone totals for the bookings overview', () => {
  beforeAll(async () => {
    await mongoose.connect(uri!, { dbName: `milestone_totals_${process.pid}_${Date.now().toString(36)}` });
  });
  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  it('sums each milestone checkout once and ignores bookings without milestones', async () => {
    const quote = new Types.ObjectId();
    const plain = new Types.ObjectId();
    await mongoose.connection.collection('bookings').insertMany([
      { _id: quote, milestonePayments: [{ amount: 3000 }, { amount: 5000 }], paymentDiscountLedger: [
        { paymentIntentId: 'pi_1', milestoneIndex: 0, totalWithVat: 3618.65 },
        { paymentIntentId: 'pi_2', milestoneIndex: 1, totalWithVat: 6031.09 },
      ] },
      { _id: plain, milestonePayments: [], paymentDiscountLedger: [{ paymentIntentId: 'pi_3', totalWithVat: 100 }] },
    ] as any[]);
    const totals = await loadSettledMilestoneTotals([quote, plain]);
    expect(totals.get(String(quote))).toBe(9649.74);
    expect(totals.has(String(plain))).toBe(false);
  });
});
