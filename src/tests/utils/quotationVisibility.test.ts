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
    // Professional-side net is withheld from customers; the customer-side amount stays.
    expect(visible.quoteVersions[0].customerTotals).toEqual({ customerNetAmount: 117 });
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

describe('customer-view walk is bounded and matches JSON serialization', () => {
  it('withholds a back-edge instead of recursing, and leaves the source untouched', () => {
    const node: any = { customerNetAmount: 117, professionalNetAmount: 100 };
    node.self = node;
    const visible: any = quotationForViewer(node, 'customer');
    expect(visible).toEqual({ customerNetAmount: 117, self: undefined });
    expect(node.professionalNetAmount).toBe(100);
  });

  it('withholds subtrees beyond the depth bound instead of traversing them', () => {
    let deep: any = { professionalNetAmount: 1, customerNetAmount: 2 };
    for (let i = 0; i < 60; i++) deep = { next: deep };
    const visible = JSON.stringify(quotationForViewer(deep, 'customer'));
    expect(visible).not.toMatch(/professionalNetAmount/);
  });

  it('reads Mongoose-style toJSON the way JSON serialization does', () => {
    const doc = { toJSON: () => ({ customerNetAmount: 117, professionalNetAmount: 100, when: new Date('2026-01-01T00:00:00Z') }) };
    const visible = JSON.parse(JSON.stringify(quotationForViewer({ doc }, 'customer')));
    expect(visible).toEqual({ doc: { customerNetAmount: 117, when: '2026-01-01T00:00:00.000Z' } });
  });

  it('returns unchanged subtrees by reference so clean responses are not copied', () => {
    const clean = { name: 'x', nested: { items: [{ id: 1 }] } };
    const visible: any = quotationForViewer({ clean }, 'customer');
    expect(visible.clean).toBe(clean);
  });

  it('withholds professional and commission amounts from anonymous and non-finance admin viewers', () => {
    const payload = { payment: { amount: 115, platformCommission: 15, professionalPayout: 100 } };
    expect(quotationForViewer(payload, 'customer')).toEqual({ payment: { amount: 115 } });
    // An admin without payments read keeps professional amounts but loses commission amounts.
    expect(quotationForViewer(payload, 'admin', false)).toEqual({ payment: { amount: 115, professionalPayout: 100 } });
    expect(quotationForViewer(payload, 'admin', true)).toBe(payload);
    expect(quotationForViewer(payload, 'professional')).toBe(payload);
  });
});
