import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type * as InvoiceArtifacts from "../../services/invoiceArtifacts";

// The UBL builders sit behind the Stripe-initialised booking model; the key is
// only stubbed so the module can be imported. No Stripe call is involved.
let buildUblInvoiceXml: typeof InvoiceArtifacts.buildUblInvoiceXml;
let buildUblCreditNoteXml: typeof InvoiceArtifacts.buildUblCreditNoteXml;

beforeAll(async () => {
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_ubl_quantity_unit");
  ({ buildUblInvoiceXml, buildUblCreditNoteXml } = await import("../../services/invoiceArtifacts"));
});

afterAll(() => {
  vi.unstubAllEnvs();
});

// A booking with manual correction lines; the quantities are the ones the
// platform invoice shows, and the UBL must multiply back to the line amounts.
const booking = {
  bookingNumber: "BK-2026-000100",
  payment: { currency: "EUR", vatRate: 6, netAmount: 559.88, amount: 559.88, totalWithVat: 593.47 },
  customer: { customerType: "business", name: "Test Customer BV", vatNumber: "BE0123456749", companyAddress: { country: "BE" } },
  professional: { name: "Test Supplier", businessInfo: { vatNumber: "BE0123456848", country: "BE" } },
  __manualInvoiceLines: [
    { description: "Paint per m²", amount: 477.74, vatRate: 6, quantity: 30, unitPrice: 15 },
    // Actual 32.125 m² against 30 m² estimated: the extra units carry three decimals.
    { description: "Extra cost: 2.125 m² more", amount: 82.14, vatRate: 6, quantity: 2.125, unitPrice: 16.427727 },
  ],
};

const platform = { name: "Fixtract", vatNumber: "BE1002103337", country: "BE" };

describe("platform UBL quantities", () => {
  it("keeps the exact quantity so quantity × price still equals the line amount", () => {
    const xml = buildUblInvoiceXml(booking, "FIX-2026-000015", new Date("2026-10-15T00:00:00Z"), {
      selfBilling: false,
      platform,
    });
    expect(xml).toMatch(/<cbc:InvoicedQuantity[^>]*>2\.125<\/cbc:InvoicedQuantity>/);
    expect(xml).toContain('<cbc:PriceAmount currencyID="EUR">38.654118</cbc:PriceAmount>');
    expect(xml).toMatch(/<cbc:InvoicedQuantity[^>]*>30\.00<\/cbc:InvoicedQuantity>/);
    expect(xml).toMatch(/<cbc:LineExtensionAmount currencyID="EUR">82\.14<\/cbc:LineExtensionAmount>/);
    // Rounding must agree with what a Peppol receiver recomputes (rule R120).
    expect(Math.round(2.125 * 38.654118 * 100) / 100).toBe(82.14);
  });

  it("serializes credit note quantities the same way", () => {
    const xml = buildUblCreditNoteXml(booking, "FIX-CN-2026-000015", new Date("2026-10-15T00:00:00Z"), { platform });
    expect(xml).toMatch(/<cbc:CreditedQuantity[^>]*>2\.125<\/cbc:CreditedQuantity>/);
    expect(xml).toMatch(/<cbc:CreditedQuantity[^>]*>30\.00<\/cbc:CreditedQuantity>/);
  });
});

describe("platform UBL unit prices in whole cents", () => {
  // 30 m² at 15/m² with a 9.5155% commission: 16.43/m², 492.90 for the package.
  const unitBooking = {
    bookingNumber: "BK-2026-000103",
    __commissionPercent: 9.5155,
    checkoutSnapshot: { pricingType: "unit", unitAmount: 15, quantity: 30, unit: "m²", baseSubtotal: 450, totalAmount: 450 },
    quote: { amount: 450, description: "Paint per m²" },
    extraCosts: [
      { type: "unit_adjustment", name: "Unit-based adjustment", estimatedUnits: 30, actualUnits: 31, unitPrice: 15, amount: 15 },
      { type: "condition", name: "Premium Paint", amount: 50 },
    ],
    payment: {
      currency: "EUR", vatRate: 21, reverseCharge: false,
      netAmount: 468.25, amount: 468.25,
      discount: { loyaltyAmount: 24.65 },
      // 16.43 + 54.76 charged for the extra costs, after a 1.00 loyalty discount.
      extraCostCustomerNetAmount: 70.19, extraCostCustomerDiscount: 1,
    },
    customer: { customerType: "business", name: "Test Customer BV", vatNumber: "BE0123456749", companyAddress: { country: "BE" } },
    professional: { name: "Test Supplier", businessInfo: { vatNumber: "BE0123456848", country: "BE" } },
  };

  it("shows the package and extra costs at whole-cent unit prices and the discount on its own line", () => {
    const xml = buildUblInvoiceXml(unitBooking, "FIX-2026-000018", new Date("2026-10-17T00:00:00Z"), { selfBilling: false, platform });
    const prices = [...xml.matchAll(/<cbc:PriceAmount currencyID="EUR">([^<]+)<\/cbc:PriceAmount>/g)].map((match) => match[1]);
    expect(prices).toEqual(["16.43", "16.43", "54.76", "-25.65"]);
    expect(xml).toMatch(/<cbc:LineExtensionAmount currencyID="EUR">492\.90<\/cbc:LineExtensionAmount>/);
    expect(xml).toContain("Loyalty discount");
    // The total is still what was charged: 468.25 + 70.19 excl. VAT.
    expect(xml).toMatch(/<cbc:TaxExclusiveAmount currencyID="EUR">538\.44<\/cbc:TaxExclusiveAmount>/);
  });
});
