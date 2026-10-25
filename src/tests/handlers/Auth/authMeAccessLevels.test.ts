import { beforeEach, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';

const { UserFindById, getCurrentConfig } = vi.hoisted(() => ({
  UserFindById: vi.fn(),
  getCurrentConfig: vi.fn(),
}));

vi.mock('../../../models/user', () => ({
  default: {
    findById: UserFindById,
  },
}));
vi.mock('../../../models/adminRoleAccess', () => ({
  default: { getCurrentConfig },
}));
vi.mock('../../../utils/emailService', () => ({
  generateOTP: vi.fn(),
  sendOTPEmail: vi.fn(),
  sendWelcomeEmail: vi.fn(),
  sendIdExpiredEmail: vi.fn(),
}));
vi.mock('../../../utils/referralSystem', () => ({
  generateReferralCode: vi.fn(),
  validateReferralCode: vi.fn(),
  createReferral: vi.fn(),
}));
vi.mock('../../../utils/bookingBlocks', () => ({
  buildBookingBlockedRanges: vi.fn(async () => []),
}));
vi.mock('../../../utils/functions', () => ({ default: vi.fn(() => 'jwt-token') }));
vi.mock('twilio', () => ({ default: vi.fn(() => ({})) }));

import { getMe } from '../../../handlers/Auth';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const response = () => {
  const res: any = { statusCode: 200, body: undefined };
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.json = vi.fn((body: unknown) => {
    res.body = body;
    return res;
  });
  res.clearCookie = vi.fn();
  return res;
};

const requestFor = (userId: string) => ({
  cookies: { 'auth-token': jwt.sign({ id: userId }, process.env.JWT_SECRET!) },
} as any);

const setUser = (user: Record<string, any>) => {
  UserFindById.mockReturnValue({
    select: vi.fn(async () => user),
  });
};

describe('GET /api/auth/me effective admin access', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getCurrentConfig.mockResolvedValue({ roles: {} });
  });

  it('returns inherited read access from the configured role matrix', async () => {
    setUser({
      _id: '507f1f77bcf86cd799439081',
      name: 'Inherited Read',
      email: 'inherited-read@example.com',
      role: 'admin',
      adminRole: 'care',
      isEmailVerified: true,
    });
    getCurrentConfig.mockResolvedValue({ roles: { care: { support: 'read' } } });

    const res = response();
    await getMe(requestFor('507f1f77bcf86cd799439081'), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.authenticated).toBe(true);
    expect(res.body.user.supportAccessLevel).toBe('read');
    expect(res.body.user.adminAccessLevels.support).toBe('read');
  });

  it('returns inherited none access for a role whose matrix has no support access', async () => {
    setUser({
      _id: '507f1f77bcf86cd799439082',
      name: 'No Support',
      email: 'no-support@example.com',
      role: 'admin',
      adminRole: 'marketing',
      isEmailVerified: true,
    });

    const res = response();
    await getMe(requestFor('507f1f77bcf86cd799439082'), res);

    expect(res.body.user.supportAccessLevel).toBe('none');
    expect(res.body.user.adminAccessLevels.support).toBe('none');
  });

  it('returns inherited write access from the configured role matrix', async () => {
    setUser({
      _id: '507f1f77bcf86cd799439083',
      name: 'Inherited Write',
      email: 'inherited-write@example.com',
      role: 'admin',
      adminRole: 'care',
      isEmailVerified: true,
    });
    getCurrentConfig.mockResolvedValue({ roles: { care: { support: 'write' } } });

    const res = response();
    await getMe(requestFor('507f1f77bcf86cd799439083'), res);

    expect(res.body.user.supportAccessLevel).toBe('write');
    expect(res.body.user.adminAccessLevels.support).toBe('write');
  });

  it('lets an explicit per-admin override win over the role matrix', async () => {
    setUser({
      _id: '507f1f77bcf86cd799439084',
      name: 'Explicit Read',
      email: 'explicit-read@example.com',
      role: 'admin',
      adminRole: 'care',
      adminPermissionLevels: { support: 'read' },
      isEmailVerified: true,
    });
    getCurrentConfig.mockResolvedValue({ roles: { care: { support: 'write' } } });

    const res = response();
    await getMe(requestFor('507f1f77bcf86cd799439084'), res);

    expect(res.body.user.supportAccessLevel).toBe('read');
    expect(res.body.user.adminAccessLevels.support).toBe('read');
  });

  it('keeps superadmin write access', async () => {
    setUser({
      _id: '507f1f77bcf86cd799439085',
      name: 'Super Admin',
      email: 'super@example.com',
      role: 'admin',
      adminRole: 'super',
      isEmailVerified: true,
    });

    const res = response();
    await getMe(requestFor('507f1f77bcf86cd799439085'), res);

    expect(res.body.user.supportAccessLevel).toBe('write');
    expect(res.body.user.adminAccessLevels.support).toBe('write');
  });

  it('does not expose admin levels to non-admin accounts', async () => {
    setUser({
      _id: '507f1f77bcf86cd799439086',
      name: 'Customer',
      email: 'customer@example.com',
      role: 'customer',
      isEmailVerified: true,
    });

    const res = response();
    await getMe(requestFor('507f1f77bcf86cd799439086'), res);

    expect(res.body.user.adminAccessLevels).toBeUndefined();
    expect(res.body.user.supportAccessLevel).toBe('none');
  });
});
