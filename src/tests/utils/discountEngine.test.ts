import { describe, expect, it } from "vitest";
import { calculateDiscountedPayouts } from "../../utils/discountAccounting";
import { buildPaymentIntentIdempotencyKey, buildTransferIdempotencyKey, computeGrossBookingAmount } from "../../utils/payment";
import { canRetryTransfer, getTransferStatus, requireProfessionalPayout } from "../../utils/paymentSafety";

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

  it("does not record a negative platform fee when discounts exceed commission", () => {
    const result = calculateDiscountedPayouts(
      {
        originalAmount: 120,
        finalAmount: 80,
        loyaltyDiscount: { amount: 30 },
        repeatBuyerDiscount: { amount: 0 },
        pointsDiscount: { discountAmount: 20 },
      },
      20,
    );
    expect(result.platformCommission).toBe(0);
  });
});

describe("payment safety invariants", () => {
  it("never uses gross customer amounts as a payout fallback", () => {
    expect(() => requireProfessionalPayout({ totalWithVat: 120, amount: 100 })).toThrow(
      /Professional payout is missing/,
    );
  });

  it("recognizes a completed payment with a failed transfer as retryable", () => {
    const payment = { status: "completed", transferStatus: "failed" as const };
    expect(getTransferStatus(payment)).toBe("failed");
    expect(canRetryTransfer(payment)).toBe(true);
  });

  it("does not treat a failed legacy transfer as settled just because an id exists", () => {
    expect(getTransferStatus({ stripeTransferId: "tr_123", metadata: { transferFailed: true } })).toBe("failed");
  });

  it("blocks payouts above the reconciled customer amount", () => {
    expect(() => requireProfessionalPayout({ professionalPayout: 101, netAmount: 100 })).toThrow(
      /exceeds the reconciled customer net amount/,
    );
    expect(requireProfessionalPayout({ professionalPayout: 100, netAmount: 100 })).toBe(100);
  });

  it("uses one idempotency key for concurrent identical attempts and a new key after a change", () => {
    const base = {
      bookingId: "booking-1",
      amount: 121,
      currency: "EUR",
      pointsToRedeem: 0,
      discountCode: "SAVE10",
      quoteVersion: 2,
    };
    expect(buildPaymentIntentIdempotencyKey(base)).toBe(buildPaymentIntentIdempotencyKey(base));
    expect(buildPaymentIntentIdempotencyKey(base)).not.toBe(
      buildPaymentIntentIdempotencyKey({ ...base, amount: 122 }),
    );
  });

  it("reuses a transfer key only for the same transfer payload", () => {
    const base = {
      bookingId: "booking-1",
      amountMinor: 10000,
      currency: "eur",
      destination: "acct_123",
      sourceTransaction: "ch_123",
      attempt: 0,
    };
    expect(buildTransferIdempotencyKey(base)).toBe(buildTransferIdempotencyKey(base));
    expect(buildTransferIdempotencyKey(base)).not.toBe(
      buildTransferIdempotencyKey({ ...base, amountMinor: 9000 }),
    );
    expect(buildTransferIdempotencyKey(base)).not.toBe(
      buildTransferIdempotencyKey({ ...base, attempt: 1 }),
    );
  });
});

describe("checkout amount reconciliation", () => {
  it("does not add selected options twice when a legacy quote stores the computed total", () => {
    expect(computeGrossBookingAmount({
      quote: {
        amount: 576.43,
        breakdown: [{ item: "checkout_snapshot:computed_total", totalPrice: 576.43 }],
      },
      selectedExtraOptions: [{ bookedPrice: 245.15 }],
    }, 0)).toBe(576.43);
  });
});
