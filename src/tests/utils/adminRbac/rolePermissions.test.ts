import { describe, expect, it } from 'vitest';
import { hasAccessLevel, permissionsForRole, hasPermission, permissionLevelsForRole, resolveAdminRole } from '../../../utils/adminRbac/rolePermissions';
import { validatePermissionMatrix, getEffectiveAccessForUser } from '../../../utils/adminRbac/roleAccess';
import { accessRequirementForAdminPath, permissionForAdminPath } from '../../../utils/adminRbac/routePermissions';

describe('admin RBAC role packs', () => {
  it('defaults only legacy missing roles to super and rejects malformed roles', () => {
    expect(resolveAdminRole(undefined)).toBe('super');
    expect(resolveAdminRole('nope')).toBeNull();
  });

  it('returns no effective access for malformed roles without stored overrides', async () => {
    await expect(getEffectiveAccessForUser({ adminRole: 'nope' as any })).resolves.toEqual({});
  });

  it('gives care chat + disputes but not payments or staff', () => {
    expect(hasPermission('care', 'disputes.manage')).toBe(true);
    expect(hasPermission('care', 'chat.support')).toBe(true);
    expect(hasPermission('care', 'payments.manage')).toBe(false);
    expect(hasPermission('care', 'staff.manage')).toBe(false);
  });

  it('gives marketing cms/discounts but not disputes', () => {
    expect(hasPermission('marketing', 'cms.manage')).toBe(true);
    expect(hasPermission('marketing', 'discounts.manage')).toBe(true);
    expect(hasPermission('marketing', 'disputes.manage')).toBe(false);
  });

  it('gives finance payments/kpi but not cms', () => {
    expect(hasPermission('finance', 'payments.manage')).toBe(true);
    expect(hasPermission('finance', 'kpi.read')).toBe(true);
    expect(hasPermission('finance', 'cms.manage')).toBe(false);
  });

  it('super has staff.manage', () => {
    expect(hasPermission('super', 'staff.manage')).toBe(true);
    expect(permissionsForRole('super').size).toBeGreaterThan(20);
  });

  it('supports the new operations and content creator role packs', () => {
    expect(hasPermission('operations', 'services.manage')).toBe(true);
    expect(hasPermission('operations', 'campaigns.manage')).toBe(false);
    expect(hasPermission('content_creator', 'cms.manage')).toBe(true);
    expect(hasPermission('content_creator', 'payments.manage')).toBe(false);
  });

  it('represents read-only access without granting writes', () => {
    const levels = { ...permissionLevelsForRole('care'), bookings: 'read' as const };
    expect(hasAccessLevel(levels, 'bookings', 'read')).toBe(true);
    expect(hasAccessLevel(levels, 'bookings', 'write')).toBe(false);
    expect(hasPermission('care', 'bookings.write', levels)).toBe(false);
    expect(hasPermission('care', 'bookings.read', levels)).toBe(true);
  });

  it('requires the super role to remain fully writable in a matrix', () => {
    expect(validatePermissionMatrix({ super: { staff: 'read' } })).toBeNull();
    expect(validatePermissionMatrix({ operations: { bookings: 'read' } })).toEqual({ operations: { bookings: 'read' } });
  });
});

describe('admin route permission mapping', () => {
  it('maps staff and payments paths', () => {
    expect(permissionForAdminPath('/staff')).toBe('staff.manage');
    expect(permissionForAdminPath('/staff/abc')).toBe('staff.manage');
    expect(permissionForAdminPath('/payments')).toBe('payments.manage');
    expect(permissionForAdminPath('/access')).toBeNull();
  });

  it('maps site-announcements to cms.manage', () => {
    expect(permissionForAdminPath('/site-announcements')).toBe('cms.manage');
    expect(permissionForAdminPath('/site-announcements/abc')).toBe('cms.manage');
  });

  it('prefers professionals/manage over professionals', () => {
    expect(permissionForAdminPath('/professionals/manage')).toBe('professionals.manage');
    expect(permissionForAdminPath('/professionals')).toBe('professionals.approve');
  });

  it('allows read-only access to the audience preview POST', () => {
    expect(accessRequirementForAdminPath('/marketing-campaigns/preview-audience', 'POST')).toBe('read');
    expect(accessRequirementForAdminPath('/marketing-campaigns/test-send', 'POST')).toBe('write');
  });
});
