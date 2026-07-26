import type { IUser } from '../../models/user';
import type { AdminPermission } from './types';
import { hasPermission, resolveAdminRole } from './rolePermissions';

export function denyUnlessPermission(user: IUser | undefined | null, permission: AdminPermission) {
  if (!user || user.role !== 'admin') {
    return {
      status: 403 as const,
      body: { success: false, msg: 'Admin access required', code: 'ADMIN_REQUIRED' },
    };
  }
  const adminRole = resolveAdminRole((user as any).adminRole);
  if (!hasPermission(adminRole, permission)) {
    return {
      status: 403 as const,
      body: {
        success: false,
        msg: 'You do not have permission to perform this action',
        code: 'ADMIN_PERMISSION_DENIED',
        permission,
        adminRole,
      },
    };
  }
  return null;
}
