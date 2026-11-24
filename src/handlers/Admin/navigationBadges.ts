import { Request, Response } from "express";
import type { IUser } from "../../models/user";
import User from "../../models/user";
import Project from "../../models/project";
import {
  loadDashboardBaselines,
  type DashboardBaselineMap,
} from "../../utils/adminDashboardBaselines";
import {
  countCancellationRequestWork,
  countChatReportWork,
  countDisputeManagementWork,
  countReviewModerationWork,
  countSupportWork,
} from "../../utils/adminWorkCounters";
import { getEffectiveAccessForUser } from "../../utils/adminRbac/roleAccess";
import { hasAccessLevel } from "../../utils/adminRbac/rolePermissions";
import { denyUnlessPermission } from "../../utils/adminRbac/assertPermission";
import type { AdminAccessArea, AdminPermissionLevels } from "../../utils/adminRbac/types";

/**
 * Admin navigation badges (restructuring DOCX, "Pending/open task counters").
 *
 * Exactly the seven DOCX items carry a badge. Each count is the work that
 * waits on an admin decision; finished rows (resolved, closed, approved,
 * rejected, completed, dismissed, ...) are never counted. Where a super admin
 * reset the counter, only work that became actionable since the reset counts,
 * so a reset brings the badge to 0 (src/utils/adminWorkCounters.ts). Category
 * sums are NOT computed here: the client adds the children it actually shows,
 * so a sum can never include a child the admin cannot see.
 *
 * Authorization mirrors each queue's own list endpoint, per key, from the
 * server-side effective access matrix. Keys the admin may not read are
 * omitted (never 0). A count that fails to load is `null` (unknown), never a
 * false 0.
 */
export const ADMIN_NAVIGATION_BADGE_KEYS = [
  "professionalApprovals",
  "projectApprovals",
  "cancellationRequests",
  "disputes",
  "supportTickets",
  "chatReports",
  "reviewModeration",
] as const;
export type AdminNavigationBadgeKey = (typeof ADMIN_NAVIGATION_BADGE_KEYS)[number];

/** Same population as GET /admin/professionals (default `pending` tab) and stats.pending. */
export const PENDING_PROFESSIONAL_APPROVAL_FILTER = Object.freeze({
  role: "professional",
  professionalStatus: "pending",
  deletedAt: null,
  isAnonymized: { $ne: true },
});

/** Same population as GET /projects/admin/pending and the approve/reject precondition. */
export const PENDING_PROJECT_APPROVAL_FILTER = Object.freeze({ status: "pending" });

type BadgeQueue = {
  /** Same authorization as the queue's list endpoint. */
  authorized: (ctx: { admin: IUser; levels: AdminPermissionLevels }) => boolean;
  count: (baselines: DashboardBaselineMap) => Promise<number>;
};

const resetAtOf = (baselines: DashboardBaselineMap, key: Parameters<DashboardBaselineMap["get"]>[0]) =>
  baselines.get(key) ?? null;

const readable = (area: AdminAccessArea) => ({ levels }: { levels: AdminPermissionLevels }) =>
  hasAccessLevel(levels, area, "read");

export const NAVIGATION_BADGE_QUEUES: Record<AdminNavigationBadgeKey, BadgeQueue> = {
  professionalApprovals: {
    authorized: readable("professionals_approve"),
    count: async () => User.countDocuments(PENDING_PROFESSIONAL_APPROVAL_FILTER),
  },
  projectApprovals: {
    // GET /projects/admin/pending is outside the admin router and is guarded by
    // denyUnlessPermission(projects.approve); use that exact check.
    authorized: ({ admin }) => denyUnlessPermission(admin, "projects.approve") === null,
    count: async () => Project.countDocuments(PENDING_PROJECT_APPROVAL_FILTER),
  },
  cancellationRequests: {
    // Only pending requests made by a professional wait on an admin. Escalated
    // customer refunds are counted under dispute management.
    authorized: readable("cancellations"),
    count: async (baselines) => countCancellationRequestWork(resetAtOf(baselines, "cancellations")),
  },
  disputes: {
    // Everything dispute management decides: open booking disputes, escalated
    // refund requests and escalated warranty claims. Same number as the
    // dispute page's "Dispute management counter".
    authorized: readable("disputes"),
    count: async (baselines) => (await countDisputeManagementWork(resetAtOf(baselines, "disputes"))).total,
  },
  supportTickets: {
    authorized: readable("support"),
    count: async (baselines) => countSupportWork(resetAtOf(baselines, "supportTickets")),
  },
  chatReports: {
    authorized: readable("chat_reports"),
    count: async (baselines) => countChatReportWork(resetAtOf(baselines, "chatReports")),
  },
  reviewModeration: {
    authorized: readable("reviews"),
    // Reviews are published on submission, so the moderation work is reading
    // the new ones: visible reviews submitted since the last reset. A super
    // admin resets the counter once the reviews have been checked.
    count: async (baselines) => countReviewModerationWork(resetAtOf(baselines, "reviewModeration")),
  },
};

export type AdminNavigationBadgeCounts = Partial<Record<AdminNavigationBadgeKey, number | null>>;

export async function computeAdminNavigationBadges(admin: IUser): Promise<AdminNavigationBadgeCounts> {
  const levels = await getEffectiveAccessForUser(admin);
  const keys = ADMIN_NAVIGATION_BADGE_KEYS.filter((key) =>
    NAVIGATION_BADGE_QUEUES[key].authorized({ admin, levels }),
  );
  // A failed baseline read must not take down every badge: fall back to no
  // baselines (count all), which keeps per-queue failure isolation intact.
  const baselines = await loadDashboardBaselines().catch((error: unknown) => {
    console.error("[Admin] navigation badge baselines failed:", (error as Error)?.message);
    return new Map() as Awaited<ReturnType<typeof loadDashboardBaselines>>;
  });
  const results = await Promise.allSettled(keys.map((key) => NAVIGATION_BADGE_QUEUES[key].count(baselines)));
  const counts: AdminNavigationBadgeCounts = {};
  keys.forEach((key, index) => {
    const result = results[index];
    if (result.status === "fulfilled" && Number.isFinite(result.value) && result.value >= 0) {
      counts[key] = result.value;
    } else {
      if (result.status === "rejected") {
        console.error(`[Admin] navigation badge "${key}" failed:`, (result.reason as Error)?.message);
      }
      counts[key] = null;
    }
  });
  return counts;
}

/** GET /api/admin/navigation/badges — one bounded request for every visible badge. */
export const getAdminNavigationBadges = async (req: Request, res: Response) => {
  res.set("Cache-Control", "private, no-store");
  const admin = req.admin as IUser | undefined;
  if (!admin) {
    return res.status(401).json({ success: false, msg: "Admin authentication required" });
  }
  try {
    const counts = await computeAdminNavigationBadges(admin);
    return res.status(200).json({
      success: true,
      data: { counts, generatedAt: new Date().toISOString() },
    });
  } catch (error) {
    console.error("[Admin] navigation badges failed:", (error as Error)?.message);
    return res.status(500).json({ success: false, msg: "Failed to load navigation counts" });
  }
};
