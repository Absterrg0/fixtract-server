import type { AdminPermission, AdminRole } from './types';
import { ADMIN_PERMISSIONS } from './types';

const ALL = [...ADMIN_PERMISSIONS] as AdminPermission[];

/** Fixed role packs from the product doc (care / marketing / quality / finance + super). */
export const ROLE_PERMISSIONS: Record<AdminRole, readonly AdminPermission[]> = {
  super: ALL,
  care: [
    'dashboard.overview',
    'bookings.read',
    'bookings.write',
    'disputes.manage',
    'cancellations.manage',
    'chat.support',
    'chat.reports',
    'support.tickets',
    'customers.manage',
    'warranty.manage',
  ],
  marketing: [
    'dashboard.overview',
    'cms.manage',
    'campaigns.manage',
    'discounts.manage',
    'loyalty.manage',
    'referrals.manage',
    'backlinks.manage',
    'favorites.manage',
  ],
  quality: [
    'dashboard.overview',
    'professionals.approve',
    'professionals.manage',
    'projects.approve',
    'reviews.moderate',
    'chat.reports',
    'warranty.manage',
    'services.manage',
  ],
  finance: [
    'dashboard.overview',
    'payments.manage',
    'kpi.read',
    'audit.read',
    'email_logs.read',
    'bookings.read',
  ],
};

export function permissionsForRole(adminRole: AdminRole | null | undefined): Set<AdminPermission> {
  if (!adminRole || !(adminRole in ROLE_PERMISSIONS)) {
    return new Set();
  }
  return new Set(ROLE_PERMISSIONS[adminRole]);
}

export function hasPermission(
  adminRole: AdminRole | null | undefined,
  permission: AdminPermission
): boolean {
  return permissionsForRole(adminRole).has(permission);
}

export function hasAnyPermission(
  adminRole: AdminRole | null | undefined,
  permissions: AdminPermission[]
): boolean {
  const set = permissionsForRole(adminRole);
  return permissions.some((p) => set.has(p));
}

/** Resolve adminRole for legacy admins missing the field. */
export function resolveAdminRole(adminRole: unknown): AdminRole {
  if (typeof adminRole === 'string' && adminRole in ROLE_PERMISSIONS) {
    return adminRole as AdminRole;
  }
  return 'super';
}
