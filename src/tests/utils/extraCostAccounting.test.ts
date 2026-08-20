import { describe, expect, it } from 'vitest';
import { calculateExtraCostBreakdown } from '../../utils/extraCostAccounting';

describe('calculateExtraCostBreakdown', () => {
  it('keeps the supplier payout at the raw extra-cost amount', () => {
    expect(calculateExtraCostBreakdown({
      extraCostNetAmount: 100,
      commissionPercent: 10,
    })).toEqual({
      extraCostNetAmount: 100,
      customerDiscount: 0,
      customerChargeAmount: 110,
      platformCommissionAmount: 10,
      professionalPayout: 100,
    });
  });

  it('caps a discount at the commission so the supplier is not underpaid', () => {
    expect(calculateExtraCostBreakdown({
      extraCostNetAmount: 100,
      commissionPercent: 10,
      customerDiscount: 20,
    }).customerChargeAmount).toBe(100);
  });

  it('applies a partial customer discount without changing the supplier payout', () => {
    expect(calculateExtraCostBreakdown({
      extraCostNetAmount: 100,
      commissionPercent: 10,
      customerDiscount: 4,
    })).toEqual({
      extraCostNetAmount: 100,
      customerDiscount: 4,
      customerChargeAmount: 106,
      platformCommissionAmount: 6,
      professionalPayout: 100,
    });
  });
});
