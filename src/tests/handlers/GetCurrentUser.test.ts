import { describe, expect, it, vi } from 'vitest';
import { GetCurrentUser } from '../../handlers';

const response = () => {
  const res: any = {
    statusCode: 200,
    body: undefined,
  };
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.json = vi.fn((body: unknown) => {
    res.body = body;
    return res;
  });
  return res;
};

describe('GET /me effective admin access', () => {
  it('returns support=read levels even though the legacy permission list is write-derived', async () => {
    const res = response();
    const user = {
      _id: '507f1f77bcf86cd799439014',
      name: 'Read Only Support',
      email: 'support-read@example.com',
      role: 'admin',
      adminRole: 'care',
      adminPermissionLevels: { support: 'read', bookings: 'read' },
    };

    await GetCurrentUser({ user } as any, res as any, vi.fn());

    expect(res.statusCode).toBe(200);
    expect(res.body.user.adminAccessLevels).toMatchObject({
      support: 'read',
      bookings: 'read',
    });
    expect(res.body.user.supportAccessLevel).toBe('read');
    // The write-derived legacy array is intentionally unchanged; frontends must
    // gate the read-only page from adminAccessLevels/supportAccessLevel.
    expect(res.body.user.adminPermissions).not.toContain('support.tickets');
  });

  it('returns write level for a support-write admin', async () => {
    const res = response();
    const user = {
      _id: '507f1f77bcf86cd799439015',
      name: 'Support Writer',
      email: 'support-write@example.com',
      role: 'admin',
      adminRole: 'care',
      adminPermissionLevels: { support: 'write' },
    };
    await GetCurrentUser({ user } as any, res as any, vi.fn());
    expect(res.body.user.adminAccessLevels.support).toBe('write');
    expect(res.body.user.supportAccessLevel).toBe('write');
    expect(res.body.user.adminPermissions).toContain('support.tickets');
  });

  it('does not expose admin levels on non-admin accounts', async () => {
    const res = response();
    await GetCurrentUser({
      user: {
        _id: '507f1f77bcf86cd799439016',
        name: 'Customer',
        email: 'customer@example.com',
        role: 'customer',
      },
    } as any, res as any, vi.fn());
    expect(res.body.user.adminAccessLevels).toBeUndefined();
    expect(res.body.user.supportAccessLevel).toBe('none');
  });
});
