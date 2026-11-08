import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { Types } from 'mongoose';
const mocks = vi.hoisted(() => ({
  config: vi.fn(),
  access: vi.fn(),
  projectFind: vi.fn(),
  userFind: vi.fn(),
}));
vi.mock('../../../models/platformSettings', () => ({ default: { getCurrentConfig: mocks.config } }));
vi.mock('../../../models/project', () => ({ default: { find: mocks.projectFind } }));
vi.mock('../../../models/user', () => ({ default: { find: mocks.userFind } }));
vi.mock('../../../utils/bookingDetails/adminAccess', () => ({
  isAdminUser: (user: any) => user?.role === 'admin' || user?.isAdmin === true,
  resolveBookingAdminAccess: mocks.access,
}));
import { getCommissionRate, previewCustomerPrices } from '../../../handlers/Public/customerPrices';
import { commissionVisibility } from '../../../middlewares/commissionVisibility';
import { attachAdminPaymentsAccess } from '../../../middlewares/auth';
import { checkoutCustomerTotal, commissionedQuoteAmount, optionsCustomerCharge } from '../../../utils/customerPricing';

const ownerId = new Types.ObjectId();
const projectId = new Types.ObjectId();
// Distinctive base prices so a leaked base amount is easy to spot in a response body.
const project = {
  _id: projectId,
  status: 'published',
  professionalId: ownerId,
  subprojects: [
    { title: 'Fixed package', pricing: { type: 'fixed', amount: 873.37 } },
    { title: 'Per square metre', pricing: { type: 'unit', amount: 12.34, unit: 'm2', minOrderQuantity: 1 } },
  ],
  extraOptions: [{ _id: new Types.ObjectId(), name: 'Extra', price: 77.77 }],
};

let server: Server;
let base: string;
beforeAll(async () => {
  const app = express();
  app.use(express.json(), commissionVisibility);
  // Stands in for the auth middleware: sets req.user, then resolves admin payments access as protect does.
  app.use(async (req, res, next) => {
    if (req.headers['x-role']) req.user = { role: req.headers['x-role'] } as any;
    await attachAdminPaymentsAccess(req.user, res);
    next();
  });
  app.get('/rate', getCommissionRate);
  app.post('/prices', previewCustomerPrices);
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
beforeEach(() => {
  mocks.config.mockReset().mockResolvedValue({ commissionPercent: 13 });
  mocks.access.mockReset().mockResolvedValue({ payments: false });
  mocks.projectFind.mockReset().mockImplementation(() => ({ lean: async () => [project] }));
  mocks.userFind.mockReset().mockImplementation(() => ({ select: () => ({ lean: async () => [{ _id: ownerId }] }) }));
});

const preview = async (requests: unknown) => fetch(`${base}/prices`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requests }),
});

describe('entity-keyed customer price preview', () => {
  it('rejects the retired amount-only contract', async () => {
    const response = await fetch(`${base}/prices`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prices: [{ kind: 'amount', amount: 100 }] }),
    });
    expect(response.status).toBe(400);
  });

  it('ignores any submitted amount and prices the stored package', async () => {
    const response = await preview([{ projectId: String(projectId), subprojectIndex: 0, amount: 1 }]);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.prices).toEqual([checkoutCustomerTotal({ pricingType: 'fixed', baseSubtotal: 873.37, extraOptionsTotal: 0 } as any, 13)]);
    expect(body.data.prices[0]).not.toBe(1);
  });

  it('matches the checkout arithmetic for a package with selected options', async () => {
    const response = await preview([{ projectId: String(projectId), subprojectIndex: 0, selectedExtraOptions: [0] }]);
    const expected = commissionedQuoteAmount(873.37, undefined, 13) + optionsCustomerCharge(77.77, 13);
    expect((await response.json()).data.prices).toEqual([+expected.toFixed(2)]);
  });

  it('returns customer totals only, never the base price or the rate', async () => {
    const response = await preview([
      { projectId: String(projectId), subprojectIndex: 0 },
      { projectId: String(projectId), subprojectIndex: 1, estimatedUsage: 2 },
    ]);
    const text = await response.text();
    expect(text).not.toMatch(/873\.37|12\.34|77\.77|commission/i);
    expect(JSON.parse(text).data.prices).toHaveLength(2);
  });

  it('does not reveal the rate across two calls with different usage', async () => {
    const one = await (await preview([{ projectId: String(projectId), subprojectIndex: 1, estimatedUsage: 1 }])).json();
    const two = await (await preview([{ projectId: String(projectId), subprojectIndex: 1, estimatedUsage: 2 }])).json();
    // Each response is customer-side only. Base and rate are never returned, so no pair can be divided.
    expect(JSON.stringify([one, two])).not.toMatch(/12\.34/);
  });

  it('fails for unpublished projects and inactive owners', async () => {
    mocks.projectFind.mockImplementation(() => ({ lean: async () => [] }));
    expect((await preview([{ projectId: String(projectId), subprojectIndex: 0 }])).status).toBe(404);
  });

  it('rejects malformed requests', async () => {
    expect((await preview([{ projectId: 'not-an-id', subprojectIndex: 0 }])).status).toBe(400);
    expect((await preview([{ projectId: String(projectId), subprojectIndex: -1 }])).status).toBe(400);
    expect((await preview([])).status).toBe(400);
  });

  it('fails closed when the pricing setting is unavailable', async () => {
    mocks.config.mockRejectedValue(new Error('db down'));
    const response = await preview([{ projectId: String(projectId), subprojectIndex: 0 }]);
    expect(response.status).toBe(503);
  });
});

describe('commission-rate endpoint', () => {
  it.each([undefined, 'customer', 'employee'])('never returns the rate to %s', async role => {
    const response = await fetch(`${base}/rate`, { headers: role ? { 'x-role': role } : {} });
    expect(response.status).toBe(403);
    expect(await response.text()).not.toMatch(/commissionPercent|13/);
    expect(mocks.config).not.toHaveBeenCalled();
  });

  it('returns the rate to professionals and payments-authorized admins only', async () => {
    expect((await (await fetch(`${base}/rate`, { headers: { 'x-role': 'professional' } })).json()).data.commissionPercent).toBe(13);
    expect((await fetch(`${base}/rate`, { headers: { 'x-role': 'admin' } })).status).toBe(403);
    mocks.access.mockResolvedValue({ payments: true });
    expect((await (await fetch(`${base}/rate`, { headers: { 'x-role': 'admin' } })).json()).data.commissionPercent).toBe(13);
  });
});
