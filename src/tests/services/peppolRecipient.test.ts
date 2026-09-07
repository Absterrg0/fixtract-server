import { describe, expect, it } from "vitest";
import { resolvePeppolRecipient, toPeppolParticipantId, validateOdooTaxCoverage } from "../../services/peppolDispatch";

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

  it("Odoo tax coverage must include all engine rates + RC", () => {
    expect(validateOdooTaxCoverage({ taxIdsByRate: { "21": 1 }, reverseChargeTaxId: 2 }, [21, 6]).ok).toBe(false);
    expect(validateOdooTaxCoverage({ taxIdsByRate: { "21": 1, "6": 3 }, reverseChargeTaxId: 2 }, [21, 6]).ok).toBe(true);
    expect(validateOdooTaxCoverage({ taxIdsByRate: { "21": 1, "6": 3 } }, [21, 6]).ok).toBe(false);
  });
});
