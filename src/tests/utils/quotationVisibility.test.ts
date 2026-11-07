import { describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import { quotationForViewer } from '../../utils/quotationVisibility';
import { bookingForRequest, bookingForViewer } from '../../utils/invoiceVisibility';

export const expectNoCommissionPercentage = (value: unknown): void => {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    expect(key.replace(/[^a-z]/gi, '').toLowerCase()).not.toMatch(/commission.*(percent|rate)/);
    expectNoCommissionPercentage(child);
  }
};

describe('role-aware quotation serialization', () => {
  const id = new Types.ObjectId();
  const at = new Date('2026-02-01T10:00:00Z');
  const source = () => ({
    customer: id,
    quoteVersions: [{ customerTotals: { commissionPercent: 17, professionalNetAmount: 100, customerNetAmount: 117 } }],
    bookingSnapshot: { checkoutSnapshot: { commission_percentage: 17, amount: 100 } },
    discount: { bag: [{ platformCommissionRate: 0.17, commission_pct: 17, vatRate: 21, commissionAmount: 17 }] },
    createdAt: at,
  });
  it('recursively strips percentage aliases from customer bags without changing amounts or source facts', () => {
    const stored = source();
    const visible = quotationForViewer(stored, 'customer');
    expectNoCommissionPercentage(visible);
    expect(visible.quoteVersions[0].customerTotals).toEqual({ professionalNetAmount: 100, customerNetAmount: 117 });
    expect(visible.discount.bag[0]).toEqual({ vatRate: 21, commissionAmount: 17 });
    expect(visible.createdAt).toBe(at);
    expect(visible.customer).toBe(id);
    expect(stored.quoteVersions[0].customerTotals.commissionPercent).toBe(17);
  });
  it.each(['customer', 'professional', 'admin'] as const)('uses one policy for raw and hydrated bookings (%s)', role => {
    const stored = source();
    const visible = bookingForViewer({ toObject: () => stored }, role);
    if (role === 'customer') expectNoCommissionPercentage(visible);
    else expect(visible.quoteVersions[0].customerTotals.commissionPercent).toBe(17);
  });
  it('resolves a customer even when their global role is professional', () => {
    expectNoCommissionPercentage(bookingForRequest(source(), { _id: id, role: 'professional' }));
  });
  it('withholds percentages from an admin without payments read', () => {
    expectNoCommissionPercentage(quotationForViewer(source(), 'admin', false));
    expect(quotationForViewer(source(), 'admin', true).quoteVersions[0].customerTotals.commissionPercent).toBe(17);
  });
});
