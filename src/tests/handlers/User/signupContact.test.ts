import { beforeEach, describe, expect, it, vi } from 'vitest';

const { userFindById, userFindOne, userFindOneAndUpdate, sendOTPEmail, twilioCreate } = vi.hoisted(() => ({
  userFindById: vi.fn(),
  userFindOne: vi.fn(),
  userFindOneAndUpdate: vi.fn(),
  sendOTPEmail: vi.fn(),
  twilioCreate: vi.fn(),
}));

vi.mock('../../../models/user', () => ({
  default: { findById: userFindById, findOne: userFindOne, findOneAndUpdate: userFindOneAndUpdate },
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

/**
 * In-memory stand-in for the stored user: findOneAndUpdate applies $set only
 * when every filter field still matches, like MongoDB does.
 */
function storedUserWrites(stored: Record<string, any>) {
  userFindOneAndUpdate.mockImplementation((filter: Record<string, any>, update: { $set: Record<string, unknown> }) => ({
    lean: async () => {
      const matches = Object.entries(filter).every(([key, value]) => {
        const actual = stored[key];
        if (value instanceof Date || actual instanceof Date) {
          return new Date(actual ?? 0).getTime() === new Date(value ?? 0).getTime() && (actual == null) === (value == null);
        }
        return (actual ?? null) === (value ?? null);
      });
      if (!matches) return null;
      Object.assign(stored, update.$set);
      return { ...stored };
    },
  }));
}

describe('updateSignupContact (FT2-6C back from the OTP step)', () => {
  let user: Record<string, any>;
  let stored: Record<string, any>;

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
    };
    stored = { ...user };
    userFindById.mockImplementation(async () => ({ ...stored }));
    userFindOne.mockReturnValue(takenQuery(null));
    storedUserWrites(stored);
  });

  it('corrects the email of the signed-in unverified account and sends a fresh code', async () => {
    const res = await call({ email: ' Right@Example.com ', phone: '+32470123456' });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(stored.email).toBe('right@example.com');
    expect(stored.isEmailVerified).toBe(false);
    expect(stored.verificationCode).toBe('654321');
    expect(stored.verificationCodeExpires).toBeInstanceOf(Date);
    expect(userFindOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(userFindOneAndUpdate.mock.calls[0][0]).toMatchObject({ _id: 'user-1', email: 'typo@exmaple.com', isEmailVerified: false });
    expect(sendOTPEmail).toHaveBeenCalledWith('right@example.com', '654321', 'New Customer');
    // Phone unchanged: no new SMS.
    expect(twilioCreate).not.toHaveBeenCalled();
    expect(res.json.mock.calls[0][0].data).toMatchObject({ email: 'right@example.com', emailChanged: true, phoneChanged: false, emailOtpSent: true });
  });

  it('changes the phone to E.164 and texts a new code, leaving a verified email alone', async () => {
    stored.isEmailVerified = true;
    const res = await call({ email: 'typo@exmaple.com', phone: '+32 471 23 45 67' });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(stored.phone).toBe('+32471234567');
    expect(stored.isPhoneVerified).toBe(false);
    expect(userFindOneAndUpdate.mock.calls[0][0]).toMatchObject({ phone: '+32470123456', isPhoneVerified: false });
    expect(twilioCreate).toHaveBeenCalledWith({ channel: 'sms', to: '+32471234567' });
    expect(sendOTPEmail).not.toHaveBeenCalled();
  });

  it('rate-limits repeated email changes so it cannot mail addresses in a loop', async () => {
    stored.verificationCodeExpires = new Date(Date.now() + 10 * 60 * 1000 - 5_000);
    const res = await call({ email: 'other@example.com' });
    expect(res.status).toHaveBeenCalledWith(429);
    expect(stored.email).not.toBe('other@example.com');
    expect(sendOTPEmail).not.toHaveBeenCalled();
    expect(userFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it('refuses an email that belongs to another account', async () => {
    userFindOne.mockReturnValue(takenQuery({ _id: 'other' }));
    const res = await call({ email: 'taken@example.com' });
    expect(res.status).toHaveBeenCalledWith(409);
    expect(userFindOneAndUpdate).not.toHaveBeenCalled();
    expect(userFindOne).toHaveBeenCalledWith({ email: 'taken@example.com', _id: { $ne: 'user-1' } });
  });

  it('never changes a channel that is already verified', async () => {
    stored.isEmailVerified = true;
    const res = await call({ email: 'other@example.com' });
    expect(res.status).toHaveBeenCalledWith(409);
    expect(stored.email).toBe('typo@exmaple.com');
  });

  it('is closed once the account is fully verified, and for staff roles', async () => {
    stored.isEmailVerified = true;
    stored.isPhoneVerified = true;
    expect((await call({ email: 'x@example.com' })).status).toHaveBeenCalledWith(409);
    stored.isEmailVerified = false;
    stored.role = 'admin';
    expect((await call({ email: 'x@example.com' })).status).toHaveBeenCalledWith(403);
  });

  it('validates input and requires a session', async () => {
    expect((await call({ email: 'x@example.com' }, null)).status).toHaveBeenCalledWith(401);
    expect((await call({})).status).toHaveBeenCalledWith(400);
    expect((await call({ email: 'not-an-email' })).status).toHaveBeenCalledWith(400);
    expect((await call({ phone: '0470123456' })).status).toHaveBeenCalledWith(400);
    expect(userFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it('refuses with 409 when the email is verified between the read and the write', async () => {
    // 1. updateSignupContact reads the unverified user; 2. verifyEmailOTP
    // verifies the old address before the uniqueness check returns; 3. the
    // contact write must miss instead of moving the verified flag to the new email.
    userFindOne.mockImplementation(() => {
      stored.isEmailVerified = true;
      return takenQuery(null);
    });
    const res = await call({ email: 'new@example.com' });
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json.mock.calls[0][0].msg).toBe('Your contact details changed meanwhile. Please reload and try again.');
    expect(stored).toMatchObject({ email: 'typo@exmaple.com', isEmailVerified: true, verificationCode: '111111' });
    expect(sendOTPEmail).not.toHaveBeenCalled();
    expect(twilioCreate).not.toHaveBeenCalled();
  });

  it('refuses with 409 when the phone is verified between the read and the write', async () => {
    userFindById.mockImplementation(async () => {
      const snapshot = { ...stored };
      stored.isPhoneVerified = true;
      return snapshot;
    });
    const res = await call({ phone: '+32471234567' });
    expect(res.status).toHaveBeenCalledWith(409);
    expect(stored).toMatchObject({ phone: '+32470123456', isPhoneVerified: true });
    expect(twilioCreate).not.toHaveBeenCalled();
  });

  it('normalizes only valid international numbers', () => {
    expect(normalizeSignupPhone('+32470123456')).toBe('+32470123456');
    expect(normalizeSignupPhone('+31 6 12345678')).toBe('+31612345678');
    expect(normalizeSignupPhone('0470123456')).toBeNull();
    expect(normalizeSignupPhone('+3247')).toBeNull();
  });
});
