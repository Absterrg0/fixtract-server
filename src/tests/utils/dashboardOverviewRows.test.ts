import { describe, expect, it } from "vitest";
import {
  buildSharedBookingsRow,
  buildSharedQuoteRow,
  isPayNowEligible,
  isWarrantyActionEligible,
  pinnedVersionMoney,
  resolveArchiveRestoreTarget,
  resolvePinnedQuoteVersion,
  resolveSnapshotTitles,
} from "../../utils/bookingDetails/overviewRows";

describe("shared bookings overview rows", () => {
  it("prefers the booking-time snapshot over the live project", () => {
    const titles = resolveSnapshotTitles({
      project: { _id: "p1", title: "Live mutated title" },
      bookingSnapshot: {
        project: { id: "p1", title: "Snapshot title" },
        selectedSubproject: { title: "Snapshot subproject" },
      },
    });
    expect(titles).toEqual({
      projectId: "p1",
      projectTitle: "Snapshot title",
      subprojectTitle: "Snapshot subproject",
      titleSource: "booking_snapshot",
    });
  });

  it("falls back to the live project only when no snapshot exists", () => {
    const titles = resolveSnapshotTitles({ project: { _id: "p1", title: "Live title" } });
    expect(titles.titleSource).toBe("live_project");
    expect(titles.projectTitle).toBe("Live title");
    expect(titles.subprojectTitle).toBeNull();
  });

  it("reports paid price VAT-inclusive and unknown dates as null", () => {
    const row = buildSharedBookingsRow({
      _id: "b1",
      bookingNumber: "BK-2026-000001",
      status: "booked",
      createdAt: new Date("2026-03-01T10:00:00.000Z"),
      payment: { totalWithVat: 1210, currency: "EUR" },
    }, "customer");
    expect(row.paidPrice).toEqual({ amount: 1210, currency: "EUR", source: "recorded" });
    expect(row.plannedStart).toBeNull();
    expect(row.actualStart).toBeNull();
    expect(row.actualEnd).toBeNull();
  });

  it("keeps pro payout fields for professionals but strips them for customers", () => {
    const booking = {
      _id: "b1",
      status: "completed",
      payment: {
        totalWithVat: 1210,
        currency: "EUR",
        professionalPayout: 1089,
        transferredAt: new Date("2026-04-01T10:00:00.000Z"),
        transferStatus: "succeeded",
        status: "completed",
      },
    };
    const pro = buildSharedBookingsRow(booking, "professional");
    expect(pro.payoutAmount.amount).toBe(1089);
    expect(pro.payoutDate).toBe("2026-04-01T10:00:00.000Z");

    const customer = buildSharedBookingsRow(booking, "customer");
    expect(customer.payoutAmount).toEqual({ amount: null, currency: null, source: "not_recorded" });
    expect(customer.payoutDate).toBeNull();
    // Customer-own totals stay intact.
    expect(customer.paidPrice.amount).toBe(1210);
  });

  it("uses the actual transfer date only, never a capture fallback", () => {
    const row = buildSharedBookingsRow({
      _id: "b1",
      status: "completed",
      payment: {
        totalWithVat: 500,
        currency: "EUR",
        professionalPayout: 450,
        capturedAt: new Date("2026-04-01T10:00:00.000Z"),
        status: "completed",
      },
    }, "professional");
    expect(row.payoutDate).toBeNull();
  });

  it("reports refunds only when a refund record or status exists", () => {
    const withoutRefund = buildSharedBookingsRow({
      _id: "b1",
      status: "completed",
      payment: { totalWithVat: 500, currency: "EUR", status: "completed" },
    }, "professional");
    expect(withoutRefund.refundAmount).toEqual({ amount: null, currency: null, source: "not_recorded" });

    const withRefund = buildSharedBookingsRow({
      _id: "b1",
      status: "refunded",
      payment: { totalWithVat: 500, currency: "EUR", status: "refunded", refundAmount: 500 },
    }, "professional");
    expect(withRefund.refundAmount.amount).toBe(500);
  });
});

describe("shared quote overview rows", () => {
  it("pins the recorded accepted version, not the mutable latest", () => {
    const booking = {
      acceptedQuoteVersion: 2,
      currentQuoteVersion: 4,
      quoteVersions: [
        { version: 2, totalAmount: 1000, currency: "EUR" },
        { version: 4, totalAmount: 2500, currency: "EUR" },
      ],
    };
    expect(resolvePinnedQuoteVersion(booking)).toEqual({ pinnedVersion: 2, pinnedVersionSource: "recorded" });
    expect(pinnedVersionMoney(booking).amount).toBe(1000);
  });

  it("infers the current version only when no accepted version is recorded", () => {
    const booking = {
      currentQuoteVersion: 3,
      quoteVersions: [{ version: 3, totalAmount: 750, currency: "EUR" }],
    };
    expect(resolvePinnedQuoteVersion(booking)).toEqual({ pinnedVersion: 3, pinnedVersionSource: "inferred_current" });
  });

  it("returns unknown money when the pinned version document is missing", () => {
    expect(pinnedVersionMoney({ currentQuoteVersion: 9, quoteVersions: [] }))
      .toEqual({ amount: null, currency: null, source: "not_recorded" });
  });

  it("renders RFQ-initial unfilled fields as null", () => {
    const row = buildSharedQuoteRow({ _id: "b1", status: "rfq", createdAt: new Date("2026-05-01T00:00:00.000Z") });
    expect(row.quotationNumber).toBeNull();
    expect(row.pinnedVersion).toBeNull();
    expect(row.quoteDate).toBeNull();
    expect(row.expiryDate).toBeNull();
    expect(row.quotePrice).toEqual({ amount: null, currency: null, source: "not_recorded" });
  });
});

describe("archive restore target", () => {
  it("never restores straight to published", () => {
    expect(resolveArchiveRestoreTarget("published")).toBe("draft");
    expect(resolveArchiveRestoreTarget(undefined)).toBe("draft");
  });

  it("preserves verified non-published states", () => {
    expect(resolveArchiveRestoreTarget("on_hold")).toBe("on_hold");
    expect(resolveArchiveRestoreTarget("draft")).toBe("draft");
    expect(resolveArchiveRestoreTarget("suspended")).toBe("suspended");
  });
});

describe("dashboard eligibility helpers", () => {
  it("marks quote_accepted and payment_pending as pay-now eligible", () => {
    expect(isPayNowEligible("quote_accepted")).toBe(true);
    expect(isPayNowEligible("payment_pending")).toBe(true);
    expect(isPayNowEligible("booked")).toBe(false);
  });

  it("marks completed bookings inside warranty coverage as eligible", () => {
    const now = new Date("2026-06-01T00:00:00.000Z").getTime();
    expect(isWarrantyActionEligible({
      status: "completed",
      warrantyCoverage: { duration: { value: 12, unit: "months" }, endsAt: "2027-01-01T00:00:00.000Z" },
    }, now)).toBe(true);
    expect(isWarrantyActionEligible({
      status: "completed",
      warrantyCoverage: { duration: { value: 12, unit: "months" }, endsAt: "2026-01-01T00:00:00.000Z" },
    }, now)).toBe(false);
    expect(isWarrantyActionEligible({ status: "booked" }, now)).toBe(false);
  });
});

it('derives the price model from the booking snapshot before the mutable project', () => {
  const row = buildSharedBookingsRow({ bookingSnapshot: { project: { priceModel: 'unit' } }, project: { priceModel: 'fixed' } }, 'professional');
  expect(row.priceModel).toBe('unit');
});
it('uses the recorded customer VAT-inclusive total for the pinned quote', () => {
  expect(pinnedVersionMoney({ currentQuoteVersion: 2, quoteVersions: [{ version: 2, totalAmount: 300, customerTotals: { totalWithVat: 363 }, currency: 'EUR' }] }).amount).toBe(363);
});
it('preserves a recorded zero refund and unknown when absent', () => {
  expect(buildSharedBookingsRow({ payment: { refundAmount: 0, currency: 'EUR' } }, 'professional').refundAmount.amount).toBe(0);
});
it('never shows the pre-VAT net for a priced version without a recorded VAT-inclusive total', () => {
  const priced = { version: 2, totalAmount: 300, currency: 'EUR', pricingLines: [{ description: 'Work', price: 300, vatRate: 21 }] };
  expect(pinnedVersionMoney({ currentQuoteVersion: 2, quoteVersions: [priced] })).toEqual({ amount: null, currency: null, source: 'not_recorded' });
  expect(pinnedVersionMoney({ currentQuoteVersion: 2, quoteVersions: [{ ...priced, totalWithVat: 363 }] }).amount).toBe(363);
  // Legacy versions without pricingLines keep the totalAmount fallback (0% VAT).
  expect(pinnedVersionMoney({ currentQuoteVersion: 2, quoteVersions: [{ version: 2, totalAmount: 300, currency: 'EUR' }] }).amount).toBe(300);
});
it('never presents an amount due as the paid price', () => {
  const due = { totalWithVat: 1210, currency: 'EUR', status: 'pending' };
  for (const status of ['quote_accepted', 'payment_pending']) {
    expect(buildSharedBookingsRow({ _id: 'b1', status, payment: { ...due, status: 'authorized' } }, 'customer').paidPrice)
      .toEqual({ amount: null, currency: null, source: 'not_recorded' });
  }
  // A later milestone's open checkout replaced booking.payment.
  expect(buildSharedBookingsRow({ _id: 'b1', status: 'in_progress', payment: due }, 'customer').paidPrice.amount).toBeNull();
  expect(buildSharedBookingsRow({ _id: 'b1', status: 'booked', payment: { ...due, status: 'authorized' } }, 'customer').paidPrice.amount).toBe(1210);
});

describe('recorded money on the shared bookings row', () => {
  it('never presents the pre-VAT payment.amount as the paid price', () => {
    // createPaymentIntent stores the net in payment.amount and the charge in totalWithVat.
    const payment = { amount: 110, netAmount: 110, vatAmount: 21, totalWithVat: 131, currency: 'EUR', status: 'authorized' };
    expect(buildSharedBookingsRow({ _id: 'b1', status: 'booked', payment }, 'customer').paidPrice)
      .toEqual({ amount: 131, currency: 'EUR', source: 'recorded' });
    const { totalWithVat: _omit, ...withoutTotal } = payment;
    expect(buildSharedBookingsRow({ _id: 'b1', status: 'booked', payment: withoutTotal }, 'customer').paidPrice)
      .toEqual({ amount: null, currency: null, source: 'not_recorded' });
  });

  it('reports the settled extra-cost charge from the payment, not unrecorded entry statuses', () => {
    const booking = {
      _id: 'b1',
      status: 'completed',
      extraCostStatus: 'confirmed',
      extraCostTotal: 20,
      // Real IExtraCost entries: no status, pre-commission/pre-VAT amounts.
      extraCosts: [{ type: 'other', name: 'Extra tile', justification: 'x', amount: 20 }],
      payment: {
        totalWithVat: 1210,
        currency: 'EUR',
        status: 'completed',
        extraCostAmount: 26.62,
        extraCostStatus: 'succeeded',
        extraCostPaymentSucceeded: true,
      },
    };
    expect(buildSharedBookingsRow(booking, 'customer').completionAddition)
      .toEqual({ amount: 26.62, currency: 'EUR', source: 'recorded' });
    // Pending, failed or refunded extra-cost payments are not a settled addition,
    // even with confirmed booking-level extra costs.
    for (const extraCostStatus of ['pending', 'failed', 'refunded', undefined]) {
      expect(buildSharedBookingsRow({ ...booking, payment: { ...booking.payment, extraCostStatus } }, 'professional').completionAddition)
        .toEqual({ amount: null, currency: null, source: 'not_recorded' });
    }
    // A legacy invented entry status is ignored.
    expect(buildSharedBookingsRow({ _id: 'b2', status: 'completed', extraCosts: [{ status: 'paid', total: 50, amount: 50 }], payment: { totalWithVat: 10, currency: 'EUR', status: 'completed' } }, 'customer').completionAddition.amount)
      .toBeNull();
  });

  it('reports a returned negative adjustment as a negative addition, excluding failed rows', () => {
    const payment = {
      totalWithVat: 500,
      currency: 'EUR',
      status: 'partially_refunded',
      refunds: [
        { amount: 30, kind: 'extra_cost', status: 'succeeded' },
        { amount: 99, kind: 'extra_cost', status: 'failed' },
      ],
    };
    const row = buildSharedBookingsRow({ _id: 'b1', status: 'completed', payment }, 'professional');
    expect(row.completionAddition).toEqual({ amount: -30, currency: 'EUR', source: 'recorded' });
    // Extra-cost rows are not booking-price refunds.
    expect(row.refundAmount).toEqual({ amount: null, currency: null, source: 'not_recorded' });
  });

  it('counts only refunds that returned money', () => {
    const row = (refunds: any[], extra: Record<string, unknown> = {}) => buildSharedBookingsRow({
      _id: 'b1',
      status: 'completed',
      payment: { totalWithVat: 500, currency: 'EUR', status: 'completed', refunds, ...extra },
    }, 'professional').refundAmount;
    expect(row([{ amount: 100, status: 'failed' }])).toEqual({ amount: null, currency: null, source: 'not_recorded' });
    expect(row([{ amount: 100, status: 'canceled' }, { amount: 40, status: 'pending' }])).toEqual({ amount: null, currency: null, source: 'not_recorded' });
    expect(row([{ amount: 100, status: 'failed' }, { amount: 40, status: 'succeeded' }, { amount: 10 }]))
      .toEqual({ amount: 50, currency: 'EUR', source: 'recorded' });
    // The recorded aggregate stays authoritative.
    expect(row([{ amount: 100, status: 'failed' }], { refundAmount: 25 }).amount).toBe(25);
    // Customers never get the pro-side refund column.
    expect(buildSharedBookingsRow({ _id: 'b1', status: 'completed', payment: { refundAmount: 25, currency: 'EUR' } }, 'customer').refundAmount.amount).toBeNull();
  });
});
