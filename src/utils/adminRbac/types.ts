/** Platform staff role packs (role === 'admin' + adminRole). */
export const ADMIN_ROLES = ['super', 'care', 'marketing', 'quality', 'finance'] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

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
};
