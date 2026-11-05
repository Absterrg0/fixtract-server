import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ config: vi.fn() }));
vi.mock('../../models/platformSettings', () => ({ default: { getCurrentConfig: mocks.config } }));
import { resolveDisputeEmailAmount, resolveDisputeBookingFinalCharge } from '../../utils/disputeFinalCharge';
import { buildQuoteCustomerTotals } from '../../utils/bookingDetails/quoteTotals';
import { isBookingStarted, preparePartialRefundCancellation, pruneFutureResourcePlanDays } from '../../utils/refundFinalization';

beforeEach(() => { vi.clearAllMocks(); mocks.config.mockResolvedValue({ commissionPercent: 10 }); });

describe('Part 3 final customer amounts', () => {
  it('includes a recorded discount and VAT when the extra-cost gross is missing', async () => {
    // Original €80 + 10% fee - €8 discount. Admin resolves €50:
    // €55 - €5 (the recorded discount scaled with the decision) + 21% VAT.
    await expect(resolveDisputeEmailAmount({ payment: { vatRate: 21, extraCostCustomerDiscount: 8 } }, 80, 50)).resolves.toBe(60.5);
  });
  it('uses recorded extra-cost net and VAT before consulting live configuration', async () => {
    mocks.config.mockRejectedValue(new Error('offline'));
    await expect(resolveDisputeEmailAmount({ payment: { extraCostCustomerNetAmount: 80, extraCostVatAmount: 16.8 } }, 80, 50)).resolves.toBe(60.5);
    expect(mocks.config).not.toHaveBeenCalled();
  });
  it('omits an unknown amount rather than assuming zero commission', async () => {
    mocks.config.mockRejectedValue(new Error('offline'));
    await expect(resolveDisputeEmailAmount({ payment: { vatRate: 21 } }, 0, 50)).resolves.toBeUndefined();
  });
  it('includes the recorded VAT-inclusive remainder in a non-extra-cost resolution', async () => {
    await expect(resolveDisputeBookingFinalCharge({ payment: { status: 'partially_refunded', totalWithVat: 121, refundAmount: 40 } })).resolves.toBe(81);
    await expect(resolveDisputeBookingFinalCharge({ payment: { status: 'refunded', totalWithVat: 121, refundAmount: 121 } })).resolves.toBe(0);
    await expect(resolveDisputeBookingFinalCharge({ payment: { netAmount: 100 } })).resolves.toBeUndefined();
  });
  it('uses the full milestone invoice basis, including options and recorded discounts', async () => {
    const booking = { currentQuoteVersion: 1, quote: { amount: 100 },
      quoteVersions: [{ version: 1, customerTotals: { commissionPercent: 10 } }],
      checkoutSnapshot: { baseSubtotal: 100, extraOptionsTotal: 20 },
      selectedExtraOptions: [{ bookedPrice: 20 }], milestonePayments: [{ amount: 40 }, { amount: 60 }],
      payment: { totalWithVat: 71.87, netAmount: 59.4, vatAmount: 12.47, vatRate: 21,
        discount: { originalAmount: 66, totalDiscount: 6.6, loyaltyAmount: 6.6 } } };
    // Full €132 net less €13.20 discount + €24.95 VAT, never the last €71.87 slice.
    await expect(resolveDisputeBookingFinalCharge(booking)).resolves.toBe(143.75);
  });
  it('records commission-inclusive mixed-rate VAT and gross quote savings consistently', () => {
    const totals = buildQuoteCustomerTotals({ booking: {}, totalAmount: 100, commissionPercent: 10, currency: 'EUR',
      pricingLines: [{ price: 50, vatRate: 21 }, { price: 50, vatRate: 6 }],
      discountBreakdown: { originalAmount: 110, finalAmount: 99, totalDiscount: 11,
        loyaltyDiscount: { tier: 'Silver', percentage: 10, amount: 11, capped: false },
        repeatBuyerDiscount: { percentage: 0, amount: 0, previousBookings: 0, capped: false },
        pointsDiscount: { pointsUsed: 0, discountAmount: 0, conversionRate: 1 } } });
    expect(totals).toMatchObject({ customerNetAmount: 99, vatAmount: 13.37, totalWithVat: 112.37,
      discount: { totalDiscount: 11, totalDiscountWithVat: 12.48 } });
    expect(totals!.vatBreakdown!.map(line => line.netAmount)).toEqual([49.5, 49.5]);
    expect(totals!.vatBreakdown!.reduce((sum, line) => sum + line.totalAmount, 0)).toBeCloseTo(112.37, 2);
  });
});

describe('captured partial-refund lifecycle', () => {
  it('compares planned day labels with today in the recorded booking timezone', () => {
    const booking = { scheduleTimeZone: 'Europe/Brussels', resourcePlan: [{ resourceId: 'r1',
      days: [new Date('2026-10-29T00:00Z'), new Date('2026-10-30T00:00Z')] }] };
    pruneFutureResourcePlanDays(booking, new Date('2026-10-29T23:30Z'));
    expect(booking.resourcePlan[0].days.map(day => day.toISOString().slice(0, 10))).toEqual(['2026-10-29']);
  });
  it('does not treat an unstarted reschedule dispute as started work', () => {
    expect(isBookingStarted({ status: 'dispute', statusBeforeDispute: 'booked' })).toBe(false);
    expect(isBookingStarted({ status: 'refunded', statusBeforeDispute: 'in_progress' })).toBe(true);
  });
  it('preserves the captured start fact after the terminal status replaces it', () => {
    const booking: any = { status: 'in_progress', resourcePlan: [] };
    preparePartialRefundCancellation(booking, isBookingStarted(booking));
    expect(booking.status).toBe('cancelled');
    expect(booking.refundPreservesPastPlanning).toBe(true);
    expect(isBookingStarted(booking)).toBe(true);
  });
});
