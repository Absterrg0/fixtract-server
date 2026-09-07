import { describe, expect, it } from "vitest";
import { calculateDiscountedPayouts } from "../../utils/discountAccounting";
import { calculateSupplierInvoiceNet } from "../../utils/invoiceAccounting";

const base = (overrides: Partial<Parameters<typeof calculateDiscountedPayouts>[0]> = {}) => ({
  originalAmount: 1000,
  finalAmount: 1000,
  loyaltyDiscount: { amount: 0 },
  repeatBuyerDiscount: { amount: 0 },
  pointsDiscount: { discountAmount: 0 },
  ...overrides,
});

describe("discount absorption — platform vs professional (independent)", () => {
  it("loyalty discount is platform-absorbed, professional payout unchanged", () => {
    const noDiscount = calculateDiscountedPayouts(base(), 10);
    const withLoyalty = calculateDiscountedPayouts(
      base({ loyaltyDiscount: { amount: 100 }, finalAmount: 900 }),
      10,
    );
    expect(withLoyalty.professionalPayout).toBe(noDiscount.professionalPayout);
    expect(withLoyalty.platformCommission).toBeLessThan(noDiscount.platformCommission);
  });

  it("referral/points discount is platform-absorbed", () => {
    const noDiscount = calculateDiscountedPayouts(base(), 10);
    const withPoints = calculateDiscountedPayouts(
      base({ pointsDiscount: { discountAmount: 50 }, finalAmount: 950 }),
      10,
    );
    expect(withPoints.professionalPayout).toBe(noDiscount.professionalPayout);
    expect(withPoints.platformCommission).toBeLessThan(noDiscount.platformCommission);
  });

  it("discount codes are platform-absorbed", () => {
    const noDiscount = calculateDiscountedPayouts(base(), 10);
    const withCode = calculateDiscountedPayouts(
      base({ codeDiscount: { amount: 80 }, finalAmount: 920 }),
      10,
    );
    expect(withCode.professionalPayout).toBe(noDiscount.professionalPayout);
    expect(withCode.platformCommission).toBeLessThan(noDiscount.platformCommission);
  });

  it("repeat-buyer discount is professional-absorbed", () => {
    const noDiscount = calculateDiscountedPayouts(base(), 10);
    const withRepeat = calculateDiscountedPayouts(
      base({ repeatBuyerDiscount: { amount: 110 }, finalAmount: 890 }),
      10,
    );
    expect(withRepeat.professionalPayout).toBeLessThan(noDiscount.professionalPayout);
  });

  it("supplier invoice net strips only repeat-buyer (never loyalty/code/points)", () => {
    const net = calculateSupplierInvoiceNet({
      quoteAmount: 1000,
      checkoutSnapshot: undefined,
      selectedExtraOptions: [],
      repeatBuyerDiscount: 110,
    });
    expect(net).toBe(890);
  });
});
