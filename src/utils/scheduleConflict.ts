import { Types } from "mongoose";
import Booking from "../models/booking";
import { findSharedCalendarConflicts } from "./support/calendarBusy";

export interface TeamConflict {
  bookingId: string;
  bookingNumber?: string;
  teamMemberIds: string[];
  overlapStart: Date;
  overlapEnd: Date;
  otherStart?: Date;
  otherEnd?: Date;
  /** Where the conflict comes from; bookings are the historical default. */
  source?: "booking" | "support" | "meeting" | "meeting_request";
}

const ACTIVE_STATUSES = ["booked", "in_progress", "rescheduling_requested"];

const toIdString = (val: any): string => {
  if (!val) return "";
  if (val instanceof Types.ObjectId) return val.toString();
  if (typeof val === "string") return val;
  if (val._id) return val._id.toString();
  return String(val);
};

export const findTeamConflicts = async (
  excludeBookingId: string,
  teamMemberIds: Types.ObjectId[] | string[],
  proposedStart: Date,
  proposedEnd: Date
): Promise<TeamConflict[]> => {
  if (!Array.isArray(teamMemberIds) || teamMemberIds.length === 0) {
    return [];
  }
  if (!(proposedStart instanceof Date) || !(proposedEnd instanceof Date)) {
    return [];
  }

  const memberIdStrings: string[] = teamMemberIds.map((id) => toIdString(id)).filter(Boolean);
  if (memberIdStrings.length === 0) return [];

  const memberObjectIds = memberIdStrings.map((id) => new Types.ObjectId(id));
  const conflicts = await Booking.find({
    _id: { $ne: new Types.ObjectId(excludeBookingId) },
    status: { $in: ACTIVE_STATUSES },
    scheduledStartDate: { $lt: proposedEnd },
    $and: [
      {
        $or: [
          { assignedTeamMembers: { $in: memberObjectIds } },
          { professional: { $in: memberObjectIds } },
        ],
      },
      {
        $or: [
          { scheduledBufferEndDate: { $gt: proposedStart } },
          { scheduledExecutionEndDate: { $gt: proposedStart } },
        ],
      },
    ],
  })
    .select("bookingNumber assignedTeamMembers professional scheduledStartDate scheduledExecutionEndDate scheduledBufferEndDate")
    .lean();

  const result: TeamConflict[] = conflicts.map((b: any) => {
    const otherStart: Date | undefined = b.scheduledStartDate;
    const otherEnd: Date | undefined = b.scheduledBufferEndDate || b.scheduledExecutionEndDate;
    const overlapStart = otherStart && otherStart > proposedStart ? otherStart : proposedStart;
    const overlapEnd = otherEnd && otherEnd < proposedEnd ? otherEnd : proposedEnd;
    const otherMembers: string[] = (b.assignedTeamMembers || [])
      .map((member: any) => toIdString(member));
    const professionalId = toIdString(b.professional);
    if (professionalId && memberIdStrings.includes(professionalId)) {
      otherMembers.push(professionalId);
    }
    const intersecting = Array.from(new Set<string>(otherMembers))
      .filter((id) => memberIdStrings.includes(id));
    return {
      bookingId: b._id.toString(),
      bookingNumber: b.bookingNumber,
      teamMemberIds: intersecting,
      overlapStart,
      overlapEnd,
      otherStart,
      otherEnd,
      source: "booking" as const,
    };
  });

  // Support meetings, project Meetings and legacy requests are not Booking
  // rows but occupy the same people. Include them without pretending they are
  // bookings, so a reschedule request/accept cannot double-book a support slot.
  const shared = await findSharedCalendarConflicts(memberIdStrings, proposedStart, proposedEnd);
  for (const source of shared) {
    result.push({
      bookingId: source.id,
      teamMemberIds: [source.userId],
      overlapStart: new Date(Math.max(source.start, proposedStart.getTime())),
      overlapEnd: new Date(Math.min(source.end, proposedEnd.getTime())),
      otherStart: new Date(source.start),
      otherEnd: new Date(source.end),
      source: source.source,
    });
  }

  return result;
};
