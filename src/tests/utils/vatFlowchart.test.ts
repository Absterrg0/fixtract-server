import { describe, expect, it } from "vitest";
import {
  flowchartPlaceOfSupplyCountry,
  flowchartPropertyNature,
  flowchartReverseCharge,
  flowchartTierRateForCountry,
} from "../../utils/vatFlowchart";

describe("vatFlowchart SSOT", () => {
  it("resolves Article 47 project_dependent via professional answer", () => {
    expect(
      flowchartPropertyNature({ classification: "project_dependent", professionalAnswers: { article47_immovable: "yes" } }).nature,
    ).toBe("immovable");
    expect(
      flowchartPropertyNature({ classification: "project_dependent", professionalAnswers: { article47_immovable: "no" } }).nature,
    ).toBe("movable");
    expect(
      flowchartPropertyNature({ classification: "project_dependent", professionalAnswers: {} }).nature,
    ).toBeUndefined();
  });

  it("customer movable B2B uses business country, immovable uses booking", () => {
    expect(
      flowchartPlaceOfSupplyCountry({ leg: "customer", customerType: "business", propertyNature: "movable", bookingCountry: "NL", customerBusinessCountry: "DE" }).country,
    ).toBe("DE");
    expect(
      flowchartPlaceOfSupplyCountry({ leg: "customer", customerType: "business", propertyNature: "immovable", bookingCountry: "NL", customerBusinessCountry: "DE" }).country,
    ).toBe("NL");
  });

  it("supplier movable uses professional address, immovable uses booking", () => {
    expect(
      flowchartPlaceOfSupplyCountry({ leg: "supplier", propertyNature: "movable", bookingCountry: "BE", supplierBusinessCountry: "NL" }).country,
    ).toBe("NL");
    expect(
      flowchartPlaceOfSupplyCountry({ leg: "supplier", propertyNature: "immovable", bookingCountry: "BE", supplierBusinessCountry: "NL" }).country,
    ).toBe("BE");
  });

  it("reverse charge follows explicit branches, no movable+B2B shortcut", () => {
    // B2C never RC
    expect(
      flowchartReverseCharge({ buyerType: "individual", buyerVatNumber: "NL123456789B01", buyerVatVerified: true, buyerCountry: "NL", propertyNature: "movable" }).reverseCharge,
    ).toBe(false);
    // BE movable keeps local rate
    expect(
      flowchartReverseCharge({ buyerType: "business", buyerVatNumber: "BE0123456789", buyerVatVerified: true, buyerCountry: "BE", propertyNature: "movable" }).reverseCharge,
    ).toBe(false);
    // BE immovable verified -> RC
    expect(
      flowchartReverseCharge({ buyerType: "business", buyerVatNumber: "BE0123456789", buyerVatVerified: true, buyerCountry: "BE", propertyNature: "immovable" }).reverseCharge,
    ).toBe(true);
    // supplier movable: VAT country = supplier (NL), platform BE buyer with
    // verified VAT -> verified EU B2B -> RC (explicit branch, not shortcut)
    expect(
      flowchartReverseCharge({ buyerType: "business", buyerVatNumber: "BE1002103337", buyerVatVerified: true, supplierCountry: "NL", supplierVatNumber: "NL123456789B01", buyerCountry: "NL", propertyNature: "movable" }).reverseCharge,
    ).toBe(true);
    // CH exception -> no RC
    expect(
      flowchartReverseCharge({ buyerType: "business", buyerVatNumber: "CH123456789", buyerVatVerified: true, buyerCountry: "CH", propertyNature: "movable" }).reverseCharge,
    ).toBe(false);
  });

  it("tier-only rate ignores eligibility and returns country rate", () => {
    expect(flowchartTierRateForCountry({ country: "BE", tier: "standard", standardRate: 21 }).rate).toBe(21);
    expect(flowchartTierRateForCountry({ country: "BE", tier: "reduced", standardRate: 21, reducedRate: 6 }).rate).toBe(6);
  });
});
