import { describe, expect, it } from "vitest";
import { assertValidInvoiceUnit, formatVatAnswerWithUnit, isKnownInvoiceUnit, mapUnitToUneceCode, normalizeUnitLabel } from "../../utils/invoiceUnits";

describe("invoiceUnits", () => {
  it("normalizes common unit labels", () => {
    expect(normalizeUnitLabel("m2")).toBe("m²");
    expect(normalizeUnitLabel("hours")).toBe("hour");
    expect(normalizeUnitLabel("  ")).toBeUndefined();
  });

  it("maps real units to UNECE codes (no generic C62 for m²/hour)", () => {
    expect(mapUnitToUneceCode("m²")).toBe("MTK");
    expect(mapUnitToUneceCode("hour")).toBe("HUR");
    expect(mapUnitToUneceCode(undefined)).toBe("C62");
  });

  it("rejects unknown units instead of silently mapping to C62", () => {
    expect(isKnownInvoiceUnit("m²")).toBe(true);
    expect(isKnownInvoiceUnit("frobnicate")).toBe(false);
    expect(() => mapUnitToUneceCode("frobnicate")).toThrow(/Unknown UBL unit/);
    expect(() => assertValidInvoiceUnit("frobnicate", "service unit")).toThrow(/Unknown service unit/);
  });

  it("formats VAT answers with configured units", () => {
    const config = { reducedVatQuestions: [{ fieldName: "building_age", unit: "years" }], professionalVatQuestions: [] };
    expect(formatVatAnswerWithUnit("building_age", 10, config)).toBe("- building_age: 10 years");
    expect(formatVatAnswerWithUnit("private_housing", true, config)).toBe("- private_housing: true");
  });
});
