import { describe, expect, it } from "vitest";
import { computeGrossBookingAmount } from "../../utils/payment";

const commission = 20;

describe("computeGrossBookingAmount", () => {
  it("marks up a package-only quote", () => {
    expect(computeGrossBookingAmount({ quote: { amount: 100 } }, commission)).toBe(120);
  });

  it("adds commissioned extras when quote is the package only", () => {
    expect(
      computeGrossBookingAmount(
        {
          quote: { amount: 410.68 },
          selectedExtraOptions: [{ bookedPrice: 80 }],
          checkoutSnapshot: {
            baseSubtotal: 410.68,
            extraOptionsTotal: 80,
            totalAmount: 490.68,
          },
        },
        commission
      )
    ).toBe(588.82);
  });

  it("does not add extras again when quote.amount already includes them", () => {
    expect(
      computeGrossBookingAmount(
        {
          quote: { amount: 490.68 },
          selectedExtraOptions: [{ bookedPrice: 80 }],
          checkoutSnapshot: {
            baseSubtotal: 410.68,
            extraOptionsTotal: 80,
            totalAmount: 490.68,
          },
        },
        commission
      )
    ).toBe(588.82);
  });

  it("adds extras when the quote is package-only and there is no snapshot", () => {
    expect(
      computeGrossBookingAmount(
        {
          quote: { amount: 410.68 },
          selectedExtraOptions: [{ bookedPrice: 80 }],
        },
        commission
      )
    ).toBe(588.82);
  });

  it("does not add extras when there are none", () => {
    expect(
      computeGrossBookingAmount(
        {
          quote: { amount: 410.68 },
          selectedExtraOptions: [],
          checkoutSnapshot: {
            baseSubtotal: 410.68,
            extraOptionsTotal: 0,
            totalAmount: 410.68,
          },
        },
        commission
      )
    ).toBe(492.82);
  });
});
