import { describe, expect, it, vi } from "vitest";

vi.mock("../../../utils/emailService", () => ({
  sendNotificationEmail: vi.fn().mockResolvedValue(true),
}));

import { getEventDef } from "../../../utils/notifications/registry";
import { sendNotificationEmail } from "../../../utils/emailService";

describe("invoice_ready notification + email/PDF end-to-end contract", () => {
  it("customer invoice links to booking page, email carries PDF attachment", async () => {
    const def: any = getEventDef("customer.invoice_ready");
    expect(def).toBeTruthy();
    const built = def.build({ bookingId: "bk1", invoiceNumber: "FIX-2026-000008", invoiceUrl: "https://s3/FIX.pdf" });
    expect(built.clickUrl).toContain(`/bookings/bk1`);
    expect(built.clickUrl).not.toContain("s3");
    expect(built.body).not.toContain("https://s3");
    await built.sendEmail!({ email: "c@example.com", name: "C", userId: "u1" });
    const customerCall = vi.mocked(sendNotificationEmail).mock.calls[0]?.[0] as any;
    expect(customerCall?.to).toBe("c@example.com");
    expect(String(customerCall?.ctaUrl)).toContain("/bookings/bk1");
    expect(String(customerCall?.ctaUrl)).not.toContain("s3");
    expect(customerCall?.attachmentUrl).toBe("https://s3/FIX.pdf");
    expect(customerCall?.attachmentName).toBe("FIX-2026-000008.pdf");
  });

  it("professional self-bill links to booking page, email carries SUP attachment", async () => {
    vi.mocked(sendNotificationEmail).mockClear();
    const def: any = getEventDef("professional.invoice_ready");
    const built = def.build({ bookingId: "bk1", invoiceNumber: "SUP-2026-000001", invoiceUrl: "https://s3/SUP.pdf" });
    expect(built.clickUrl).toContain(`/bookings/bk1`);
    await built.sendEmail!({ email: "p@example.com", name: "P", userId: "u2" });
    expect(sendNotificationEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        attachmentUrl: "https://s3/SUP.pdf",
        attachmentName: "SUP-2026-000001.pdf",
      }),
    );
  });
});
