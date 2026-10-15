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
