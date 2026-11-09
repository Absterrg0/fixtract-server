import { Request, Response } from "express";
import type { IUser } from "../../models/user";
import User from "../../models/user";
import Project from "../../models/project";
import ChatReport from "../../models/chatReport";
import SupportTicket from "../../models/supportTicket";
import MeetingRequest from "../../models/meetingRequest";
import Booking from "../../models/booking";
import CancellationRequest, {
  ADMIN_ACTIONABLE_CANCELLATION_STATUSES,
} from "../../models/cancellationRequest";
import { buildDisputeFilter } from "./disputeManagement";
import {
  clauseForDashboard,
  loadDashboardBaselines,
  withBaselineClause,
  type DashboardBaselineMap,
} from "../../utils/adminDashboardBaselines";
import { getEffectiveAccessForUser } from "../../utils/adminRbac/roleAccess";
import { hasAccessLevel } from "../../utils/adminRbac/rolePermissions";
import { denyUnlessPermission } from "../../utils/adminRbac/assertPermission";
import type { AdminAccessArea, AdminPermissionLevels } from "../../utils/adminRbac/types";

/**
 * Admin navigation badges (restructuring DOCX, "Pending/open task counters").
 *
 * Exactly the seven DOCX items carry a badge. Each count is the population the
 * matching admin queue lists as still needing an admin decision; finished rows
 * (resolved, closed, approved, rejected, completed, dismissed, ...) are never
 * counted. Category sums are NOT computed here: the client adds the children
 * it actually shows, so a sum can never include a child the admin cannot see.
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

/** Exactly the statuses the admin approve/deny handlers accept. */
export const ACTIONABLE_CANCELLATION_FILTER = Object.freeze({
  status: { $in: ADMIN_ACTIONABLE_CANCELLATION_STATUSES },
});

/** Only pending reports can be resolved (warn/ban/dismiss); reviewed/dismissed are done. */
export const PENDING_CHAT_REPORT_FILTER = Object.freeze({ status: "pending" });

/**
 * Support inbox items that wait on an admin:
 * - tickets (including legacy rows without `kind`) that are open/in progress
 *   and whose latest public reply is not an admin reply (an admin reply means
 *   the ticket now waits on the customer/professional);
 * - meeting requests not yet scheduled or declined (`meeting.status: pending`).
 * A meeting's internal ticket status is not a ticket status, so it is ignored.
 */
export const ACTIONABLE_SUPPORT_TICKET_FILTER = Object.freeze({
  $or: [
    {
      kind: { $ne: "meeting" },
      status: { $in: ["open", "in_progress"] },
      $expr: { $ne: [{ $arrayElemAt: [{ $ifNull: ["$replies.authorRole", []] }, -1] }, "admin"] },
    },
    { kind: "meeting", "meeting.status": "pending" },
  ],
});

/** Historical MeetingRequest rows shown in the same unified support inbox. */
export const PENDING_LEGACY_MEETING_REQUEST_FILTER = Object.freeze({ status: "pending" });

type BadgeQueue = {
  /** Same authorization as the queue's list endpoint. */
  authorized: (ctx: { admin: IUser; levels: AdminPermissionLevels }) => boolean;
  count: (baselines: DashboardBaselineMap) => Promise<number>;
};

/**
 * Counting-since clause for a dashboard's current baseline. Badges count only
 * open work, and the baseline rule keeps open work visible, so this clause does
 * not change the number. It is applied anyway so the badge follows the same rule
 * as its queue.
 */
const badgeBaselineClause = (key: "disputes" | "cancellations", baselines: DashboardBaselineMap) => {
  const resetAt = baselines.get(key);
  return resetAt ? clauseForDashboard(key, resetAt) : {};
};

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
    authorized: readable("cancellations"),
    count: async (baselines) => CancellationRequest.countDocuments(
      withBaselineClause(ACTIONABLE_CANCELLATION_FILTER, badgeBaselineClause("cancellations", baselines)),
    ),
  },
  disputes: {
    // Canonical open booking disputes: the dispute list's Open view and the
    // "Open booking disputes" card. Warranty claims and escalated refunds are
    // separate queues and are never part of this count.
    authorized: readable("disputes"),
    count: async (baselines) => Booking.countDocuments(
      withBaselineClause(buildDisputeFilter("open"), badgeBaselineClause("disputes", baselines)) as any,
    ),
  },
  supportTickets: {
    authorized: readable("support"),
    count: async () => {
      const [tickets, legacyMeetings] = await Promise.all([
        SupportTicket.countDocuments(ACTIONABLE_SUPPORT_TICKET_FILTER),
        MeetingRequest.countDocuments(PENDING_LEGACY_MEETING_REQUEST_FILTER),
      ]);
      return tickets + legacyMeetings;
    },
  },
  chatReports: {
    authorized: readable("chat_reports"),
    count: async () => ChatReport.countDocuments(PENDING_CHAT_REPORT_FILTER),
  },
  reviewModeration: {
    authorized: readable("reviews"),
    // Reviews are published on submission (profanity is rejected up front) and
    // there is no review report/flag or "awaiting moderation" state. Hidden
    // reviews were already acted on; visible ones are ordinary published
    // reviews. No review currently waits on an admin, so the queue is empty by
    // construction. Counting all visible reviews would turn every published
    // review into a fake task.
    count: async () => 0,
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
