/**
 * createSupportIndexes
 * --------------------
 * Correctness-critical indexes for the user support system:
 *   - supporttickets.ticketNumber                unique, sparse
 *   - supporttickets.meeting.slotKeys            unique, sparse (multikey)
 *   - supporttickets kind/status/updatedAt, kind/meeting.scheduledAt,
 *     userType, reason, booking number
 *   - supportticketinternalnotes.ticketId/createdAt
 *   - supportmeetingnotifications (ticketId,eventId) unique
 *   - calendarreservations.key unique
 *
 * Production must not rely on Mongoose autoIndex. Run this once per deployed
 * database BEFORE enabling support meetings:
 *   npm run migrate:support-indexes
 *
 * The script is idempotent and does not modify ticket records. It never sends
 * email and makes no provider calls.
 */
import dotenv from "dotenv";
import path from "path";
import mongoose from "mongoose";
import SupportTicket from "../../models/supportTicket";
import SupportTicketInternalNote from "../../models/supportTicketInternalNote";
import SupportMeetingNotification from "../../models/supportMeetingNotification";
import CalendarReservation from "../../models/calendarReservation";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

async function main(): Promise<void> {
  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!mongoUri) {
    throw new Error("MONGO_URI or MONGODB_URI not found in environment variables");
  }

  await mongoose.connect(mongoUri);
  console.log("Connected to MongoDB");

  console.log("Ensuring supporttickets indexes...");
  await SupportTicket.createIndexes();
  console.log("Ensuring supportticketinternalnotes indexes...");
  await SupportTicketInternalNote.createIndexes();
  console.log("Ensuring supportmeetingnotifications indexes...");
  await SupportMeetingNotification.createIndexes();
  console.log("Ensuring calendarreservations indexes...");
  await CalendarReservation.createIndexes();

  const db = mongoose.connection.db;
  if (!db) throw new Error("MongoDB connection is missing database handle");
  const indexes = await db.collection("supporttickets").indexes();
  console.log("supporttickets indexes:");
  for (const index of indexes) {
    console.log(
      `  ${index.name}: ${JSON.stringify(index.key)} unique=${Boolean(index.unique)} sparse=${Boolean(index.sparse)}`,
    );
  }

  const ticketNumberIndex = indexes.find((index) => index.name === "ticketNumber_1");
  const slotIndex = indexes.find((index) => index.name === "meeting.slotKeys_1");
  if (!ticketNumberIndex?.unique || !ticketNumberIndex?.sparse) {
    throw new Error("ticketNumber_1 is not unique+sparse; deployment is not safe");
  }
  if (!slotIndex?.unique || !slotIndex?.sparse) {
    throw new Error("meeting.slotKeys_1 is not unique+sparse; meeting reservations are not safe");
  }

  const reservationIndexes = await db.collection("calendarreservations").indexes();
  const keyIndex = reservationIndexes.find((index) => index.name === "key_1");
  const sourceIndex = reservationIndexes.find((index) => index.name === "sourceType_1_sourceId_1");
  if (!keyIndex?.unique) {
    throw new Error("calendarreservations.key_1 is not unique; cross-feature reservations are not safe");
  }
  if (!sourceIndex) {
    throw new Error("calendarreservations sourceType/sourceId index is missing");
  }

  const notificationIndexes = await db.collection("supportmeetingnotifications").indexes();
  const eventIndex = notificationIndexes.find((index) => index.name === "ticketId_1_eventId_1");
  if (!eventIndex?.unique) {
    throw new Error(
      "supportmeetingnotifications ticketId_1_eventId_1 is not unique; notification identity is not safe",
    );
  }

  console.log("Support indexes verified.");
}

main()
  .catch((error) => {
    console.error("Support index setup failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
