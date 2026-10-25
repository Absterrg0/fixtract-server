import { Types } from "mongoose";
import Meeting from "../../models/meeting";
import MeetingRequest from "../../models/meetingRequest";
import SupportTicket from "../../models/supportTicket";
import User from "../../models/user";
import { SUPPORT_MEETING_DURATION_MINUTES } from "../../constants/support";
import { meetingIntervalInTimeZone, resolveStoredCalendarTimeZone } from "./availability";

export interface SharedCalendarInterval {
  start: number;
  end: number;
}

export interface SharedCalendarBusySource extends SharedCalendarInterval {
  source: "support" | "meeting" | "meeting_request";
  id: string;
  userId: string;
}

export interface SharedCalendarBusyResult {
  byUser: Map<string, SharedCalendarInterval[]>;
  sources: SharedCalendarBusySource[];
}

export interface SharedCalendarBusyOptions {
  excludeSupportTicketId?: string;
  excludeMeetingId?: string;
  excludeMeetingRequestId?: string;
}

function idVariants(ids: string[]): Array<Types.ObjectId | string> {
  const variants: Array<Types.ObjectId | string> = [...ids];
  for (const id of ids) {
    if (Types.ObjectId.isValid(id)) variants.push(new Types.ObjectId(id));
  }
  return variants;
}

function intervalOverlaps(start: number, end: number, interval: SharedCalendarInterval): boolean {
  return start < interval.end && end > interval.start;
}

function pushUnique(
  map: Map<string, SharedCalendarInterval[]>,
  sources: SharedCalendarBusySource[],
  userId: string,
  source: SharedCalendarBusySource["source"],
  id: string,
  start: number,
  end: number,
): void {
  if (!userId || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
  const current = map.get(userId) || [];
  if (current.some((entry) => entry.start === start && entry.end === end)) return;
  current.push({ start, end });
  map.set(userId, current);
  sources.push({ source, id, userId, start, end });
}

/**
 * Reads every non-booking calendar source that can occupy a professional or
 * employee calendar. Used by project booking writers and the legacy admin
 * MeetingRequest scheduler so they cannot double-book support meetings,
 * project Meetings, or legacy requests. Only the requested users are loaded:
 * an unrelated employee is never marked busy.
 */
export async function loadSharedCalendarBusy(
  userIds: Array<Types.ObjectId | string>,
  options: SharedCalendarBusyOptions = {},
): Promise<SharedCalendarBusyResult> {
  const ids = Array.from(new Set(userIds.map((id) => String(id)).filter(Boolean)));
  const byUser = new Map<string, SharedCalendarInterval[]>();
  const sources: SharedCalendarBusySource[] = [];
  if (ids.length === 0) return { byUser, sources };

  const variants = idVariants(ids);

  const supportFilter: Record<string, unknown> = {
    kind: "meeting",
    "meeting.status": { $in: ["pending", "scheduled"] },
    "meeting.scheduledAt": { $ne: null },
    $or: [{ userId: { $in: variants } }, { "meeting.adminId": { $in: variants } }],
  };
  if (options.excludeSupportTicketId && Types.ObjectId.isValid(options.excludeSupportTicketId)) {
    supportFilter._id = { $ne: new Types.ObjectId(options.excludeSupportTicketId) };
  }
  const supportTickets = await SupportTicket.find(supportFilter)
    .select("userId meeting.scheduledAt meeting.durationMinutes meeting.adminId")
    .lean();
  for (const ticket of supportTickets as Array<{
    _id: unknown;
    userId?: unknown;
    meeting?: { scheduledAt?: Date; durationMinutes?: number; adminId?: unknown };
  }>) {
    if (!ticket.meeting?.scheduledAt) continue;
    const start = new Date(ticket.meeting.scheduledAt).getTime();
    const end = start +
      (Number(ticket.meeting.durationMinutes) || SUPPORT_MEETING_DURATION_MINUTES) * 60 * 1000;
    const ownerId = ticket.userId ? String(ticket.userId) : "";
    const adminId = ticket.meeting.adminId ? String(ticket.meeting.adminId) : "";
    if (ids.includes(ownerId)) {
      pushUnique(byUser, sources, ownerId, "support", String(ticket._id), start, end);
    }
    if (adminId && ids.includes(adminId)) {
      pushUnique(byUser, sources, adminId, "support", String(ticket._id), start, end);
    }
  }

  const meetingFilter: Record<string, unknown> = {
    status: { $in: ["scheduled", "rescheduled"] },
    scheduledDate: { $ne: null },
    $or: [
      { professionalId: { $in: variants } },
      { "attendees.userId": { $in: ids } },
    ],
  };
  if (options.excludeMeetingId && Types.ObjectId.isValid(options.excludeMeetingId)) {
    meetingFilter._id = { $ne: new Types.ObjectId(options.excludeMeetingId) };
  }
  const meetings = await Meeting.find(meetingFilter)
    .select("professionalId scheduledDate startTime endTime attendees.userId")
    .lean();
  if (meetings.length > 0) {
    const organizerIds = Array.from(
      new Set(
        (meetings as Array<{ professionalId?: unknown }>)
          .map((meeting) => (meeting.professionalId ? String(meeting.professionalId) : ""))
          .filter((id) => Boolean(id) && Types.ObjectId.isValid(id)),
      ),
    );
    const organizers = organizerIds.length > 0
      ? await User.find({ _id: { $in: organizerIds } })
          .select("timeZone businessInfo")
          .lean()
      : [];
    const organizerZones = new Map<string, string>();
    for (const organizer of organizers as Array<{
      _id: unknown;
      timeZone?: string;
      businessInfo?: { timezone?: string };
    }>) {
      organizerZones.set(String(organizer._id), resolveStoredCalendarTimeZone(organizer));
    }
    for (const meeting of meetings as Array<{
      _id: unknown;
      professionalId?: unknown;
      scheduledDate?: Date;
      startTime?: string;
      endTime?: string;
      attendees?: Array<{ userId?: string }>;
    }>) {
      if (!meeting.scheduledDate) continue;
      const organizerId = meeting.professionalId ? String(meeting.professionalId) : "";
      const zone = organizerZones.get(organizerId) || "UTC";
      const interval = meetingIntervalInTimeZone(
        new Date(meeting.scheduledDate),
        meeting.startTime,
        meeting.endTime,
        zone,
      );
      if (!interval) continue;
      if (ids.includes(organizerId)) {
        pushUnique(byUser, sources, organizerId, "meeting", String(meeting._id), interval.start, interval.end);
      }
      for (const attendee of meeting.attendees || []) {
        const attendeeId = attendee.userId ? String(attendee.userId) : "";
        if (attendeeId && ids.includes(attendeeId)) {
          pushUnique(byUser, sources, attendeeId, "meeting", String(meeting._id), interval.start, interval.end);
        }
      }
    }
  }

  const legacyFilter: Record<string, unknown> = {
    userId: { $in: variants },
    status: "scheduled",
    scheduledAt: { $ne: null },
  };
  if (options.excludeMeetingRequestId && Types.ObjectId.isValid(options.excludeMeetingRequestId)) {
    legacyFilter._id = { $ne: new Types.ObjectId(options.excludeMeetingRequestId) };
  }
  const legacy = await MeetingRequest.find(legacyFilter)
    .select("userId scheduledAt durationMinutes")
    .lean();
  for (const request of legacy as Array<{
    _id: unknown;
    userId?: unknown;
    scheduledAt?: Date;
    durationMinutes?: number;
  }>) {
    if (!request.scheduledAt) continue;
    const ownerId = request.userId ? String(request.userId) : "";
    if (!ids.includes(ownerId)) continue;
    const start = new Date(request.scheduledAt).getTime();
    const end = start +
      (Number(request.durationMinutes) || SUPPORT_MEETING_DURATION_MINUTES) * 60 * 1000;
    pushUnique(byUser, sources, ownerId, "meeting_request", String(request._id), start, end);
  }

  return { byUser, sources };
}

export async function findSharedCalendarConflicts(
  userIds: Array<Types.ObjectId | string>,
  startAt: Date,
  endAt: Date,
  options: SharedCalendarBusyOptions = {},
): Promise<SharedCalendarBusySource[]> {
  const { sources } = await loadSharedCalendarBusy(userIds, options);
  const start = startAt.getTime();
  const end = endAt.getTime();
  return sources.filter((source) => intervalOverlaps(start, end, source));
}

export function mergeBusyIntervals(
  ...maps: Array<Map<string, SharedCalendarInterval[]> | undefined>
): Map<string, SharedCalendarInterval[]> {
  const merged = new Map<string, SharedCalendarInterval[]>();
  for (const map of maps) {
    if (!map) continue;
    for (const [userId, intervals] of map) {
      const current = merged.get(userId) || [];
      current.push(...intervals);
      merged.set(userId, current);
    }
  }
  return merged;
}
