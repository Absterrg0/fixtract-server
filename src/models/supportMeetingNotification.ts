import { Schema, model, Document, Types } from "mongoose";

export const SUPPORT_MEETING_NOTIFICATION_TYPES = [
  "confirmed",
  "link_updated",
  "rescheduled",
  "cancelled",
] as const;

export type SupportMeetingNotificationType =
  (typeof SUPPORT_MEETING_NOTIFICATION_TYPES)[number];

export const SUPPORT_MEETING_NOTIFICATION_STATUSES = [
  "pending",
  "dispatching",
  "sent",
  "failed",
  "superseded",
] as const;

export type SupportMeetingNotificationStatus =
  (typeof SUPPORT_MEETING_NOTIFICATION_STATUSES)[number];

/**
 * Durable identity + delivery state for each meeting notification event.
 *
 * The unique (ticketId, eventId) index is the concurrency guard: two requests
 * that observe the same transition race to claim the event, and only one sends
 * the mail. `pending` is a short lease, so a crashed instance cannot strand a
 * notification forever; an expired lease can be claimed again.
 */
export interface ISupportMeetingNotification extends Document {
  _id: Types.ObjectId;
  ticketId: Types.ObjectId;
  /** Deterministic, e.g. `confirmed:3` from the meeting revision. */
  eventId: string;
  /**
   * Meeting revision parsed from `eventId`. Supersede only marks rows from a
   * strictly older revision, so an older transition can never suppress a
   * newer event that another request already claimed. Rows written before
   * this field existed have no revision and are treated as older.
   */
  revision?: number;
  type: SupportMeetingNotificationType;
  status: SupportMeetingNotificationStatus;
  attempts: number;
  claimedAt: Date;
  /** Set when a bounded dispatch hand-off starts (before the provider call). */
  dispatchStartedAt?: Date;
  sentAt?: Date;
  failedAt?: Date;
  supersededAt?: Date;
  /** Safe failure summary only; never a rendered body or meeting link. */
  lastError?: string;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<ISupportMeetingNotification>(
  {
    ticketId: { type: Schema.Types.ObjectId, ref: "SupportTicket", required: true },
    eventId: { type: String, required: true, trim: true, maxlength: 120 },
    revision: { type: Number, min: 0 },
    type: {
      type: String,
      enum: SUPPORT_MEETING_NOTIFICATION_TYPES,
      required: true,
    },
    status: {
      type: String,
      enum: SUPPORT_MEETING_NOTIFICATION_STATUSES,
      default: "pending",
      required: true,
    },
    attempts: { type: Number, default: 1, min: 1 },
    claimedAt: { type: Date, required: true },
    dispatchStartedAt: { type: Date },
    sentAt: { type: Date },
    failedAt: { type: Date },
    supersededAt: { type: Date },
    lastError: { type: String, trim: true, maxlength: 300 },
  },
  { timestamps: true },
);

schema.index({ ticketId: 1, eventId: 1 }, { unique: true });
schema.index({ status: 1, claimedAt: 1 });

const SupportMeetingNotification = model<ISupportMeetingNotification>(
  "SupportMeetingNotification",
  schema,
);
export default SupportMeetingNotification;
