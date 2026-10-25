import { Schema, model, Document, Types } from "mongoose";

export type CalendarReservationSource = "support" | "meeting" | "meeting_request" | "booking";

/**
 * Shared unique reservation keys for every calendar writer that can occupy an
 * admin or professional slot. Mongo unique indexes are per collection, so the
 * support ticket's own slotKeys cannot stop an existing Meeting route from
 * racing a support reservation. This collection is the cross-feature lock.
 */
export interface ICalendarReservation extends Document {
  _id: Types.ObjectId;
  /** `<role>:<userId>:<UTC ISO start>` — globally unique. */
  key: string;
  sourceType: CalendarReservationSource;
  sourceId: Types.ObjectId;
  role: "admin" | "professional";
  userId: Types.ObjectId;
  startAt: Date;
  endAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const calendarReservationSchema = new Schema<ICalendarReservation>(
  {
    key: { type: String, required: true, trim: true, maxlength: 200 },
    sourceType: {
      type: String,
      enum: ["support", "meeting", "meeting_request", "booking"],
      required: true,
    },
    sourceId: { type: Schema.Types.ObjectId, required: true },
    role: { type: String, enum: ["admin", "professional"], required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    startAt: { type: Date, required: true },
    endAt: { type: Date, required: true },
  },
  { timestamps: true },
);

calendarReservationSchema.index({ key: 1 }, { unique: true });
calendarReservationSchema.index({ sourceType: 1, sourceId: 1 });
calendarReservationSchema.index({ startAt: 1, endAt: 1 });

const CalendarReservation = model<ICalendarReservation>(
  "CalendarReservation",
  calendarReservationSchema,
);
export default CalendarReservation;
