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

import { validateAndPopulateVAT, validateVAT } from '../../../handlers/User/validateVat';

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

  it('keeps "LA HULPE" as the city for a Belgian VIES address on both auto-population paths', async () => {
    mocks.validateVATNumber.mockResolvedValue({
      valid: true,
      companyName: 'Hulpe SRL',
      companyAddress: 'Rue de la Station 1\n1310 LA HULPE',
    });

    const professional: any = {
      _id: '507f1f77bcf86cd799439012',
      email: 'pro-be@example.test',
      role: 'professional',
      username: 'existing-be-pro',
      businessInfo: {},
      save: vi.fn(async () => undefined),
    };
    mocks.userFindById.mockResolvedValue(professional);
    let res = mockRes();
    await validateAndPopulateVAT(
      { user: { id: professional._id }, body: { vatNumber: 'BE0123456789', autoPopulate: true } } as unknown as Request,
      res,
      vi.fn(),
    );
    expect(res.statusCode).toBe(200);
    expect(professional.businessInfo).toMatchObject({
      address: 'Rue de la Station 1',
      postalCode: '1310',
      city: 'LA HULPE',
      country: 'BE',
    });

    const business: any = {
      _id: '507f1f77bcf86cd799439013',
      email: 'customer-be@example.test',
      role: 'customer',
      customerType: 'business',
      companyAddress: {},
      save: vi.fn(async () => undefined),
    };
    mocks.userFindById.mockResolvedValue(business);
    res = mockRes();
    await validateAndPopulateVAT(
      { user: { id: business._id }, body: { vatNumber: 'BE0123456789', autoPopulate: true } } as unknown as Request,
      res,
      vi.fn(),
    );
    expect(res.statusCode).toBe(200);
    expect(business.companyAddress).toMatchObject({
      address: 'Rue de la Station 1',
      postalCode: '1310',
      city: 'LA HULPE',
      country: 'BE',
    });
  });
});

describe('validateVAT address preview', () => {
  it('returns the Belgian postcode and full city for "1300 LA HULPE"', async () => {
    mocks.validateVATNumber.mockResolvedValue({
      valid: true,
      companyName: 'Hulpe SRL',
      companyAddress: 'Avenue 2\n1300 LA HULPE',
    });
    const res = mockRes();
    await validateVAT({ body: { vatNumber: 'BE0123456789' } } as unknown as Request, res, vi.fn());
    expect(res.statusCode).toBe(200);
    expect(res.body.data.parsedAddress).toMatchObject({
      postalCode: '1300',
      city: 'LA HULPE',
      country: 'BE',
    });
  });
});
