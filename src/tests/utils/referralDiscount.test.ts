import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ find: vi.fn(), reserve: vi.fn(), config: vi.fn(), consume: vi.fn(), ledger: vi.fn() }));
vi.mock('../../models/referral', () => ({ default: { findOne: mocks.find, findOneAndUpdate: mocks.reserve, updateOne: mocks.consume } }));
vi.mock('../../models/referralConfig', () => ({ default: { getCurrentConfig: mocks.config } }));
vi.mock('../../models/booking', () => ({ default: { updateOne: mocks.ledger } }));
import { withReferralDiscount } from '../../utils/referralDiscount';
import { calculateDiscountedPayouts } from '../../utils/discountAccounting';
import { buildPaymentDiscountLedgerEntry, recordPaymentDiscountSnapshot } from '../../utils/paymentDiscountLedger';
import { aggregateRecordedSavings } from '../../utils/savingsAggregation';
import { buildQuoteCustomerTotals } from '../../utils/bookingDetails/quoteTotals';

const discount = () => ({ originalAmount: 120, finalAmount: 108, totalDiscount: 12, loyaltyDiscount: { amount: 12, tier: 'Gold', percentage: 10, capped: false }, repeatBuyerDiscount: { amount: 0, percentage: 0, previousBookings: 0, capped: false }, pointsDiscount: { discountAmount: 0, pointsUsed: 0, conversionRate: 1 } });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.find.mockReturnValue({ lean: async () => ({ _id: 'r1' }) });
  mocks.config.mockResolvedValue({ isEnabled: true, minBookingAmountForTrigger: 25, referredCustomerDiscountType: 'percentage', referredCustomerDiscountValue: 10, referredCustomerDiscountMaxAmount: 25 });
  mocks.reserve.mockResolvedValue({ _id: 'r1' });
  mocks.ledger.mockResolvedValue({ modifiedCount: 1 });
});

describe('referred customer checkout savings', () => {
  it('uses the configured customer reduction, and reserves it for one booking only at checkout', async () => {
    const preview = await withReferralDiscount(discount(), 'customer1', 'booking1');
    expect(preview.finalAmount).toBe(96);
    expect(mocks.reserve).not.toHaveBeenCalled();
    const paid = await withReferralDiscount(discount(), 'customer1', 'booking1', true);
    expect(paid.referralDiscount).toEqual({ amount: 12, referralId: 'r1' });
    expect(mocks.reserve.mock.calls[0][0].$or[0]).toMatchObject({ discountBooking: 'booking1' });
    mocks.reserve.mockResolvedValue(null);
    await expect(withReferralDiscount(discount(), 'customer1', 'booking2', true)).rejects.toThrow('another checkout');
  });
  it('does not discount non-referred customers or disabled programs', async () => {
    mocks.find.mockReturnValue({ lean: async () => null });
    expect(await withReferralDiscount(discount(), 'customer1', 'booking1', true)).toEqual(discount());
    expect(mocks.config).not.toHaveBeenCalled();
    mocks.find.mockReturnValue({ lean: async () => ({ _id: 'r1' }) });
    mocks.config.mockResolvedValue({ isEnabled: false });
    expect(await withReferralDiscount(discount(), 'customer1', 'booking1', true)).toEqual(discount());
    expect(mocks.reserve).not.toHaveBeenCalled();
  });
  it('caps the reduction at the remaining payable amount and keeps the professional payout unchanged', async () => {
    const result = await withReferralDiscount({ ...discount(), finalAmount: 2, totalDiscount: 118 }, 'c1', 'b1');
    expect(result.referralDiscount?.amount).toBe(1.5);
    expect(result.finalAmount).toBe(0.5);
    const without = calculateDiscountedPayouts(discount(), 20);
    const withReferral = calculateDiscountedPayouts(await withReferralDiscount(discount(), 'c1', 'b1'), 20);
    expect(withReferral.professionalPayout).toBe(without.professionalPayout);
    expect(withReferral.platformCommission).toBeLessThanOrEqual(without.platformCommission);
  });
  it('persists attribution from the succeeded intent into the durable ledger and consumes only its bound benefit', async () => {
    const payment = { stripePaymentIntentId: 'pi_1', currency: 'EUR', discount: { originalAmount: 120, referralDiscountAmount: 12, referralId: 'r1', totalDiscount: 12 } };
    expect(buildPaymentDiscountLedgerEntry(payment)?.referralDiscountAmount).toBe(12);
    expect(await recordPaymentDiscountSnapshot('b1', payment, 'pi_other')).toBe(false);
    expect(mocks.consume).not.toHaveBeenCalled();
    await recordPaymentDiscountSnapshot('b1', payment, 'pi_1');
    expect(mocks.consume).toHaveBeenCalledWith({ _id: 'r1', discountBooking: 'b1' }, { $set: { referredUserDiscountApplied: true } });
  });
  it('includes referral savings exactly once and keeps historical attribution unknown', () => {
    const entry = { paymentIntentId: 'pi_1', currency: 'EUR', originalAmount: 100, loyaltyAmount: 5, referralDiscountAmount: 10 };
    const modern = { payment: { stripePaymentIntentId: 'pi_1', currency: 'EUR', status: 'completed', discount: entry }, paymentDiscountLedger: [entry, entry] };
    const current = aggregateRecordedSavings([modern]);
    expect(current.groups[0]).toMatchObject({ totalRecorded: 15, referral: 10, recordedReferral: 10, byType: { loyalty: 5, points: 0 } });
    const mixed = aggregateRecordedSavings([modern, { payment: { status: 'completed', currency: 'EUR', discount: { originalAmount: 100, pointsDiscountAmount: 20 } } }]);
    expect(mixed.groups[0]).toMatchObject({ totalRecorded: 35, referral: null, recordedReferral: 10, byType: { points: 20 } });
  });
  it('freezes automatic quote-time discounts and recomputes VAT on the discounted net', () => {
    const totals = buildQuoteCustomerTotals({ booking: {}, totalAmount: 100, commissionPercent: 0, currency: 'EUR', pricingLines: [{ price: 100, vatRate: 21 }], discountBreakdown: { ...discount(), originalAmount: 100, finalAmount: 80, totalDiscount: 20 } });
    expect(totals).toMatchObject({ customerNetAmount: 80, amountBeforeDiscounts: 100, vatAmount: 16.8, totalWithVat: 96.8, discount: { source: 'quote_time_automatic', totalDiscount: 20 } });
  });
});
