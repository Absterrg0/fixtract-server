import { describe, expect, it } from 'vitest';
import {
  adminInviteExpiresAt,
  buildAdminInviteUrl,
  generateAdminInviteToken,
  hashAdminInviteToken,
} from '../../../utils/adminRbac/inviteToken';

describe('admin invite token helpers', () => {
  it('hashes tokens deterministically', () => {
    const token = 'sample-invite-token';
    expect(hashAdminInviteToken(token)).toBe(hashAdminInviteToken(token));
    expect(hashAdminInviteToken(token)).not.toBe(hashAdminInviteToken('other-token'));
  });

  it('generates unique tokens', () => {
    const a = generateAdminInviteToken();
    const b = generateAdminInviteToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(20);
  });

  it('builds invite URLs with encoded token', () => {
    const url = buildAdminInviteUrl('abc/def');
    expect(url).toContain('/admin/accept-invite?token=abc%2Fdef');
  });

  it('expires invites after seven days by default', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const expires = adminInviteExpiresAt(now);
    expect(expires.getTime() - now.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
  });
});
