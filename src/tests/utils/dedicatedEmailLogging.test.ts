import { beforeEach, describe, expect, it, vi } from 'vitest';

// Admin > Email logs never listed verification (OTP) or welcome emails: those
// senders called Brevo directly instead of going through the logger.
const brevo = vi.hoisted(() => ({ send: vi.fn(async () => ({})) }));
const logger = vi.hoisted(() => ({ logEmail: vi.fn(async () => undefined) }));

vi.hoisted(() => {
  process.env.EMAIL_DEV_NO_SEND = 'false';
  process.env.BREVO_API_KEY = 'xkeysib-test-not-real';
});

vi.mock('@getbrevo/brevo', () => ({
  TransactionalEmailsApi: class {
    setApiKey() {}
    sendTransacEmail = brevo.send;
  },
  SendSmtpEmail: class {},
  TransactionalEmailsApiApiKeys: { apiKey: 0 },
}));
vi.mock('../../utils/emailLogger', () => logger);

import { sendOTPEmail, sendProfessionalWelcomeEmail, sendWelcomeEmail } from '../../utils/emailService';

describe('dedicated senders write the email log', () => {
  beforeEach(() => {
    brevo.send.mockReset();
    brevo.send.mockImplementation(async () => ({}));
    logger.logEmail.mockClear();
  });

  it('logs a sent verification code, welcome and professional welcome email', async () => {
    expect(await sendOTPEmail('new@example.test', '123456', 'New User')).toBe(true);
    expect(await sendWelcomeEmail('new@example.test', 'New User')).toBe(true);
    expect(await sendProfessionalWelcomeEmail('pro@example.test', 'Pro')).toBe(true);
    expect(logger.logEmail.mock.calls.map(([entry]: any[]) => [entry.to, entry.template, entry.status])).toEqual([
      ['new@example.test', 'otp', 'sent'],
      ['new@example.test', 'welcome', 'sent'],
      ['pro@example.test', 'professional_welcome', 'sent'],
    ]);
    expect((logger.logEmail.mock.calls[0] as any[])[0].subject).toBe('Verify Your Fixtract Account');
    // The code itself is never written to the log.
    expect(JSON.stringify(logger.logEmail.mock.calls)).not.toContain('123456');
  });

  it('logs a failed send and keeps the sender result', async () => {
    brevo.send.mockImplementation(async () => { throw new Error('401 Unauthorized'); });
    expect(await sendOTPEmail('new@example.test', '654321', 'New User')).toBe(false);
    expect(logger.logEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: 'new@example.test', template: 'otp', status: 'failed', errorMessage: '401 Unauthorized',
    }));
  });
});
