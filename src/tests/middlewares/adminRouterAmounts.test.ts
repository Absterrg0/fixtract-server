import { beforeEach, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';

const mocks = vi.hoisted(() => ({
  findById: vi.fn(),
  resolveBookingAdminAccess: vi.fn(),
}));
vi.mock('../../config/db', () => ({ default: vi.fn(async () => undefined) }));
vi.mock('../../models/user', () => ({ default: { findById: mocks.findById } }));
vi.mock('../../utils/bookingDetails/adminAccess', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/bookingDetails/adminAccess')>()),
  resolveBookingAdminAccess: mocks.resolveBookingAdminAccess,
}));

import { requireAdmin } from '../../handlers/Admin/professionalApprovals';
import { commissionVisibility } from '../../middlewares/commissionVisibility';

const disputeBody = () => ({
  disputes: [{
    _id: 'b1',
    extraCosts: [{ type: 'other', name: 'Access', amount: 100, unitPrice: 100 }],
    extraCostTotal: 100,
    payment: { amount: 830.06, platformCommission: 12.5, professionalPayout: 800 },
  }],
});

/** Runs the real `/api` boundary and the real admin-router auth on one request. */
const runAdminRequest = async (payments: boolean) => {
  process.env.JWT_SECRET = 'test-secret-admin-amounts';
  const admin = { _id: 'admin-1', role: 'admin', adminRole: 'super_admin', accountStatus: 'approved' };
  mocks.findById.mockResolvedValue(admin);
  mocks.resolveBookingAdminAccess.mockResolvedValue({ bookings: true, disputes: true, warranty: true, cancellations: true, payments });
  const req: any = { cookies: { 'auth-token': jwt.sign({ id: 'admin-1' }, process.env.JWT_SECRET) }, headers: {} };
  let sent: any;
  const res: any = {
    locals: {},
    status() { return this; },
    json(body: unknown) { sent = body; return this; },
  };
  commissionVisibility(req, res, () => undefined);
  let nextCalled = false;
  await requireAdmin(req, res, () => { nextCalled = true; });
  expect(nextCalled).toBe(true);
  res.json(disputeBody());
  return sent;
};

describe('FT3-13x — admin router responses keep the amounts admins need', () => {
  beforeEach(() => vi.clearAllMocks());

  it('a payments-authorized admin (e.g. super admin) gets extra-cost amounts and commission unchanged', async () => {
    const body = await runAdminRequest(true);
    expect(body.disputes[0].extraCosts[0]).toMatchObject({ amount: 100, unitPrice: 100 });
    expect(body.disputes[0].extraCostTotal).toBe(100);
    expect(body.disputes[0].payment.platformCommission).toBe(12.5);
  });

  it('an admin without payments read still gets extra-cost amounts, but no commission', async () => {
    const body = await runAdminRequest(false);
    expect(body.disputes[0].extraCosts[0]).toMatchObject({ amount: 100, unitPrice: 100 });
    expect(body.disputes[0].extraCostTotal).toBe(100);
    expect(body.disputes[0].payment.professionalPayout).toBe(800);
    expect(body.disputes[0].payment).not.toHaveProperty('platformCommission');
  });

  it('a customer still gets the customer view', () => {
    const req: any = { user: { _id: 'c1', role: 'customer' } };
    let sent: any;
    const res: any = { locals: {}, json(body: unknown) { sent = body; return this; } };
    commissionVisibility(req, res, () => undefined);
    res.json(disputeBody());
    expect(sent.disputes[0].extraCosts[0]).not.toHaveProperty('amount');
    expect(sent.disputes[0]).not.toHaveProperty('extraCostTotal');
  });
});
