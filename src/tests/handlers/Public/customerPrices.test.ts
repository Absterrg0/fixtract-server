import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
const mocks = vi.hoisted(() => ({ config: vi.fn(), access: vi.fn() }));
vi.mock('../../../models/platformSettings', () => ({ default: { getCurrentConfig: mocks.config } }));
vi.mock('../../../utils/bookingDetails/adminAccess', () => ({
  isAdminUser: (user: any) => user?.role === 'admin' || user?.isAdmin === true,
  resolveBookingAdminAccess: mocks.access,
}));
import { getCommissionRate, previewCustomerPrices } from '../../../handlers/Public/customerPrices';
import { commissionVisibility } from '../../../middlewares/commissionVisibility';
import { attachAdminPaymentsAccess } from '../../../middlewares/auth';
import { commissionedExtraCostTotal, commissionedQuoteAmount } from '../../../utils/customerPricing';
let server: Server;
let base: string;
beforeAll(async () => {
  const app = express();
  // Production mounts commissionVisibility on /api before the auth middleware sets req.user. The
  // middleware reads req.user lazily inside res.json, so this test's earlier user injection behaves the same.
  app.use(express.json(), commissionVisibility);
  // Stands in for the auth middleware: sets req.user, then resolves admin payments access as protect does.
  app.use(async (req, res, next) => {
    if (req.headers['x-role']) req.user = { role: req.headers['x-role'] } as any;
    await attachAdminPaymentsAccess(req.user, res);
    next();
  });
  app.get('/rate', getCommissionRate);
  app.post('/prices', previewCustomerPrices);
  app.get('/legacy', (_req, res) => res.json({ nested: [{ commissionPercent: 17, platform_commission_percentage: 17, commissionRate: .17, professionalNetAmount: 100, customerNetAmount: 117 }] }));
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
beforeEach(() => { mocks.config.mockReset().mockResolvedValue({ commissionPercent: 17 }); mocks.access.mockReset().mockResolvedValue({ payments: false }); });
const post = async (prices: any) => fetch(`${base}/prices`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prices }) });

describe('amount-only pricing HTTP contract', () => {
  it.each([undefined, 'customer', 'employee'])('never returns the rate to %s', async role => {
    const response = await fetch(`${base}/rate`, { headers: role ? { 'x-role': role } : {} });
    expect(response.status).toBe(403);
    expect(await response.text()).not.toMatch(/commissionPercent|17/);
    expect(mocks.config).not.toHaveBeenCalled();
  });
  it('retains professional and payments-admin accounting access only', async () => {
    expect((await (await fetch(`${base}/rate`, { headers: { 'x-role': 'professional' } })).json()).data.commissionPercent).toBe(17);
    expect((await fetch(`${base}/rate`, { headers: { 'x-role': 'admin' } })).status).toBe(403);
    mocks.access.mockResolvedValue({ payments: true });
    expect((await (await fetch(`${base}/rate`, { headers: { 'x-role': 'admin' } })).json()).data.commissionPercent).toBe(17);
  });
  it('prices fixed, per-unit, options and signed extra-cost adjustments using the checkout functions', async () => {
    const cost = { type: 'unit_adjustment', amount: -25, unitPrice: 10, actualUnits: 2.5, estimatedUnits: 5 };
    const prices = [
      { kind: 'amount', amount: 100 },
      { kind: 'amount', amount: 492.82, unitPricing: { pricingType: 'unit', unitAmount: 16.427333 / 1.17, quantity: 30 } },
      { kind: 'extra_cost', amount: cost.amount, cost },
      { kind: 'extra_cost_total', amount: -25, costs: [cost] },
      { kind: 'amount', amount: 0 },
    ];
    const response = await post(prices);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.prices).toEqual([117, commissionedQuoteAmount(prices[1].amount, prices[1].unitPricing, 17), -29.25, commissionedExtraCostTotal([cost], -25, 17), 0]);
    expect(JSON.stringify(body)).not.toMatch(/commission|rate|percent|multiplier/i);
  });
  it.each([[], Array(101).fill({ kind: 'amount', amount: 100 }), [{ kind: 'amount', amount: '100' }], [{ kind: 'amount', amount: 1e15 }], [{ kind: 'amount', amount: 10, unitPricing: { pricingType: 'unit', unitAmount: 5, quantity: 0 } }], [{ kind: 'extra_cost_total', amount: 10, costs: [{ amount: null }] }]])('rejects invalid or unbounded previews', async prices => {
    expect((await post(prices)).status).toBe(400);
    expect(mocks.config).not.toHaveBeenCalled();
  });
  it('fails closed when the pricing setting is unavailable', async () => {
    mocks.config.mockRejectedValue(new Error('provider secret'));
    const response = await post([{ kind: 'amount', amount: 100 }]);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toMatch(/provider secret|100/);
  });
  it.each([undefined, 'customer'])('scrubs percentage aliases at the final JSON boundary for %s', async role => {
    const result = await (await fetch(`${base}/legacy`, { headers: role ? { 'x-role': role } : {} })).json();
    expect(result).toEqual({ nested: [{ customerNetAmount: 117 }] });
  });
});
