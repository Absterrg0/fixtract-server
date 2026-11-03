import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

const CUSTOMER_ID = '507f1f77bcf86cd799439011';

const mocks = vi.hoisted(() => ({
  claimFind: vi.fn(),
  claimCount: vi.fn(),
  claimExists: vi.fn(),
  claimDistinct: vi.fn(),
  bookingFind: vi.fn(),
  projectFind: vi.fn(),
}));

vi.mock('../../../models/warrantyClaim', () => ({
  default: {
    find: mocks.claimFind,
    countDocuments: mocks.claimCount,
    exists: mocks.claimExists,
    distinct: mocks.claimDistinct,
  },
}));

vi.mock('../../../models/booking', () => ({
  default: { find: mocks.bookingFind },
}));

vi.mock('../../../models/project', () => ({
  default: { find: mocks.projectFind },
}));

vi.mock('../../../models/conversation', () => ({ default: {} }));
vi.mock('../../../models/chatMessage', () => ({ default: {} }));
vi.mock('../../../models/user', () => ({ default: { findById: vi.fn() } }));

import { listMyWarrantyClaims } from '../../../handlers/WarrantyClaim';

const mockRes = () => {
  const res: any = {
    statusCode: 200,
    body: undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res as Response & { statusCode: number; body: any };
};

const claimChain = (rows: any[]) => {
  const chain: any = {};
  chain.populate = vi.fn(() => chain);
  chain.sort = vi.fn(() => chain);
  chain.skip = vi.fn(() => chain);
  chain.limit = vi.fn(async () => rows.map((row) => ({ ...row })));
  return chain;
};

describe('warranty claim search and filters', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.claimFind.mockReturnValue(claimChain([]));
    mocks.claimCount.mockResolvedValue(0);
    mocks.bookingFind.mockReturnValue({ select: vi.fn(() => ({ lean: vi.fn(async () => []) })) });
    mocks.projectFind.mockReturnValue({ select: vi.fn(() => ({ lean: vi.fn(async () => []) })) });
  });

  it('searches by escaped claim number without regex injection', async () => {
    const res = mockRes();
    await listMyWarrantyClaims(
      { user: { _id: CUSTOMER_ID, role: 'customer' }, query: { q: 'WC-2026.1 (x)' } } as unknown as Request,
      res,
    );
    expect(res.statusCode).toBe(200);
    const query = mocks.claimFind.mock.calls[0][0];
    const searchOr = query.$and[0].$or;
    expect(String(searchOr[0].claimNumber)).toContain('WC-2026\\.1 \\(x\\)');
    // Role scoping preserved.
    expect(String(query.customer)).toContain(CUSTOMER_ID.slice(-6));
  });

  it('resolves booking-number text through the viewer own bookings', async () => {
    mocks.bookingFind.mockReturnValue({
      select: vi.fn(() => ({ lean: vi.fn(async () => [{ _id: 'b9' }]) })),
    });
    const res = mockRes();
    await listMyWarrantyClaims(
      { user: { _id: CUSTOMER_ID, role: 'customer' }, query: { q: 'BK-9' } } as unknown as Request,
      res,
    );
    expect(res.statusCode).toBe(200);
    const query = mocks.claimFind.mock.calls[0][0];
    const bookingClause = query.$and[0].$or.find((clause: any) => clause.booking);
    expect(bookingClause).toBeTruthy();
    const bookingScope = mocks.bookingFind.mock.calls[0][0];
    expect(String(bookingScope.customer)).toContain(CUSTOMER_ID.slice(-6));
  });

  it('scopes the service filter to the viewer claims without global id lists', async () => {
    mocks.claimDistinct.mockResolvedValue(['b1', 'b2', 'b3']);
    const bookingLean = vi.fn(async () => [
      { _id: 'b1', rfqData: { serviceType: 'Cleaning' } },
      { _id: 'b2', project: 'p2' },
      { _id: 'b3', project: 'p3' },
    ]);
    const bookingSelect = vi.fn(() => ({ lean: bookingLean }));
    mocks.bookingFind.mockReturnValue({ select: bookingSelect });
    mocks.projectFind.mockReturnValue({ select: vi.fn(() => ({ lean: vi.fn(async () => [{ _id: 'p2' }]) })) });
    const res = mockRes();
    await listMyWarrantyClaims(
      { user: { _id: CUSTOMER_ID, role: 'customer' }, query: { service: 'Cleaning' } } as unknown as Request,
      res,
    );
    expect(res.statusCode).toBe(200);
    // Candidate bookings come from the customer's own claims.
    const claimScope = mocks.claimDistinct.mock.calls[0];
    expect(claimScope[0]).toBe('booking');
    expect(String(claimScope[1].customer)).toBe(CUSTOMER_ID);
    expect(mocks.bookingFind.mock.calls[0][0]).toEqual({ _id: { $in: ['b1', 'b2', 'b3'] } });
    // Project service lookup is limited to the candidates' own projects.
    expect(mocks.projectFind.mock.calls[0][0]).toEqual({ _id: { $in: ['p2', 'p3'] }, service: 'Cleaning' });
    const query = mocks.claimFind.mock.calls[0][0];
    expect(query.booking).toEqual({ $in: ['b1', 'b2'] });
    expect(String(query.customer)).toBe(CUSTOMER_ID);
  });

  it('narrows the service filter to a requested bookingId before any lookup', async () => {
    const BOOKING_ID = '507f1f77bcf86cd799439099';
    mocks.bookingFind.mockReturnValue({
      select: vi.fn(() => ({ lean: vi.fn(async () => [{ _id: BOOKING_ID, rfqData: { serviceType: 'Plumbing' } }]) })),
    });
    const res = mockRes();
    await listMyWarrantyClaims(
      { user: { _id: CUSTOMER_ID, role: 'customer' }, query: { service: 'Cleaning', bookingId: BOOKING_ID } } as unknown as Request,
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(mocks.claimDistinct).not.toHaveBeenCalled();
    expect(String(mocks.bookingFind.mock.calls[0][0]._id.$in[0])).toBe(BOOKING_ID);
    expect(mocks.projectFind).not.toHaveBeenCalled();
    expect(mocks.claimFind.mock.calls[0][0].booking).toEqual({ $in: [] });
  });
});
