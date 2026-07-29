import { describe, expect, it } from 'vitest';

/**
 * Mirrors sanitizeIncompleteCheckoutSnapshot in handlers/Quotation/index.ts.
 * Kept local so the rule is unit-tested without pulling Express handlers.
 */
const sanitizeIncompleteCheckoutSnapshot = (booking: any) => {
  const snapshot = booking?.checkoutSnapshot;
  if (!snapshot) return;

  const hasRequiredTotals =
    typeof snapshot.pricingType === 'string' &&
    Number.isFinite(Number(snapshot.unitAmount)) &&
    Number.isFinite(Number(snapshot.quantity)) &&
    Number.isFinite(Number(snapshot.baseSubtotal)) &&
    Number.isFinite(Number(snapshot.extraOptionsTotal)) &&
    Number.isFinite(Number(snapshot.totalAmount)) &&
    typeof snapshot.currency === 'string' &&
    snapshot.currency.length > 0;

  if (!hasRequiredTotals) {
    booking.checkoutSnapshot = undefined;
    if (typeof booking.markModified === 'function') {
      booking.markModified('checkoutSnapshot');
    }
  }
};

describe('sanitizeIncompleteCheckoutSnapshot', () => {
  it('clears currency-only snapshots that block RFQ accept saves', () => {
    const booking: any = {
      checkoutSnapshot: { currency: 'EUR', selectedOptions: [] },
      markModified: () => undefined,
    };

    sanitizeIncompleteCheckoutSnapshot(booking);
    expect(booking.checkoutSnapshot).toBeUndefined();
  });

  it('keeps complete checkout snapshots', () => {
    const snapshot = {
      pricingType: 'fixed',
      unitAmount: 500,
      quantity: 1,
      baseSubtotal: 500,
      extraOptionsTotal: 0,
      totalAmount: 500,
      currency: 'EUR',
      selectedOptions: [],
    };
    const booking: any = { checkoutSnapshot: snapshot };

    sanitizeIncompleteCheckoutSnapshot(booking);
    expect(booking.checkoutSnapshot).toEqual(snapshot);
  });
});
