import { DateTime } from "luxon";
import { Types } from "mongoose";
import Meeting from "../../models/meeting";
import MeetingRequest from "../../models/meetingRequest";
import SupportTicket from "../../models/supportTicket";
import User, { type IUser } from "../../models/user";
import { UserFacingError } from "../appErrors";
import { hasAccessLevel } from "../adminRbac/rolePermissions";
import { getEffectiveAccessForUser } from "../adminRbac/roleAccess";
import { isAdminAvailableForMeeting } from "../../handlers/User/adminAvailability";
import { SUPPORT_MEETING_DURATION_MINUTES } from "../../constants/support";

export interface BusyInterval {
  start: number;
  end: number;
}

export interface SupportAdminLike extends Pick<
  IUser,
  "availability" | "blockedDates" | "blockedRanges" | "timeZone" | "adminAvailabilityConfigured"
> {
  _id: Types.ObjectId | string;
  name?: string;
  email?: string;
}

export interface SupportSlot {
  start: string;
  end: string;
  localStart: string;
  localEnd: string;
  adminIds: string[];
}

export interface SupportSlotResult {
  timeZone: string;
  durationMinutes: number;
  slots: SupportSlot[];
}

const GRID_MINUTES = 15;
const MAX_RANGE_DAYS = 31;

export function isValidIanaTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

/**
 * The source timezone for a professional's local calendar rows. Legacy
 * `Meeting.scheduledDate + startTime/endTime` has no timezone of its own, so
 * the professional's stored profile zone is the only correct interpretation.
 */
export function resolveStoredCalendarTimeZone(
  user: { timeZone?: string | null; businessInfo?: { timezone?: string | null } | null } | null | undefined,
): string {
  for (const candidate of [user?.businessInfo?.timezone, user?.timeZone]) {
    if (isValidIanaTimeZone(candidate)) return candidate;
  }
  return "UTC";
}


export function resolveSupportTimeZone(
  user: Pick<IUser, "businessInfo" | "timeZone">,
  requested?: unknown,
): string {
  if (requested !== undefined && requested !== null && String(requested).trim() !== "") {
    if (!isValidIanaTimeZone(requested)) {
      throw new UserFacingError(400, "A valid IANA time zone is required.", "VALIDATION", "timeZone");
    }
    return String(requested).trim();
  }
  const fallback = user.businessInfo?.timezone || user.timeZone;
  if (isValidIanaTimeZone(fallback)) return fallback;
  return "UTC";
}

export function intervalsOverlap(a: BusyInterval, b: BusyInterval): boolean {
  return a.start < b.end && a.end > b.start;
}

export function overlapsAny(start: number, end: number, intervals: BusyInterval[] | undefined): boolean {
  if (!intervals?.length) return false;
  return intervals.some((interval) => start < interval.end && end > interval.start);
}

export function toBusyInterval(start: Date, durationMinutes: number): BusyInterval {
  const startMs = start.getTime();
  return { start: startMs, end: startMs + durationMinutes * 60 * 1000 };
}

/** Only active admins with an explicitly configured schedule and support-write access. */
export function isEligibleSupportAdmin(
  admin: Pick<IUser, "adminRole" | "adminPermissionLevels" | "adminAvailabilityConfigured" | "accountStatus" | "deletedAt">,
  effectiveLevels: Record<string, string> | undefined,
): boolean {
  if (admin.deletedAt) return false;
  if (["suspended", "rejected"].includes(admin.accountStatus || "")) return false;
  if (admin.adminAvailabilityConfigured !== true) return false;
  return hasAccessLevel(effectiveLevels as never, "support", "write");
}

export async function listEligibleSupportAdmins(): Promise<SupportAdminLike[]> {
  const admins = await User.find({
    role: "admin",
    deletedAt: null,
    accountStatus: { $nin: ["suspended", "rejected"] },
    adminAvailabilityConfigured: true,
  })
    .select(
      "name email timeZone adminAvailabilityConfigured availability blockedDates blockedRanges adminRole adminPermissionLevels accountStatus deletedAt",
    )
    .lean();

  const eligible: SupportAdminLike[] = [];
  for (const admin of admins) {
    const levels = await getEffectiveAccessForUser(admin as unknown as IUser);
    if (isEligibleSupportAdmin(admin as unknown as IUser, levels)) {
      eligible.push(admin as unknown as SupportAdminLike);
    }
  }
  return eligible;
}

/**
 * Scheduled legacy and new support meetings that occupy an admin calendar.
 * Legacy MeetingRequest rows were not assigned to an admin, but the old flow
 * blocked them for every admin, so they remain busy for all eligible admins.
 */
export async function buildAdminBusyIntervals(
  adminIds: Array<Types.ObjectId | string>,
  excludeMeetingTicketId?: string,
): Promise<Map<string, BusyInterval[]>> {
  const map = new Map<string, BusyInterval[]>();
  const add = (adminId: string, interval: BusyInterval) => {
    const current = map.get(adminId) || [];
    current.push(interval);
    map.set(adminId, current);
  };

  if (adminIds.length > 0) {
    const supportFilter: Record<string, unknown> = {
      kind: "meeting",
      "meeting.status": { $in: ["pending", "scheduled"] },
      "meeting.adminId": { $in: adminIds },
    };
    if (excludeMeetingTicketId && Types.ObjectId.isValid(excludeMeetingTicketId)) {
      supportFilter._id = { $ne: new Types.ObjectId(excludeMeetingTicketId) };
    }
    const tickets = await SupportTicket.find(supportFilter)
      .select("meeting.adminId meeting.scheduledAt meeting.durationMinutes")
      .lean();
    for (const ticket of tickets as Array<{ meeting?: { adminId?: unknown; scheduledAt?: Date; durationMinutes?: number } }>) {
      const adminId = ticket.meeting?.adminId ? String(ticket.meeting.adminId) : "";
      if (!adminId || !ticket.meeting?.scheduledAt) continue;
      add(adminId, toBusyInterval(new Date(ticket.meeting.scheduledAt), ticket.meeting.durationMinutes || 30));
    }
  }

  const legacyFilter: Record<string, unknown> = {
    status: "scheduled",
    scheduledAt: { $ne: null },
  };
  if (excludeMeetingTicketId && Types.ObjectId.isValid(excludeMeetingTicketId)) {
    legacyFilter._id = { $ne: excludeMeetingTicketId };
  }
  const legacy = await MeetingRequest.find(legacyFilter)
    .select("scheduledAt durationMinutes")
    .lean();
  for (const request of legacy as Array<{ scheduledAt?: Date; durationMinutes?: number }>) {
    if (!request.scheduledAt) continue;
    const interval = toBusyInterval(new Date(request.scheduledAt), request.durationMinutes || 30);
    for (const adminId of adminIds) add(String(adminId), interval);
  }

  return map;
}

export function meetingIntervalInTimeZone(
  scheduledDate: Date,
  startTime: string | undefined,
  endTime: string | undefined,
  timeZone: string,
): BusyInterval | null {
  if (!startTime || !endTime) return null;
  const datePart = DateTime.fromJSDate(scheduledDate, { zone: "utc" }).toISODate();
  if (!datePart) return null;
  const start = DateTime.fromISO(`${datePart}T${startTime}`, { zone: timeZone });
  let end = DateTime.fromISO(`${datePart}T${endTime}`, { zone: timeZone });
  if (!start.isValid || !end.isValid) return null;
  if (end <= start) end = end.plus({ days: 1 });
  return { start: start.toUTC().toMillis(), end: end.toUTC().toMillis() };
}

/** Bookings (including buffers), project meetings, support reservations and legacy requests. */
export async function buildProfessionalBusyIntervals(
  professionalId: Types.ObjectId | string,
  timeZone: string,
  excludeMeetingTicketId?: string,
  excludeMeetingId?: string,
  /**
   * Source zone for local Meeting.startTime/endTime rows. Callers that know the
   * professional must pass their stored profile zone; `timeZone` is only the
   * display/request zone. Defaults to `timeZone` for backwards compatibility.
   */
  calendarTimeZone?: string,
  excludeMeetingRequestId?: string,
): Promise<BusyInterval[]> {
  const busy: BusyInterval[] = [];
  const add = (interval: BusyInterval | null) => {
    if (interval) busy.push(interval);
  };

  // Loaded lazily: the booking model pulls in the Stripe client at import time,
  // and pure slot generation must stay importable in unit tests without keys.
  const { buildBookingBlockedRanges } = await import("../bookingBlocks");
  const bookingRanges = await buildBookingBlockedRanges(professionalId);
  for (const range of bookingRanges) {
    const start = new Date(range.startDate).getTime();
    const end = new Date(range.endDate).getTime();
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) add({ start, end });
  }

  const supportFilter: Record<string, unknown> = {
    userId: professionalId,
    kind: "meeting",
    "meeting.status": { $in: ["pending", "scheduled"] },
  };
  if (excludeMeetingTicketId && Types.ObjectId.isValid(excludeMeetingTicketId)) {
    supportFilter._id = { $ne: new Types.ObjectId(excludeMeetingTicketId) };
  }
  const supportMeetings = await SupportTicket.find(supportFilter)
    .select("meeting.scheduledAt meeting.durationMinutes")
    .lean();
  for (const meeting of supportMeetings as Array<{ meeting?: { scheduledAt?: Date; durationMinutes?: number } }>) {
    if (!meeting.meeting?.scheduledAt) continue;
    add(toBusyInterval(new Date(meeting.meeting.scheduledAt), meeting.meeting.durationMinutes || 30));
  }

  // Meeting.professionalId is stored as ObjectId on current docs and as a
  // string on legacy docs, so match both representations.
  const professionalIds: Array<Types.ObjectId | string> = [professionalId];
  if (Types.ObjectId.isValid(String(professionalId))) {
    professionalIds.push(new Types.ObjectId(String(professionalId)));
  }
  const meetings = await Meeting.find({
    professionalId: { $in: professionalIds },
    status: { $in: ["scheduled", "rescheduled"] },
    scheduledDate: { $ne: null },
    ...(excludeMeetingId && Types.ObjectId.isValid(excludeMeetingId)
      ? { _id: { $ne: excludeMeetingId } }
      : {}),
  })
    .select("scheduledDate startTime endTime")
    .lean();
  for (const meeting of meetings as Array<{
    scheduledDate?: Date;
    startTime?: string;
    endTime?: string;
  }>) {
    if (!meeting.scheduledDate) continue;
    add(
      meetingIntervalInTimeZone(
        new Date(meeting.scheduledDate),
        meeting.startTime,
        meeting.endTime,
        calendarTimeZone || timeZone,
      ),
    );
  }

  const legacyFilter: Record<string, unknown> = {
    userId: professionalId,
    status: "scheduled",
    scheduledAt: { $ne: null },
  };
  if (excludeMeetingTicketId && Types.ObjectId.isValid(excludeMeetingTicketId)) {
    legacyFilter._id = { $ne: excludeMeetingTicketId };
  }
  if (excludeMeetingRequestId && Types.ObjectId.isValid(excludeMeetingRequestId)) {
    legacyFilter._id = { $ne: excludeMeetingRequestId };
  }
  const legacy = await MeetingRequest.find(legacyFilter)
    .select("scheduledAt durationMinutes")
    .lean();
  for (const request of legacy as Array<{ scheduledAt?: Date; durationMinutes?: number }>) {
    if (!request.scheduledAt) continue;
    add(toBusyInterval(new Date(request.scheduledAt), request.durationMinutes || 30));
  }

  return busy;
}

function hasHalfHourStart(start: Date, timeZone: string): boolean {
  const local = DateTime.fromJSDate(start, { zone: "utc" }).setZone(timeZone);
  return local.isValid && (local.minute === 0 || local.minute === 30);
}

function roundUpToGrid(ms: number): number {
  const grid = GRID_MINUTES * 60 * 1000;
  return Math.ceil(ms / grid) * grid;
}

export interface GenerateSupportSlotsInput {
  admins: SupportAdminLike[];
  adminBusy?: Map<string, BusyInterval[]>;
  professionalBusy?: BusyInterval[];
  from: Date;
  to: Date;
  timeZone: string;
  durationMinutes?: number;
  now?: Date;
}

/** Pure slot union: one free eligible admin is enough; the professional must always be free. */
export function generateSupportSlots(input: GenerateSupportSlotsInput): SupportSlot[] {
  const durationMinutes = input.durationMinutes || SUPPORT_MEETING_DURATION_MINUTES;
  const durationMs = durationMinutes * 60 * 1000;
  const now = (input.now || new Date()).getTime();
  const fromMs = Math.max(input.from.getTime(), now);
  const toMs = input.to.getTime();
  if (!(toMs > fromMs) || input.admins.length === 0) return [];

  const slots = new Map<string, SupportSlot>();
  for (
    let cursor = roundUpToGrid(fromMs);
    cursor + durationMs <= toMs;
    cursor += GRID_MINUTES * 60 * 1000
  ) {
    if (cursor < now) continue;
    if (overlapsAny(cursor, cursor + durationMs, input.professionalBusy)) continue;

    const freeAdminIds: string[] = [];
    for (const admin of input.admins) {
      const adminId = String(admin._id);
      const start = new Date(cursor);
      if (!hasHalfHourStart(start, admin.timeZone || "UTC")) continue;
      if (!isAdminAvailableForMeeting(admin, start, durationMinutes)) continue;
      if (overlapsAny(cursor, cursor + durationMs, input.adminBusy?.get(adminId))) continue;
      freeAdminIds.push(adminId);
    }
    if (freeAdminIds.length === 0) continue;
    freeAdminIds.sort();

    const start = new Date(cursor);
    const end = new Date(cursor + durationMs);
    const localStart = DateTime.fromJSDate(start, { zone: "utc" }).setZone(input.timeZone);
    const localEnd = DateTime.fromJSDate(end, { zone: "utc" }).setZone(input.timeZone);
    if (!localStart.isValid || !localEnd.isValid) continue;
    slots.set(start.toISOString(), {
      start: start.toISOString(),
      end: end.toISOString(),
      localStart: localStart.toISO() || "",
      localEnd: localEnd.toISO() || "",
      adminIds: freeAdminIds,
    });
  }

  return Array.from(slots.values()).sort((a, b) => a.start.localeCompare(b.start));
}

export interface ParsedSupportRange {
  from: Date;
  to: Date;
  timeZone: string;
}

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const EXPLICIT_ZONE_RE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

function parseRangePart(raw: unknown, timeZone: string, edge: "start" | "end"): DateTime | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const value = raw.trim();
  let parsed: DateTime;
  if (DATE_ONLY_RE.test(value)) {
    const date = DateTime.fromISO(value, { zone: timeZone });
    if (!date.isValid) return null;
    parsed = edge === "start" ? date.startOf("day") : date.plus({ days: 1 }).startOf("day");
  } else if (EXPLICIT_ZONE_RE.test(value)) {
    parsed = DateTime.fromISO(value, { setZone: true });
  } else {
    parsed = DateTime.fromISO(value, { zone: timeZone });
  }
  return parsed.isValid ? parsed : null;
}

export function parseSupportAvailabilityRange(
  fromRaw: unknown,
  toRaw: unknown,
  timeZone: string,
  now: Date = new Date(),
): ParsedSupportRange {
  if (!isValidIanaTimeZone(timeZone)) {
    throw new UserFacingError(400, "A valid IANA time zone is required.", "VALIDATION", "timeZone");
  }
  const nowLocal = DateTime.fromJSDate(now, { zone: "utc" }).setZone(timeZone);
  const defaultFrom = nowLocal.startOf("day");
  const defaultTo = defaultFrom.plus({ days: 7 });

  const from = fromRaw === undefined || fromRaw === null || fromRaw === ""
    ? defaultFrom
    : parseRangePart(fromRaw, timeZone, "start");
  const to = toRaw === undefined || toRaw === null || toRaw === ""
    ? defaultTo
    : parseRangePart(toRaw, timeZone, "end");

  if (!from || !to) {
    throw new UserFacingError(
      400,
      "A valid from/to date range is required.",
      "VALIDATION",
      "from",
    );
  }
  if (to.toMillis() <= from.toMillis()) {
    throw new UserFacingError(400, "The end of the range must be after its start.", "VALIDATION", "to");
  }
  // Compare calendar days in the requested zone, not elapsed UTC. A 31-day
  // local window is 31d +/- 1h across DST and must remain valid.
  const localDaySpan = to
    .setZone(timeZone)
    .startOf("day")
    .diff(from.setZone(timeZone).startOf("day"), "days").days;
  if (localDaySpan > MAX_RANGE_DAYS) {
    throw new UserFacingError(400, "The date range can cover at most 31 days.", "VALIDATION", "to");
  }
  return { from: from.toUTC().toJSDate(), to: to.toUTC().toJSDate(), timeZone };
}

export interface AvailabilityForProfessionalInput {
  professional: Pick<IUser, "_id" | "businessInfo" | "timeZone">;
  timeZone: string;
  from: Date;
  to: Date;
  excludeItemId?: string;
  now?: Date;
}

export async function getSupportAvailabilityForProfessional(
  input: AvailabilityForProfessionalInput,
): Promise<SupportSlotResult & { admins: SupportAdminLike[] }> {
  const admins = await listEligibleSupportAdmins();
  const adminIds = admins.map((admin) => admin._id);
  const calendarTimeZone = resolveStoredCalendarTimeZone(input.professional);
  const [adminBusy, professionalBusy] = await Promise.all([
    buildAdminBusyIntervals(adminIds, input.excludeItemId),
    buildProfessionalBusyIntervals(
      input.professional._id,
      input.timeZone,
      input.excludeItemId,
      undefined,
      calendarTimeZone,
    ),
  ]);
  return {
    timeZone: input.timeZone,
    durationMinutes: SUPPORT_MEETING_DURATION_MINUTES,
    slots: generateSupportSlots({
      admins,
      adminBusy,
      professionalBusy,
      from: input.from,
      to: input.to,
      timeZone: input.timeZone,
      now: input.now,
    }),
    admins,
  };
}

export interface AdminAvailabilityInput {
  from: Date;
  to: Date;
  timeZone: string;
  excludeItemId?: string;
  /** Optional professional whose calendar must also be free (admin planning/reschedule). */
  professional?: {
    _id: Types.ObjectId | string;
    businessInfo?: { timezone?: string };
    timeZone?: string;
  } | null;
  now?: Date;
}

/**
 * Combined admin calendar. When a meeting/professional context is supplied the
 * slots are free for both that professional and at least one eligible admin;
 * otherwise the legacy admin-only behaviour is kept.
 */
export async function getSupportAvailabilityForAdmin(
  input: AdminAvailabilityInput,
): Promise<SupportSlotResult & { admins: SupportAdminLike[] }> {
  const admins = await listEligibleSupportAdmins();
  const adminBusy = await buildAdminBusyIntervals(
    admins.map((admin) => admin._id),
    input.excludeItemId,
  );
  const professionalBusy = input.professional
    ? await buildProfessionalBusyIntervals(
        input.professional._id,
        input.timeZone,
        input.excludeItemId,
        undefined,
        resolveStoredCalendarTimeZone(input.professional),
      )
    : undefined;
  return {
    timeZone: input.timeZone,
    durationMinutes: SUPPORT_MEETING_DURATION_MINUTES,
    slots: generateSupportSlots({
      admins,
      adminBusy,
      professionalBusy,
      from: input.from,
      to: input.to,
      timeZone: input.timeZone,
      now: input.now,
    }),
    admins,
  };
}

export async function listProfessionalBookedIntervals(
  professionalId: Types.ObjectId | string,
  timeZone: string,
): Promise<BusyInterval[]> {
  return buildProfessionalBusyIntervals(professionalId, timeZone);
}

/** Defensive lookup used by booking/meeting creation to ensure a slot is still real. */
export async function professionalHasBusyConflict(
  professionalId: Types.ObjectId | string,
  timeZone: string,
  start: Date,
  durationMinutes = SUPPORT_MEETING_DURATION_MINUTES,
  excludeMeetingId?: string,
  options: { calendarTimeZone?: string; excludeMeetingRequestId?: string } = {},
): Promise<boolean> {
  const busy = await buildProfessionalBusyIntervals(
    professionalId,
    timeZone,
    undefined,
    excludeMeetingId,
    options.calendarTimeZone || timeZone,
    options.excludeMeetingRequestId,
  );
  return overlapsAny(start.getTime(), start.getTime() + durationMinutes * 60 * 1000, busy);
}

export const SUPPORT_SLOT_GRID_MINUTES = GRID_MINUTES;
export const SUPPORT_MAX_AVAILABILITY_DAYS = MAX_RANGE_DAYS;
