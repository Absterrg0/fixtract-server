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

    it("continues when action_post timed out but Odoo posted the move", async () => {
      const normal = mocks.call.getMockImplementation()!;
      mocks.call.mockImplementation(async (...args) => {
        if (args[2] === "action_post") throw timeoutError("account.move.action_post");
        if (args[1] === "account.move" && args[2] === "read") return [{ state: "posted" }];
        return normal(...args);
      });
      expect(await dispatch("customer")).toMatchObject({ status: "sent" });
      expect(mocks.call.mock.calls.filter((call) => call[2] === "action_post")).toHaveLength(1);
    });

    it("fails when action_post timed out and the move is still draft", async () => {
      const normal = mocks.call.getMockImplementation()!;
      mocks.call.mockImplementation(async (...args) => {
        if (args[2] === "action_post") throw timeoutError("account.move.action_post");
        if (args[1] === "account.move" && args[2] === "read") return [{ state: "draft" }];
        return normal(...args);
      });
      expect(await dispatch("customer")).toMatchObject({ status: "failed", reason: expect.stringMatching(/action_post/) });
      expect(mocks.call.mock.calls.some((call) => call[2] === "button_process_edi_web_services")).toBe(false);
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
});
