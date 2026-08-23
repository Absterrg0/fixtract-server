import mongoose from 'mongoose';
import User, { type IUser } from '../../models/user';
import AdminRoleAccess, { type IAdminRoleAccess } from '../../models/adminRoleAccess';
import {
  ADMIN_ACCESS_AREAS,
  ADMIN_ACCESS_LEVELS,
  ADMIN_ROLES,
  type AdminAccessArea,
  type AdminAccessLevel,
  type AdminPermissionLevels,
  type AdminRole,
} from './types';
import { permissionLevelsForRole, resolveAdminRole } from './rolePermissions';

const isAccessLevel = (value: unknown): value is AdminAccessLevel =>
  typeof value === 'string' && (ADMIN_ACCESS_LEVELS as readonly string[]).includes(value);

export function normalizePermissionLevels(value: unknown): AdminPermissionLevels {
  if (!value || typeof value !== 'object') return {};
  const result: AdminPermissionLevels = {};
  for (const area of ADMIN_ACCESS_AREAS) {
    const next = (value as Record<string, unknown>)[area];
    if (isAccessLevel(next)) result[area] = next;
  }
  return result;
}

export async function getConfiguredRoleAccess(): Promise<Partial<Record<AdminRole, AdminPermissionLevels>>> {
  const config = await AdminRoleAccess.getCurrentConfig();
  const roles: Partial<Record<AdminRole, AdminPermissionLevels>> = {};
  for (const role of ADMIN_ROLES) {
    const configured = normalizePermissionLevels(config.roles?.[role]);
    roles[role] = {
      ...permissionLevelsForRole(role),
      ...configured,
    };
  }
  return roles;
}

export async function getConfiguredAccessForRole(role: AdminRole): Promise<AdminPermissionLevels> {
  const roles = await getConfiguredRoleAccess();
  return roles[role] || permissionLevelsForRole(role);
}

export async function getEffectiveAccessForUser(user: Pick<IUser, 'adminRole' | 'adminPermissionLevels'>): Promise<AdminPermissionLevels> {
  const stored = normalizePermissionLevels(user.adminPermissionLevels);
  if (Object.keys(stored).length > 0) return stored;
  const resolvedRole = resolveAdminRole(user.adminRole);
  if (!resolvedRole) return {};
  return getConfiguredAccessForRole(resolvedRole);
}

export function validatePermissionMatrix(value: unknown): Partial<Record<AdminRole, AdminPermissionLevels>> | null {
  if (!value || typeof value !== 'object') return null;
  const matrix: Partial<Record<AdminRole, AdminPermissionLevels>> = {};
  for (const role of ADMIN_ROLES) {
    const row = (value as Record<string, unknown>)[role];
    if (row === undefined) continue;
    const normalized = normalizePermissionLevels(row);
    if (role === 'super' && ADMIN_ACCESS_AREAS.some((area) => normalized[area] !== 'write')) {
      return null;
    }
    matrix[role] = normalized;
  }
  return matrix;
}

const ROLE_ACCESS_SINGLETON_ID = 'admin-role-access';
const ROLE_ACCESS_SAVE_MAX_RETRIES = 3;

function isVersionError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'name' in error &&
      (error as { name?: string }).name === 'VersionError',
  );
}

/** Persist a role matrix and copy the selected role's settings to existing admins. */
export async function saveConfiguredRoleAccess(
  matrix: Partial<Record<AdminRole, AdminPermissionLevels>>,
  modifiedBy?: IUser['_id'],
) {
  let lastError: unknown;
  for (let attempt = 0; attempt < ROLE_ACCESS_SAVE_MAX_RETRIES; attempt += 1) {
    const session = await mongoose.startSession();
    try {
      let saved: IAdminRoleAccess | undefined;
      await session.withTransaction(async () => {
        let config = await AdminRoleAccess.findOne({ _id: ROLE_ACCESS_SINGLETON_ID }).session(session);
        if (!config) {
          config = new AdminRoleAccess({ _id: ROLE_ACCESS_SINGLETON_ID, roles: {}, lastModified: new Date() });
        }
        config.roles = { ...(config.roles || {}), ...matrix };
        config.lastModifiedBy = modifiedBy as any;
        config.lastModified = new Date();
        await config.save({ session });

        for (const [role, levels] of Object.entries(matrix) as Array<[AdminRole, AdminPermissionLevels]>) {
          await User.updateMany(
            { role: 'admin', adminRole: role },
            { $set: { adminPermissionLevels: levels } },
            { session },
          );
        }
        saved = config;
      });
      if (!saved) {
        throw new Error('Failed to save role access configuration');
      }
      return saved;
    } catch (error) {
      lastError = error;
      if (!isVersionError(error) || attempt === ROLE_ACCESS_SAVE_MAX_RETRIES - 1) {
        throw error;
      }
    } finally {
      await session.endSession();
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Failed to save role access configuration');
}
