import { IBooking } from "../models/booking";

/**
 * Releases the schedule slots a booking holds on its assigned team members.
 * Called when a booking is cancelled. Once status flips to 'cancelled', the
 * conflict-detection query (`scheduleConflict.findTeamConflicts`) already
 * filters to active statuses, so clearing the array here is belt-and-suspenders
 * plus an audit trail.
 */
export const releaseScheduleSlots = (booking: IBooking, releasedBy?: any) => {
  const hadTeamMembers = Array.isArray(booking.assignedTeamMembers) && booking.assignedTeamMembers.length > 0;
  if (hadTeamMembers) {
    booking.assignedTeamMembers = [];
  }

  booking.statusHistory = booking.statusHistory || [];
  booking.statusHistory.push({
    status: booking.status,
    timestamp: new Date(),
    updatedBy: releasedBy,
    note: hadTeamMembers
      ? "Schedule slots released on cancellation (assignedTeamMembers cleared)"
      : "Schedule slots released on cancellation",
  } as any);
};
