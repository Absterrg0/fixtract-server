import { describe, expect, it } from "vitest";
import { getExtraCostQuantity, reconcileUnitPrice } from "../../utils/invoiceLineQuantity";
import { isInvoiceSettled } from "../../utils/invoiceSettlement";

describe("extra cost quantity", () => {
  it("bills a unit adjustment on the extra units, not the total actual units", () => {
    // 30 m² estimated, 35 m² measured: 5 m² are billed.
    expect(getExtraCostQuantity({ type: "unit_adjustment", estimatedUnits: 30, actualUnits: 35 })).toBe(5);
    expect(getExtraCostQuantity({ type: "unit_adjustment", estimatedUnits: 30, actualUnits: 27.5 })).toBe(-2.5);
  });

  it("has no quantity for unchanged units or extra costs without units", () => {
    expect(getExtraCostQuantity({ type: "unit_adjustment", estimatedUnits: 30, actualUnits: 30 })).toBeUndefined();
    expect(getExtraCostQuantity({ type: "condition" })).toBeUndefined();
    expect(getExtraCostQuantity({ type: "unit_adjustment", actualUnits: null })).toBeUndefined();
  });

  it("keeps the actual units when no estimate was recorded", () => {
    expect(getExtraCostQuantity({ type: "unit_adjustment", actualUnits: 4 })).toBe(4);
  });
});

describe("unit price reconciliation", () => {
  it("keeps a unit price that multiplies back to the amount", () => {
    expect(reconcileUnitPrice(450, 30, 15)).toBe(15);
  });

  it("derives the unit price from the charged amount when they disagree", () => {
    // Customer line of 477.74 on 30 m² priced from the professional's 15/m².
    expect(reconcileUnitPrice(477.74, 30, 15)).toBeCloseTo(15.924667, 6);
    // 5 extra m² charged 82.14 including commission.
    const unitPrice = reconcileUnitPrice(82.14, 5, 15)!;
    expect(Math.round(5 * unitPrice * 100) / 100).toBe(82.14);
  });

  it("returns the given unit price when there is no quantity", () => {
    expect(reconcileUnitPrice(100, undefined, 50)).toBe(50);
    expect(reconcileUnitPrice(100, 0, undefined)).toBeUndefined();
  });
});

describe("invoice settlement", () => {
  const extraCosts = [{ amount: 75 }];

  it("treats a captured customer payment as settled", () => {
    expect(isInvoiceSettled({ payment: { status: "completed" } }, "customer")).toBe(true);
    expect(isInvoiceSettled({ payment: { status: "authorized" } }, "customer")).toBe(false);
  });

  it("requires the extra-cost payment when extra costs were charged", () => {
    expect(isInvoiceSettled({ extraCosts, payment: { status: "completed", extraCostStatus: "pending" } }, "customer")).toBe(false);
    expect(isInvoiceSettled({ extraCosts, payment: { status: "completed", extraCostStatus: "succeeded" } }, "customer")).toBe(true);
  });

  it("settles a self-bill once the professional was paid out", () => {
    expect(isInvoiceSettled({ payment: { status: "completed", transferStatus: "pending" } }, "supplier")).toBe(false);
    expect(isInvoiceSettled({ payment: { transferStatus: "succeeded" } }, "supplier")).toBe(true);
    expect(isInvoiceSettled({ extraCosts, payment: { transferStatus: "succeeded" } }, "supplier")).toBe(false);
    expect(isInvoiceSettled({ extraCosts, payment: { transferStatus: "succeeded", extraCostTransferStatus: "succeeded" } }, "supplier")).toBe(true);
  });
});
