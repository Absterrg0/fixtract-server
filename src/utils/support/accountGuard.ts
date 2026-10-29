import { Types } from "mongoose";
import AccountDataGuard, {
  type AccountDataGuardState,
} from "../../models/accountDataGuard";
import SupportTicket from "../../models/supportTicket";
import SupportTicketInternalNote from "../../models/supportTicketInternalNote";
import SupportMeetingNotification from "../../models/supportMeetingNotification";
import User from "../../models/user";
import { UserFacingError } from "../appErrors";
import { releaseCalendarReservations } from "./calendarReservations";

export async function beginAccountDataRemoval(
  userId: Types.ObjectId | string,
  state: Extract<AccountDataGuardState, "deleting" | "anonymizing">,
): Promise<void> {
  const id = new Types.ObjectId(String(userId));
  await AccountDataGuard.updateOne(
    { _id: id },
    {
      $setOnInsert: { startedAt: new Date() },
      $set: { state },
    },
    { upsert: true },
  );
}

export async function completeAccountDataRemoval(
  userId: Types.ObjectId | string,
  state: Extract<AccountDataGuardState, "deleted" | "anonymized">,
): Promise<void> {
  const id = new Types.ObjectId(String(userId));
  await AccountDataGuard.updateOne(
    { _id: id },
    {
      $setOnInsert: { startedAt: new Date() },
      $set: { state, completedAt: new Date() },
    },
    { upsert: true },
  );
}

/**
 * A support write belongs to an active account. The durable guard closes the
 * race where an already-authenticated request reaches persistence after the
 * owner was deleted/anonymized; callers must also re-check after inserting.
 */
export async function assertSupportAccountWritable(
  userId: Types.ObjectId | string,
): Promise<void> {
  const id = new Types.ObjectId(String(userId));
  const [guard, user] = await Promise.all([
    AccountDataGuard.findById(id).select("state").lean(),
    User.findById(id).select("deletedAt").lean(),
  ]);
  if (!guard && user && !user.deletedAt) return;
  throw new UserFacingError(
    403,
    "This account is being deleted or anonymized and cannot create support requests.",
    "FORBIDDEN",
  );
}

/** Remove a support record that was inserted while its owner was being removed. */
export async function discardSupportCreation(
  ticketId: Types.ObjectId | string,
): Promise<void> {
  const id = new Types.ObjectId(String(ticketId));
  const results = await Promise.allSettled([
    releaseCalendarReservations("support", id),
    SupportTicketInternalNote.deleteMany({ ticketId: id }),
    SupportMeetingNotification.deleteMany({ ticketId: id }),
  ]);
  const failed = results.filter((result) => result.status === "rejected");
  if (failed.length > 0) {
    // Keep the ticket: it is the only handle that can still release its slot
    // keys, so deleting it after a failed cleanup would strand reservations.
    console.error("Support creation cleanup incomplete:", String(id), failed.length);
    throw new Error("Support creation cleanup incomplete.");
  }
  await SupportTicket.deleteOne({ _id: id });
}
