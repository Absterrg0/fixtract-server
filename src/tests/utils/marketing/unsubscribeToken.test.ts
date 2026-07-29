import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  generateUnsubscribeToken,
  signUnsubscribePayload,
  verifyUnsubscribePayload,
} from '../../../utils/marketing/unsubscribeToken';

describe('unsubscribeToken', () => {
  const prevJwt = process.env.JWT_SECRET;

  beforeEach(() => {
    process.env.JWT_SECRET = 'test-jwt-secret-for-unsubscribe';
  });

  afterEach(() => {
    if (prevJwt === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = prevJwt;
    }
  });

  it('generates opaque random tokens', () => {
    const a = generateUnsubscribeToken();
    const b = generateUnsubscribeToken();
    expect(a).toHaveLength(48);
    expect(a).not.toEqual(b);
  });

  it('signs and verifies email payloads', () => {
    const token = signUnsubscribePayload('User@Example.com');
    const result = verifyUnsubscribePayload(token);
    expect(result).toEqual({ ok: true, email: 'user@example.com' });
  });

  it('keeps campaign unsubscribe links valid without an expiry', () => {
    const token = signUnsubscribePayload('old-campaign@example.com');
    const [payload] = token.split('.');
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));

    expect(decoded).toEqual({ email: 'old-campaign@example.com' });
    expect(verifyUnsubscribePayload(token)).toEqual({
      ok: true,
      email: 'old-campaign@example.com',
    });
  });

  it('rejects expired time-bound payloads', () => {
    const token = signUnsubscribePayload('expired@example.com', -1);
    expect(verifyUnsubscribePayload(token)).toEqual({ ok: false, error: 'Token expired' });
  });

  it('rejects tampered tokens', () => {
    const token = signUnsubscribePayload('a@b.com');
    const [payload] = token.split('.');
    const result = verifyUnsubscribePayload(`${payload}.deadbeef`);
    expect(result.ok).toBe(false);
  });

  it('throws when signing without JWT_SECRET', () => {
    delete process.env.JWT_SECRET;
    expect(() => signUnsubscribePayload('a@b.com')).toThrow(/JWT_SECRET/);
  });

  it('returns clear error when verifying without JWT_SECRET', () => {
    const token = signUnsubscribePayload('a@b.com');
    delete process.env.JWT_SECRET;
    const result = verifyUnsubscribePayload(token);
    expect(result).toEqual({ ok: false, error: 'JWT_SECRET is not configured' });
  });
});
