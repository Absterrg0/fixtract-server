import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { inflateSync } from "node:zlib";

import type * as InvoiceArtifacts from "../../services/invoiceArtifacts";
import type * as InvoiceGenerator from "../../services/invoiceGenerator";

const mocks = vi.hoisted(() => ({ platformSettings: vi.fn(), invoiceSequence: vi.fn() }));
vi.mock("../../models/platformSettings", () => ({ default: { getCurrentConfig: mocks.platformSettings } }));
vi.mock("../../models/invoiceSequence", () => ({ default: { findOneAndUpdate: mocks.invoiceSequence } }));

let buildUblInvoiceXml: typeof InvoiceArtifacts.buildUblInvoiceXml;
let generateBookingInvoice: typeof InvoiceGenerator.generateBookingInvoice;
let getQuotePricingVatCalculation: typeof import("../../handlers/Stripe/payment").getQuotePricingVatCalculation;

beforeAll(async () => {
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_quote_milestone_option");
  ({ buildUblInvoiceXml } = await import("../../services/invoiceArtifacts"));
  ({ generateBookingInvoice } = await import("../../services/invoiceGenerator"));
  ({ getQuotePricingVatCalculation } = await import("../../handlers/Stripe/payment"));
});
afterAll(() => vi.unstubAllEnvs());
beforeEach(() => {
  mocks.platformSettings.mockResolvedValue({
    companyAddress: { name: "Fixtract", street: "Main 1", city: "Brussels", postalCode: "1000", country: "BE" },
    companyVatNumber: "BE1002103337",
  });
  mocks.invoiceSequence.mockResolvedValue({ value: 1 });
});

const extractPdfText = (pdf: Buffer): string => {
  const parts: string[] = [];
  let offset = 0;
  while (true) {
    const start = pdf.indexOf(Buffer.from("stream"), offset);
    if (start < 0) break;
    let contentStart = start + 6;
    if (pdf[contentStart] === 13) contentStart += 1;
    if (pdf[contentStart] === 10) contentStart += 1;
    const end = pdf.indexOf(Buffer.from("endstream"), contentStart);
    if (end < 0) break;
    try { parts.push(inflateSync(pdf.subarray(contentStart, end)).toString("latin1")); } catch { /* not text */ }
    offset = end + 9;
  }
  return [...parts.join("\n").matchAll(/<([0-9a-f]+)>/gi)].map((m) => Buffer.from(m[1], "hex").toString("latin1")).join("");
};

const OPTION_ID = "6b000132fa98d2c30dbce71d";

// BK-2026-000060 on staging: QT-2026-000006 v1 €8,000 (Deposit 3,000 +
// Cabinets installed 5,000), option Integrated Lighting €400 charged with the
// deposit, Gold loyalty €75 (30.36 + 44.64), 0 % commission. The Payment row
// of milestone 1 was overwritten by milestone 2 (pre-existing); its charge is
// in the discount ledger. Milestone 2's stored breakdown spread the option
// over it and named it by id.
const quoteBooking = () => ({
  _id: "booking-quote-option",
  bookingNumber: "BK-2026-000060",
  __commissionPercent: 0,
  currentQuoteVersion: 1,
  quote: { amount: 8000, description: "Kitchen renovation" },
  quoteVersions: [{
    version: 1,
    totalAmount: 8000,
    pricingLines: [{ description: "Kitchen installation (QA-R)", price: 8000, vatRate: 21 }],
    milestones: [{ title: "Deposit", amount: 3000 }, { title: "Cabinets installed", amount: 5000 }],
  }],
  milestonePayments: [
    { title: "Deposit", amount: 3000, order: 0, status: "paid", dueCondition: "on_start" },
    { title: "Cabinets installed", amount: 5000, order: 1, status: "paid", dueCondition: "on_completion" },
  ],
  selectedExtraOptions: [{ extraOptionId: OPTION_ID, bookedPrice: 400 }],
  project: { extraOptions: [{ _id: OPTION_ID, name: "Integrated Lighting", price: 400 }] },
  vatDecision: { appliedRate: 21, country: "BE" },
  __settledPayments: [{
    milestoneIndex: 1, status: "completed", stripePaymentIntentId: "pi_m2", currency: "EUR",
    netAmount: 4955.36, vatAmount: 1040.62, totalWithVat: 5995.98, vatRate: 21, reverseCharge: false,
    professionalPayout: 5000,
    vatBreakdown: [
      { description: "Kitchen installation (QA-R)", netAmount: 4719.39, vatRate: 21, vatAmount: 991.07, totalAmount: 5710.46 },
      { description: OPTION_ID, netAmount: 235.97, vatRate: 21, vatAmount: 49.55, totalAmount: 285.52 },
    ],
  }],
  paymentDiscountLedger: [
    { paymentIntentId: "pi_m1", milestoneIndex: 0, currency: "EUR", netAmount: 3369.64, vatAmount: 707.63, totalWithVat: 4077.27,
      professionalPayout: 3400, vatRate: 21, originalAmount: 3400, loyaltyAmount: 30.36, repeatBuyerAmount: 0,
      pointsDiscountAmount: 0, codeDiscountAmount: 0, totalDiscount: 30.36, recordedAt: new Date("2026-11-20T12:00:00Z") },
    { paymentIntentId: "pi_m2", milestoneIndex: 1, currency: "EUR", netAmount: 4955.36, vatAmount: 1040.62, totalWithVat: 5995.98,
      professionalPayout: 5000, vatRate: 21, originalAmount: 5000, loyaltyAmount: 44.64, repeatBuyerAmount: 0,
      pointsDiscountAmount: 0, codeDiscountAmount: 0, totalDiscount: 44.64, recordedAt: new Date("2026-11-20T13:00:00Z") },
  ],
  payment: {
    status: "completed", currency: "EUR", milestoneIndex: 1, stripePaymentIntentId: "pi_m2",
    netAmount: 4955.36, amount: 4955.36, vatAmount: 1040.62, totalWithVat: 5995.98, vatRate: 21, reverseCharge: false,
    professionalPayout: 5000,
    discount: { loyaltyAmount: 44.64, totalDiscount: 44.64, originalAmount: 5000 },
  },
  customer: { customerType: "individual", name: "Customer", location: { country: "BE" } },
  professional: { name: "Supplier", businessInfo: { vatNumber: "BE0123456848", country: "BE" } },
});

describe("F1-8 — option on a quote booking", () => {
  it("checkout breakdown names the option and lists it only on the milestone that charges it", () => {
    const booking = quoteBooking();
    const m1 = getQuotePricingVatCalculation(booking, 3369.64, 0, { baseCustomerGross: 3000, includesSelectedOptions: true })!;
    expect(m1.vatBreakdown.map((line: any) => [line.description, line.netAmount])).toEqual([
      ["Kitchen installation (QA-R)", 2973.21],
      ["Integrated Lighting", 396.43],
    ]);
    expect(m1.netAmount).toBe(3369.64);
    const m2 = getQuotePricingVatCalculation(booking, 4955.36, 0, { baseCustomerGross: 5000, includesSelectedOptions: false })!;
    expect(m2.vatBreakdown.map((line: any) => [line.description, line.netAmount])).toEqual([["Kitchen installation (QA-R)", 4955.36]]);
    expect(JSON.stringify([m1, m2])).not.toContain(OPTION_ID);
  });

  it("customer invoice lines add up to 8,000 + 400 with the option by name (PDF and UBL)", async () => {
    const text = extractPdfText((await generateBookingInvoice(structuredClone(quoteBooking()) as any, { kind: "customer" })).pdfBuffer);
    expect(text).toMatch(/Deposit \(21% VAT\)\D?3,000\.00/);
    expect(text).toMatch(/Option: Integrated Lighting \(21% VAT\)\D?400\.00/);
    expect(text).toMatch(/Kitchen installation \(QA-R\) \(21% VAT\)\D?5,000\.00/);
    expect(text).toMatch(/Loyalty discount-\D?75\.00/);
    expect(text).toMatch(/TOTAL\D?10,073\.25/);
    expect(text).not.toContain(OPTION_ID);
    expect(text).not.toContain("Options included");

    const xml = buildUblInvoiceXml(quoteBooking(), "FIX-2026-000017", new Date("2026-11-20T00:00:00Z"), {
      selfBilling: false,
      platform: { name: "Fixtract", vatNumber: "BE1002103337", country: "BE" },
    });
    const lines = [...xml.matchAll(/<cac:InvoiceLine>[\s\S]*?<cbc:LineExtensionAmount[^>]*>([\d.]+)<[\s\S]*?<cbc:Description>([^<]*)<\/cbc:Description>/g)]
      .map(([, amount, name]) => [name, Number(amount)]);
    expect(lines).toEqual(expect.arrayContaining([["Deposit", 3000], ["Option: Integrated Lighting", 400], ["Kitchen installation (QA-R)", 5000]]));
    expect(lines).toHaveLength(3);
    expect(lines.reduce((sum, [, amount]) => sum + Number(amount), 0)).toBeCloseTo(8400, 2);
    expect(xml).not.toContain(OPTION_ID);
    expect(xml).toMatch(/<cbc:TaxInclusiveAmount currencyID="EUR">10073\.25</);
  });
});
