/** Platform staff role packs (role === 'admin' + adminRole). */
export const ADMIN_ROLES = [
  'super',
  'care',
  'marketing',
  'quality',
  'finance',
  'operations',
  'content_creator',
] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

export const ADMIN_ACCESS_LEVELS = ['write', 'read', 'none'] as const;
export type AdminAccessLevel = (typeof ADMIN_ACCESS_LEVELS)[number];

/** Admin areas shown in the role matrix and used by route-level access checks. */
export const ADMIN_ACCESS_AREAS = [
  'staff',
  'platform',
  'maintenance',
  'user_delete',
  'bookings',
  'disputes',
  'cancellations',
  'chat',
  'support',
  'chat_reports',
  'customers',
  'warranty',
  'professionals_approve',
  'professionals_manage',
  'projects',
  'services',
  'cms',
  'campaigns',
  'discounts',
  'loyalty',
  'referrals',
  'backlinks',
  'favorites',
  'reviews',
  'payments',
  'kpi',
  'audit',
  'email_logs',
] as const;
export type AdminAccessArea = (typeof ADMIN_ACCESS_AREAS)[number];
export type AdminPermissionLevels = Partial<Record<AdminAccessArea, AdminAccessLevel>>;

/** Fine-grained permissions enforced on admin APIs and UI. */
export const ADMIN_PERMISSIONS = [
  'staff.manage',
  'dashboard.overview',
  'professionals.approve',
  'professionals.manage',
  'customers.manage',
  'bookings.read',
  'bookings.write',
  'disputes.manage',
  'cancellations.manage',
  'chat.support',
  'chat.reports',
  'support.tickets',
  'payments.manage',
  'kpi.read',
  'audit.read',
  'email_logs.read',
  'cms.manage',
  'campaigns.manage',
  'discounts.manage',
  'loyalty.manage',
  'referrals.manage',
  'backlinks.manage',
  'reviews.moderate',
  'favorites.manage',
  'services.manage',
  'projects.approve',
  'warranty.manage',
  'settings.platform',
  'settings.site',
  'maintenance.run',
  'users.delete',
] as const;

export type AdminPermission = (typeof ADMIN_PERMISSIONS)[number];

export function isAdminRole(value: unknown): value is AdminRole {
  return typeof value === 'string' && (ADMIN_ROLES as readonly string[]).includes(value);
}

export const ADMIN_ROLE_LABELS: Record<AdminRole, string> = {
  super: 'Super admin',
  care: 'Customer care',
  marketing: 'Marketing',
  quality: 'Quality',
  finance: 'Finance',
  operations: 'Operations',
  content_creator: 'Content Creator',
};
