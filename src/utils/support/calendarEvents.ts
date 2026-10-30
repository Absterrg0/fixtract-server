import { DateTime } from "luxon";
import MeetingRequest from "../../models/meetingRequest";
import SupportTicket from "../../models/supportTicket";
import {
  SUPPORT_MEETING_DURATION_MINUTES,
  type SupportMeetingStatus,
  type SupportTicketStatus,
} from "../../constants/support";
import { safeSupportMeetingLink } from "./meetingLink";

export interface SupportCalendarEvent {
  source: "support";
  kind: "meeting";
  id: string;
  ticketNumber: string | null;
  subject: string;
  status: SupportMeetingStatus;
  ticketStatus: SupportTicketStatus;
  start: string;
  end: string;
  localStart: string;
  localEnd: string;
  displayTimeZone: string;
  /** The IANA zone stored with the meeting, or null for legacy rows. */
  timeZone: string | null;
  durationMinutes: number;
  meetingLink: string | null;
  linkActive: boolean;
  legacy: boolean;
  /** Admin feeds only: assigned support admin. Never present in owner feeds. */
  admin?: { id: string; name: string | null } | null;
  /** Admin feeds only: requester identity. Never present in owner feeds. */
  user?: { id: string; name: string | null; email: string | null } | null;
}

function iso(value: unknown): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value as string);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function local(value: Date, timeZone: string): string {
  return DateTime.fromJSDate(value, { zone: "utc" }).setZone(timeZone).toISO() || "";
}

function realLink(value: unknown): string | null {
  return safeSupportMeetingLink(value);
}

function person(value: unknown): { id: string; name: string | null; email: string | null } | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as { _id?: unknown; name?: unknown; email?: unknown };
  if (!raw._id) return null;
  return {
    id: String(raw._id),
    name: typeof raw.name === "string" ? raw.name : null,
    email: typeof raw.email === "string" ? raw.email : null,
  };
}

/**
 * Read-only support-meeting events for the existing availability/calendar
 * feeds. Owner feeds never include admin identity; admin feeds include the
 * assigned admin and requester for calendar display, never internal notes.
 */
export async function listSupportCalendarEvents(params: {
  viewer: "professional" | "admin";
  from: Date;
  to: Date;
  timeZone: string;
  userId?: string;
  /** Admin feeds: restrict new support meetings to this assigned admin. */
  adminId?: string;
}): Promise<SupportCalendarEvent[]> {
  // Fail closed: a professional feed without a user id would otherwise drop the
  // owner filter and expose every user's support meetings.
  if (params.viewer === "professional" && !params.userId) {
    throw new Error("userId is required for professional support calendar feeds.");
  }
  const ticketFilter: Record<string, unknown> = {
    kind: "meeting",
    "meeting.scheduledAt": { $gte: params.from, $lte: params.to },
  };
  if (params.userId) ticketFilter.userId = params.userId;
  if (params.adminId) ticketFilter["meeting.adminId"] = params.adminId;

  const ticketQuery = SupportTicket.find(ticketFilter)
    .select("userId ticketNumber subject status meeting")
    .sort({ "meeting.scheduledAt": 1, _id: 1 });
  if (params.viewer === "admin") {
    ticketQuery.populate("userId", "name email role").populate("meeting.adminId", "name");
  }
  const tickets = await ticketQuery.lean();

  const legacyFilter: Record<string, unknown> = {
    scheduledAt: { $gte: params.from, $lte: params.to },
  };
  if (params.userId) legacyFilter.userId = params.userId;
  const legacyQuery = MeetingRequest.find(legacyFilter)
    .select("userId topic status scheduledAt durationMinutes")
    .sort({ scheduledAt: 1, _id: 1 });
  if (params.viewer === "admin") legacyQuery.populate("userId", "name email role");
  const legacy = await legacyQuery.lean();

  const events: SupportCalendarEvent[] = [];

  for (const ticket of tickets as Array<Record<string, any>>) {
    const meeting = ticket.meeting || {};
    const start = meeting.scheduledAt ? new Date(meeting.scheduledAt) : null;
    if (!start || Number.isNaN(start.getTime())) continue;
    const durationMinutes = Number(meeting.durationMinutes) || SUPPORT_MEETING_DURATION_MINUTES;
    const end = new Date(start.getTime() + durationMinutes * 60 * 1000);
    const status = (meeting.status || "pending") as SupportMeetingStatus;
    const admin = params.viewer === "admin" ? person(meeting.adminId) : null;
    const user = params.viewer === "admin" ? person(ticket.userId) : null;
    const link = realLink(meeting.meetingLink);
    events.push({
      source: "support",
      kind: "meeting",
      id: String(ticket._id),
      ticketNumber: ticket.ticketNumber || null,
      subject: String(ticket.subject || ""),
      status,
      ticketStatus: (ticket.status || "open") as SupportTicketStatus,
      start: start.toISOString(),
      end: end.toISOString(),
      localStart: local(start, params.timeZone),
      localEnd: local(end, params.timeZone),
      displayTimeZone: params.timeZone,
      timeZone: meeting.timeZone || null,
      durationMinutes,
      meetingLink: link,
      linkActive: status === "scheduled" && Boolean(link),
      legacy: false,
      ...(params.viewer === "admin" ? { admin, user } : {}),
    });
  }

  for (const request of legacy as Array<Record<string, any>>) {
    const start = request.scheduledAt ? new Date(request.scheduledAt) : null;
    const startIso = iso(request.scheduledAt);
    if (!start || !startIso || Number.isNaN(start.getTime())) continue;
    const durationMinutes = Number(request.durationMinutes) || SUPPORT_MEETING_DURATION_MINUTES;
    const end = new Date(start.getTime() + durationMinutes * 60 * 1000);
    const status = (["pending", "scheduled", "declined", "cancelled", "completed"].includes(request.status)
      ? request.status
      : "pending") as SupportMeetingStatus;
    const user = params.viewer === "admin" ? person(request.userId) : null;
    events.push({
      source: "support",
      kind: "meeting",
      id: String(request._id),
      ticketNumber: null,
      subject: String(request.topic || ""),
      status,
      ticketStatus: status === "cancelled" || status === "declined" ? "closed" : "open",
      start: startIso,
      end: end.toISOString(),
      localStart: local(start, params.timeZone),
      localEnd: local(end, params.timeZone),
      displayTimeZone: params.timeZone,
      timeZone: null,
      durationMinutes,
      meetingLink: null,
      linkActive: false,
      legacy: true,
      ...(params.viewer === "admin" ? { admin: null, user } : {}),
    });
  }

  return events.sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
}
