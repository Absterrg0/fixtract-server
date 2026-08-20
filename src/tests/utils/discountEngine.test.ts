import { describe, expect, it } from "vitest";
import { calculateDiscountedPayouts } from "../../utils/discountAccounting";

describe("calculateDiscountedPayouts", () => {
  it("does not charge the commission twice when originalAmount includes it", () => {
    const result = calculateDiscountedPayouts(
      {
        originalAmount: 120,
        finalAmount: 120,
        loyaltyDiscount: { amount: 0 },
        repeatBuyerDiscount: { amount: 0 },
        pointsDiscount: { discountAmount: 0 },
      },
      20,
    );

    expect(result.customerPays).toBe(120);
    expect(result.professionalPayout).toBe(100);
    expect(result.platformCommission).toBe(20);
  });

  it("lets repeat-buyer discounts reduce the professional payout once", () => {
    const result = calculateDiscountedPayouts(
      {
        originalAmount: 120,
        finalAmount: 108,
        loyaltyDiscount: { amount: 0 },
        repeatBuyerDiscount: { amount: 12 },
        pointsDiscount: { discountAmount: 0 },
      },
      20,
    );

    expect(result.professionalPayout).toBe(90);
    expect(result.platformCommission).toBe(18);
    expect(result.customerPays).toBe(108);
  });
});
