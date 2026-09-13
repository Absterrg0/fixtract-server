import { beforeEach, describe, expect, it, vi } from 'vitest';

const { userFindOne, userCreate } = vi.hoisted(() => ({
  userFindOne: vi.fn(),
  userCreate: vi.fn(),
}));

vi.mock('../../../models/user', () => ({
  default: {
    findOne: userFindOne,
    create: userCreate,
  },
}));

vi.mock('bcrypt', () => ({
  default: { hash: vi.fn().mockResolvedValue('hashed-password') },
}));

vi.mock('../../../utils/emailService', () => ({
  generateOTP: vi.fn(() => '123456'),
  sendOTPEmail: vi.fn().mockResolvedValue(true),
  sendWelcomeEmail: vi.fn().mockResolvedValue(true),
  sendIdExpiredEmail: vi.fn(),
}));

vi.mock('../../../utils/referralSystem', () => ({
  generateReferralCode: vi.fn().mockResolvedValue('FIX-ABC123'),
  validateReferralCode: vi.fn(),
  createReferral: vi.fn(),
}));

vi.mock('../../../utils/functions', () => ({
  default: vi.fn(() => 'jwt-token'),
}));

vi.mock('../../../utils/bookingBlocks', () => ({
  buildBookingBlockedRanges: vi.fn().mockResolvedValue([]),
}));

vi.mock('twilio', () => ({
  default: vi.fn(() => ({
    verify: { v2: { services: () => ({ verifications: { create: vi.fn().mockResolvedValue({}) } }) } },
  })),
}));

import { SignUp } from '../../../handlers/Auth';

function resMock() {
  const res: Record<string, unknown> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.cookie = vi.fn().mockReturnValue(res);
  return res as any;
}

describe('SignUp phone uniqueness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    userCreate.mockResolvedValue({
      _id: 'user-2',
      name: 'Second User',
      email: 'second@example.com',
      phone: '+32470123456',
      role: 'customer',
      isEmailVerified: false,
      isPhoneVerified: false,
      save: vi.fn().mockResolvedValue(undefined),
    });
  });

  it('allows creating an account when another user already has the same phone', async () => {
    userFindOne.mockImplementation(async (query: { email?: string; phone?: string }) => {
      if (query.phone) {
        return { _id: 'user-1', phone: query.phone };
      }
      return null;
    });

    const res = resMock();
    await SignUp(
      {
        body: {
          name: 'Second User',
          password: 'secret123',
          email: 'second@example.com',
          phone: '+32470123456',
          role: 'customer',
        },
      } as any,
      res,
      vi.fn(),
    );

    expect(userCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'second@example.com',
        phone: '+32470123456',
      }),
    );
    expect(res.status).toHaveBeenCalledWith(201);
  });
});
