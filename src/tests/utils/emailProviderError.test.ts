import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const brevo = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock('@getbrevo/brevo', () => ({
  TransactionalEmailsApi: class {
    setApiKey() {}
    sendTransacEmail = brevo.send;
  },
  SendSmtpEmail: class {},
  TransactionalEmailsApiApiKeys: { apiKey: 0 },
}));

const logs = vi.hoisted(() => ({ entries: [] as any[] }));
vi.mock('../../utils/emailLogger', () => ({
  logEmail: vi.fn(async (entry: any) => { logs.entries.push(entry); }),
}));

import { describeEmailProviderError } from '../../utils/emailProviderError';

/** Shape of @getbrevo/brevo v3 HttpError (message is always generic). */
const httpError = (statusCode: number, body: unknown) => {
  const error: any = new Error('HTTP request failed');
  error.name = 'HttpError';
  error.statusCode = statusCode;
  error.body = body;
  error.response = {
    statusCode,
    req: { _header: 'POST /v3/smtp/email HTTP/1.1\r\napi-key: xkeysib-SECRETSECRETSECRET-abc\r\n' },
  };
  return error;
};

describe('describeEmailProviderError', () => {
  it('separates provider configuration from recipient and transient failures', () => {
    expect(describeEmailProviderError(httpError(401, { code: 'unauthorized', message: 'Key not found' })))
      .toMatchObject({ kind: 'provider_auth', statusCode: 401, code: 'unauthorized', message: 'Brevo HTTP 401 [provider_auth] unauthorized: Key not found' });
    expect(describeEmailProviderError(httpError(402, { code: 'not_enough_credits', message: 'No credits' })).kind)
      .toBe('provider_account');
    expect(describeEmailProviderError(httpError(400, { code: 'invalid_parameter', message: 'email is not valid in to' })))
      .toMatchObject({ kind: 'request_rejected', message: 'Brevo HTTP 400 [request_rejected] invalid_parameter: email is not valid in to' });
    expect(describeEmailProviderError(httpError(429, '{"code":"too_many_requests","message":"slow down"}')))
      .toMatchObject({ kind: 'rate_limited', code: 'too_many_requests' });
    expect(describeEmailProviderError(httpError(503, 'Service Unavailable')).kind).toBe('provider_unavailable');
    expect(describeEmailProviderError(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })))
      .toMatchObject({ kind: 'network', message: 'Email provider unreachable (ECONNREFUSED)' });
  });

  it('never includes request headers, keys or URL query tokens', () => {
    const described = describeEmailProviderError(httpError(401, {
      code: 'unauthorized',
      message: 'Key xkeysib-abcdefabcdef-123 rejected; see https://meet.example.com/j/1?pwd=topsecret',
    }));
    expect(described.message).not.toMatch(/SECRET|xkeysib-|pwd=|topsecret|api-key/);
    expect(described.message).toContain('https://meet.example.com/j/1');
  });
});

describe('sendEmail provider failure logging', () => {
  let consoleError: ReturnType<typeof vi.spyOn>;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    logs.entries.length = 0;
    brevo.send.mockReset();
    process.env.EMAIL_DEV_NO_SEND = 'false';
    process.env.BREVO_API_KEY = 'xkeysib-test-not-real';
    process.env.NODE_ENV = 'production';
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    consoleError.mockRestore();
  });

  it.each([true, false])('records the HTTP status/reason and never logs the raw error (redactLogUrls=%s)', async (redactLogUrls) => {
    brevo.send.mockRejectedValue(httpError(401, { code: 'unauthorized', message: 'Unable to send email. Your IP address is not in the list of authorized IPs' }));
    const { sendEmail } = await import('../../utils/emailService');
    const sent = await sendEmail('user@example.com', 'Ticket received', '<p>Hi</p>', { template: 'support_ticket_ack', redactLogUrls });

    expect(sent).toBe(false);
    const failed = logs.entries.find((entry) => entry.status === 'failed');
    expect(failed.errorMessage).toBe(
      'Brevo HTTP 401 [provider_auth] unauthorized: Unable to send email. Your IP address is not in the list of authorized IPs',
    );
    for (const call of consoleError.mock.calls) {
      for (const arg of call) {
        expect(typeof arg).toBe('string');
        expect(String(arg)).not.toMatch(/xkeysib|api-key/);
      }
    }
  });

  it('logs a missing provider key as a failure without calling the provider', async () => {
    delete process.env.BREVO_API_KEY;
    const { sendEmail } = await import('../../utils/emailService');
    expect(await sendEmail('user@example.com', 'Ticket received', '<p>Hi</p>', { template: 'support_ticket_ack' })).toBe(false);
    expect(brevo.send).not.toHaveBeenCalled();
    expect(logs.entries.at(-1)).toMatchObject({ status: 'failed', errorMessage: 'BREVO_API_KEY is not set' });
  });
});
