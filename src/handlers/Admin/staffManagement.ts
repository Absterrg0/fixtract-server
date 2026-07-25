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

function isInvitePending(user: IUser): boolean {
  const adminStaff = (user as any).adminStaff;
  if (!adminStaff?.inviteTokenHash || adminStaff.inviteAcceptedAt) return false;
  if (!adminStaff.inviteTokenExpires) return false;
  return new Date() <= new Date(adminStaff.inviteTokenExpires);
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
    await connecToDatabase();

    const existing = await User.findOne({ email: normalizedEmail });
    if (existing) {
      return res.status(409).json({ success: false, msg: 'A user with this email already exists' });
    }

    const inviteToken = generateAdminInviteToken();
    const inviteTokenHash = hashAdminInviteToken(inviteToken);
    const inviteTokenExpires = adminInviteExpiresAt();
    const unusablePassword = await randomUnusablePasswordHash();

    const staff = await User.create({
      name: name.trim(),
      email: normalizedEmail,
      phone: typeof phone === 'string' && phone.trim() ? phone.trim() : `+1000${Date.now().toString().slice(-8)}`,
      password: unusablePassword,
      role: 'admin',
      adminRole: adminRole as AdminRole,
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

    const inviteUrl = buildAdminInviteUrl(inviteToken);
    let emailSent = false;

    try {
      emailSent = await sendAdminStaffInvitationEmail(
        normalizedEmail,
        name.trim(),
        ADMIN_ROLE_LABELS[adminRole as AdminRole],
        inviteUrl
      );
    } catch (emailErr) {
      console.warn('Staff invite email failed (user still created):', emailErr);
    }

    return res.status(201).json({
      success: true,
      data: serializeStaff(staff),
      inviteUrl,
      emailSent,
    });
  } catch (error) {
    console.error('Invite staff error:', error);
    return res.status(500).json({ success: false, msg: 'Failed to invite staff' });
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
    console.error('Update staff error:', error);
    return res.status(500).json({ success: false, msg: 'Failed to update staff' });
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
