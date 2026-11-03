import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

const mocks = vi.hoisted(() => ({
  validateVATNumber: vi.fn(),
  userFindById: vi.fn(),
  userFindOne: vi.fn(),
}));

vi.mock('../../../utils/viesApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../utils/viesApi')>();
  return { ...actual, validateVATNumber: mocks.validateVATNumber };
});
vi.mock('../../../config/db', () => ({ default: vi.fn(async () => undefined) }));
vi.mock('../../../models/user', () => ({
  default: { findById: mocks.userFindById, findOne: mocks.userFindOne },
}));
vi.mock('../../../utils/support/accountGuard', () => ({
  withAnonymizationWriteFence: vi.fn(async (_ids: unknown, work: (session: null) => unknown) => work(null)),
}));

import { validateAndPopulateVAT } from '../../../handlers/User/validateVat';

const mockRes = () => {
  const res: any = { statusCode: 200, body: undefined };
  res.status = vi.fn((code: number) => { res.statusCode = code; return res; });
  res.json = vi.fn((body: unknown) => { res.body = body; return res; });
  return res as Response & { statusCode: number; body: any };
};

describe('validateAndPopulateVAT address auto-population', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.userFindOne.mockResolvedValue(null);
  });

  it('parses the VIES address with the VAT country, not the stored profile country', async () => {
    const user: any = {
      _id: '507f1f77bcf86cd799439011',
      email: 'pro@example.test',
      role: 'professional',
      username: 'existing-pro',
      // Stored profile country differs from the VAT registration country.
      businessInfo: { country: 'BE' },
      save: vi.fn(async () => undefined),
    };
    mocks.userFindById.mockResolvedValue(user);
    mocks.validateVATNumber.mockResolvedValue({
      valid: true,
      companyName: 'Tilburg BV',
      companyAddress: 'Stationsstraat 1\n5026SL TILBURG',
    });

    const res = mockRes();
    await validateAndPopulateVAT(
      { user: { id: user._id }, body: { vatNumber: 'NL123456789B01', autoPopulate: true } } as unknown as Request,
      res,
      vi.fn(),
    );

    expect(res.statusCode).toBe(200);
    expect(user.businessInfo).toMatchObject({
      address: 'Stationsstraat 1',
      postalCode: '5026SL',
      city: 'TILBURG',
      // The stored country is kept, never overwritten.
      country: 'BE',
    });
    expect(user.save).toHaveBeenCalledTimes(1);
  });
});
