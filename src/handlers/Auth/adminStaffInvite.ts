import { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcrypt';
import mongoose from 'mongoose';
import User from '../../models/user';
import connecToDatabase from '../../config/db';
import generateToken from '../../utils/functions';
import { permissionsForRole, resolveAdminRole } from '../../utils/adminRbac/rolePermissions';
import { hashAdminInviteToken } from '../../utils/adminRbac/inviteToken';
import { ADMIN_ROLE_LABELS, type AdminRole } from '../../utils/adminRbac/types';

function setTokenCookie(res: Response, token: string) {
  const isProduction = process.env.NODE_ENV === 'production';
  res.cookie('auth-token', token, {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? 'none' : 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

function adminAccessFields(user: { role?: string; adminRole?: string }) {
  if (user.role !== 'admin') return {};
  const adminRole = resolveAdminRole(user.adminRole);
  return {
    adminRole,
    adminPermissions: [...permissionsForRole(adminRole)],
  };
}

async function findStaffByInviteToken(token: string) {
  if (!token || typeof token !== 'string' || token.length < 16) {
    return null;
  }

  const tokenHash = hashAdminInviteToken(token);
  const staff = await User.findOne({
    role: 'admin',
    accountStatus: 'active',
    // Matches missing or explicit null (unlike $exists: false alone)
    deletedAt: null,
    'adminStaff.inviteTokenHash': tokenHash,
    'adminStaff.inviteTokenExpires': { $gt: new Date() },
    'adminStaff.inviteAcceptedAt': { $exists: false },
  }).select('+adminStaff.inviteTokenHash +adminStaff.inviteTokenExpires');

  return staff;
}

export const getAdminInviteDetails = async (req: Request, res: Response) => {
  try {
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    if (!token) {
      return res.status(400).json({ success: false, msg: 'Invite token is required' });
    }

    await connecToDatabase();
    const staff = await findStaffByInviteToken(token);
    if (!staff) {
      return res.status(404).json({
        success: false,
        msg: 'This invite link is invalid or has expired',
      });
    }

    const adminRole = resolveAdminRole((staff as any).adminRole) as AdminRole;
    return res.json({
      success: true,
      data: {
        name: staff.name,
        email: staff.email,
        adminRole,
        roleLabel: ADMIN_ROLE_LABELS[adminRole],
      },
    });
  } catch (error) {
    console.error('Get admin invite details error:', error);
    return res.status(500).json({ success: false, msg: 'Failed to load invite details' });
  }
};

export const acceptAdminInvite = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { token, password } = req.body || {};

    if (!token || typeof token !== 'string') {
      return res.status(400).json({ success: false, msg: 'Invite token is required' });
    }
    if (!password || typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({
        success: false,
        msg: 'Password must be at least 8 characters long',
      });
    }

    await connecToDatabase();
    const tokenHash = hashAdminInviteToken(token);
    const hashedPassword = await bcrypt.hash(password, 12);
    const now = new Date();

    const staff = await User.findOneAndUpdate(
      {
        role: 'admin',
        accountStatus: 'active',
        // Matches missing or explicit null (unlike $exists: false alone)
        deletedAt: null,
        'adminStaff.inviteTokenHash': tokenHash,
        'adminStaff.inviteTokenExpires': { $gt: now },
        'adminStaff.inviteAcceptedAt': { $exists: false },
      },
      {
        $set: {
          password: hashedPassword,
          isEmailVerified: true,
          // Email invite does not prove phone ownership
          accountStatus: 'active',
          'adminStaff.inviteAcceptedAt': now,
        },
        $unset: {
          'adminStaff.inviteTokenHash': '',
          'adminStaff.inviteTokenExpires': '',
        },
      },
      { new: true }
    );

    if (!staff) {
      return res.status(404).json({
        success: false,
        msg: 'This invite link is invalid or has expired',
      });
    }

    const jwtToken = generateToken(staff._id as mongoose.Types.ObjectId);
    setTokenCookie(res, jwtToken);

    const adminRole = resolveAdminRole((staff as any).adminRole);
    return res.status(200).json({
      success: true,
      msg: 'Account activated successfully',
      token: jwtToken,
      user: {
        _id: staff._id,
        name: staff.name,
        email: staff.email,
        phone: staff.phone,
        role: staff.role,
        ...adminAccessFields(staff),
        isEmailVerified: staff.isEmailVerified,
        isPhoneVerified: staff.isPhoneVerified,
        accountStatus: staff.accountStatus || 'active',
      },
    });
  } catch (error) {
    return next(error);
  }
};
