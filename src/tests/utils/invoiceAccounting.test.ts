import { describe, expect, it } from "vitest";
import {
  calculateInvoiceSideTotals,
  calculateSupplierInvoiceNet,
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
});
