import { NextFunction, Request, Response } from 'express';
import type { AdminPermission } from './types';
import { hasAnyPermission, hasPermission, resolveAdminRole } from './rolePermissions';
import { permissionForAdminPath } from './routePermissions';

/** Attach resolved adminRole onto req.admin for downstream handlers. */
export function attachResolvedAdminRole(req: Request, _res: Response, next: NextFunction) {
  if (req.admin) {
    (req.admin as any).adminRole = resolveAdminRole((req.admin as any).adminRole);
  }
  return next();
}

/** Enforce permission for the current admin-router path (after requireAdmin). */
export function enforceAdminRoutePermission(req: Request, res: Response, next: NextFunction) {
  const permission = permissionForAdminPath(req.path);
  if (!permission) {
    return next();
  }

  const adminRole = resolveAdminRole((req.admin as any)?.adminRole);
  if (!hasPermission(adminRole, permission)) {
    return res.status(403).json({
      success: false,
      msg: 'You do not have permission to perform this action',
      code: 'ADMIN_PERMISSION_DENIED',
      permission,
      adminRole,
    });
  }

  // Force-status needs write, not just read
  if (req.path.includes('/force-status') && !hasPermission(adminRole, 'bookings.write')) {
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
  return (req: Request, res: Response, next: NextFunction) => {
    const adminRole = resolveAdminRole((req.admin as any)?.adminRole);
    if (!hasAnyPermission(adminRole, permissions)) {
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
