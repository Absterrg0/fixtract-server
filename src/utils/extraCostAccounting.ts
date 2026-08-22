export type ExtraCostBreakdown = {
  extraCostNetAmount: number;
  customerDiscount: number;
  customerChargeAmount: number;
  platformCommissionAmount: number;
  professionalPayout: number;
};

const roundToTwo = (value: number) => Math.round(value * 100) / 100;

/**
 * Extra costs are supplier prices. The customer pays the supplier price plus
 * the platform commission, less any customer-funded discount. The supplier
 * always receives the original extra-cost amount.
 */
export const calculateExtraCostBreakdown = ({
  extraCostNetAmount,
  commissionPercent,
  customerDiscount = 0,
}: {
  extraCostNetAmount: number;
  commissionPercent: number;
  customerDiscount?: number;
}): ExtraCostBreakdown => {
  const net = Math.max(0, roundToTwo(extraCostNetAmount));
  const commission = Math.max(0, roundToTwo(net * (commissionPercent / 100)));
  const cappedDiscount = Math.max(0, Math.min(roundToTwo(customerDiscount), commission));
  const customerChargeAmount = roundToTwo(net + commission - cappedDiscount);

  return {
    extraCostNetAmount: net,
    customerDiscount: cappedDiscount,
    customerChargeAmount,
    platformCommissionAmount: roundToTwo(commission - cappedDiscount),
    professionalPayout: net,
  };
};
