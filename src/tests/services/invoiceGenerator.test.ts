import { describe, expect, it } from "vitest";
import { inflateSync } from "node:zlib";
import {
  applyManualInvoicePartyOverrides,
  formatInvoiceServiceAddress,
  generateInvoicePDF,
  scaleLineItemsToTotal,
} from "../../services/invoiceGenerator";

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

// Mirrors invoiceGenerator: 50pt page margin + 60pt reserved footer band.
// PDFKit flips the page (`1 0 0 -1 0 <height> cm`), so a text-matrix y is
// measured from the PDF bottom edge; the band starts this many points above it.
const PDF_CONTENT_MARGIN = 50;
const PDF_FOOTER_BAND = 60;
const PDF_FOOTER_BAND_TOP_FROM_BOTTOM = PDF_CONTENT_MARGIN + PDF_FOOTER_BAND;
const PDF_FOOTER_PATTERNS = [
  /^Page \d+ of \d+$/,
  /^Thank you for using Fixtract!$/,
  /^This invoice was generated automatically/,
  /^Fixtract$/,
  /^VAT:/,
];
const isFooterText = (text: string): boolean =>
  PDF_FOOTER_PATTERNS.some((pattern) => pattern.test(text));

/** One text-bearing content stream per page, in page order. */
const extractPdfPageTextStreams = (pdf: Buffer): string[] => {
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
      const text = inflateSync(pdf.subarray(contentStart, endOffset)).toString("latin1");
      const printable = [...text].filter((char) => {
        const code = char.charCodeAt(0);
        return code === 9 || code === 10 || code === 13 || (code >= 32 && code < 127);
      }).length / text.length;
      // Invoice page content is the only highly printable stream with text ops.
      if (printable > 0.9 && text.includes("BT")) parts.push(text);
    } catch {
      // Non-flate streams (images/fonts) do not carry page text.
    }
    offset = endOffset + endMarker.length;
  }
  return parts;
};

/** Text baselines measured from the PDF bottom edge (the native `Tm` y). */
const extractTextPositions = (pageStream: string): Array<{ yFromBottom: number; text: string }> =>
  [...pageStream.matchAll(/1 0 0 1 ([\d.]+) ([\d.]+) Tm([\s\S]*?)ET/g)].map((match) => ({
    yFromBottom: Number(match[2]),
    text: concatenatePdfHexText(match[3]),
  }));

describe("customer invoice pre-discount display", () => {
  it("scales lines so full prices minus the discount lines equal the charged net", () => {
    const lines = [
      { description: "Service", amount: 273.79, unitPrice: 10.95 },
      { description: "Option", amount: 54.76 },
    ];
    const scaled = scaleLineItemsToTotal(lines, 335.26);
    expect(scaled.reduce((sum, line) => sum + line.amount, 0)).toBeCloseTo(335.26, 2);
    expect(scaled[0].unitPrice).toBeCloseTo(10.95 * (335.26 / 328.55), 2);
    expect(scaled[1]).toMatchObject({ description: "Option" });
  });

  it("keeps lines untouched without a discount and never invents lines", () => {
    const lines = [{ description: "Service", amount: 100 }];
    expect(scaleLineItemsToTotal(lines, 100)).toEqual(lines);
    expect(scaleLineItemsToTotal([], 100)).toEqual([]);
  });

  it("builds a one-line service address from the booking location", () => {
    expect(formatInvoiceServiceAddress({
      location: { address: "Rue de la Loi 1", postalCode: "1000", city: "Brussels", country: "BE" },
    } as any)).toBe("Rue de la Loi 1, 1000 Brussels, BE");
  });

  it("falls back to the customer address for legacy bookings without a service location", () => {
    expect(formatInvoiceServiceAddress({
      customer: { companyAddress: { address: "Main Street 2", postalCode: "2000", city: "Antwerp", country: "BE" } },
    } as any)).toBe("Main Street 2, 2000 Antwerp, BE");
    expect(formatInvoiceServiceAddress({ customer: {} } as any)).toBeUndefined();
  });
});

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
    expect(encodedText).toContain(Buffer.from("VAT (Reverse charge)").toString("latin1"));
    expect(encodedText).toContain(Buffer.from("Page 1 of 1").toString("latin1"));
  });

  it("renders line-item quantity units in the Qty column", async () => {
    const pdf = await generateInvoicePDF({
      invoiceNumber: "FIX-2026-000002",
      invoiceDate: new Date("2026-08-20T00:00:00.000Z"),
      bookingNumber: "BK-3",
      customer: { name: "Customer", email: "customer@example.com", country: "BE" },
      professional: { name: "Professional", country: "BE" },
      payment: { netAmount: 100, vatAmount: 21, vatRate: 21, totalWithVat: 121, currency: "EUR" },
      serviceDescription: "Service",
      lineItems: [{ description: "Plastering", amount: 100, vatRate: 21, quantity: 50, unitPrice: 2, unit: "m²" }],
    });

    const encodedText = concatenatePdfHexText(extractPdfStreamText(pdf));
    expect(encodedText).toContain(Buffer.from("50 m").toString("latin1"));
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

  it("keeps flowing content out of the reserved footer band on every page", async () => {
    const longDescription = Array.from(
      { length: 60 },
      (_, index) => `Scope line ${index + 1}: detailed description of the work.`,
    ).join("\n");
    const pdf = await generateInvoicePDF({
      invoiceNumber: "FIX-2026-000003",
      invoiceDate: new Date("2026-08-20T00:00:00.000Z"),
      bookingNumber: "BK-LONG",
      customer: { name: "Customer", email: "customer@example.com", country: "BE" },
      professional: { name: "Professional", country: "BE" },
      payment: { netAmount: 100, vatAmount: 21, vatRate: 21, totalWithVat: 121, currency: "EUR" },
      serviceDescription: longDescription,
      lineItems: [{ description: "Service", amount: 100, vatRate: 21, quantity: 2, unitPrice: 50 }],
    });

    const encodedText = concatenatePdfHexText(extractPdfStreamText(pdf));
    expect(encodedText).toContain(Buffer.from("Page 1 of 2").toString("latin1"));
    expect(encodedText).toContain(Buffer.from("Page 2 of 2").toString("latin1"));

    const pages = extractPdfPageTextStreams(pdf).map(extractTextPositions);
    expect(pages).toHaveLength(2);

    for (const items of pages) {
      // Footer/page number is present on each page, inside the reserved band.
      const pageNumber = items.find((item) => /^Page \d+ of \d+$/.test(item.text));
      expect(pageNumber).toBeDefined();
      expect(pageNumber!.yFromBottom).toBeLessThanOrEqual(PDF_FOOTER_BAND_TOP_FROM_BOTTOM);

      // No description/table content may extend into the footer band.
      const contentItems = items.filter((item) => item.text && !isFooterText(item.text));
      expect(contentItems.length).toBeGreaterThan(0);
      for (const item of contentItems) {
        expect(item.yFromBottom).toBeGreaterThanOrEqual(PDF_FOOTER_BAND_TOP_FROM_BOTTOM);
      }
    }

    // The description actually flowed onto page 2 instead of being clipped.
    expect(pages[1].some((item) => /^Scope line \d+:/.test(item.text))).toBe(true);
  });

  it("keeps a short invoice on a single page", async () => {
    const pdf = await generateInvoicePDF({
      invoiceNumber: "FIX-2026-000004",
      invoiceDate: new Date("2026-08-20T00:00:00.000Z"),
      bookingNumber: "BK-SHORT",
      customer: { name: "Customer", email: "customer@example.com", country: "BE" },
      professional: { name: "Professional", country: "BE" },
      payment: { netAmount: 100, vatAmount: 21, vatRate: 21, totalWithVat: 121, currency: "EUR" },
      serviceDescription: "Short service",
      lineItems: [{ description: "Service", amount: 100, vatRate: 21, quantity: 1, unitPrice: 100 }],
    });

    const encodedText = concatenatePdfHexText(extractPdfStreamText(pdf));
    expect(encodedText).toContain(Buffer.from("Page 1 of 1").toString("latin1"));
    expect(encodedText).not.toContain(Buffer.from("Page 2 of").toString("latin1"));
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
