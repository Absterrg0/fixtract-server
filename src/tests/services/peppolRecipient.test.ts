import { describe, expect, it } from "vitest";
import {
  getInvoiceVatRates,
  resolvePeppolRecipient,
  toPeppolParticipantId,
  validateOdooTaxCoverage,
} from "../../services/peppolDispatch";

describe("resolvePeppolRecipient (per actual recipient, not both-BE)", () => {
  it("customer eligible with business VAT in any country (NL, not BE)", () => {
    const booking = {
      customer: { customerType: "business", vatNumber: "NL123456789B01", companyAddress: { country: "NL" } },
      professional: { businessInfo: { country: "BE", vatNumber: "BE0123456789" } },
    };
    const result = resolvePeppolRecipient(booking, "customer");
    expect(result.eligible).toBe(true);
    expect(result.country).toBe("NL");
  });

  it("customer ineligible without business type", () => {
    const booking = { customer: { customerType: "individual", vatNumber: "NL123456789B01", location: { country: "NL" } } };
    expect(resolvePeppolRecipient(booking, "customer").eligible).toBe(false);
  });

  it("supplier eligible with professional VAT in any country (no customer-BE requirement)", () => {
    const booking = {
      customer: { customerType: "individual", location: { country: "BE" } },
      professional: { businessInfo: { country: "NL" }, vatNumber: "NL123456789B01" },
    };
    const result = resolvePeppolRecipient(booking, "supplier");
    expect(result.eligible).toBe(true);
    expect(result.country).toBe("NL");
  });

  it("supplier ineligible without VAT", () => {
    const booking = { professional: { businessInfo: { country: "BE" } } };
    expect(resolvePeppolRecipient(booking, "supplier").eligible).toBe(false);
  });

  it("participant-ID scheme: BE 0208, unknown countries rejected", () => {
    expect(toPeppolParticipantId("BE1002103337", "BE")).toEqual({ participantId: "0208:1002103337", scheme: "0208" });
    expect(toPeppolParticipantId("BE12", "BE")).toHaveProperty("error");
    expect(toPeppolParticipantId("XX123", "XX")).toHaveProperty("error");
  });

  it("participant-ID scheme follows the VAT prefix, not the address country", () => {
    // A Dutch professional working from a Belgian address was rejected as an invalid BE VAT.
    expect(toPeppolParticipantId("NL859484827B01", "BE")).toEqual({ participantId: "9944:NL859484827B01", scheme: "9944" });
    expect(toPeppolParticipantId("BE 0123.456.749", "NL")).toEqual({ participantId: "0208:0123456749", scheme: "0208" });
    expect(toPeppolParticipantId("DE123456789", "DE")).toEqual({ participantId: "9930:DE123456789", scheme: "9930" });
    expect(toPeppolParticipantId("EL123456789", "GR")).toEqual({ participantId: "9933:EL123456789", scheme: "9933" });
    // Prefix-less numbers fall back to the address country.
    expect(toPeppolParticipantId("859484827B01", "NL")).toEqual({ participantId: "9944:NL859484827B01", scheme: "9944" });
  });

  it("pads pre-2007 nine-digit Belgian numbers to the 10-digit CBE number", () => {
    expect(toPeppolParticipantId("BE123456749", "BE")).toEqual({ participantId: "0208:0123456749", scheme: "0208" });
  });

  it("supplier with a Dutch VAT and a Belgian address is eligible", () => {
    const booking = { professional: { businessInfo: { country: "BE", vatNumber: "NL859484827B01" } } };
    expect(resolvePeppolRecipient(booking, "supplier")).toMatchObject({ eligible: true, participantId: "9944:NL859484827B01" });
  });

  it("Odoo tax coverage requires every invoice rate and, only for reverse charge, the RC tax", () => {
    expect(validateOdooTaxCoverage({ taxIdsByRate: { "21": 1 }, reverseChargeTaxId: 2 }, [21, 6]).ok).toBe(false);
    expect(validateOdooTaxCoverage({ taxIdsByRate: { "21": 1, "6": 3 }, reverseChargeTaxId: 2 }, [21, 6]).ok).toBe(true);
    expect(validateOdooTaxCoverage({ taxIdsByRate: { "21": 1, "6": 3 } }, [21, 6]).ok).toBe(false);
    // A domestic invoice must not fail because the chart has no 0% RC tax.
    expect(validateOdooTaxCoverage({ taxIdsByRate: { "21": 1 } }, [21], false).ok).toBe(true);
    expect(validateOdooTaxCoverage({ taxIdsByRate: { "21": 1 } }, [21], true).ok).toBe(false);
  });

  it("scopes required Odoo rates to the invoice lines, not every configured service", () => {
    expect(getInvoiceVatRates([{ vatRate: 21 }, { vatRate: 21 }, { vatRate: 0 }, {}])).toEqual([21]);
    expect(getInvoiceVatRates([{ vatRate: 21 }, { vatRate: 6 }])).toEqual([6, 21]);
    expect(getInvoiceVatRates([{}])).toEqual([]);
  });
});
