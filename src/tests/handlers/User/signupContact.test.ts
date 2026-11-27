import { beforeEach, describe, expect, it, vi } from 'vitest';

const { userFindById, userFindOne, sendOTPEmail, twilioCreate } = vi.hoisted(() => ({
  userFindById: vi.fn(),
  userFindOne: vi.fn(),
  sendOTPEmail: vi.fn(),
  twilioCreate: vi.fn(),
}));

vi.mock('../../../models/user', () => ({
  default: { findById: userFindById, findOne: userFindOne },
}));
vi.mock('../../../config/db', () => ({ default: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../utils/emailService', () => ({
  generateOTP: vi.fn(() => '654321'),
  sendOTPEmail,
}));
vi.mock('../../../utils/support/accountGuard', () => ({
  withAnonymizationWriteFence: (_ids: unknown, write: (session: undefined) => Promise<unknown>) => write(undefined),
}));
vi.mock('twilio', () => ({
  default: vi.fn(() => ({
    verify: { v2: { services: () => ({ verifications: { create: twilioCreate } }) } },
  })),
}));

import { normalizeSignupPhone, updateSignupContact } from '../../../handlers/User/signupContact';

function resMock() {
  const res: Record<string, unknown> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as any;
}

const call = async (body: Record<string, unknown>, userId: string | null = 'user-1') => {
  const res = resMock();
  await updateSignupContact({ body, user: userId ? { id: userId } : undefined } as any, res);
  return res;
};

const takenQuery = (result: unknown) => ({ select: () => ({ lean: async () => result }) });

describe('updateSignupContact (FT2-6C back from the OTP step)', () => {
  let user: Record<string, any>;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.TWILIO_ACCOUNT_SID = 'AC';
    process.env.TWILIO_AUTH_TOKEN = 'token';
    process.env.TWILIO_VERIFY_SERVICE_SID = 'VA';
    sendOTPEmail.mockResolvedValue(true);
    twilioCreate.mockResolvedValue({});
    user = {
      _id: 'user-1',
      name: 'New Customer',
      role: 'customer',
      email: 'typo@exmaple.com',
      phone: '+32470123456',
      isEmailVerified: false,
      isPhoneVerified: false,
      verificationCode: '111111',
      save: vi.fn().mockResolvedValue(undefined),
    };
    userFindById.mockResolvedValue(user);
    userFindOne.mockReturnValue(takenQuery(null));
  });

  it('corrects the email of the signed-in unverified account and sends a fresh code', async () => {
    const res = await call({ email: ' Right@Example.com ', phone: '+32470123456' });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(user.email).toBe('right@example.com');
    expect(user.verificationCode).toBe('654321');
    expect(user.verificationCodeExpires).toBeInstanceOf(Date);
    expect(user.save).toHaveBeenCalledTimes(1);
    expect(sendOTPEmail).toHaveBeenCalledWith('right@example.com', '654321', 'New Customer');
    // Phone unchanged: no new SMS.
    expect(twilioCreate).not.toHaveBeenCalled();
    expect(res.json.mock.calls[0][0].data).toMatchObject({ email: 'right@example.com', emailChanged: true, phoneChanged: false, emailOtpSent: true });
  });

  it('changes the phone to E.164 and texts a new code, leaving a verified email alone', async () => {
    user.isEmailVerified = true;
    const res = await call({ email: 'typo@exmaple.com', phone: '+32 471 23 45 67' });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(user.phone).toBe('+32471234567');
    expect(user.isPhoneVerified).toBe(false);
    expect(twilioCreate).toHaveBeenCalledWith({ channel: 'sms', to: '+32471234567' });
    expect(sendOTPEmail).not.toHaveBeenCalled();
  });

  it('refuses an email that belongs to another account', async () => {
    userFindOne.mockReturnValue(takenQuery({ _id: 'other' }));
    const res = await call({ email: 'taken@example.com' });
    expect(res.status).toHaveBeenCalledWith(409);
    expect(user.save).not.toHaveBeenCalled();
    expect(userFindOne).toHaveBeenCalledWith({ email: 'taken@example.com', _id: { $ne: 'user-1' } });
  });

  it('never changes a channel that is already verified', async () => {
    user.isEmailVerified = true;
    const res = await call({ email: 'other@example.com' });
    expect(res.status).toHaveBeenCalledWith(409);
    expect(user.email).toBe('typo@exmaple.com');
  });

  it('is closed once the account is fully verified, and for staff roles', async () => {
    user.isEmailVerified = true;
    user.isPhoneVerified = true;
    expect((await call({ email: 'x@example.com' })).status).toHaveBeenCalledWith(409);
    user.isEmailVerified = false;
    user.role = 'admin';
    expect((await call({ email: 'x@example.com' })).status).toHaveBeenCalledWith(403);
  });

  it('validates input and requires a session', async () => {
    expect((await call({ email: 'x@example.com' }, null)).status).toHaveBeenCalledWith(401);
    expect((await call({})).status).toHaveBeenCalledWith(400);
    expect((await call({ email: 'not-an-email' })).status).toHaveBeenCalledWith(400);
    expect((await call({ phone: '0470123456' })).status).toHaveBeenCalledWith(400);
    expect(user.save).not.toHaveBeenCalled();
  });

  it('normalizes only valid international numbers', () => {
    expect(normalizeSignupPhone('+32470123456')).toBe('+32470123456');
    expect(normalizeSignupPhone('+31 6 12345678')).toBe('+31612345678');
    expect(normalizeSignupPhone('0470123456')).toBeNull();
    expect(normalizeSignupPhone('+3247')).toBeNull();
  });
});
