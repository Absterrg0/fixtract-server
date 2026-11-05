import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ customer: vi.fn(), automatic: vi.fn(), referral: vi.fn() }));
vi.mock('../../models/user', () => ({ default: { findById: mocks.customer } }));
vi.mock('../../utils/discountEngine', () => ({ calculateAutoDiscount: mocks.automatic }));
vi.mock('../../utils/referralDiscount', () => ({ withReferralDiscount: mocks.referral }));
import { buildQuoteCustomerTotalsWithDiscounts } from '../../utils/bookingDetails/quoteTotals';

const automatic = { originalAmount: 100, finalAmount: 90, totalDiscount: 10,
  loyaltyDiscount: { amount: 10 }, repeatBuyerDiscount: { amount: 0 } };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.customer.mockReturnValue({ select: () => ({ lean: async () => ({ totalSpent: 1234 }) }) });
  mocks.automatic.mockResolvedValue(automatic);
  mocks.referral.mockResolvedValue(automatic);
});

describe('private quote-time automatic discount inputs', () => {
  it('reads spend privately and records discounted totals without mutating the participant payload', async () => {
    const customer = { _id: 'c1', name: 'Customer' };
    const booking = { _id: 'b1', customer, professional: { _id: 'p1' }, project: { _id: 'project1' } };
    const totals = await buildQuoteCustomerTotalsWithDiscounts({ booking, totalAmount: 100,
      commissionPercent: 0, currency: 'EUR', pricingLines: [{ price: 100, vatRate: 21 }] });
    expect(mocks.automatic).toHaveBeenCalledWith('c1', 'p1', 'project1', 100, 1234);
    expect(mocks.referral).toHaveBeenCalledWith(automatic, 'c1', 'b1');
    expect(customer).toEqual({ _id: 'c1', name: 'Customer' });
    expect(totals).toMatchObject({ customerNetAmount: 90, totalWithVat: 108.9,
      discount: { source: 'quote_time_automatic', totalDiscount: 10 } });
  });

  it('does not read eligibility for an invalid quote amount', async () => {
    expect(await buildQuoteCustomerTotalsWithDiscounts({ booking: {}, totalAmount: -1,
      commissionPercent: 0, currency: 'EUR' })).toBeNull();
    expect(mocks.customer).not.toHaveBeenCalled();
    expect(mocks.automatic).not.toHaveBeenCalled();
  });
});
