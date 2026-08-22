import { describe, expect, it } from "vitest";
import { inflateSync } from "node:zlib";
import { applyManualInvoicePartyOverrides, generateInvoicePDF } from "../../services/invoiceGenerator";

const extractPdfStreamText = (pdf: Buffer): string => {
  const marker = Buffer.from("stream");
  const endMarker = Buffer.from("endstream");
  const parts: string[] = [];
  let offset = 0;
  while (true) {
    const streamOffset = pdf.indexOf(marker, offset);
    if (streamOffset < 0) break;
    let contentStart = streamOffset + marker.length;
    if (pdf[contentStart] === 13) contentStart += 1;
    if (pdf[contentStart] === 10) contentStart += 1;
    const endOffset = pdf.indexOf(endMarker, contentStart);
    if (endOffset < 0) break;
    try {
      parts.push(inflateSync(pdf.subarray(contentStart, endOffset)).toString("latin1"));
    } catch {
      // Non-compressed streams are not text-bearing PDFKit content.
    }
    offset = endOffset + endMarker.length;
  }
  return parts.join("\n");
};

const concatenatePdfHexText = (streamText: string): string =>
  [...streamText.matchAll(/<([0-9a-f]+)>/gi)]
    .map((match) => Buffer.from(match[1], "hex").toString("latin1"))
    .join("");

describe("invoice PDF artifacts", () => {
  it("renders a valid PDF with units, VAT, and page metadata inputs", async () => {
    const pdf = await generateInvoicePDF({
      invoiceNumber: "FIX-2026-000001",
      invoiceDate: new Date("2026-08-20T00:00:00.000Z"),
      bookingNumber: "BK-1",
      customer: { name: "Customer", email: "customer@example.com", country: "BE" },
      professional: { name: "Professional", country: "BE" },
      payment: {
        netAmount: 100,
        vatAmount: 0,
        vatRate: 6,
        reverseCharge: true,
        totalWithVat: 100,
        currency: "EUR",
      },
      serviceDescription: "Service\nIncluded materials: paint",
      lineItems: [{ description: "Service", amount: 100, vatRate: 6, quantity: 2, unitPrice: 50, unit: "units" }],
      actualStartDate: new Date("2026-08-19T00:00:00.000Z"),
      actualEndDate: new Date("2026-08-20T00:00:00.000Z"),
    });

    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.toString("latin1")).toContain("/Type /Page");
    const renderedText = extractPdfStreamText(pdf);
    const encodedText = concatenatePdfHexText(renderedText);
    expect(encodedText).toContain(Buffer.from("Reverse Charge").toString("latin1"));
    expect(encodedText).toContain(Buffer.from("Page 1 of 1").toString("latin1"));
  });

  it("renders the self-billing party label", async () => {
    const pdf = await generateInvoicePDF({
      invoiceNumber: "SUP-2026-000001",
      invoiceDate: new Date("2026-08-20T00:00:00.000Z"),
      bookingNumber: "BK-2",
      customer: { name: "Fixtract", email: "accounts@example.com", country: "BE" },
      professional: { name: "Supplier", country: "BE" },
      payment: { netAmount: 100, vatAmount: 0, vatRate: 0, totalWithVat: 100, currency: "EUR" },
      serviceDescription: "Supplier service",
      selfBilling: true,
    });

    const encodedText = concatenatePdfHexText(extractPdfStreamText(pdf));
    expect(encodedText).toContain(Buffer.from("SUPPLIER").toString("latin1"));
  });

  it("applies manual party overrides to hydrated bookings without losing fields", () => {
    const booking = {
      toObject: () => ({
        customer: { name: "Original customer", email: "customer@example.com", location: { country: "BE" } },
        professional: { name: "Original supplier", businessInfo: { country: "BE" } },
        location: { country: "BE" },
        payment: { netAmount: 100 },
      }),
    } as any;
    const result = applyManualInvoicePartyOverrides(booking, {
      lines: [],
      payment: { netAmount: 100, vatAmount: 0, vatRate: 0, totalWithVat: 100, currency: "EUR" },
      customer: { name: "Corrected customer", country: "NL" },
    });

    expect(result.location).toEqual({ country: "BE" });
    expect(result.customer).toMatchObject({
      name: "Corrected customer",
      email: "customer@example.com",
      companyAddress: { country: "NL" },
    });
    expect(result.professional).toMatchObject({
      name: "Original supplier",
      businessInfo: { country: "BE" },
    });
  });
});
