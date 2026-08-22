import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import User, { IUser } from '../../models/user';
import connecToDatabase from '../../config/db';
import { ADMIN_ROLES, isAdminRole, type AdminRole } from '../../utils/adminRbac/types';
import { permissionsForLevels, permissionsForRole, resolveAdminRole } from '../../utils/adminRbac/rolePermissions';
import {
  getConfiguredAccessForRole,
  getConfiguredRoleAccess,
  getEffectiveAccessForUser,
  saveConfiguredRoleAccess,
  validatePermissionMatrix,
} from '../../utils/adminRbac/roleAccess';
import { sendAdminStaffInvitationEmail } from '../../utils/emailService';
import {
  adminInviteExpiresAt,
  buildAdminInviteUrl,
  generateAdminInviteToken,
  hashAdminInviteToken,
  randomUnusablePasswordHash,
} from '../../utils/adminRbac/inviteToken';
import { ADMIN_ROLE_LABELS } from '../../utils/adminRbac/types';
import { sendHandlerError } from '../../utils/handlerErrors';
import CronJobLock from '../../models/cronJobLock';

const SUPER_ADMIN_GUARD_KEY = 'admin_super_role_guard';
const SUPER_ADMIN_GUARD_LEASE_MS = 30_000;

async function acquireSuperAdminGuard(): Promise<string | null> {
  const claimId = crypto.randomUUID();
  try {
    const lock = await CronJobLock.findOneAndUpdate(
      {
        key: SUPER_ADMIN_GUARD_KEY,
        $or: [
          { claimedAt: { $lte: new Date(Date.now() - SUPER_ADMIN_GUARD_LEASE_MS) } },
          { claimedAt: { $exists: false } },
        ],
      },
      {
        $set: { claimedAt: new Date(), claimId },
        $setOnInsert: { key: SUPER_ADMIN_GUARD_KEY },
      },
      { upsert: true, new: true },
    );
    return lock?.claimId === claimId ? claimId : null;
  } catch (error: any) {
    if (error?.code === 11000) return null;
    throw error;
  }
}

/** Keep the demotion lease alive across count + save so another request cannot reclaim mid-flight. */
async function renewSuperAdminGuard(claimId: string): Promise<boolean> {
  const result = await CronJobLock.updateOne(
    { key: SUPER_ADMIN_GUARD_KEY, claimId },
    { $set: { claimedAt: new Date() } },
  );
  return result.matchedCount === 1;
}

/**
 * User.phone is required + unique. When invite omits a real phone we store a
 * synthetic placeholder so the row can be created — never mark it verified.
 */
function resolveInvitePhone(phone: unknown): { value: string; isPlaceholder: boolean } {
  if (typeof phone === 'string' && phone.trim()) {
    return { value: phone.trim(), isPlaceholder: false };
  }
  // Collision-resistant placeholder (unique index); not a real phone, stays unverified
  return { value: `+1999${crypto.randomBytes(6).toString('hex')}`, isPlaceholder: true };
}

function isInviteExpired(user: IUser): boolean {
  const expires = (user as any).adminStaff?.inviteTokenExpires;
  if (!expires) return false;
  return new Date(expires).getTime() <= Date.now();
}

function isInvitePending(user: IUser): boolean {
  const adminStaff = (user as any).adminStaff;
  if (adminStaff?.inviteAcceptedAt) return false;
  if (!adminStaff?.invitedAt) return false;
  if (isInviteExpired(user)) return false;
  return true;
}

function canResendAdminInvite(user: IUser): boolean {
  if (user.role !== 'admin') return false;
  // Resend only for active (or unset) accounts — never suspended/rejected/etc.
  const status = user.accountStatus || 'active';
  if (status !== 'active') return false;
  const adminStaff = (user as any).adminStaff;
  if (adminStaff?.inviteAcceptedAt) return false;
  // Legacy active admin created outside the invite flow
  if (user.isEmailVerified && !adminStaff?.invitedAt) return false;
  return true;
}

function createInviteCredentials() {
  const inviteToken = generateAdminInviteToken();
  return {
    inviteToken,
    inviteTokenHash: hashAdminInviteToken(inviteToken),
    inviteTokenExpires: adminInviteExpiresAt(),
    inviteUrl: buildAdminInviteUrl(inviteToken),
  };
}

async function dispatchStaffInviteEmail(
  email: string,
  name: string,
  adminRole: AdminRole,
  inviteUrl: string
) {
  return sendAdminStaffInvitationEmail(
    email,
    name,
    ADMIN_ROLE_LABELS[adminRole],
    inviteUrl
  );
}

async function regeneratePendingInvite(
  staff: IUser,
  admin: IUser,
  opts: { name: string; adminRole: AdminRole; phone?: string }
) {
  const { inviteToken, inviteTokenHash, inviteTokenExpires, inviteUrl } = createInviteCredentials();

  staff.name = opts.name.trim();
  (staff as any).adminRole = opts.adminRole;
  (staff as any).adminPermissionLevels = await getConfiguredAccessForRole(opts.adminRole);
  if (opts.phone) {
    staff.phone = opts.phone;
  }
  staff.isEmailVerified = false;
  staff.isPhoneVerified = false;
  // Never reactivate non-active accounts via invite resend

  const adminStaff = { ...((staff as any).adminStaff || {}) };
  adminStaff.invitedBy = String(admin._id);
  adminStaff.invitedByEmail = admin.email;
  adminStaff.invitedAt = new Date();
  adminStaff.inviteTokenHash = inviteTokenHash;
  adminStaff.inviteTokenExpires = inviteTokenExpires;
  adminStaff.inviteAcceptedAt = undefined;
  (staff as any).adminStaff = adminStaff;

  await staff.save();

  const emailResult = await dispatchStaffInviteEmail(
    staff.email,
    staff.name,
    opts.adminRole,
    inviteUrl
  );

  return { staff, inviteUrl, ...emailResult };
}

function serializeStaff(user: IUser) {
  const adminRole = resolveAdminRole((user as any).adminRole);
  const permissionLevels = (user as any).adminPermissionLevels || undefined;
  const pending = isInvitePending(user);
  const expiredInvite =
    !pending &&
    !(user as any).adminStaff?.inviteAcceptedAt &&
    Boolean((user as any).adminStaff?.invitedAt) &&
    isInviteExpired(user);
  const rawStatus = user.accountStatus || 'active';
  // Keep real account state (suspended/rejected); invite lifecycle is separate
  const accountStatus =
    rawStatus === 'suspended' || rawStatus === 'rejected'
      ? rawStatus
      : pending
        ? 'pending'
        : expiredInvite
          ? 'invite_expired'
          : rawStatus;
  return {
    _id: user._id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    role: user.role,
    adminRole,
    permissions: [...(permissionLevels ? permissionsForLevels(permissionLevels) : permissionsForRole(adminRole))],
    permissionLevels,
    accountStatus,
    invitePending: pending,
    inviteExpired: expiredInvite,
    isEmailVerified: user.isEmailVerified,
    isPhoneVerified: user.isPhoneVerified,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    invitedBy: (user as any).adminStaff?.invitedBy ?? null,
    invitedAt: (user as any).adminStaff?.invitedAt ?? null,
    currentStatusSince: (user as any).adminStatusSince || user.createdAt,
    timeZone: (user as any).timeZone || 'UTC',
    availability: user.availability || {},
    blockedDates: user.blockedDates || [],
    blockedRanges: user.blockedRanges || [],
  };
}

export const listStaff = async (_req: Request, res: Response) => {
  try {
    await connecToDatabase();
    const staff = await User.find({ role: 'admin' })
      .select(
        'name email phone role adminRole adminPermissionLevels adminStatusSince timeZone availability blockedDates blockedRanges accountStatus isEmailVerified createdAt updatedAt adminStaff.invitedBy adminStaff.invitedAt adminStaff.inviteTokenHash adminStaff.inviteTokenExpires adminStaff.inviteAcceptedAt'
      )
      .sort({ createdAt: -1 });

    const rows = await Promise.all(staff.map(async (member) => {
      if (!(member as any).adminPermissionLevels && resolveAdminRole((member as any).adminRole)) {
        (member as any).adminPermissionLevels = await getConfiguredAccessForRole(resolveAdminRole((member as any).adminRole) as AdminRole);
      }
      return serializeStaff(member);
    }));

    return res.json({
      success: true,
      data: rows,
      roles: ADMIN_ROLES,
    });
  } catch (error) {
    console.error('List staff error:', error);
    return res.status(500).json({ success: false, msg: 'Failed to list staff' });
  }
};

export const inviteStaff = async (req: Request, res: Response) => {
  try {
    const admin = req.admin as IUser;
    const { name, email, phone, adminRole } = req.body || {};

    if (!name || typeof name !== 'string' || name.trim().length < 2) {
      return res.status(400).json({ success: false, msg: 'Name is required' });
    }
    if (!email || typeof email !== 'string') {
      return res.status(400).json({ success: false, msg: 'Email is required' });
    }
    if (!isAdminRole(adminRole)) {
      return res.status(400).json({
        success: false,
        msg: `adminRole must be one of: ${ADMIN_ROLES.join(', ')}`,
      });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const resolvedPhone = resolveInvitePhone(phone);
    const trimmedName = name.trim();
    const role = adminRole as AdminRole;
    const permissionLevels = await getConfiguredAccessForRole(role);
    await connecToDatabase();

    const existing = await User.findOne({ email: normalizedEmail }).select(
      'name email phone role adminRole accountStatus isEmailVerified isPhoneVerified createdAt updatedAt adminStaff'
    );

    if (existing) {
      if (!canResendAdminInvite(existing)) {
        const status = existing.accountStatus || 'active';
        return res.status(409).json({
          success: false,
          msg:
            status !== 'active'
              ? `This staff member is ${status} — reactivate them before resending an invite`
              : 'A user with this email already exists',
          field: 'email',
        });
      }

      if (!resolvedPhone.isPlaceholder && resolvedPhone.value !== existing.phone) {
        const existingPhone = await User.findOne({
          phone: resolvedPhone.value,
          _id: { $ne: existing._id },
        }).select('_id');
        if (existingPhone) {
          return res.status(409).json({
            success: false,
            msg: 'A user with this phone number already exists',
            field: 'phone',
          });
        }
      }

      const { staff, inviteUrl, sent, error } = await regeneratePendingInvite(existing, admin, {
        name: trimmedName,
        adminRole: role,
        phone: resolvedPhone.isPlaceholder ? undefined : resolvedPhone.value,
      });

      return res.status(200).json({
        success: true,
        resent: true,
        data: serializeStaff(staff),
        inviteUrl,
        emailSent: sent,
        emailError: error,
        msg: sent
          ? 'Invite resent — a fresh link was emailed'
          : 'Invite link regenerated — copy it below (email could not be sent)',
      });
    }

    if (!resolvedPhone.isPlaceholder) {
      const existingPhone = await User.findOne({ phone: resolvedPhone.value }).select('_id');
      if (existingPhone) {
        return res.status(409).json({
          success: false,
          msg: 'A user with this phone number already exists',
          field: 'phone',
        });
      }
    }

    const { inviteTokenHash, inviteTokenExpires, inviteUrl } = createInviteCredentials();
    const unusablePassword = await randomUnusablePasswordHash();

    const staff = await User.create({
      name: trimmedName,
      email: normalizedEmail,
      phone: resolvedPhone.value,
      password: unusablePassword,
      role: 'admin',
      adminRole: role,
      adminPermissionLevels: permissionLevels,
      adminStatusSince: new Date(),
      isEmailVerified: false,
      // Placeholder phones must stay unverified; real phones still require OTP later
      isPhoneVerified: false,
      accountStatus: 'active',
      adminStaff: {
        invitedBy: String(admin._id),
        invitedAt: new Date(),
        invitedByEmail: admin.email,
        inviteTokenHash,
        inviteTokenExpires,
      },
    });

    const emailResult = await dispatchStaffInviteEmail(
      normalizedEmail,
      trimmedName,
      role,
      inviteUrl
    );

    return res.status(201).json({
      success: true,
      data: serializeStaff(staff),
      inviteUrl,
      emailSent: emailResult.sent,
      emailError: emailResult.error,
    });
  } catch (error) {
    return sendHandlerError(res, error, 'Failed to invite staff');
  }
};

export const resendStaffInvite = async (req: Request, res: Response) => {
  try {
    const admin = req.admin as IUser;
    const { staffId } = req.params;

    await connecToDatabase();
    const staff = await User.findOne({ _id: staffId, role: 'admin' });
    if (!staff) {
      return res.status(404).json({ success: false, msg: 'Staff member not found' });
    }
    if (!canResendAdminInvite(staff)) {
      const status = staff.accountStatus || 'active';
      return res.status(400).json({
        success: false,
        msg:
          status !== 'active'
            ? `This staff member is ${status} — reactivate them before resending an invite`
            : 'This staff member has already activated their account',
      });
    }

    const adminRole = resolveAdminRole((staff as any).adminRole) as AdminRole;
    const { staff: updated, inviteUrl, sent, error } = await regeneratePendingInvite(staff, admin, {
      name: staff.name,
      adminRole,
    });

    return res.json({
      success: true,
      resent: true,
      data: serializeStaff(updated),
      inviteUrl,
      emailSent: sent,
      emailError: error,
      msg: sent
        ? 'Invite resent — a fresh link was emailed'
        : 'Invite link regenerated — copy it below (email could not be sent)',
    });
  } catch (error) {
    return sendHandlerError(res, error, 'Failed to resend invite');
  }
};

export const updateStaff = async (req: Request, res: Response) => {
  let superAdminGuard: string | null = null;
  try {
    const admin = req.admin as IUser;
    const { staffId } = req.params;
    const { adminRole, accountStatus, name } = req.body || {};

    await connecToDatabase();
    const staff = await User.findOne({ _id: staffId, role: 'admin' });
    if (!staff) {
      return res.status(404).json({ success: false, msg: 'Staff member not found' });
    }

    // Prevent demoting/suspending yourself into a lockout
    if (String(staff._id) === String(admin._id)) {
      if (accountStatus && accountStatus !== 'active') {
        return res.status(400).json({ success: false, msg: 'You cannot deactivate your own account' });
      }
      if (adminRole && adminRole !== 'super') {
        return res.status(400).json({ success: false, msg: 'You cannot remove your own super role' });
      }
    }

    if (adminRole !== undefined && resolveAdminRole(admin.adminRole) !== 'super') {
      return res.status(403).json({ success: false, msg: 'Only a super admin can change admin roles' });
    }

    const targetIsActiveSuper =
      resolveAdminRole(staff.adminRole) === 'super' &&
      !['suspended', 'rejected'].includes(staff.accountStatus || '') &&
      !staff.deletedAt &&
      (!staff.adminStaff?.invitedAt || Boolean(staff.adminStaff.inviteAcceptedAt));
    const removesSuperAccess =
      (adminRole !== undefined && adminRole !== 'super') ||
      (accountStatus !== undefined && accountStatus !== 'active');
    if (targetIsActiveSuper && removesSuperAccess) {
      superAdminGuard = await acquireSuperAdminGuard();
      if (!superAdminGuard) {
        return res.status(409).json({
          success: false,
          msg: 'Another super-admin update is in progress; retry shortly',
        });
      }
      if (!(await renewSuperAdminGuard(superAdminGuard))) {
        return res.status(409).json({
          success: false,
          msg: 'Another super-admin update is in progress; retry shortly',
        });
      }
      const activeSuperCount = await User.countDocuments({
        role: 'admin',
        deletedAt: null,
        accountStatus: { $nin: ['suspended', 'rejected'] },
        $or: [
          { adminRole: 'super' },
          { adminRole: null },
          { adminRole: { $exists: false } },
        ],
        $and: [
          {
            $or: [
              { 'adminStaff.invitedAt': { $exists: false } },
              { 'adminStaff.inviteAcceptedAt': { $type: 'date' } },
            ],
          },
        ],
      });
      if (activeSuperCount <= 1) {
        return res.status(400).json({
          success: false,
          msg: 'At least one active super admin must remain',
        });
      }
      if (!(await renewSuperAdminGuard(superAdminGuard))) {
        return res.status(409).json({
          success: false,
          msg: 'Another super-admin update is in progress; retry shortly',
        });
      }
    }

    if (adminRole !== undefined) {
      if (!isAdminRole(adminRole)) {
        return res.status(400).json({
          success: false,
          msg: `adminRole must be one of: ${ADMIN_ROLES.join(', ')}`,
        });
      }
      (staff as any).adminRole = adminRole;
      (staff as any).adminPermissionLevels = await getConfiguredAccessForRole(adminRole as AdminRole);
    }

    if (accountStatus !== undefined) {
      if (!['active', 'suspended'].includes(accountStatus)) {
        return res.status(400).json({ success: false, msg: 'accountStatus must be active or suspended' });
      }
      if ((staff.accountStatus || 'active') !== accountStatus) {
        staff.adminStatusSince = new Date();
      }
      staff.accountStatus = accountStatus;
    }

    if (typeof name === 'string' && name.trim().length >= 2) {
      staff.name = name.trim();
    }

    await staff.save();
    return res.json({ success: true, data: serializeStaff(staff) });
  } catch (error) {
    return sendHandlerError(res, error, 'Failed to update staff');
  } finally {
    if (superAdminGuard) {
      await CronJobLock.deleteOne({ key: SUPER_ADMIN_GUARD_KEY, claimId: superAdminGuard }).catch((error) => {
        console.error('Failed to release super-admin update guard:', error);
      });
    }
  }
};

export const getMyAdminAccess = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const admin = req.admin as IUser;
    const adminRole = resolveAdminRole((admin as any).adminRole);
    const permissionLevels = await getEffectiveAccessForUser(admin);
    return res.json({
      success: true,
      data: {
        adminRole,
        permissions: [...permissionsForLevels(permissionLevels)],
        permissionLevels,
        roles: ADMIN_ROLES,
      },
    });
  } catch (error) {
    return next(error);
  }
};

export const getAdminRoleAccess = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const adminRole = resolveAdminRole((req.admin as any)?.adminRole);
    if (adminRole !== 'super') {
      return res.status(403).json({ success: false, msg: 'Only a super admin can configure role access' });
    }
    const roles = await getConfiguredRoleAccess();
    return res.json({ success: true, data: { roles, levels: ['write', 'read', 'none'] } });
  } catch (error) {
    return next(error);
  }
};

export const updateAdminRoleAccess = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const admin = req.admin as IUser;
    if (resolveAdminRole((admin as any).adminRole) !== 'super') {
      return res.status(403).json({ success: false, msg: 'Only a super admin can configure role access' });
    }
    const matrix = validatePermissionMatrix(req.body?.roles);
    if (!matrix) {
      return res.status(400).json({ success: false, msg: 'Invalid role access matrix' });
    }
    const config = await saveConfiguredRoleAccess(matrix, admin._id);
    const roles = await getConfiguredRoleAccess();
    return res.json({ success: true, data: { roles, lastModified: config.lastModified } });
  } catch (error) {
    return next(error);
  }
};
