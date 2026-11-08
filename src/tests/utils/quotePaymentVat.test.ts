import { describe, expect, it } from 'vitest';
import { getQuotePricingVatCalculation } from '../../handlers/Stripe/payment';

const booking = (included = false) => ({
  currentQuoteVersion: 1, quote: { amount: included ? 120 : 100 },
  quoteVersions: [{ version: 1, pricingLines: [
    { description: 'Work', price: included ? 70 : 50, vatRate: 21 },
    { description: 'Materials', price: 50, vatRate: 6 },
  ] }],
  checkoutSnapshot: { baseSubtotal: 100, extraOptionsTotal: 20, totalAmount: 120 },
  selectedExtraOptions: [{ bookedPrice: 20, name: 'Option' }], vatDecision: { appliedRate: 21, country: 'BE' },
});

describe('quote payment VAT includes the entire charged net', () => {
  it('adds separately priced options with commission and the applicable option rate', () => {
    const vat = getQuotePricingVatCalculation(booking(), 132, 10)!;
    expect(vat.netAmount).toBe(132);
    expect(vat.vatBreakdown.map(line => [line.netAmount, line.vatRate])).toEqual([[55, 21], [55, 6], [22, 21]]);
    expect(vat.vatAmount).toBe(19.47); expect(vat.total).toBe(151.47);
  });
  it('never adds options already included in the quote', () => {
    const vat = getQuotePricingVatCalculation(booking(true), 132, 10)!;
    expect(vat.vatBreakdown).toHaveLength(2); expect(vat.netAmount).toBe(132); expect(vat.vatAmount).toBe(19.47);
  });
  it('preserves proportional discount allocation across mixed rates and options', () => {
    const vat = getQuotePricingVatCalculation(booking(), 118.8, 10)!;
    expect(vat.netAmount).toBe(118.8);
    expect(vat.vatBreakdown.map(line => line.netAmount)).toEqual([49.5, 49.5, 19.8]);
    expect(vat.vatAmount).toBe(17.53); expect(vat.total).toBe(136.33);
  });
  it('preserves the existing discount behavior without options', () => {
    const value = { ...booking(), selectedExtraOptions: [] };
    const vat = getQuotePricingVatCalculation(value, 99, 10)!;
    expect(vat.netAmount).toBe(99); expect(vat.vatBreakdown.map(line => line.netAmount)).toEqual([49.5, 49.5]);
  });
});
