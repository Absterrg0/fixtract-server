type AmountDiscountComponent = { amount?: number; discountAmount?: never };
type PointsDiscountComponent = { amount?: never; discountAmount?: number };

export type DiscountPayoutInput = {
  originalAmount: number;
  finalAmount: number;
  loyaltyDiscount: AmountDiscountComponent;
  repeatBuyerDiscount: AmountDiscountComponent;
  pointsDiscount: PointsDiscountComponent;
  codeDiscount?: AmountDiscountComponent;
};

const roundToTwo = (value: number): number => Math.round(value * 100) / 100;

/** Allocate a customer-facing, commission-inclusive amount once. */
export function calculateDiscountedPayouts(
  discount: DiscountPayoutInput,
  commissionPercent: number,
): {
  customerPays: number;
  platformCommission: number;
  professionalPayout: number;
} {
  const commissionMultiplier = 1 + Math.max(0, commissionPercent) / 100;
  const professionalQuotedAmount = roundToTwo(discount.originalAmount / commissionMultiplier);
  const repeatBuyerProfessionalDiscount = roundToTwo(
    (discount.repeatBuyerDiscount.amount || 0) / commissionMultiplier,
  );
  const professionalBaseAmount = roundToTwo(
    professionalQuotedAmount - repeatBuyerProfessionalDiscount,
  );
  const platformCommissionOnBase = roundToTwo(
    (professionalBaseAmount * Math.max(0, commissionPercent)) / 100,
  );
  const professionalPayout = roundToTwo(professionalBaseAmount);
  const platformAbsorbed = roundToTwo(
    (discount.loyaltyDiscount.amount || 0) +
      (discount.pointsDiscount.discountAmount || 0) +
      (discount.codeDiscount?.amount || 0),
  );

  return {
    customerPays: discount.finalAmount,
    // Discounts can be larger than the nominal commission. Keep the stored
    // platform fee non-negative; any subsidy is an explicit platform cost,
    // never a negative commission that corrupts payout reporting.
    platformCommission: roundToTwo(Math.max(0, platformCommissionOnBase - platformAbsorbed)),
    professionalPayout,
  };
}
