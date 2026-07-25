import { Request, Response, NextFunction } from 'express';
import User, { IUser } from '../../models/user';
import connecToDatabase from '../../config/db';
import { ADMIN_ROLES, isAdminRole, type AdminRole } from '../../utils/adminRbac/types';
import { permissionsForRole, resolveAdminRole } from '../../utils/adminRbac/rolePermissions';
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

function resolveInvitePhone(phone: unknown): string {
  if (typeof phone === 'string' && phone.trim()) {
    return phone.trim();
  }
  return `+1000${Date.now().toString().slice(-8)}`;
}

function isInvitePending(user: IUser): boolean {
  const adminStaff = (user as any).adminStaff;
  if (adminStaff?.inviteAcceptedAt) return false;
  if (!adminStaff?.invitedAt) return false;
  return true;
}

function canResendAdminInvite(user: IUser): boolean {
  if (user.role !== 'admin') return false;
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
  if (opts.phone) {
    staff.phone = opts.phone;
  }
  staff.isEmailVerified = false;
  staff.isPhoneVerified = false;
  staff.accountStatus = 'active';

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
  const pending = isInvitePending(user);
  return {
    _id: user._id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    role: user.role,
    adminRole,
    permissions: [...permissionsForRole(adminRole)],
    accountStatus: pending ? 'pending' : (user.accountStatus || 'active'),
    invitePending: pending,
    isEmailVerified: user.isEmailVerified,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    invitedBy: (user as any).adminStaff?.invitedBy ?? null,
    invitedAt: (user as any).adminStaff?.invitedAt ?? null,
  };
}

export const listStaff = async (_req: Request, res: Response) => {
  try {
    await connecToDatabase();
    const staff = await User.find({ role: 'admin' })
      .select(
        'name email phone role adminRole accountStatus isEmailVerified createdAt updatedAt adminStaff.invitedBy adminStaff.invitedAt adminStaff.inviteTokenHash adminStaff.inviteTokenExpires adminStaff.inviteAcceptedAt'
      )
      .sort({ createdAt: -1 });

    return res.json({
      success: true,
      data: staff.map(serializeStaff),
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
    const normalizedPhone = resolveInvitePhone(phone);
    const trimmedName = name.trim();
    const role = adminRole as AdminRole;
    await connecToDatabase();

    const existing = await User.findOne({ email: normalizedEmail }).select(
      'name email phone role adminRole accountStatus isEmailVerified createdAt updatedAt adminStaff'
    );

    if (existing) {
      if (!canResendAdminInvite(existing)) {
        return res.status(409).json({
          success: false,
          msg: 'A user with this email already exists',
          field: 'email',
        });
      }

      if (typeof phone === 'string' && phone.trim() && phone.trim() !== existing.phone) {
        const existingPhone = await User.findOne({
          phone: normalizedPhone,
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
        phone: typeof phone === 'string' && phone.trim() ? normalizedPhone : undefined,
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

    if (typeof phone === 'string' && phone.trim()) {
      const existingPhone = await User.findOne({ phone: normalizedPhone }).select('_id');
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
      phone: normalizedPhone,
      password: unusablePassword,
      role: 'admin',
      adminRole: role,
      isEmailVerified: false,
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
      return res.status(400).json({
        success: false,
        msg: 'This staff member has already activated their account',
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

    if (adminRole !== undefined) {
      if (!isAdminRole(adminRole)) {
        return res.status(400).json({
          success: false,
          msg: `adminRole must be one of: ${ADMIN_ROLES.join(', ')}`,
        });
      }
      (staff as any).adminRole = adminRole;
    }

    if (accountStatus !== undefined) {
      if (!['active', 'suspended'].includes(accountStatus)) {
        return res.status(400).json({ success: false, msg: 'accountStatus must be active or suspended' });
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
  }
};

export const getMyAdminAccess = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const admin = req.admin as IUser;
    const adminRole = resolveAdminRole((admin as any).adminRole);
    return res.json({
      success: true,
      data: {
        adminRole,
        permissions: [...permissionsForRole(adminRole)],
        roles: ADMIN_ROLES,
      },
    });
  } catch (error) {
    return next(error);
  }
};
