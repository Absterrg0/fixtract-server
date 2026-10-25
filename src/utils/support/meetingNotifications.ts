import { Types, type ClientSession } from "mongoose";
import SupportMeetingNotification, {
  type SupportMeetingNotificationType,
} from "../../models/supportMeetingNotification";

/** A claim older than this is considered abandoned (crashed instance) and may be retried. */
export const SUPPORT_MEETING_NOTIFICATION_LEASE_MS = 5 * 60 * 1000;

export function supportMeetingEventId(
  type: SupportMeetingNotificationType,
  revision: number,
): string {
  return `${type}:${revision}`;
}

/** Event ids are always `type:revision`; anything else has no revision. */
export function supportMeetingEventRevision(eventId: string): number | undefined {
  const separator = eventId.lastIndexOf(":");
  if (separator < 0) return undefined;
  const revision = Number(eventId.slice(separator + 1));
  return Number.isInteger(revision) && revision >= 0 ? revision : undefined;
}

export type SupportMeetingNotificationClaim =
  | {
      claimed: true;
      notificationId: Types.ObjectId;
      attempts: number;
    }
  | {
      claimed: false;
      status: "sent" | "pending" | "dispatching" | "failed" | "superseded" | "missing";
    };

function isDuplicateKey(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  return code === 11000 || code === 11001;
}

/**
 * Claim the right to send one notification event. The unique (ticketId,
 * eventId) index means concurrent requests cannot both send the same event.
 * A failed event or an expired pending/dispatching lease (crashed request) is
 * retryable. A superseded event belongs to an older meeting transition and is
 * never sent again.
 */
export async function claimSupportMeetingNotification(params: {
  ticketId: Types.ObjectId | string;
  eventId: string;
  type: SupportMeetingNotificationType;
  now?: Date;
}): Promise<SupportMeetingNotificationClaim> {
  const now = params.now || new Date();
  const leaseCutoff = new Date(now.getTime() - SUPPORT_MEETING_NOTIFICATION_LEASE_MS);
  const ticketId = new Types.ObjectId(String(params.ticketId));

  try {
    const created = await SupportMeetingNotification.create({
      ticketId,
      eventId: params.eventId,
      revision: supportMeetingEventRevision(params.eventId),
      type: params.type,
      status: "pending",
      attempts: 1,
      claimedAt: now,
    });
    return { claimed: true, notificationId: created._id, attempts: 1 };
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
  }

  const existing = await SupportMeetingNotification.findOne({
    ticketId,
    eventId: params.eventId,
  }).lean();
  if (!existing) return { claimed: false, status: "missing" };
  if (existing.status === "sent") return { claimed: false, status: "sent" };
  if (existing.status === "superseded") return { claimed: false, status: "superseded" };
  if (existing.status === "pending" && existing.claimedAt > leaseCutoff) {
    return { claimed: false, status: "pending" };
  }
  if (
    existing.status === "dispatching"
    && existing.dispatchStartedAt
    && existing.dispatchStartedAt > leaseCutoff
  ) {
    return { claimed: false, status: "dispatching" };
  }

  // Conditional claim: either a failed attempt, an expired pending claim, or
  // an expired dispatching lease. A concurrent retry that wins first makes
  // this update a no-op.
  const updated = await SupportMeetingNotification.findOneAndUpdate(
    {
      _id: existing._id,
      $or: [
        { status: "failed" },
        { status: "pending", claimedAt: { $lte: leaseCutoff } },
        { status: "dispatching", dispatchStartedAt: { $lte: leaseCutoff } },
      ],
    },
    {
      $set: {
        status: "pending",
        claimedAt: now,
        revision: supportMeetingEventRevision(params.eventId),
      },
      $unset: { failedAt: 1, lastError: 1, dispatchStartedAt: 1, supersededAt: 1 },
      $inc: { attempts: 1 },
    },
    { new: true },
  );
  if (updated) {
    return {
      claimed: true,
      notificationId: updated._id,
      attempts: updated.attempts,
    };
  }
  const current = await SupportMeetingNotification.findOne({
    ticketId,
    eventId: params.eventId,
  })
    .select("status")
    .lean();
  const status = current?.status;
  return {
    claimed: false,
    status:
      status === "sent"
        ? "sent"
        : status === "superseded"
          ? "superseded"
          : status === "dispatching"
            ? "dispatching"
            : status === "failed"
              ? "failed"
              : "pending",
  };
}

/**
 * Atomically mark that this attempt is being handed to the mail provider.
 * Transitions only supersede pending/failed events; once dispatching starts the
 * mail is treated as already initiated (it cannot be recalled from a provider).
 */
export async function startSupportMeetingNotificationDispatch(
  notificationId: Types.ObjectId,
  attempts: number,
  now = new Date(),
): Promise<boolean> {
  const updated = await SupportMeetingNotification.findOneAndUpdate(
    { _id: notificationId, status: "pending", attempts },
    { $set: { status: "dispatching", dispatchStartedAt: now } },
    { new: true },
  );
  return Boolean(updated);
}

export async function markSupportMeetingNotificationSent(
  notificationId: Types.ObjectId,
  now = new Date(),
): Promise<void> {
  await SupportMeetingNotification.updateOne(
    { _id: notificationId, status: "dispatching" },
    {
      $set: { status: "sent", sentAt: now },
      $unset: { failedAt: 1, lastError: 1 },
    },
  );
}

export async function markSupportMeetingNotificationFailed(
  notificationId: Types.ObjectId,
  now = new Date(),
  reason = "Mail provider rejected or threw",
): Promise<void> {
  await SupportMeetingNotification.updateOne(
    { _id: notificationId, status: { $in: ["pending", "dispatching"] } },
    {
      $set: {
        status: "failed",
        failedAt: now,
        lastError: String(reason).slice(0, 300),
      },
    },
  );
}

export async function markSupportMeetingNotificationSuperseded(
  notificationId: Types.ObjectId,
  now = new Date(),
): Promise<void> {
  await SupportMeetingNotification.updateOne(
    { _id: notificationId, status: { $in: ["pending", "failed"] } },
    {
      $set: { status: "superseded", supersededAt: now },
      $unset: { failedAt: 1, lastError: 1, dispatchStartedAt: 1 },
    },
  );
}

/**
 * A newer meeting transition makes every older undelivered event obsolete.
 * This must run in the same transaction as the transition write. Already
 * dispatching/sent events are left alone: a mail handed to the provider cannot
 * be recalled, but a pending event can never start after the new state.
 *
 * `revision` is the revision written by the transition. Only events from a
 * strictly older revision are marked: an older transition can then never
 * suppress a newer cancellation/reschedule event that another request already
 * claimed. Rows persisted before the revision field are necessarily older.
 */
export async function supersedeSupportMeetingNotifications(
  ticketId: Types.ObjectId | string,
  options: {
    session?: ClientSession;
    revision?: number;
    now?: Date;
  } = {},
): Promise<void> {
  const filter: Record<string, unknown> = {
    ticketId: new Types.ObjectId(String(ticketId)),
    status: { $in: ["pending", "failed"] },
  };
  if (typeof options.revision === "number" && Number.isFinite(options.revision)) {
    filter.$and = [
      {
        $or: [
          { revision: { $lt: options.revision } },
          { revision: { $exists: false } },
        ],
      },
    ];
  }
  await SupportMeetingNotification.updateMany(
    filter,
    {
      $set: { status: "superseded", supersededAt: options.now || new Date() },
      $unset: { failedAt: 1, lastError: 1, dispatchStartedAt: 1 },
    },
    options.session ? { session: options.session } : undefined,
  );
}

/** Read an accepted delivery marker without trusting an in-memory ticket. */
export async function findSentSupportMeetingNotification(
  ticketId: Types.ObjectId | string,
  eventId: string,
): Promise<{ sentAt: Date } | null> {
  const notification = await SupportMeetingNotification.findOne({
    ticketId: new Types.ObjectId(String(ticketId)),
    eventId,
    status: "sent",
  })
    .select("sentAt")
    .lean();
  if (!notification?.sentAt) return null;
  return { sentAt: notification.sentAt };
}
