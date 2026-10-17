import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ call: vi.fn(), discover: vi.fn(), settings: vi.fn() }));
vi.mock("../../services/odooAccounting", () => ({
  odooJson2Call: mocks.call,
  discoverOdooAccountingConfig: mocks.discover,
}));
vi.mock("../../models/platformSettings", () => ({ default: { getCurrentConfig: mocks.settings } }));
vi.mock("../../models/serviceConfiguration", () => ({
  default: { find: () => ({ select: () => ({ lean: async () => [] }) }) },
}));
import { maybeDispatchPeppolInvoice } from "../../services/peppolDispatch";

const config = {
  companyId: 1, incomeAccountId: 10, expenseAccountId: 20,
  salesJournalId: 30, selfBillingJournalId: 40,
  taxIdsByRate: { "21": 51, "6": 52 }, reverseChargeTaxId: 53,
  purchaseTaxIdsByRate: { "21": 61, "6": 62 }, purchaseReverseChargeTaxId: 63,
};
const booking = {
  customer: { customerType: "business", vatNumber: "BE1002103337", companyAddress: { country: "BE" } },
  professional: { businessInfo: { vatNumber: "BE1002103337", country: "BE" } },
};
const dispatch = (side: "supplier" | "customer", documentType: "invoice" | "credit_note" = "invoice") =>
  maybeDispatchPeppolInvoice({
    booking, side, documentType, invoiceNumber: "TEST-1", ublXml: "<Invoice/>", invoiceUblUrl: "",
    lineItems: [{ description: "Service", price: 100, vatRate: 21 }],
  });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.discover.mockResolvedValue({ ...config });
  mocks.settings.mockResolvedValue({ eInvoicing: { peppolEnabled: true, provider: "odoo" } });
  mocks.call.mockImplementation(async (_config, model, method) => {
    switch (`${model}.${method}`) {
      case "account.move.search_read": return [];
      case "res.partner.search_read": return [{ id: 60 }];
      case "account.move.create": return 70;
      // Totals Odoo computed for the 100.00 excl. VAT test invoice.
      case "account.move.read": return [{ amount_untaxed: 100, amount_total: 121 }];
      case "ir.attachment.search_read": return [{ id: 80 }];
      case "account.move.action_post": return true;
      case "account.move.button_process_edi_web_services": return true;
      case "account.edi.document.search_read": return [{ state: "sent" }];
      default: throw new Error(`Unexpected call ${model}.${method}`);
    }
  });
});

describe("Peppol Odoo dispatch", () => {
  it.each(["invoice", "credit_note"] as const)("creates supplier %s in the self-billing purchase journal", async (documentType) => {
    const result = await dispatch("supplier", documentType);
    expect(result.status).toBe("sent");
    const create = mocks.call.mock.calls.find((call) => call[1] === "account.move" && call[2] === "create");
    expect(create?.[3].vals_list).toMatchObject({
      move_type: documentType === "invoice" ? "in_invoice" : "in_refund", journal_id: 40,
      invoice_line_ids: [[0, 0, expect.objectContaining({ account_id: 20, tax_ids: [[6, 0, [61]]] })]],
    });
  });
  it("keeps customer invoices in the sales journal", async () => {
    expect((await dispatch("customer")).status).toBe("sent");
    const create = mocks.call.mock.calls.find((call) => call[1] === "account.move" && call[2] === "create");
    expect(create?.[3].vals_list).toMatchObject({ move_type: "out_invoice", journal_id: 30 });
  });
  it("fails before creating records when the self-billing journal is missing", async () => {
    mocks.discover.mockResolvedValue({ ...config, selfBillingJournalId: undefined });
    const result = await dispatch("supplier");
    expect(result).toMatchObject({ status: "failed", attempts: 0 });
    expect(result.reason).toMatch(/self.billing.*journal/i);
    expect(mocks.call).not.toHaveBeenCalled();
  });
  it("sends a domestic invoice even when the chart has no reverse-charge tax", async () => {
    mocks.discover.mockResolvedValue({ ...config, reverseChargeTaxId: undefined });
    expect(await dispatch("customer")).toMatchObject({ status: "sent" });
  });

  it("fails before creating records when the chart lacks the invoice VAT rate", async () => {
    mocks.discover.mockResolvedValue({ ...config, taxIdsByRate: { "6": 52 } });
    const result = await dispatch("customer");
    expect(result).toMatchObject({ status: "failed", attempts: 0 });
    expect(result.reason).toMatch(/21/);
    expect(mocks.call).not.toHaveBeenCalled();
  });

  it("reports send rejection as failed with the actual Odoo error", async () => {
    const normal = mocks.call.getMockImplementation()!;
    mocks.call.mockImplementation(async (...args) => {
      if (args[2] === "button_process_edi_web_services") throw new Error("Recipient is not registered on Peppol");
      return normal(...args);
    });
    expect(await dispatch("supplier")).toMatchObject({ status: "failed", reason: "Recipient is not registered on Peppol" });
  });

  it.each([["sent", "sent"], ["processing", "queued"]])("refreshes an existing %s move without sending it again", async (state, status) => {
    const normal = mocks.call.getMockImplementation()!;
    mocks.call.mockImplementation(async (...args) => {
      if (args[1] === "account.move" && args[2] === "search_read") return [{ id: 70, state: "posted" }];
      if (args[1] === "account.edi.document") return [{ state }];
      return normal(...args);
    });
    expect(await dispatch("supplier")).toMatchObject({ status });
    expect(mocks.call.mock.calls.some((call) => call[2] === "button_process_edi_web_services")).toBe(false);
    expect(mocks.call.mock.calls.some((call) => call[2] === "create")).toBe(false);
  });

  describe("slow Odoo answers", () => {
    const timeoutError = (call: string) =>
      Object.assign(new Error(`Odoo did not answer ${call} within 120s`), { name: "OdooTimeoutError" });

    it.each([
      [[], "queued", /did not answer account\.move\.button_process_edi_web_services.*still processing/],
      [[{ state: "sent" }], "sent", /confirms/],
      [[{ state: "error", error_message: "<p>Peppol Error [code=303]</p>" }], "failed", /^Peppol Error \[code=303\]$/],
    ])("reports the move's Peppol state when the send times out (%j)", async (documents, status, reason) => {
      const normal = mocks.call.getMockImplementation()!;
      mocks.call.mockImplementation(async (...args) => {
        if (args[2] === "button_process_edi_web_services") throw timeoutError("account.move.button_process_edi_web_services");
        if (args[1] === "account.edi.document") return documents;
        return normal(...args);
      });
      const result = await dispatch("customer");
      expect(result.status).toBe(status);
      expect(result.reason).toMatch(reason);
    });

    it("reuses the partner Odoo created after a slow (VIES) create timed out", async () => {
      let searches = 0;
      const normal = mocks.call.getMockImplementation()!;
      mocks.call.mockImplementation(async (...args) => {
        if (args[1] === "res.partner" && args[2] === "search_read") return searches++ === 0 ? [] : [{ id: 61 }];
        if (args[1] === "res.country") return [{ id: 20 }];
        if (args[1] === "res.partner" && args[2] === "create") throw timeoutError("res.partner.create");
        return normal(...args);
      });
      expect(await dispatch("customer")).toMatchObject({ status: "sent" });
      const create = mocks.call.mock.calls.find((call) => call[1] === "account.move" && call[2] === "create");
      expect(create?.[3].vals_list).toMatchObject({ partner_id: 61 });
    });

    it("posts and sends the draft Odoo created after account.move.create timed out", async () => {
      let moveSearches = 0;
      const normal = mocks.call.getMockImplementation()!;
      mocks.call.mockImplementation(async (...args) => {
        if (args[1] === "account.move" && args[2] === "search_read") {
          return moveSearches++ === 0 ? [] : [{ id: 71, name: "TEST-1", state: "draft" }];
        }
        if (args[1] === "account.move" && args[2] === "create") throw timeoutError("account.move.create");
        return normal(...args);
      });
      expect(await dispatch("customer")).toMatchObject({ status: "sent" });
      const moveCalls = mocks.call.mock.calls.filter((call) => call[1] === "account.move");
      expect(moveCalls.filter((call) => call[2] === "create")).toHaveLength(1);
      expect(moveCalls.find((call) => call[2] === "action_post")?.[3]).toMatchObject({ ids: [71] });
      expect(moveCalls.find((call) => call[2] === "button_process_edi_web_services")?.[3]).toMatchObject({ ids: [71] });
    });

    it("continues when action_post timed out but Odoo posted the move", async () => {
      const normal = mocks.call.getMockImplementation()!;
      mocks.call.mockImplementation(async (...args) => {
        if (args[2] === "action_post") throw timeoutError("account.move.action_post");
        if (args[1] === "account.move" && args[2] === "read") return [{ state: "posted", amount_untaxed: 100 }];
        return normal(...args);
      });
      expect(await dispatch("customer")).toMatchObject({ status: "sent" });
      expect(mocks.call.mock.calls.filter((call) => call[2] === "action_post")).toHaveLength(1);
    });

    it("fails when action_post timed out and the move is still draft", async () => {
      const normal = mocks.call.getMockImplementation()!;
      mocks.call.mockImplementation(async (...args) => {
        if (args[2] === "action_post") throw timeoutError("account.move.action_post");
        if (args[1] === "account.move" && args[2] === "read") return [{ state: "draft", amount_untaxed: 100 }];
        return normal(...args);
      });
      expect(await dispatch("customer")).toMatchObject({ status: "failed", reason: expect.stringMatching(/action_post/) });
      expect(mocks.call.mock.calls.some((call) => call[2] === "button_process_edi_web_services")).toBe(false);
    });
  });

  describe("platform invoice in Odoo", () => {
    const callsOf = (model: string, method: string) =>
      mocks.call.mock.calls.filter((call) => call[1] === model && call[2] === method);

    it("books the move under the platform number and date with amounts that match the invoice", async () => {
      const normal = mocks.call.getMockImplementation()!;
      mocks.call.mockImplementation(async (...args) => {
        if (args[1] === "account.move" && args[2] === "read") return [{ amount_untaxed: 559.88, amount_total: 593.47 }];
        return normal(...args);
      });
      const result = await maybeDispatchPeppolInvoice({
        booking, side: "customer", invoiceNumber: "FIX-2026-000015", ublXml: "<Invoice/>", invoiceUblUrl: "",
        issueDate: new Date("2026-10-13T09:00:00Z"), totalWithVat: 593.47,
        lineItems: [
          { description: "Paint per m²", price: 477.74, vatRate: 6, quantity: 30, unitPrice: 15 },
          { description: "Extra cost: 5 m² more", price: 82.14, vatRate: 6, quantity: 5, unitPrice: 16.427727 },
        ],
      });
      expect(result.status).toBe("sent");
      const vals = callsOf("account.move", "create")[0][3].vals_list;
      expect(vals).toMatchObject({ name: "FIX-2026-000015", ref: "FIX-2026-000015", invoice_date: "2026-10-13" });
      expect(vals.narration).toBeUndefined();
      const lines = vals.invoice_line_ids.map((line: any) => line[2]);
      expect(lines[0]).toMatchObject({ quantity: 30 });
      expect(lines[0].price_unit).toBeCloseTo(15.924667, 6);
      expect(lines[1]).toMatchObject({ quantity: 5 });
      expect(Math.round(lines[1].quantity * lines[1].price_unit * 100) / 100).toBe(82.14);
    });

    it("keeps the negative quantity of an adjustment for fewer units, like the PDF does", async () => {
      const normal = mocks.call.getMockImplementation()!;
      mocks.call.mockImplementation(async (...args) => {
        if (args[1] === "account.move" && args[2] === "read") return [{ amount_untaxed: 436.67, amount_total: 462.87 }];
        return normal(...args);
      });
      const result = await maybeDispatchPeppolInvoice({
        booking, side: "customer", invoiceNumber: "FIX-2026-000016", ublXml: "<Invoice/>", invoiceUblUrl: "",
        issueDate: new Date("2026-10-13T09:00:00Z"), totalWithVat: 462.87,
        lineItems: [
          { description: "Paint per m²", price: 477.74, vatRate: 6, quantity: 30, unitPrice: 15 },
          { description: "Extra cost: 2.5 m² fewer", price: -41.07, vatRate: 6, quantity: -2.5, unitPrice: 16.427727 },
        ],
      });
      expect(result.status).toBe("sent");
      const vals = callsOf("account.move", "create")[0][3].vals_list;
      const lines = vals.invoice_line_ids.map((line: any) => line[2]);
      expect(lines[1].quantity).toBe(-2.5);
      expect(lines[1].price_unit).toBeCloseTo(16.427727, 6);
      expect(Math.round(lines[1].quantity * lines[1].price_unit * 100) / 100).toBe(-41.07);
    });

    it("keeps a discount line negative on a credit note", async () => {
      const normal = mocks.call.getMockImplementation()!;
      mocks.call.mockImplementation(async (...args) => {
        if (args[1] === "account.move" && args[2] === "read") return [{ amount_untaxed: 90, amount_total: 108.9 }];
        return normal(...args);
      });
      const result = await maybeDispatchPeppolInvoice({
        booking, side: "customer", documentType: "credit_note", invoiceNumber: "FIX-CN-2026-000003", ublXml: "<CreditNote/>",
        invoiceUblUrl: "", totalWithVat: 108.9,
        lineItems: [
          { description: "Paint per m²", price: 100, vatRate: 21 },
          { description: "Loyalty discount", price: -10, vatRate: 21 },
        ],
      });
      expect(result.status).toBe("sent");
      const vals = callsOf("account.move", "create")[0][3].vals_list;
      expect(vals.move_type).toBe("out_refund");
      expect(vals.invoice_line_ids.map((line: any) => line[2].price_unit)).toEqual([100, -10]);
    });

    it("removes the draft and reports the difference when Odoo totals differ from the invoice", async () => {
      const normal = mocks.call.getMockImplementation()!;
      mocks.call.mockImplementation(async (...args) => {
        if (args[1] === "account.move" && args[2] === "read") return [{ amount_untaxed: 1116.38, amount_total: 1183.36 }];
        if (args[1] === "account.move" && args[2] === "unlink") return true;
        return normal(...args);
      });
      const result = await dispatch("customer");
      expect(result.status).toBe("failed");
      expect(result.reason).toMatch(/Odoo computed 1116\.38 excl\. VAT.*Fixtract invoice is 100\.00/);
      expect(callsOf("account.move", "unlink")[0][3]).toEqual({ ids: [70] });
      expect(callsOf("account.move", "action_post")).toHaveLength(0);
    });

    it("rebuilds an earlier draft whose totals Odoo does not return instead of posting it", async () => {
      const normal = mocks.call.getMockImplementation()!;
      mocks.call.mockImplementation(async (...args) => {
        if (args[1] === "account.move" && args[2] === "search_read") return [{ id: 69, name: "TEST-1", state: "draft" }];
        if (args[1] === "account.move" && args[2] === "read") {
          return args[3].ids[0] === 69 ? [{}] : [{ amount_untaxed: 100, amount_total: 121 }];
        }
        if (args[1] === "account.move" && args[2] === "unlink") return true;
        return normal(...args);
      });
      expect(await dispatch("customer")).toMatchObject({ status: "sent" });
      expect(callsOf("account.move", "unlink")[0][3]).toEqual({ ids: [69] });
      expect(callsOf("account.move", "create")).toHaveLength(1);
      expect(callsOf("account.move", "action_post")[0][3]).toMatchObject({ ids: [70] });
    });

    it("keeps the Odoo number when the draft rename is refused", async () => {
      const normal = mocks.call.getMockImplementation()!;
      mocks.call.mockImplementation(async (...args) => {
        if (args[1] === "account.move" && args[2] === "search_read") return [{ id: 69, name: "INV/2026/00001", state: "draft" }];
        if (args[1] === "account.move" && args[2] === "write") throw new Error("You are not allowed to modify 'Invoice Number'.");
        return normal(...args);
      });
      expect(await dispatch("customer")).toMatchObject({ status: "sent" });
      expect(callsOf("account.move", "write")[0][3]).toEqual({ ids: [69], vals: { name: "TEST-1", invoice_date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) } });
      expect(callsOf("account.move", "create")).toHaveLength(0);
      expect(callsOf("account.move", "action_post")[0][3]).toMatchObject({ ids: [69] });
    });

    it("puts the invoice date on a reused draft that carries another date", async () => {
      const normal = mocks.call.getMockImplementation()!;
      mocks.call.mockImplementation(async (...args) => {
        if (args[1] === "account.move" && args[2] === "search_read") return [{ id: 69, name: "TEST-1", state: "draft", invoice_date: "2026-01-05" }];
        if (args[1] === "account.move" && args[2] === "write") return true;
        return normal(...args);
      });
      const result = await maybeDispatchPeppolInvoice({
        booking, side: "customer", invoiceNumber: "TEST-1", ublXml: "<Invoice/>", invoiceUblUrl: "",
        issueDate: new Date("2026-10-13T09:00:00Z"),
        lineItems: [{ description: "Service", price: 100, vatRate: 21 }],
      });
      expect(result).toMatchObject({ status: "sent" });
      expect(callsOf("account.move", "write")[0][3]).toEqual({ ids: [69], vals: { invoice_date: "2026-10-13" } });
      expect(callsOf("account.move", "create")).toHaveLength(0);
      expect(callsOf("account.move", "action_post")[0][3]).toMatchObject({ ids: [69] });
    });

    it("fails with the draft to fix when Odoo refuses to delete it", async () => {
      const normal = mocks.call.getMockImplementation()!;
      mocks.call.mockImplementation(async (...args) => {
        if (args[1] === "account.move" && args[2] === "search_read") return [{ id: 69, name: "TEST-1", state: "draft" }];
        if (args[1] === "account.move" && args[2] === "read") return [{ amount_untaxed: 1116.38, amount_total: 1183.36 }];
        if (args[1] === "account.move" && args[2] === "unlink") throw new Error("You cannot delete an entry which has been posted once.");
        return normal(...args);
      });
      const result = await dispatch("customer");
      expect(result).toMatchObject({ status: "failed" });
      expect(result.reason).toMatch(/Odoo computed 1116\.38 excl\. VAT/);
      expect(result.reason).toMatch(/refused to delete that draft.*draft 69/s);
      expect(callsOf("account.move", "create")).toHaveLength(0);
      expect(callsOf("account.move", "action_post")).toHaveLength(0);
    });

    it("fails without posting when Odoo does not return the totals of a new move", async () => {
      const normal = mocks.call.getMockImplementation()!;
      mocks.call.mockImplementation(async (...args) => {
        if (args[1] === "account.move" && args[2] === "read") return [{}];
        if (args[1] === "account.move" && args[2] === "unlink") return true;
        return normal(...args);
      });
      const result = await dispatch("customer");
      expect(result).toMatchObject({ status: "failed", reason: expect.stringMatching(/could not be checked/) });
      expect(callsOf("account.move", "action_post")).toHaveLength(0);
    });

    it("posts under the Odoo sequence when Odoo refuses the platform number at posting", async () => {
      let posts = 0;
      const normal = mocks.call.getMockImplementation()!;
      mocks.call.mockImplementation(async (...args) => {
        if (args[1] === "account.move" && args[2] === "action_post" && posts++ === 0) {
          throw new Error("The Date (13-10-2026) you've entered isn't aligned with the existing sequence number (TEST-1). Clear the sequence number to proceed.");
        }
        if (args[1] === "account.move" && args[2] === "write") return true;
        return normal(...args);
      });
      expect(await dispatch("customer")).toMatchObject({ status: "sent" });
      expect(callsOf("account.move", "action_post")).toHaveLength(2);
      expect(callsOf("account.move", "action_post")[0][3]).toMatchObject({ ids: [70], context: { lang: "en_US" } });
      expect(callsOf("account.move", "write")[0][3]).toEqual({ ids: [70], vals: { name: false } });
      expect(callsOf("account.move", "create")).toHaveLength(1);
    });

    it("reports other create errors without creating a second move", async () => {
      const normal = mocks.call.getMockImplementation()!;
      mocks.call.mockImplementation(async (...args) => {
        if (args[1] === "account.move" && args[2] === "create") throw new Error("Invalid tax on line 1");
        return normal(...args);
      });
      expect(await dispatch("customer")).toMatchObject({ status: "failed", reason: expect.stringMatching(/Invalid tax/) });
      expect(callsOf("account.move", "create")).toHaveLength(1);
      expect(callsOf("account.move", "action_post")).toHaveLength(0);
    });

    it("does not retry a post that Odoo refused for another reason", async () => {
      const normal = mocks.call.getMockImplementation()!;
      mocks.call.mockImplementation(async (...args) => {
        if (args[1] === "account.move" && args[2] === "action_post") throw new Error("You need to add a line before posting.");
        if (args[1] === "account.move" && args[2] === "read" && args[3].fields?.includes("state")) return [{ state: "draft" }];
        return normal(...args);
      });
      expect(await dispatch("customer")).toMatchObject({ status: "failed", reason: expect.stringMatching(/add a line/) });
      expect(callsOf("account.move", "action_post")).toHaveLength(1);
      expect(callsOf("account.move", "write")).toHaveLength(0);
    });

    it("fails before creating anything when the Odoo company cannot send on Peppol", async () => {
      const normal = mocks.call.getMockImplementation()!;
      mocks.call.mockImplementation(async (...args) => {
        if (args[1] === "res.company" && args[2] === "read") return [{ name: "Fixtract", peppol_can_send: false }];
        return normal(...args);
      });
      const result = await dispatch("customer");
      expect(result).toMatchObject({ status: "failed", attempts: 0 });
      expect(result.reason).toMatch(/"Fixtract" \(id 1\) is not registered to send on Peppol/);
      expect(callsOf("account.move", "create")).toHaveLength(0);
    });

    it("uses the Odoo company chosen in the e-invoicing settings", async () => {
      mocks.settings.mockResolvedValue({ eInvoicing: { peppolEnabled: true, provider: "odoo", odooCompanyId: 2 } });
      await dispatch("customer");
      expect(mocks.discover).toHaveBeenCalledWith({ companyId: 2 });
    });

    it("sends the Fixtract PDF and a prepaid UBL through the Odoo 17+ wizard", async () => {
      const pdf = Buffer.from("%PDF-1.4 fixtract");
      const odooXml = '<Invoice xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"><cbc:ID>PID7750-2026-10</cbc:ID><cac:AccountingSupplierParty/><cac:LegalMonetaryTotal><cbc:TaxInclusiveAmount currencyID="EUR">121.00</cbc:TaxInclusiveAmount><cbc:PrepaidAmount currencyID="EUR">0.00</cbc:PrepaidAmount><cbc:PayableAmount currencyID="EUR">121.00</cbc:PayableAmount></cac:LegalMonetaryTotal></Invoice>';
      const move: any = {
        ubl_cii_xml_id: false, invoice_pdf_report_id: false, peppol_is_sent: false,
        commercial_partner_id: [60, "Customer"], amount_untaxed: 100, amount_total: 121,
      };
      let storedXml = "";
      const normal = mocks.call.getMockImplementation()!;
      mocks.call.mockImplementation(async (...args) => {
        const [, model, method, body] = args;
        const key = `${model}.${method}`;
        if (key === "account.move.button_process_edi_web_services") throw new Error("The method 'button_process_edi_web_services' does not exist");
        if (key === "account.move.read") return [{ ...move }];
        if (key === "res.partner.read") {
          return [{ peppol_eas: "0208", peppol_endpoint: "1002103337", peppol_verification_state: "valid", invoice_edi_format: "ubl_bis3" }];
        }
        if (key === "account.move.send.wizard.create") return 90;
        if (key === "account.move.send.wizard.action_send_and_print") {
          if (!move.ubl_cii_xml_id) {
            move.ubl_cii_xml_id = [95, "FIX_ubl_bis3.xml"];
            storedXml = odooXml;
          }
          return true;
        }
        if (key === "account.move.send.wizard.unlink") return true;
        if (key === "ir.attachment.create") return 91;
        if (key === "ir.attachment.read") return [{ datas: Buffer.from(storedXml).toString("base64") }];
        if (key === "ir.attachment.write") {
          storedXml = Buffer.from(body.vals.datas, "base64").toString("utf8");
          return true;
        }
        if (model === "account.edi.document") throw new Error("Model account.edi.document does not exist");
        return normal(...args);
      });
      const result = await maybeDispatchPeppolInvoice({
        booking: { ...booking, payment: { status: "completed" } }, side: "customer", invoiceNumber: "FIX-2026-000016",
        ublXml: "<Invoice/>", invoiceUblUrl: "", invoicePdf: pdf,
        lineItems: [{ description: "Service", price: 100, vatRate: 21 }],
      });
      expect(result.status, result.reason).toBe("queued");
      const pdfAttachment = callsOf("ir.attachment", "create").find((call) => call[3].vals_list.res_field);
      expect(pdfAttachment?.[3].vals_list).toMatchObject({
        name: "FIX-2026-000016.pdf", res_field: "invoice_pdf_report_file", res_id: 70, datas: pdf.toString("base64"),
      });
      const wizards = callsOf("account.move.send.wizard", "create").map((call) => call[3].vals_list[0].sending_methods);
      expect(wizards).toEqual([["manual"], ["peppol"]]);
      expect(storedXml).toContain('<cbc:PayableAmount currencyID="EUR">0.00</cbc:PayableAmount>');
      expect(storedXml).toContain('<cbc:PrepaidAmount currencyID="EUR">121.00</cbc:PrepaidAmount>');
      expect(storedXml).toContain("<cbc:ID>FIX-2026-000016</cbc:ID>");
      expect(storedXml).toContain('filename="FIX-2026-000016.pdf"');
    });

    it("replaces an earlier Odoo PDF on the move with the Fixtract PDF", async () => {
      const pdf = Buffer.from("Fixtract invoice PDF");
      const oldPdf = Buffer.from("Odoo invoice PDF");
      const odooXml = '<Invoice xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"><cbc:ID>PID7750-2026-10</cbc:ID><cac:AdditionalDocumentReference><cbc:ID>odoo.pdf</cbc:ID><cac:Attachment><cbc:EmbeddedDocumentBinaryObject mimeCode="application/pdf" filename="odoo.pdf">' + oldPdf.toString("base64") + '</cbc:EmbeddedDocumentBinaryObject></cac:Attachment></cac:AdditionalDocumentReference><cac:AccountingSupplierParty/><cac:LegalMonetaryTotal><cbc:TaxInclusiveAmount currencyID="EUR">121.00</cbc:TaxInclusiveAmount><cbc:PayableAmount currencyID="EUR">121.00</cbc:PayableAmount></cac:LegalMonetaryTotal></Invoice>';
      const move: any = {
        ubl_cii_xml_id: false, invoice_pdf_report_id: [96, "odoo.pdf"], peppol_is_sent: false,
        commercial_partner_id: [60, "Customer"], amount_untaxed: 100, amount_total: 121,
      };
      let storedXml = "";
      let storedPdf = "";
      const normal = mocks.call.getMockImplementation()!;
      mocks.call.mockImplementation(async (...args) => {
        const [, model, method, body] = args;
        const key = `${model}.${method}`;
        if (key === "account.move.read") return [{ ...move }];
        if (key === "res.partner.read") return [{
          peppol_eas: "0208", peppol_endpoint: "1002103337", peppol_verification_state: "valid", invoice_edi_format: "ubl_bis3",
        }];
        if (key === "account.move.button_process_edi_web_services") throw new Error("The method 'button_process_edi_web_services' does not exist");
        if (key === "ir.attachment.write" && body.ids[0] === 96) {
          storedPdf = body.vals.datas;
          return true;
        }
        if (key === "ir.attachment.read") return [{ datas: Buffer.from(storedXml).toString("base64") }];
        if (key === "ir.attachment.write") {
          storedXml = Buffer.from(body.vals.datas, "base64").toString("utf8");
          return true;
        }
        if (key === "account.move.send.wizard.create") return 90;
        if (key === "account.move.send.wizard.action_send_and_print") {
          if (!move.ubl_cii_xml_id) {
            move.ubl_cii_xml_id = [95, "PID7750-2026-10.xml"];
            storedXml = odooXml;
          }
          return true;
        }
        if (key === "account.move.send.wizard.unlink") return true;
        if (model === "account.edi.document") throw new Error("Model account.edi.document does not exist");
        return normal(...args);
      });

      const result = await maybeDispatchPeppolInvoice({
        booking: { ...booking, payment: { status: "completed" } }, side: "customer", invoiceNumber: "FIX-2026-000017",
        ublXml: "<Invoice/>", invoiceUblUrl: "", invoicePdf: pdf, totalWithVat: 121,
        lineItems: [{ description: "Service", price: 100, vatRate: 21 }],
      });

      expect(result.status, result.reason).toBe("queued");
      expect(storedPdf).toBe(pdf.toString("base64"));
      expect(storedXml).toContain(`filename="FIX-2026-000017.pdf">${pdf.toString("base64")}</cbc:EmbeddedDocumentBinaryObject>`);
      expect(storedXml).not.toContain(oldPdf.toString("base64"));
      expect(storedXml).toContain("<cbc:ID>FIX-2026-000017</cbc:ID>");
    });
  });

  describe("recipient verification", () => {
    const partnerState = (initial: Record<string, unknown>, isValid: (partner: any) => boolean) => {
      const partner: any = { ...initial };
      const normal = mocks.call.getMockImplementation()!;
      mocks.call.mockImplementation(async (...args) => {
        const [, model, method, body] = args;
        if (model === "res.partner" && method === "read") return [{ ...partner }];
        if (model === "res.partner" && method === "write") return Object.assign(partner, body.vals) && true;
        if (model === "res.partner" && method === "button_account_peppol_check_partner_endpoint") {
          partner.peppol_verification_state = isValid(partner) ? "valid" : "not_valid";
          return true;
        }
        return normal(...args);
      });
      return partner;
    };
    const calls = (model: string, method: string) =>
      mocks.call.mock.calls.filter((call) => call[1] === model && call[2] === method);

    it("skips without creating an Odoo move when the recipient is not on Peppol", async () => {
      partnerState({ peppol_eas: "0208", peppol_endpoint: "1002103337", peppol_verification_state: "not_verified" }, () => false);
      const result = await dispatch("customer");
      expect(result).toMatchObject({ status: "skipped", attempts: 0 });
      expect(result.reason).toMatch(/0208:1002103337 \/ 9925:BE1002103337 is not registered on the Peppol network/);
      expect(calls("account.move", "create")).toHaveLength(0);
      expect(calls("account.move", "button_process_edi_web_services")).toHaveLength(0);
    });

    it("sends with the Belgian 9925 VAT identity when 0208 is not registered", async () => {
      const partner = partnerState(
        { peppol_eas: "0208", peppol_endpoint: "1002103337", peppol_verification_state: "not_valid" },
        (current) => current.peppol_eas === "9925",
      );
      expect(await dispatch("customer")).toMatchObject({ status: "sent" });
      expect(partner).toMatchObject({ peppol_eas: "9925", peppol_endpoint: "BE1002103337" });
    });

    it("writes the VAT participant when Odoo derived no endpoint (NL)", async () => {
      booking.customer.vatNumber = "NL859484827B01";
      try {
        const partner = partnerState(
          { peppol_eas: "0106", peppol_endpoint: false, peppol_verification_state: "not_verified" },
          (current) => current.peppol_eas === "9944",
        );
        expect(await dispatch("customer")).toMatchObject({ status: "sent" });
        expect(partner).toMatchObject({ peppol_eas: "9944", peppol_endpoint: "NL859484827B01" });
      } finally {
        booking.customer.vatNumber = "BE1002103337";
      }
    });

    it("switches self-bill recipients to Peppol BIS 3 and re-verifies them", async () => {
      // Odoo suggests NLCIUS for Dutch VAT numbers, which cannot carry a self-bill.
      const partner = partnerState(
        { peppol_eas: "9944", peppol_endpoint: "NL999999904B01", peppol_verification_state: "valid", invoice_edi_format: "nlcius" },
        () => true,
      );
      expect(await dispatch("supplier")).toMatchObject({ status: "sent" });
      expect(partner.invoice_edi_format).toBe("ubl_bis3");
      expect(calls("res.partner", "button_account_peppol_check_partner_endpoint")).toHaveLength(1);
    });

    it("keeps the partner's own format for customer invoices", async () => {
      const partner = partnerState(
        { peppol_eas: "9944", peppol_endpoint: "NL999999904B01", peppol_verification_state: "valid", invoice_edi_format: "nlcius" },
        () => true,
      );
      expect(await dispatch("customer")).toMatchObject({ status: "sent" });
      expect(partner.invoice_edi_format).toBe("nlcius");
    });

    it("verifies the booking's partner when a retried move has none", async () => {
      partnerState({ peppol_eas: "0208", peppol_endpoint: "1002103337", peppol_verification_state: "not_valid" }, () => false);
      const normal = mocks.call.getMockImplementation()!;
      mocks.call.mockImplementation(async (...args) => {
        if (args[1] === "account.move" && args[2] === "search_read") return [{ id: 70, state: "draft", partner_id: false }];
        return normal(...args);
      });
      expect(await dispatch("customer")).toMatchObject({ status: "skipped", reference: "odoo-account.move-70" });
      expect(calls("res.partner", "search_read")).toHaveLength(1);
      expect(calls("account.move", "button_process_edi_web_services")).toHaveLength(0);
    });

    it("leaves a partner that Odoo already verified untouched", async () => {
      partnerState({ peppol_eas: "0106", peppol_endpoint: "12345678", peppol_verification_state: "valid" }, () => true);
      expect(await dispatch("customer")).toMatchObject({ status: "sent" });
      expect(calls("res.partner", "write")).toHaveLength(0);
      expect(calls("res.partner", "button_account_peppol_check_partner_endpoint")).toHaveLength(0);
    });
  });

  describe("Stripe payment in Odoo", () => {
    const paidBooking = { ...booking, payment: { status: "completed", totalWithVat: 121 } };
    const odooWithMove = (residual: number) => {
      const normal = mocks.call.getMockImplementation()!;
      mocks.call.mockImplementation(async (...args) => {
        const [, model, method] = args;
        if (model === "account.move" && method === "read") {
          return [{ state: "posted", amount_untaxed: 100, amount_total: 121, amount_residual: residual }];
        }
        if (model === "account.journal" && method === "search_read") {
          return [{ id: 90, default_account_id: [5, "550004 Stripe (Fixtract)"], inbound_payment_method_line_ids: [1], outbound_payment_method_line_ids: [2] }];
        }
        if (model === "account.payment.method.line" && method === "read") return [{ id: 1, payment_account_id: false }, { id: 2, payment_account_id: [5, "x"] }];
        if (model === "account.payment.method.line" && method === "write") return true;
        if (model === "account.payment.register" && method === "create") return 91;
        if (model === "account.payment.register" && method === "action_create_payments") return {};
        return normal(...args);
      });
    };
    const send = () => maybeDispatchPeppolInvoice({
      booking: paidBooking, side: "customer", invoiceNumber: "FIX-2026-000020", ublXml: "<Invoice/>", invoiceUblUrl: "",
      totalWithVat: 121, lineItems: [{ description: "Service", price: 100, vatRate: 21 }],
    });
    const calls = (model: string, method: string) =>
      mocks.call.mock.calls.filter((call) => call[1] === model && call[2] === method);

    it("books the Stripe payment in the Stripe journal when enabled", async () => {
      mocks.settings.mockResolvedValue({ eInvoicing: { peppolEnabled: true, provider: "odoo", odooRecordPayments: true } });
      odooWithMove(121);
      expect(await send()).toMatchObject({ status: "sent" });
      expect(calls("account.payment.method.line", "write")[0][3]).toMatchObject({ ids: [1], vals: { payment_account_id: 5 } });
      expect(calls("account.payment.register", "create")[0][3]).toMatchObject({
        vals_list: [{ journal_id: 90, amount: 121, communication: "FIX-2026-000020" }],
        context: { active_model: "account.move", active_ids: [70] },
      });
      expect(calls("account.payment.register", "action_create_payments")).toHaveLength(1);
    });

    it("does not book a payment twice or when disabled", async () => {
      mocks.settings.mockResolvedValue({ eInvoicing: { peppolEnabled: true, provider: "odoo", odooRecordPayments: true } });
      odooWithMove(0);
      await send();
      mocks.settings.mockResolvedValue({ eInvoicing: { peppolEnabled: true, provider: "odoo" } });
      odooWithMove(121);
      await send();
      expect(calls("account.payment.register", "create")).toHaveLength(0);
    });
  });
});
