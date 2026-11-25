import Booking from '../models/booking';
import CancellationRequest from '../models/cancellationRequest';
import WarrantyClaim from '../models/warrantyClaim';
import ChatReport from '../models/chatReport';
import SupportTicket from '../models/supportTicket';
import MeetingRequest from '../models/meetingRequest';
import { RECORDED_DISPUTE_FILTER } from './bookingActivity';

/**
 * Admin work counters (nav badges and the dispute-management counter).
 *
 * A counter counts items that wait on an admin AND that became actionable at
 * or after the queue's reset (`resetAt`). Without a reset every actionable
 * item counts. A reset therefore brings a counter to 0 at once, and it rises
 * again only for work that arrives (or comes back to the admin) later.
 *
 * Counters are not list filters: every list keeps showing all open items. A
 * reset never deletes or edits a record.
 *
 * "Actionable since" per counter:
 * - booking disputes: `dispute.raisedAt`;
 * - escalated refund requests: `escalatedAt` (falls back to `createdAt`);
 * - escalated warranty claims: `escalation.escalatedAt` (no fallback: a note-only
 *   save must not bring a claim back; every escalation path sets it);
 * - professional cancellation requests: `createdAt`;
 * - support tickets: the latest public reply (the customer/pro reply that put
 *   the ticket back on the admin), else `createdAt`; meetings: `createdAt`;
 * - chat reports: `createdAt`;
 * - reviews: `customerReview.reviewedAt` (submission time).
 */

type Filter = Record<string, unknown>;

/** AND an extra "since reset" clause onto a base filter, without mutating either. */
const since = (base: Filter, clause: Filter | null): Filter => (clause ? { $and: [base, clause] } : base);
const sinceField = (field: string, resetAt: Date | null): Filter | null =>
  resetAt ? { [field]: { $gte: resetAt } } : null;
/** `$expr` comparing the first non-null of `fields` with the reset. */
const sinceFirstOf = (fields: string[], resetAt: Date | null): Filter | null => {
  if (!resetAt) return null;
  const value = fields.slice(0, -1).reduceRight<unknown>(
    (fallback, field) => ({ $ifNull: [`$${field}`, fallback] }),
    `$${fields[fields.length - 1]}`,
  );
  return { $expr: { $gte: [value, resetAt] } };
};

/** Open booking disputes (the dispute list's Open view). */
export const OPEN_BOOKING_DISPUTE_FILTER = Object.freeze({
  status: 'dispute',
  ...RECORDED_DISPUTE_FILTER,
  'dispute.resolvedAt': null,
});

/** Customer refund requests the professional rejected / did not answer: dispute management decides. */
export const ESCALATED_REFUND_REQUEST_FILTER = Object.freeze({ requestedRole: 'customer', status: 'escalated' });

/** Warranty claims escalated to the platform: dispute management decides. */
export const ESCALATED_WARRANTY_CLAIM_FILTER = Object.freeze({ status: 'escalated' });

/**
 * Cancellation requests counter: only pending requests a professional made
 * (they wait on an admin approve/deny). Customer requests first go to the
 * professional; once escalated they are counted under dispute management.
 */
export const PENDING_PROFESSIONAL_CANCELLATION_FILTER = Object.freeze({
  requestedRole: 'professional',
  status: 'pending',
});

/** Only pending reports can be resolved (warn/ban/dismiss); reviewed/dismissed are done. */
export const PENDING_CHAT_REPORT_FILTER = Object.freeze({ status: 'pending' });

/**
 * Support inbox items that wait on an admin:
 * - tickets (including legacy rows without `kind`) that are open/in progress
 *   and whose latest public reply is not an admin reply (an admin reply means
 *   the ticket now waits on the customer/professional);
 * - meeting requests not yet scheduled or declined (`meeting.status: pending`).
 */
export const ACTIONABLE_SUPPORT_TICKET_FILTER = Object.freeze({
  $or: [
    {
      kind: { $ne: 'meeting' },
      status: { $in: ['open', 'in_progress'] },
      $expr: { $ne: [{ $arrayElemAt: [{ $ifNull: ['$replies.authorRole', []] }, -1] }, 'admin'] },
    },
    { kind: 'meeting', 'meeting.status': 'pending' },
  ],
});

/** Historical MeetingRequest rows shown in the same unified support inbox. */
export const PENDING_LEGACY_MEETING_REQUEST_FILTER = Object.freeze({ status: 'pending' });

/** Published (not hidden) customer reviews: the Review moderation "Visible" list. */
export const VISIBLE_REVIEW_FILTER = Object.freeze({
  status: 'completed',
  'customerReview.communicationLevel': { $exists: true },
  'customerReview.isHidden': { $ne: true },
});

export interface DisputeManagementCounter {
  total: number;
  bookingDisputes: number;
  escalatedRefundRequests: number;
  escalatedWarrantyClaims: number;
}

/** Dispute management counter: open booking disputes + escalated refunds + escalated warranty claims. */
export async function countDisputeManagementWork(resetAt: Date | null): Promise<DisputeManagementCounter> {
  const [bookingDisputes, escalatedRefundRequests, escalatedWarrantyClaims] = await Promise.all([
    Booking.countDocuments(since(OPEN_BOOKING_DISPUTE_FILTER, sinceField('dispute.raisedAt', resetAt)) as any),
    CancellationRequest.countDocuments(
      since(ESCALATED_REFUND_REQUEST_FILTER, sinceFirstOf(['escalatedAt', 'createdAt'], resetAt)) as any,
    ),
    WarrantyClaim.countDocuments(
      since(ESCALATED_WARRANTY_CLAIM_FILTER, sinceField('escalation.escalatedAt', resetAt)) as any,
    ),
  ]);
  return {
    total: bookingDisputes + escalatedRefundRequests + escalatedWarrantyClaims,
    bookingDisputes,
    escalatedRefundRequests,
    escalatedWarrantyClaims,
  };
}

export const countCancellationRequestWork = (resetAt: Date | null): Promise<number> =>
  CancellationRequest.countDocuments(
    since(PENDING_PROFESSIONAL_CANCELLATION_FILTER, sinceField('createdAt', resetAt)) as any,
  );

export const countChatReportWork = (resetAt: Date | null): Promise<number> =>
  ChatReport.countDocuments(since(PENDING_CHAT_REPORT_FILTER, sinceField('createdAt', resetAt)) as any);

export async function countSupportWork(resetAt: Date | null): Promise<number> {
  // A ticket becomes admin work again when the customer/pro replies, so its
  // "since" is the latest reply; a ticket without replies counts from creation.
  const ticketSince = resetAt
    ? {
        $expr: {
          $gte: [
            {
              $cond: [
                { $eq: ['$kind', 'meeting'] },
                '$createdAt',
                { $ifNull: [{ $arrayElemAt: [{ $ifNull: ['$replies.createdAt', []] }, -1] }, '$createdAt'] },
              ],
            },
            resetAt,
          ],
        },
      }
    : null;
  const [tickets, legacyMeetings] = await Promise.all([
    SupportTicket.countDocuments(since(ACTIONABLE_SUPPORT_TICKET_FILTER, ticketSince) as any),
    MeetingRequest.countDocuments(since(PENDING_LEGACY_MEETING_REQUEST_FILTER, sinceField('createdAt', resetAt)) as any),
  ]);
  return tickets + legacyMeetings;
}

export const countReviewModerationWork = (resetAt: Date | null): Promise<number> =>
  Booking.countDocuments(since(VISIBLE_REVIEW_FILTER, sinceField('customerReview.reviewedAt', resetAt)) as any);
