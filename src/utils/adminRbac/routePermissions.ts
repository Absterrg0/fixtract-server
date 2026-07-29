import type { AdminPermission } from './types';

/**
 * Most-specific path prefix wins. Paths are relative to the admin router
 * (e.g. `/payments`, not `/api/admin/payments`).
 */
const ROUTE_RULES: Array<{ prefix: string; permission: AdminPermission }> = [
  { prefix: '/staff', permission: 'staff.manage' },

  { prefix: '/professionals/manage', permission: 'professionals.manage' },
  { prefix: '/professionals', permission: 'professionals.approve' },
  { prefix: '/stats/approvals', permission: 'professionals.approve' },

  { prefix: '/customers', permission: 'customers.manage' },

  { prefix: '/bookings/', permission: 'bookings.read' }, // /bookings/:id/... — force-status checked in handler via requirePermission
  { prefix: '/bookings', permission: 'bookings.read' },
  { prefix: '/disputes', permission: 'disputes.manage' },
  { prefix: '/cancellation-requests', permission: 'cancellations.manage' },

  { prefix: '/chat-reports', permission: 'chat.reports' },
  { prefix: '/conversations', permission: 'chat.support' },
  { prefix: '/chat/', permission: 'chat.support' },

  { prefix: '/support', permission: 'support.tickets' },

  { prefix: '/payments', permission: 'payments.manage' },
  { prefix: '/kpi', permission: 'kpi.read' },
  { prefix: '/audit-logs', permission: 'audit.read' },
  { prefix: '/email-logs', permission: 'email_logs.read' },

  { prefix: '/cms', permission: 'cms.manage' },
  { prefix: '/site-announcements', permission: 'cms.manage' },
  { prefix: '/discount-codes', permission: 'discounts.manage' },
  { prefix: '/loyalty', permission: 'loyalty.manage' },
  { prefix: '/points', permission: 'loyalty.manage' },
  { prefix: '/professional-levels', permission: 'loyalty.manage' },
  { prefix: '/referral', permission: 'referrals.manage' },
  { prefix: '/backlinks', permission: 'backlinks.manage' },
  { prefix: '/favorites', permission: 'favorites.manage' },
  { prefix: '/reviews', permission: 'reviews.moderate' },

  { prefix: '/service-configurations', permission: 'services.manage' },

  { prefix: '/platform-settings', permission: 'settings.platform' },
  { prefix: '/site-settings', permission: 'settings.site' },

  { prefix: '/users/', permission: 'users.delete' },

  { prefix: '/run-', permission: 'maintenance.run' },
];

/** Permission required for an admin-router path, or null if any authenticated admin may call it. */
export function permissionForAdminPath(path: string): AdminPermission | null {
  const normalized = path.split('?')[0] || '/';
  const matches = ROUTE_RULES.filter(
    (rule) => normalized === rule.prefix || normalized.startsWith(rule.prefix)
  );
  if (matches.length === 0) return null;
  matches.sort((a, b) => b.prefix.length - a.prefix.length);
  return matches[0]?.permission ?? null;
}
