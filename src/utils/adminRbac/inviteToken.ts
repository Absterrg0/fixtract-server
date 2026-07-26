import crypto from 'crypto';
import bcrypt from 'bcrypt';

export const ADMIN_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function generateAdminInviteToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function hashAdminInviteToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function adminInviteExpiresAt(from = new Date()): Date {
  return new Date(from.getTime() + ADMIN_INVITE_TTL_MS);
}

export function buildAdminInviteUrl(token: string): string {
  const base = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
  return `${base}/admin/accept-invite?token=${encodeURIComponent(token)}`;
}

/** Unusable placeholder password for invited admins until they accept the link. */
export async function randomUnusablePasswordHash(): Promise<string> {
  const secret = crypto.randomBytes(32).toString('hex');
  return bcrypt.hash(secret, 12);
}
