import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ find: vi.fn(), updateOne: vi.fn(), settings: vi.fn(), ensure: vi.fn() }));
vi.mock("../../models/booking", () => ({ default: { find: mocks.find, updateOne: mocks.updateOne } }));
vi.mock("../../models/platformSettings", () => ({ default: { getCurrentConfig: mocks.settings } }));
vi.mock("../../services/invoiceArtifacts", () => ({ ensureBookingInvoiceArtifacts: mocks.ensure }));
import {
  retryStuckPeppolDispatches,
  sanitizePeppolRetryResultForResponse,
} from "../../utils/retryPeppolDispatches";

const chain = (rows: unknown[]) => {
  const query: any = {};
  for (const step of ["sort", "limit", "select"]) query[step] = vi.fn(() => query);
  query.lean = vi.fn(async () => rows);
  return query;
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.settings.mockResolvedValue({ eInvoicing: { peppolEnabled: true, provider: "odoo" } });
  mocks.updateOne.mockResolvedValue({ acknowledged: true });
});

describe("Peppol retry", () => {
  it("re-runs invoice generation for dispatches left in progress or timed out", async () => {
    const query = chain([{ _id: "b1", bookingNumber: "BK-2026-000103" }]);
    mocks.find.mockReturnValue(query);
    mocks.ensure.mockResolvedValue({ peppolDispatchStatus: "sent", supplierPeppolDispatchStatus: "skipped" });
    const now = new Date("2026-10-18T08:30:00Z");
    const result = await retryStuckPeppolDispatches({ now });
    expect(result.results).toEqual([{ bookingNumber: "BK-2026-000103", customer: "sent", supplier: "skipped" }]);
    const filter = mocks.find.mock.calls[0][0];
    // Not while the dispatch may still be running in its own request.
    expect(filter["payment.invoiceGeneratedAt"].$lte.getTime()).toBe(now.getTime() - 15 * 60 * 1000);
    const failedReason = filter.$or[2]["payment.peppolDispatchReason"] as RegExp;
    expect(failedReason.test("Odoo did not answer account.move.create within 15s")).toBe(true);
    expect(failedReason.test("Missing active Odoo sales tax for VAT rates 21")).toBe(false);
    // Least recently attempted first, so stuck sends cannot take the slots daily.
    expect(query.sort).toHaveBeenCalledWith({ "payment.peppolRetriedAt": 1, "payment.invoiceGeneratedAt": 1 });
    expect(mocks.updateOne).toHaveBeenCalledWith({ _id: "b1" }, { $set: { "payment.peppolRetriedAt": now } });
  });

  it("does nothing unless Odoo Peppol dispatch is enabled", async () => {
    mocks.settings.mockResolvedValue({ eInvoicing: { peppolEnabled: true, provider: "manual" } });
    expect((await retryStuckPeppolDispatches()).checked).toBe(0);
    expect(mocks.find).not.toHaveBeenCalled();
  });
});

describe("Peppol retry cron response", () => {
  it("keeps status fields but hides raw provider errors", () => {
    const result = sanitizePeppolRetryResultForResponse({
      checked: 2,
      results: [
        { bookingNumber: "BK-1", customer: "sent", supplier: "skipped" },
        {
          bookingNumber: "BK-2",
          error: "Odoo Server Error: Traceback; SQLSTATE 42P01 api_key=sk_live_secret",
        },
      ],
    });

    expect(result.checked).toBe(2);
    expect(result.results[0]).toEqual({
      bookingNumber: "BK-1",
      customer: "sent",
      supplier: "skipped",
    });
    expect(result.results[1]).toEqual({
      bookingNumber: "BK-2",
      error: "Peppol retry failed. Check server logs for details.",
    });
    expect(JSON.stringify(result)).not.toContain("Traceback");
    expect(JSON.stringify(result)).not.toContain("sk_live_secret");
  });
});
