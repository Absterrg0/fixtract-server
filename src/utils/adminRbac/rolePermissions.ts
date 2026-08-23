import type {
  AdminAccessArea,
  AdminAccessLevel,
  AdminPermission,
  AdminPermissionLevels,
  AdminRole,
} from './types';
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
  operations: [
    'dashboard.overview',
    'bookings.read',
    'bookings.write',
    'customers.manage',
    'professionals.manage',
    'services.manage',
    'projects.approve',
    'warranty.manage',
  ],
  content_creator: [
    'dashboard.overview',
    'cms.manage',
    'campaigns.manage',
  ],
};

const PERMISSION_ACCESS: Record<AdminPermission, { area: AdminAccessArea; level: AdminAccessLevel }> = {
  'staff.manage': { area: 'staff', level: 'write' },
  'dashboard.overview': { area: 'platform', level: 'read' },
  'professionals.approve': { area: 'professionals_approve', level: 'write' },
  'professionals.manage': { area: 'professionals_manage', level: 'write' },
  'customers.manage': { area: 'customers', level: 'write' },
  'bookings.read': { area: 'bookings', level: 'read' },
  'bookings.write': { area: 'bookings', level: 'write' },
  'disputes.manage': { area: 'disputes', level: 'write' },
  'cancellations.manage': { area: 'cancellations', level: 'write' },
  'chat.support': { area: 'chat', level: 'write' },
  'chat.reports': { area: 'chat_reports', level: 'read' },
  'support.tickets': { area: 'support', level: 'write' },
  'payments.manage': { area: 'payments', level: 'write' },
  'kpi.read': { area: 'kpi', level: 'read' },
  'audit.read': { area: 'audit', level: 'read' },
  'email_logs.read': { area: 'email_logs', level: 'read' },
  'cms.manage': { area: 'cms', level: 'write' },
  'campaigns.manage': { area: 'campaigns', level: 'write' },
  'discounts.manage': { area: 'discounts', level: 'write' },
  'loyalty.manage': { area: 'loyalty', level: 'write' },
  'referrals.manage': { area: 'referrals', level: 'write' },
  'backlinks.manage': { area: 'backlinks', level: 'write' },
  'reviews.moderate': { area: 'reviews', level: 'write' },
  'favorites.manage': { area: 'favorites', level: 'write' },
  'services.manage': { area: 'services', level: 'write' },
  'projects.approve': { area: 'projects', level: 'write' },
  'warranty.manage': { area: 'warranty', level: 'write' },
  'settings.platform': { area: 'platform', level: 'write' },
  'settings.site': { area: 'platform', level: 'write' },
  'maintenance.run': { area: 'maintenance', level: 'write' },
  'users.delete': { area: 'user_delete', level: 'write' },
};

export const DEFAULT_ROLE_ACCESS_LEVELS: Record<AdminRole, AdminPermissionLevels> = (() => {
  const result = {} as Record<AdminRole, AdminPermissionLevels>;
  for (const role of Object.keys(ROLE_PERMISSIONS) as AdminRole[]) {
    const levels: AdminPermissionLevels = {};
    for (const permission of ROLE_PERMISSIONS[role]) {
      const access = PERMISSION_ACCESS[permission];
      if (!access) continue;
      const current = levels[access.area];
      if (access.level === 'write' || current === undefined || current === 'none') {
        levels[access.area] = access.level;
      }
    }
    if (role === 'super') {
      for (const permission of ADMIN_PERMISSIONS) {
        const access = PERMISSION_ACCESS[permission];
        if (access) levels[access.area] = 'write';
      }
    }
    result[role] = levels;
  }
  return result;
})();

export function accessLevelForPermission(permission: AdminPermission): { area: AdminAccessArea; level: AdminAccessLevel } {
  return PERMISSION_ACCESS[permission];
}

export function hasAccessLevel(
  levels: AdminPermissionLevels | undefined,
  area: AdminAccessArea,
  required: Exclude<AdminAccessLevel, 'none'>,
): boolean {
  const actual = levels?.[area] || 'none';
  return required === 'read' ? actual === 'read' || actual === 'write' : actual === 'write';
}

export function permissionLevelsForRole(adminRole: AdminRole | null | undefined): AdminPermissionLevels {
  const role = resolveAdminRole(adminRole);
  return role ? { ...DEFAULT_ROLE_ACCESS_LEVELS[role] } : {};
}

export function permissionsForLevels(levels: AdminPermissionLevels | undefined): Set<AdminPermission> {
  const result = new Set<AdminPermission>();
  for (const permission of ADMIN_PERMISSIONS) {
    const access = PERMISSION_ACCESS[permission];
    if (access && hasAccessLevel(levels, access.area, access.level === 'write' ? 'write' : 'read')) {
      result.add(permission);
    }
  }
  return result;
}

export function permissionsForRole(adminRole: AdminRole | null | undefined): Set<AdminPermission> {
  return permissionsForLevels(permissionLevelsForRole(adminRole));
}

export function hasPermission(
  adminRole: AdminRole | null | undefined,
  permission: AdminPermission,
  levels?: AdminPermissionLevels,
): boolean {
  const access = accessLevelForPermission(permission);
  const effective = levels || permissionLevelsForRole(adminRole);
  return Boolean(access && hasAccessLevel(effective, access.area, access.level === 'write' ? 'write' : 'read'));
}

export function hasAnyPermission(
  adminRole: AdminRole | null | undefined,
  permissions: AdminPermission[]
): boolean {
  const set = permissionsForRole(adminRole);
  return permissions.some((p) => set.has(p));
}

/** Resolve adminRole for legacy admins missing the field. */
export function resolveAdminRole(adminRole: unknown): AdminRole | null {
  if (typeof adminRole === 'string' && adminRole in ROLE_PERMISSIONS) {
    return adminRole as AdminRole;
  }
  // Legacy admins predate the field and retain their previous full access.
  return adminRole == null ? 'super' : null;
}
