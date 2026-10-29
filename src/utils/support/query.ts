import { Types } from "mongoose";
import {
  SUPPORT_DISPLAY_STATUSES,
  SUPPORT_KINDS,
  SUPPORT_MEETING_STATUSES,
  SUPPORT_TICKET_STATUSES,
  isSupportKind,
  isSupportMeetingStatus,
  isSupportTicketStatus,
  isSupportUserType,
  normalizeSupportReason,
} from "../../constants/support";
import User from "../../models/user";
import { UserFacingError } from "../appErrors";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MAX_PAGE = 200;
const MAX_MATCHED_USERS = 2000;
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function escapeSupportRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function firstString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}

function positiveInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.trunc(parsed);
}

export interface ParsedSupportListQuery {
  page: number;
  limit: number;
  skip: number;
  q?: string;
  kind?: "ticket" | "meeting";
  status?: string;
  userType?: "customer" | "professional";
  reason?: string;
  bookingMode?: "with" | "without";
  bookingRef?: string;
  meetingMode?: "with" | "without";
  meetingFrom?: Date;
  meetingTo?: Date;
}

function parseDateFilter(value: string | undefined, field: string, endOfDay: boolean): Date | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const candidate = DATE_ONLY_RE.test(trimmed)
    ? new Date(`${trimmed}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`)
    : new Date(trimmed);
  if (Number.isNaN(candidate.getTime())) {
    throw new UserFacingError(400, `Invalid ${field} date.`, "VALIDATION", field);
  }
  return candidate;
}

export function parseSupportListQuery(query: Record<string, unknown>): ParsedSupportListQuery {
  const page = Math.max(1, positiveInt(query.page, 1));
  if (page > MAX_PAGE) {
    throw new UserFacingError(
      400,
      `Page must be between 1 and ${MAX_PAGE}. Narrow the filters instead of paging further.`,
      "VALIDATION",
      "page",
    );
  }
  const limit = Math.min(MAX_LIMIT, positiveInt(query.limit, DEFAULT_LIMIT));

  const rawKind = firstString(query.kind) ?? firstString(query.type);
  let kind: "ticket" | "meeting" | undefined;
  if (rawKind !== undefined && rawKind !== "") {
    if (!isSupportKind(rawKind)) {
      throw new UserFacingError(400, "Invalid support type filter.", "VALIDATION", "kind");
    }
    kind = rawKind;
  }

  const rawStatus = firstString(query.status);
  let status: string | undefined;
  if (rawStatus !== undefined && rawStatus !== "") {
    if (!(SUPPORT_DISPLAY_STATUSES as readonly string[]).includes(rawStatus)) {
      throw new UserFacingError(400, "Invalid support status filter.", "VALIDATION", "status");
    }
    status = rawStatus;
  }

  const rawUserType = firstString(query.userType) ?? firstString(query.requesterRole);
  let userType: "customer" | "professional" | undefined;
  if (rawUserType !== undefined && rawUserType !== "") {
    if (!isSupportUserType(rawUserType)) {
      throw new UserFacingError(400, "Invalid requester role filter.", "VALIDATION", "userType");
    }
    userType = rawUserType;
  }

  const rawReason = firstString(query.reason);
  let reason: string | undefined;
  if (rawReason !== undefined && rawReason !== "") {
    reason = normalizeSupportReason(rawReason);
    if (!reason) {
      throw new UserFacingError(400, "Invalid support reason filter.", "VALIDATION", "reason");
    }
  }

  const rawBooking = firstString(query.booking);
  let bookingMode: "with" | "without" | undefined;
  let bookingRef: string | undefined;
  if (rawBooking !== undefined && rawBooking !== "") {
    const bookingValue = rawBooking.trim();
    if (bookingValue === "with" || bookingValue === "without") bookingMode = bookingValue;
    else if (bookingValue.length <= 100) bookingRef = bookingValue;
    else throw new UserFacingError(400, "Invalid booking filter.", "VALIDATION", "booking");
  }

  const rawMeeting = firstString(query.meeting);
  let meetingMode: "with" | "without" | undefined;
  if (rawMeeting !== undefined && rawMeeting !== "") {
    const meetingValue = rawMeeting.trim();
    if (meetingValue !== "with" && meetingValue !== "without") {
      throw new UserFacingError(400, "Invalid meeting filter.", "VALIDATION", "meeting");
    }
    meetingMode = meetingValue;
  }

  const rawQ = firstString(query.q);
  const q = rawQ?.trim();
  if (q && q.length > 100) {
    throw new UserFacingError(400, "Search text must be 100 characters or fewer.", "VALIDATION", "q");
  }

  const meetingFrom = parseDateFilter(firstString(query.meetingFrom), "meetingFrom", false);
  const meetingTo = parseDateFilter(firstString(query.meetingTo), "meetingTo", true);
  if (meetingFrom && meetingTo && meetingTo < meetingFrom) {
    throw new UserFacingError(400, "meetingTo must be after meetingFrom.", "VALIDATION", "meetingTo");
  }

  return {
    page,
    limit,
    skip: (page - 1) * limit,
    ...(q ? { q } : {}),
    ...(kind ? { kind } : {}),
    ...(status ? { status } : {}),
    ...(userType ? { userType } : {}),
    ...(reason ? { reason } : {}),
    ...(bookingMode ? { bookingMode } : {}),
    ...(bookingRef ? { bookingRef } : {}),
    ...(meetingMode ? { meetingMode } : {}),
    ...(meetingFrom ? { meetingFrom } : {}),
    ...(meetingTo ? { meetingTo } : {}),
  };
}

export async function findSupportMatchingUserIds(q: string | undefined): Promise<Types.ObjectId[]> {
  if (!q) return [];
  const regex = new RegExp(escapeSupportRegex(q), "i");
  const users = await User.find({
    $or: [
      { name: regex },
      { email: regex },
      { phone: regex },
      { username: regex },
    ],
  })
    .select("_id")
    .limit(MAX_MATCHED_USERS + 1)
    .lean();
  if (users.length > MAX_MATCHED_USERS) {
    throw new UserFacingError(
      400,
      "That search matches too many accounts. Add more characters to the search.",
      "VALIDATION",
      "q",
    );
  }
  return users.map((user) => user._id);
}

function combine(conditions: Record<string, unknown>[]): Record<string, unknown> {
  if (conditions.length === 0) return {};
  if (conditions.length === 1) return conditions[0];
  return { $and: conditions };
}

export function buildSupportTicketFilter(
  parsed: ParsedSupportListQuery,
  matchedUserIds: Types.ObjectId[] = [],
): Record<string, unknown> {
  const conditions: Record<string, unknown>[] = [];
  if (parsed.kind) {
    // Historical support tickets predate `kind`; they are tickets, not meetings.
    conditions.push(
      parsed.kind === "ticket" ? { kind: { $ne: "meeting" } } : { kind: "meeting" },
    );
  }
  if (parsed.status) {
    if (isSupportTicketStatus(parsed.status)) {
      // Ticket statuses are display statuses only for kind=ticket. A scheduled
      // meeting has ticketStatus=open internally, but its display status is
      // "scheduled" and must not appear under an "open" filter.
      conditions.push({ kind: { $ne: "meeting" }, status: parsed.status });
    } else if (isSupportMeetingStatus(parsed.status)) {
      conditions.push({ kind: "meeting", "meeting.status": parsed.status });
    }
  }
  if (parsed.userType) {
    // Historical tickets predate userType and were professional-only.
    conditions.push(
      parsed.userType === "professional"
        ? { $or: [{ userType: "professional" }, { userType: { $exists: false } }, { userType: null }] }
        : { userType: "customer" },
    );
  }
  if (parsed.reason) conditions.push({ reason: parsed.reason });
  if (parsed.bookingMode === "with") conditions.push({ "booking.bookingId": { $exists: true } });
  if (parsed.bookingMode === "without") {
    conditions.push({ $or: [{ booking: { $exists: false } }, { booking: null }] });
  }
  if (parsed.bookingRef) {
    const bookingConditions: Record<string, unknown>[] = [{ "booking.bookingNumber": parsed.bookingRef }];
    if (Types.ObjectId.isValid(parsed.bookingRef)) {
      bookingConditions.push({ "booking.bookingId": new Types.ObjectId(parsed.bookingRef) });
    }
    conditions.push({ $or: bookingConditions });
  }
  if (parsed.meetingMode === "with") {
    conditions.push({ kind: "meeting", "meeting.scheduledAt": { $exists: true, $ne: null } });
  }
  if (parsed.meetingMode === "without") {
    conditions.push({
      $or: [
        { kind: { $ne: "meeting" } },
        { "meeting.scheduledAt": { $exists: false } },
        { "meeting.scheduledAt": null },
      ],
    });
  }
  if (parsed.meetingFrom || parsed.meetingTo) {
    conditions.push({
      "meeting.scheduledAt": {
        ...(parsed.meetingFrom ? { $gte: parsed.meetingFrom } : {}),
        ...(parsed.meetingTo ? { $lte: parsed.meetingTo } : {}),
      },
    });
  }
  if (parsed.q) {
    const regex = new RegExp(escapeSupportRegex(parsed.q), "i");
    conditions.push({
      $or: [
        ...(matchedUserIds.length > 0 ? [{ userId: { $in: matchedUserIds } }] : []),
        { ticketNumber: regex },
        { subject: regex },
      ],
    });
  }
  return combine(conditions);
}

/** Returns null when the legacy collection can never satisfy the filter. */
export function buildLegacyMeetingRequestFilter(
  parsed: ParsedSupportListQuery,
  matchedUserIds: Types.ObjectId[] = [],
): Record<string, unknown> | null {
  if (parsed.kind === "ticket") return null;
  if (parsed.status && !isSupportMeetingStatus(parsed.status)) return null;
  if (parsed.userType === "customer") return null;
  // Legacy rows have no reason/booking snapshot. `booking=without` is
  // inherently true for them and must stay visible; only `booking=with` and a
  // specific booking reference can never match.
  if (parsed.reason || parsed.bookingRef) return null;
  if (parsed.bookingMode === "with") return null;

  const conditions: Record<string, unknown>[] = [];
  if (parsed.status) conditions.push({ status: parsed.status });
  if (parsed.meetingMode === "with") conditions.push({ scheduledAt: { $ne: null } });
  if (parsed.meetingMode === "without") {
    conditions.push({ $or: [{ scheduledAt: { $exists: false } }, { scheduledAt: null }] });
  }
  if (parsed.meetingFrom || parsed.meetingTo) {
    conditions.push({
      scheduledAt: {
        ...(parsed.meetingFrom ? { $gte: parsed.meetingFrom } : {}),
        ...(parsed.meetingTo ? { $lte: parsed.meetingTo } : {}),
      },
    });
  }
  if (parsed.q) {
    const regex = new RegExp(escapeSupportRegex(parsed.q), "i");
    conditions.push({
      $or: [
        ...(matchedUserIds.length > 0 ? [{ userId: { $in: matchedUserIds } }] : []),
        { topic: regex },
      ],
    });
  }
  return combine(conditions);
}

/** Stable merged order for new support rows + legacy MeetingRequest rows. */
export function mergeSupportItemsPage<T extends Record<string, any>>(
  tickets: T[],
  legacy: T[],
  skip: number,
  limit: number,
): T[] {
  return [...tickets, ...legacy]
    .sort((a, b) => {
      const byDate = String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
      if (byDate !== 0) return byDate;
      return String(b._id || "").localeCompare(String(a._id || ""));
    })
    .slice(skip, skip + limit);
}

export function paginationMeta(page: number, limit: number, total: number) {
  return {
    page,
    limit,
    total,
    totalPages: total === 0 ? 0 : Math.ceil(total / limit),
  };
}

export const SUPPORT_LIST_DEFAULT_LIMIT = DEFAULT_LIMIT;
export const SUPPORT_LIST_MAX_LIMIT = MAX_LIMIT;
export const SUPPORT_LIST_MAX_PAGE = MAX_PAGE;
export const SUPPORT_SEARCH_MAX_USER_MATCHES = MAX_MATCHED_USERS;
export const SUPPORT_TICKET_STATUS_VALUES = SUPPORT_TICKET_STATUSES;
export const SUPPORT_MEETING_STATUS_VALUES = SUPPORT_MEETING_STATUSES;
export const SUPPORT_KIND_VALUES = SUPPORT_KINDS;
