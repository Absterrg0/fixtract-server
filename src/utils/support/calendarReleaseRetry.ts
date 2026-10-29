import Booking from "../../models/booking";
import { releaseCalendarReservations } from "./calendarReservations";

/**
 * Retries terminal-booking calendar releases that failed earlier.
 *
 * A post-save hook cannot fail the save that already committed, so failures
 * are recorded as `calendarReleasePending`. This sweeper is the explicit retry
 * path: it clears the flag only after the release succeeds, so a persistent
 * failure leaves the booking visible for the next run instead of stranding
 * reservation rows that keep returning SLOT_UNAVAILABLE.
 */
export async function retryPendingBookingCalendarReleases(
  options: { limit?: number } = {},
): Promise<number> {
  const pending = (await Booking.find({
    calendarReleasePending: true,
    status: { $in: ["cancelled", "refunded", "completed"] },
  })
    .select("_id")
    .limit(options.limit ?? 50)
    .lean()) as Array<{ _id: unknown }>;

  let released = 0;
  for (const doc of pending) {
    try {
      await releaseCalendarReservations("booking", doc._id as any);
      await Booking.updateOne(
        { _id: doc._id },
        { $unset: { calendarReleasePending: 1 } },
      );
      released += 1;
    } catch (error) {
      console.error(
        "Booking calendar release retry failed:",
        String(doc._id),
        error instanceof Error ? error.name : typeof error,
      );
    }
  }
  return released;
}
