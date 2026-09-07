import { describe, expect, it } from "vitest";
import { filterInvoiceFieldsByRole } from "../../utils/invoiceVisibility";

const payment = {
  invoiceNumber: "FIX-2026-000001",
  invoiceUrl: "https://example/FIX.pdf",
  creditNoteNumber: "CN-FIX-1",
  supplierInvoiceNumber: "SUP-2026-000001",
  supplierInvoiceUrl: "https://example/SUP.pdf",
  supplierCreditNoteNumber: "CN-SUP-1",
  invoiceArtifactHistory: [
    { side: "customer", invoiceNumber: "FIX-OLD", invoiceUrl: "https://example/FIX-old.pdf" },
    { side: "supplier", invoiceNumber: "SUP-OLD", invoiceUrl: "https://example/SUP-old.pdf" },
  ],
};

describe("invoice visibility", () => {
  it("hides customer identifiers as well as URLs from professionals", () => {
    const result = filterInvoiceFieldsByRole({ payment: { ...payment } }, "professional");
    expect(result.payment.invoiceNumber).toBeUndefined();
    expect(result.payment.creditNoteNumber).toBeUndefined();
    expect(result.payment.supplierInvoiceNumber).toBe("SUP-2026-000001");
    expect(result.payment.invoiceArtifactHistory).toEqual([
      expect.objectContaining({ side: "supplier", invoiceNumber: "SUP-OLD" }),
    ]);
  });

  it("hides supplier identifiers as well as URLs from customers", () => {
    const result = filterInvoiceFieldsByRole({ payment: { ...payment } }, "customer");
    expect(result.payment.invoiceNumber).toBe("FIX-2026-000001");
    expect(result.payment.supplierInvoiceNumber).toBeUndefined();
    expect(result.payment.supplierCreditNoteNumber).toBeUndefined();
    expect(result.payment.invoiceArtifactHistory).toEqual([
      expect.objectContaining({ side: "customer", invoiceNumber: "FIX-OLD" }),
    ]);
  });
});
