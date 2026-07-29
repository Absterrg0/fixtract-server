import { describe, expect, it } from 'vitest';
import {
  generateUnsubscribeToken,
  signUnsubscribePayload,
  verifyUnsubscribePayload,
} from '../../../utils/marketing/unsubscribeToken';

describe('unsubscribeToken', () => {
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

  it('rejects tampered tokens', () => {
    const token = signUnsubscribePayload('a@b.com');
    const [payload] = token.split('.');
    const result = verifyUnsubscribePayload(`${payload}.deadbeef`);
    expect(result.ok).toBe(false);
  });
});
