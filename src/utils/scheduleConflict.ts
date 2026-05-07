import { Types } from "mongoose";
import Booking from "../models/booking";

export interface TeamConflict {
  bookingId: string;
  bookingNumber?: string;
  teamMemberIds: string[];
  overlapStart: Date;
  overlapEnd: Date;
  otherStart?: Date;
  otherEnd?: Date;
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

  const memberIdStrings = teamMemberIds.map(toIdString).filter(Boolean);
  if (memberIdStrings.length === 0) return [];

  const conflicts = await Booking.find({
    _id: { $ne: new Types.ObjectId(excludeBookingId) },
    status: { $in: ACTIVE_STATUSES },
    assignedTeamMembers: { $in: memberIdStrings.map((id) => new Types.ObjectId(id)) },
    scheduledStartDate: { $lt: proposedEnd },
    $or: [
      { scheduledBufferEndDate: { $gt: proposedStart } },
      { scheduledExecutionEndDate: { $gt: proposedStart } },
    ],
  })
    .select("bookingNumber assignedTeamMembers scheduledStartDate scheduledExecutionEndDate scheduledBufferEndDate")
    .lean();

  return conflicts.map((b: any) => {
    const otherStart: Date | undefined = b.scheduledStartDate;
    const otherEnd: Date | undefined = b.scheduledBufferEndDate || b.scheduledExecutionEndDate;
    const overlapStart = otherStart && otherStart > proposedStart ? otherStart : proposedStart;
    const overlapEnd = otherEnd && otherEnd < proposedEnd ? otherEnd : proposedEnd;
    const otherMembers = (b.assignedTeamMembers || []).map(toIdString);
    const intersecting = otherMembers.filter((id: string) => memberIdStrings.includes(id));
    return {
      bookingId: b._id.toString(),
      bookingNumber: b.bookingNumber,
      teamMemberIds: intersecting,
      overlapStart,
      overlapEnd,
      otherStart,
      otherEnd,
    };
  });
};
