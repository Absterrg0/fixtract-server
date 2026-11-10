import { describe, expect, it } from 'vitest';
import { aggregateRecordedSavings } from '../../utils/savingsAggregation';

const settled = (discount: any, currency = 'EUR') => ({
  payment: { status: 'completed', currency, discount },
});

describe('aggregateRecordedSavings', () => {
  it('sums recorded parts per currency and labels the total recorded', () => {
    const summary = aggregateRecordedSavings([
      settled({
        loyaltyAmount: 10,
        repeatBuyerAmount: 5,
        pointsDiscountAmount: 4,
        codeDiscountAmount: 6,
        originalAmount: 100,
      }),
      settled({ loyaltyAmount: 3, originalAmount: 50 }, 'USD'),
    ]);
    expect(summary.settledBookingCount).toBe(2);
    expect(summary.unrecordedBookingCount).toBe(0);
    expect(summary.complete).toBe(true);
    const eur = summary.groups.find((group) => group.currency === 'EUR')!;
    expect(eur.byType).toEqual({ recurring: 5, loyalty: 10, discountCode: 6, points: 4 });
    expect(eur.totalRecorded).toBe(25);
    expect(eur.referral).toBeNull();
    const usd = summary.groups.find((group) => group.currency === 'USD')!;
    expect(usd.totalRecorded).toBe(3);
  });

  it('never mixes currencies into one total', () => {
    const summary = aggregateRecordedSavings([
      settled({ loyaltyAmount: 10, originalAmount: 100 }, 'EUR'),
      settled({ loyaltyAmount: 10, originalAmount: 100 }, 'USD'),
    ]);
    expect(summary.groups).toHaveLength(2);
    for (const group of summary.groups) {
      expect(group.totalRecorded).toBe(10);
    }
  });

  it('excludes unpaid and fully refunded bookings, flags partial refunds as uncertain', () => {
    const summary = aggregateRecordedSavings([
      { payment: { status: 'pending', currency: 'EUR', discount: { loyaltyAmount: 50, originalAmount: 200 } } },
      { payment: { status: 'refunded', currency: 'EUR', discount: { loyaltyAmount: 50, originalAmount: 200 } } },
      {
        payment: { status: 'partially_refunded', currency: 'EUR', discount: { loyaltyAmount: 50, originalAmount: 200 } },
      },
      settled({ loyaltyAmount: 7, originalAmount: 100 }),
    ]);
    expect(summary.settledBookingCount).toBe(1);
    expect(summary.excludedUncertainCount).toBe(1);
    expect(summary.complete).toBe(false);
    const eur = summary.groups.find((group) => group.currency === 'EUR')!;
    expect(eur.totalRecorded).toBe(7);
    expect(eur.coverage).toBe('partial');
    expect(eur.excludedUncertain).toBe(1);
  });

  it('counts completed bookings without snapshots as unrecorded, never zero', () => {
    const summary = aggregateRecordedSavings([
      settled({ loyaltyAmount: 7, originalAmount: 100 }),
      { payment: { status: 'completed', currency: 'EUR' } },
    ]);
    expect(summary.unrecordedBookingCount).toBe(1);
    expect(summary.complete).toBe(false);
    const eur = summary.groups.find((group) => group.currency === 'EUR')!;
    expect(eur.unrecorded).toBe(1);
    expect(eur.totalRecorded).toBe(7);
  });

  it('caps a booking total at its recorded original amount (double-count guard)', () => {
    const summary = aggregateRecordedSavings([
      settled({ loyaltyAmount: 90, repeatBuyerAmount: 90, originalAmount: 100 }),
    ]);
    const eur = summary.groups[0];
    expect(eur.totalRecorded).toBe(100);
    expect(eur.byType).toEqual({ recurring: 50, loyalty: 50, discountCode: 0, points: 0 });
  });

  it('prefers the booking snapshot and never adds milestone snapshots on top', () => {
    const summary = aggregateRecordedSavings([
      {
        payment: { status: 'completed', currency: 'EUR', discount: { loyaltyAmount: 10, originalAmount: 100 } },
        milestonePayments: [{ discount: { loyaltyAmount: 10, originalAmount: 100 } }],
      },
    ]);
    expect(summary.groups[0].totalRecorded).toBe(10);
  });

  it('reports an empty settled base as true zero only when nothing is recorded', () => {
    const summary = aggregateRecordedSavings([]);
    expect(summary.groups).toEqual([]);
    expect(summary.settledBookingCount).toBe(0);
  });
});

it('keeps capped component cents equal to their total', () => {
  for (const originalAmount of [0.01, 1, 100]) {
    const group = aggregateRecordedSavings([settled({ loyaltyAmount: 60, codeDiscountAmount: 50, pointsDiscountAmount: 20, repeatBuyerAmount: 5, originalAmount })]).groups[0];
    expect(Math.round(Object.values(group.byType).reduce((a, b) => a + b, 0) * 100)).toBe(Math.round(group.totalRecorded * 100));
    expect(group.totalRecorded).toBe(originalAmount);
  }
});
it('does not infer unrecorded booking discounts from unsupported milestone fields', () => {
  const summary = aggregateRecordedSavings([{ payment: { status: 'completed', currency: 'EUR' }, milestonePayments: [{ discount: { loyaltyAmount: 10 } }] }]);
  expect(summary.unrecordedBookingCount).toBe(1);
});
it('excludes a disputed booking whose payment is still completed', () => {
  const summary = aggregateRecordedSavings([
    { status: 'dispute', payment: { status: 'completed', currency: 'EUR', discount: { loyaltyAmount: 40, originalAmount: 200 } } },
    { status: 'completed', ...settled({ loyaltyAmount: 5, originalAmount: 100 }) },
  ]);
  expect(summary.settledBookingCount).toBe(1);
  expect(summary.excludedUncertainCount).toBe(1);
  expect(summary.complete).toBe(false);
  const eur = summary.groups[0];
  expect(eur.totalRecorded).toBe(5);
  expect(eur.excludedUncertain).toBe(1);
  expect(eur.coverage).toBe('partial');
});
it('keeps earlier paid milestones visible after the next milestone payment replaced the snapshot', () => {
  const pendingNext = aggregateRecordedSavings([{
    status: 'in_progress',
    payment: { status: 'pending', currency: 'EUR', discount: { loyaltyAmount: 8, originalAmount: 80 } },
    milestonePayments: [{ status: 'paid' }, { status: 'pending' }],
  }]);
  // The first milestone settled: the booking is settled but its discount is unknown.
  expect(pendingNext.settledBookingCount).toBe(1);
  expect(pendingNext.unrecordedBookingCount).toBe(1);
  expect(pendingNext.complete).toBe(false);
  expect(pendingNext.groups[0].totalRecorded).toBe(0);

  const secondPaid = aggregateRecordedSavings([{
    status: 'in_progress',
    payment: { status: 'completed', currency: 'EUR', discount: { loyaltyAmount: 8, originalAmount: 80 } },
    milestonePayments: [{ status: 'paid' }, { status: 'paid' }],
  }]);
  // Only the latest milestone's snapshot is counted, once, as a lower bound.
  expect(secondPaid.settledBookingCount).toBe(1);
  expect(secondPaid.unrecordedBookingCount).toBe(1);
  expect(secondPaid.complete).toBe(false);
  expect(secondPaid.groups[0].totalRecorded).toBe(8);
  expect(secondPaid.groups[0].bookingCount).toBe(1);

  const singlePaid = aggregateRecordedSavings([{
    payment: { status: 'completed', currency: 'EUR', discount: { loyaltyAmount: 8, originalAmount: 80 } },
    milestonePayments: [{ status: 'paid' }, { status: 'pending' }],
  }]);
  expect(singlePaid.complete).toBe(true);
  expect(singlePaid.groups[0].totalRecorded).toBe(8);
});

describe('per-payment discount ledger', () => {
  const entry = (paymentIntentId: string, milestoneIndex: number | undefined, loyaltyAmount: number, originalAmount = 100) => ({
    paymentIntentId,
    ...(milestoneIndex === undefined ? {} : { milestoneIndex }),
    currency: 'EUR',
    loyaltyAmount,
    repeatBuyerAmount: 0,
    pointsDiscountAmount: 0,
    codeDiscountAmount: 0,
    originalAmount,
    totalDiscount: loyaltyAmount,
  });

  it('keeps a paid milestone discount while the next milestone checkout is pending', () => {
    const summary = aggregateRecordedSavings([{
      status: 'in_progress',
      payment: {
        status: 'pending', currency: 'EUR', stripePaymentIntentId: 'pi_2', milestoneIndex: 1,
        discount: { loyaltyAmount: 4, originalAmount: 60 },
      },
      milestonePayments: [{ status: 'paid' }, { status: 'pending' }],
      paymentDiscountLedger: [entry('pi_1', 0, 10)],
    }]);
    expect(summary.complete).toBe(true);
    expect(summary.settledPaymentCount).toBe(1);
    expect(summary.groups[0].totalRecorded).toBe(10);
    expect(summary.groups[0].byType.loyalty).toBe(10);
  });

  it('adds the second milestone once, whether it comes from the ledger or the legacy snapshot', () => {
    const base = {
      status: 'in_progress',
      payment: {
        status: 'authorized', currency: 'EUR', stripePaymentIntentId: 'pi_2', milestoneIndex: 1,
        discount: { loyaltyAmount: 4, originalAmount: 60 },
      },
      milestonePayments: [{ status: 'paid' }, { status: 'paid' }],
    };
    const both = aggregateRecordedSavings([{ ...base, paymentDiscountLedger: [entry('pi_1', 0, 10), entry('pi_2', 1, 4, 60)] }]);
    expect(both.groups[0].totalRecorded).toBe(14);
    expect(both.settledPaymentCount).toBe(2);
    expect(both.complete).toBe(true);
    expect(both.groups[0].bookingCount).toBe(1);
    // Ledger write for milestone 2 still missing: the current snapshot is its own source.
    const legacySecond = aggregateRecordedSavings([{ ...base, paymentDiscountLedger: [entry('pi_1', 0, 10)] }]);
    expect(legacySecond.groups[0].totalRecorded).toBe(14);
    expect(legacySecond.complete).toBe(true);
  });

  it('ignores duplicated ledger rows for the same intent or milestone', () => {
    const summary = aggregateRecordedSavings([{
      payment: { status: 'authorized', currency: 'EUR', stripePaymentIntentId: 'pi_2', milestoneIndex: 1 },
      milestonePayments: [{ status: 'paid' }, { status: 'pending' }],
      paymentDiscountLedger: [entry('pi_1', 0, 10), entry('pi_1', 0, 10), entry('pi_x', 0, 99)],
    }]);
    expect(summary.groups[0].totalRecorded).toBe(10);
    expect(summary.settledPaymentCount).toBe(1);
  });

  it('never counts ledger rows for milestones that are not paid', () => {
    const summary = aggregateRecordedSavings([{
      payment: { status: 'pending', currency: 'EUR', stripePaymentIntentId: 'pi_2', milestoneIndex: 1 },
      milestonePayments: [{ status: 'pending' }, { status: 'pending' }],
      paymentDiscountLedger: [entry('pi_2', 1, 10)],
    }]);
    expect(summary.groups).toEqual([]);
    expect(summary.settledBookingCount).toBe(0);
  });

  it('treats a zero-discount ledger row as a recorded zero, not unknown', () => {
    const summary = aggregateRecordedSavings([{
      payment: { status: 'completed', currency: 'EUR', stripePaymentIntentId: 'pi_1' },
      paymentDiscountLedger: [entry('pi_1', undefined, 0, 0)],
    }]);
    expect(summary.complete).toBe(true);
    expect(summary.unrecordedPaymentCount).toBe(0);
    expect(summary.groups[0].totalRecorded).toBe(0);
  });

  it('prefers the ledger row over the current snapshot for the same intent (no double count)', () => {
    const summary = aggregateRecordedSavings([{
      payment: {
        status: 'completed', currency: 'EUR', stripePaymentIntentId: 'pi_1',
        discount: { loyaltyAmount: 10, originalAmount: 100 },
      },
      paymentDiscountLedger: [entry('pi_1', undefined, 10)],
    }]);
    expect(summary.groups[0].totalRecorded).toBe(10);
  });

  it('keeps pre-ledger milestones replaced by a later checkout explicitly unrecorded', () => {
    const summary = aggregateRecordedSavings([{
      payment: {
        status: 'authorized', currency: 'EUR', stripePaymentIntentId: 'pi_3', milestoneIndex: 2,
        discount: { loyaltyAmount: 3, originalAmount: 30 },
      },
      milestonePayments: [{ status: 'paid' }, { status: 'paid' }, { status: 'paid' }],
      paymentDiscountLedger: [entry('pi_2', 1, 5, 50)],
    }]);
    expect(summary.settledPaymentCount).toBe(3);
    expect(summary.unrecordedPaymentCount).toBe(1);
    expect(summary.unrecordedBookingCount).toBe(1);
    expect(summary.complete).toBe(false);
    expect(summary.groups[0].coverage).toBe('partial');
    expect(summary.groups[0].totalRecorded).toBe(8);
  });

  it('classifies refunds and disputes on milestone bookings as uncertain, never summed', () => {
    const milestones = [{ status: 'paid' }, { status: 'paid' }];
    const ledger = [entry('pi_1', 0, 10), entry('pi_2', 1, 4, 60)];
    for (const input of [
      { payment: { status: 'refunded', currency: 'EUR', stripePaymentIntentId: 'pi_2', milestoneIndex: 1 } },
      { payment: { status: 'partially_refunded', currency: 'EUR', stripePaymentIntentId: 'pi_2', milestoneIndex: 1 } },
      { payment: { status: 'disputed', currency: 'EUR', stripePaymentIntentId: 'pi_2', milestoneIndex: 1 } },
      { status: 'dispute', payment: { status: 'authorized', currency: 'EUR', stripePaymentIntentId: 'pi_2', milestoneIndex: 1 } },
    ]) {
      const summary = aggregateRecordedSavings([{ ...input, milestonePayments: milestones, paymentDiscountLedger: ledger }]);
      expect(summary.excludedUncertainCount).toBe(1);
      expect(summary.complete).toBe(false);
      expect(summary.groups[0].totalRecorded).toBe(0);
    }
    // A fully refunded single payment is simply not a saving.
    const single = aggregateRecordedSavings([{
      payment: { status: 'refunded', currency: 'EUR', stripePaymentIntentId: 'pi_1' },
      paymentDiscountLedger: [entry('pi_1', undefined, 10)],
    }]);
    expect(single.groups).toEqual([]);
    expect(single.complete).toBe(true);
  });

  it('does not count an authorized non-milestone payment before completion', () => {
    const summary = aggregateRecordedSavings([{
      payment: { status: 'authorized', currency: 'EUR', stripePaymentIntentId: 'pi_1' },
      paymentDiscountLedger: [entry('pi_1', undefined, 10)],
    }]);
    expect(summary.settledBookingCount).toBe(0);
    expect(summary.groups).toEqual([]);
  });
});


it('recognizes a sparse referral-only snapshot without another discount or original amount', () => {
  const summary = aggregateRecordedSavings([settled({ referralDiscountAmount: 12 })]);
  expect(summary.unrecordedBookingCount).toBe(0);
  expect(summary.groups[0]).toMatchObject({ totalRecorded: 12, recordedReferral: 12, referral: 12 });
});
