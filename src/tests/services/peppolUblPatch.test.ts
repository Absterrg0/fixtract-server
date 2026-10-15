import { describe, expect, it, vi } from "vitest";

vi.mock("../../services/odooAccounting", () => ({ odooJson2Call: vi.fn(), discoverOdooAccountingConfig: vi.fn() }));
vi.mock("../../models/platformSettings", () => ({ default: { getCurrentConfig: vi.fn() } }));
import { embedPdfInUbl, markUblAsPrepaid, setUblInvoiceNumber } from "../../services/peppolDispatch";

// Shape of the BIS 3 invoice Odoo 19 generates.
const odooUbl = `<?xml version='1.0' encoding='UTF-8'?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:ID>PID7750-2026-10</cbc:ID>
  <cac:OrderReference><cbc:ID>FIX-2026-000015</cbc:ID></cac:OrderReference>
  <cac:AccountingSupplierParty><cac:Party/></cac:AccountingSupplierParty>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="EUR">651.29</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="EUR">651.29</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="EUR">690.37</cbc:TaxInclusiveAmount>
    <cbc:PrepaidAmount currencyID="EUR">0.00</cbc:PrepaidAmount>
    <cbc:PayableAmount currencyID="EUR">690.37</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
</Invoice>`;

describe("Odoo UBL patching", () => {
  it("keeps the Fixtract invoice number as the UBL document ID", () => {
    const xml = setUblInvoiceNumber(odooUbl, "FIX-2026-000015");
    expect(xml).toContain("<cbc:ID>FIX-2026-000015</cbc:ID>");
    expect(xml).not.toContain("<cbc:ID>PID7750-2026-10</cbc:ID>");
    expect(xml).toContain("<cac:OrderReference><cbc:ID>FIX-2026-000015</cbc:ID></cac:OrderReference>");
  });

  it("states a paid invoice as fully prepaid", () => {
    const xml = markUblAsPrepaid(odooUbl);
    expect(xml).toContain('<cbc:PrepaidAmount currencyID="EUR">690.37</cbc:PrepaidAmount>');
    expect(xml).toContain('<cbc:PayableAmount currencyID="EUR">0.00</cbc:PayableAmount>');
    expect(xml).toContain('<cbc:TaxInclusiveAmount currencyID="EUR">690.37</cbc:TaxInclusiveAmount>');
  });

  it("adds a missing PrepaidAmount before the payable amounts and counts rounding", () => {
    const withoutPrepaid = odooUbl
      .replace(/\s*<cbc:PrepaidAmount[^\n]*/, "")
      .replace("<cbc:PayableAmount", '<cbc:PayableRoundingAmount currencyID="EUR">0.03</cbc:PayableRoundingAmount><cbc:PayableAmount');
    const xml = markUblAsPrepaid(withoutPrepaid);
    expect(xml).toMatch(/<cbc:PrepaidAmount currencyID="EUR">690\.40<\/cbc:PrepaidAmount><cbc:PayableRoundingAmount/);
    expect(xml).toContain('<cbc:PayableAmount currencyID="EUR">0.00</cbc:PayableAmount>');
  });

  it("embeds the Fixtract PDF once, before the supplier party", () => {
    const pdf = Buffer.from("%PDF-1.4 fixtract");
    const xml = embedPdfInUbl(odooUbl, "FIX-2026-000015.pdf", pdf);
    const reference = xml.indexOf("<cac:AdditionalDocumentReference>");
    expect(reference).toBeGreaterThan(xml.indexOf("</cac:OrderReference>"));
    expect(reference).toBeLessThan(xml.indexOf("<cac:AccountingSupplierParty>"));
    expect(xml).toContain(`<cbc:EmbeddedDocumentBinaryObject mimeCode="application/pdf" filename="FIX-2026-000015.pdf">${pdf.toString("base64")}</cbc:EmbeddedDocumentBinaryObject>`);
    expect(embedPdfInUbl(xml, "FIX-2026-000015.pdf", pdf)).toBe(xml);
  });

  it("replaces an Odoo PDF already embedded in the UBL with the Fixtract PDF", () => {
    const oldPdf = Buffer.from("Odoo invoice template");
    const fixtractPdf = Buffer.from("Fixtract invoice template");
    const xmlWithOdooPdf = odooUbl.replace(
      "<cac:AccountingSupplierParty>",
      `<cac:AdditionalDocumentReference><cbc:ID>odoo.pdf</cbc:ID><cac:Attachment><cbc:EmbeddedDocumentBinaryObject mimeCode="application/pdf" filename="odoo.pdf">${oldPdf.toString("base64")}</cbc:EmbeddedDocumentBinaryObject></cac:Attachment></cac:AdditionalDocumentReference><cac:AccountingSupplierParty>`,
    );

    const xml = embedPdfInUbl(xmlWithOdooPdf, "FIX-2026-000015.pdf", fixtractPdf);

    expect(xml).toContain(`filename="FIX-2026-000015.pdf">${fixtractPdf.toString("base64")}</cbc:EmbeddedDocumentBinaryObject>`);
    expect(xml).not.toContain(oldPdf.toString("base64"));
  });
});
