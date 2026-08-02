import { describe, expect, it } from 'vitest';
import { permissionsForRole, hasPermission, resolveAdminRole } from '../../../utils/adminRbac/rolePermissions';
import { permissionForAdminPath } from '../../../utils/adminRbac/routePermissions';

describe('admin RBAC role packs', () => {
  it('defaults only legacy missing roles to super and rejects malformed roles', () => {
    expect(resolveAdminRole(undefined)).toBe('super');
    expect(resolveAdminRole('nope')).toBeNull();
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
});
