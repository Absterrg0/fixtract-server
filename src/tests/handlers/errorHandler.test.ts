import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import errorHandler from '../../handlers/error';

function run(
  error: unknown,
  options: { env?: string; path?: string; originalUrl?: string } = {},
) {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = options.env ?? 'production';
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  const res = { headersSent: false, status } as unknown as Response;
  const next = vi.fn() as unknown as NextFunction;
  const req = {
    method: 'POST',
    path: options.path ?? '/api/test',
    originalUrl: options.originalUrl ?? '/api/test?token=secret-token',
  } as Request;
  const logs: unknown[][] = [];

  const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    logs.push(args);
  });
  errorHandler(error, req, res, next);
  spy.mockRestore();
  process.env.NODE_ENV = previous;

  return { status, json, next, payload: json.mock.calls[0]?.[0], logs, logged: JSON.stringify(logs) };
}

describe('global error handler', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns a safe envelope in production and development', () => {
    for (const env of ['production', 'development']) {
      const { status, payload } = run(new Error('MongoServerError: secret token abc'), { env });
      expect(status).toHaveBeenCalledWith(500);
      expect(payload).toEqual({
        success: false,
        msg: 'Something went wrong on our side. Please try again in a moment.',
        message: 'Something went wrong on our side. Please try again in a moment.',
        code: 'INTERNAL',
      });
      expect(JSON.stringify(payload)).not.toContain('secret');
      expect(payload).not.toHaveProperty('stack');
    }
  });

  it('handles non-Error throws', () => {
    const { payload } = run({ nope: true });
    expect(payload.success).toBe(false);
    expect(payload.code).toBe('INTERNAL');
    expect(JSON.stringify(payload)).not.toContain('nope');
  });

  it('does not touch a response that already started', () => {
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));
    const res = { headersSent: true, status } as unknown as Response;
    const next = vi.fn() as unknown as NextFunction;
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    errorHandler(new Error('late'), { method: 'GET', path: '/api/test', originalUrl: '/api/test' } as Request, res, next);
    spy.mockRestore();

    expect(status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  it('maps malformed JSON to a safe 400', () => {
    const { status, payload } = run({ type: 'entity.parse.failed', message: 'Unexpected token <' });
    expect(status).toHaveBeenCalledWith(400);
    expect(payload.msg).toBe('The request body is not valid JSON.');
    expect(payload).not.toHaveProperty('stack');
  });

  it('never logs a malformed request body or the query string', () => {
    const error = Object.assign(new SyntaxError('Unexpected end of JSON input'), {
      type: 'entity.parse.failed',
      status: 400,
      body: '{"email":"a@b.c","password":"hunter2"',
    });

    const { logged } = run(error, {
      path: '/api/auth/login',
      originalUrl: '/api/auth/login?inviteToken=invite-secret',
    });

    expect(logged).toContain('/api/auth/login');
    expect(logged).not.toContain('hunter2');
    expect(logged).not.toContain('password');
    expect(logged).not.toContain('a@b.c');
    expect(logged).not.toContain('invite-secret');
    expect(logged).not.toContain('originalUrl');
    expect(logged).toContain('entity.parse.failed');
  });

  it("does not log fake stack frames hidden in a malformed-body message", () => {
    const error = Object.assign(new SyntaxError('Unexpected end of JSON input'), {
      type: 'entity.parse.failed',
      status: 400,
      body: '{"token":"sk_live_body_secret"}',
      stack: [
        'SyntaxError: Unexpected end of JSON input',
        '    at password=hunter2',
        '    at Authorization: Bearer header-secret',
        '    at Bearer frame-secret (/srv/app/fake.ts:1:1)',
        '    at parse (/srv/app/src/bodyParser.ts:12:7)',
      ].join('\n'),
    });

    const { logged } = run(error, {
      path: '/api/auth/login',
      originalUrl: '/api/auth/login?inviteToken=invite-secret',
    });

    expect(logged).toContain('/api/auth/login');
    expect(logged).toContain('entity.parse.failed');
    expect(logged).toContain('/srv/app/src/bodyParser.ts:12:7');
    expect(logged).not.toContain('hunter2');
    expect(logged).not.toContain('header-secret');
    expect(logged).not.toContain('frame-secret');
    expect(logged).not.toContain('sk_live_body_secret');
    expect(logged).not.toContain('invite-secret');
    expect(logged).not.toContain('password');
    expect(logged).not.toContain('Authorization');
  });

  it('never logs provider request config or auth headers', () => {
    const error = Object.assign(new Error('Request failed with status code 401'), {
      name: 'AxiosError',
      code: 'ERR_BAD_REQUEST',
      status: 401,
      config: {
        url: 'https://provider.example/invoices',
        headers: { Authorization: 'Bearer provider-secret-token', 'X-Api-Key': 'provider-api-key' },
        data: { account: 'secret-account' },
      },
      response: { status: 401, data: { message: 'invalid provider credentials' } },
    });

    const { logged } = run(error);
    expect(logged).not.toContain('provider-secret-token');
    expect(logged).not.toContain('provider-api-key');
    expect(logged).not.toContain('secret-account');
    expect(logged).not.toContain('invalid provider credentials');
    expect(logged).toContain('AxiosError');
    expect(logged).toContain('ERR_BAD_REQUEST');
  });
});
