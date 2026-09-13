import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.TWILIO_ACCOUNT_SID = 'ACtest';
  process.env.TWILIO_AUTH_TOKEN = 'token';
  process.env.TWILIO_VERIFY_SERVICE_SID = 'VAtest';
});

const { verificationCreate, verificationCheckCreate, userFindByIdAndUpdate } = vi.hoisted(() => ({
  verificationCreate: vi.fn().mockResolvedValue({}),
  verificationCheckCreate: vi.fn().mockResolvedValue({ status: 'approved' }),
  userFindByIdAndUpdate: vi.fn().mockResolvedValue({}),
}));

vi.mock('twilio', () => ({
  default: vi.fn(() => ({
    verify: {
      v2: {
        services: () => ({
          verifications: { create: verificationCreate },
          verificationChecks: { create: verificationCheckCreate },
        }),
      },
    },
  })),
}));

vi.mock('../../../models/user', () => ({
  default: {
    findByIdAndUpdate: userFindByIdAndUpdate,
  },
}));

import { VerifyPhone, VerifyPhoneCheck } from '../../../handlers/User/verify/phone';

function resMock() {
  const res: Record<string, unknown> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as any;
}

const sharedPhone = '+32470123456';
const account = { _id: 'user-42', phone: sharedPhone };

describe('phone OTP verification with shared numbers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verificationCreate.mockResolvedValue({});
    verificationCheckCreate.mockResolvedValue({ status: 'approved' });
  });

  it('sends OTP for the authenticated account even if another user shares the phone', async () => {
    const res = resMock();
    await VerifyPhone(
      { body: { phone: sharedPhone }, user: account } as any,
      res,
      vi.fn(),
    );

    expect(verificationCreate).toHaveBeenCalledWith({
      channel: 'sms',
      to: sharedPhone,
    });
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('marks the authenticated user verified instead of looking up by phone', async () => {
    const res = resMock();
    await VerifyPhoneCheck(
      { body: { phone: sharedPhone, otp: '123456' }, user: account } as any,
      res,
      vi.fn(),
    );

    expect(verificationCheckCreate).toHaveBeenCalledWith({
      code: '123456',
      to: sharedPhone,
    });
    expect(userFindByIdAndUpdate).toHaveBeenCalledWith('user-42', { isPhoneVerified: true });
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('rejects OTP for a phone that does not belong to the authenticated account', async () => {
    const res = resMock();
    await VerifyPhoneCheck(
      { body: { phone: '+32470999999', otp: '123456' }, user: account } as any,
      res,
      vi.fn(),
    );

    expect(verificationCheckCreate).not.toHaveBeenCalled();
    expect(userFindByIdAndUpdate).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });
});
