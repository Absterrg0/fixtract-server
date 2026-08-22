import { NextFunction, Request, Response } from 'express';
import type { AdminPermission } from './types';
import { hasAccessLevel, hasPermission, resolveAdminRole } from './rolePermissions';
import { accessAreaForAdminPath, accessRequirementForAdminPath, permissionForAdminPath } from './routePermissions';
import { getEffectiveAccessForUser } from './roleAccess';

/** Attach resolved adminRole onto req.admin for downstream handlers. */
export function attachResolvedAdminRole(req: Request, _res: Response, next: NextFunction) {
  if (req.admin) {
    (req.admin as any).adminRole = resolveAdminRole((req.admin as any).adminRole);
  }
  return next();
}

/** Enforce permission for the current admin-router path (after requireAdmin). */
export async function enforceAdminRoutePermission(req: Request, res: Response, next: NextFunction) {
  const permission = permissionForAdminPath(req.path);
  if (!permission) {
    return next();
  }

  const adminRole = resolveAdminRole((req.admin as any)?.adminRole);
  const area = accessAreaForAdminPath(req.path);
  const levels = await getEffectiveAccessForUser(req.admin as any);
  const required = accessRequirementForAdminPath(req.path, req.method);
  if (!area || !hasAccessLevel(levels, area, required)) {
    return res.status(403).json({
      success: false,
      msg: 'You do not have permission to perform this action',
      code: 'ADMIN_PERMISSION_DENIED',
      permission,
      adminRole,
      requiredAccess: required,
    });
  }

  // Force-status needs write, not just read
  if (req.path.includes('/force-status') && !hasPermission(adminRole, 'bookings.write', levels)) {
    return res.status(403).json({
      success: false,
      msg: 'You do not have permission to force booking status',
      code: 'ADMIN_PERMISSION_DENIED',
      permission: 'bookings.write',
      adminRole,
    });
  }

  return next();
}

export function requirePermission(...permissions: AdminPermission[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const adminRole = resolveAdminRole((req.admin as any)?.adminRole);
    const levels = await getEffectiveAccessForUser(req.admin as any);
    if (!permissions.some((permission) => hasPermission(adminRole, permission, levels))) {
      return res.status(403).json({
        success: false,
        msg: 'You do not have permission to perform this action',
        code: 'ADMIN_PERMISSION_DENIED',
        permissions,
        adminRole,
      });
    }
    return next();
  };
}
