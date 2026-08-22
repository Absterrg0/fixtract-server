import { describe, expect, it } from "vitest";
import {
  calculateInvoiceSideTotals,
  calculateSupplierInvoiceNet,
  getCustomerExtraCostNet,
} from "../../utils/invoiceAccounting";

describe("invoice accounting", () => {
  it("keeps supplier pricing separate from the customer commission", () => {
    expect(calculateSupplierInvoiceNet({
      quoteAmount: 500,
      selectedExtraOptions: [{ bookedPrice: 50 }],
      repeatBuyerDiscount: 10,
      extraCostTotal: 25,
    })).toBe(565);
  });

  it("uses the checkout snapshot instead of adding options twice", () => {
    expect(calculateSupplierInvoiceNet({
      quoteAmount: 550,
      checkoutSnapshot: { baseSubtotal: 500, extraOptionsTotal: 50 },
      selectedExtraOptions: [{ bookedPrice: 50 }],
    })).toBe(550);
  });

  it("calculates a zero-VAT reverse-charge side", () => {
    expect(calculateInvoiceSideTotals({
      lines: [{ description: "Immovable service", amount: 500, vatRate: 21 }],
      reverseCharge: true,
      vatRate: 21,
      vatLabel: "Reverse Charge",
    })).toMatchObject({
      netAmount: 500,
      vatAmount: 0,
      totalWithVat: 500,
      vatRate: 0,
      reverseCharge: true,
      vatLabel: "Reverse Charge",
    });
  });

  describe("getCustomerExtraCostNet", () => {
    it("prefers the persisted customer net amount", () => {
      expect(getCustomerExtraCostNet({
        extraCostCustomerNetAmount: 42.456,
        extraCostAmount: 60,
        extraCostVatAmount: 10,
        reverseCharge: false,
      }, 999)).toBe(42.46);
    });

    it("deducts VAT from the gross extra cost unless reverse charged", () => {
      expect(getCustomerExtraCostNet({ extraCostAmount: 121, extraCostVatAmount: 21 }, 999)).toBe(100);
      expect(getCustomerExtraCostNet({ extraCostAmount: 121, extraCostVatAmount: 21, reverseCharge: true }, 999)).toBe(121);
    });

    it("falls back to the raw extra-cost sum when no payment metadata exists", () => {
      expect(getCustomerExtraCostNet({}, 37.5)).toBe(37.5);
      expect(getCustomerExtraCostNet(undefined as any, 12)).toBe(12);
    });
  });
});
