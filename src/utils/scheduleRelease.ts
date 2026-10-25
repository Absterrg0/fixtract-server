import { IBooking } from "../models/booking";

/**
 * Clears the schedule slots a booking holds on its assigned team members when
 * it is cancelled. The caller releases the shared CalendarReservation keys
 * after the cancellation save succeeds, so a failed write never leaves an
 * active booking without its calendar lock.
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
