import mongoose, { Types, type ClientSession } from "mongoose";
import CalendarReservation, {
  type CalendarReservationSource,
} from "../../models/calendarReservation";
import { UserFacingError } from "../appErrors";

const OCCUPANCY_BUCKET_MINUTES = 15;
const OCCUPANCY_BUCKET_MS = OCCUPANCY_BUCKET_MINUTES * 60 * 1000;

export interface CalendarReservationKey {
  key: string;
  role: "admin" | "professional";
  userId: Types.ObjectId | string;
  startAt: Date;
  endAt: Date;
}

export function calendarReservationKey(
  role: "admin" | "professional",
  userId: Types.ObjectId | string,
  start: Date,
): string {
  return `${role}:${String(userId)}:${start.toISOString()}`;
}

export function buildCalendarReservationKey(input: {
  role: "admin" | "professional";
  userId: Types.ObjectId | string;
  startAt: Date;
  endAt: Date;
}): CalendarReservationKey {
  return {
    key: calendarReservationKey(input.role, input.userId, input.startAt),
    role: input.role,
    userId: input.userId,
    startAt: input.startAt,
    endAt: input.endAt,
  };
}

/**
 * Reserve every 15-minute bucket the interval touches. Two writers with
 * partially overlapping intervals (e.g. a legacy 09:15 meeting vs a 09:30
 * support slot) then collide even when their start instants differ.
 */
export function buildCalendarReservationKeysForInterval(input: {
  role: "admin" | "professional";
  userId: Types.ObjectId | string;
  startAt: Date;
  endAt: Date;
}): CalendarReservationKey[] {
  const startMs = input.startAt.getTime();
  const endMs = Math.max(input.endAt.getTime(), startMs + 1);
  const firstBucket = Math.floor(startMs / OCCUPANCY_BUCKET_MS) * OCCUPANCY_BUCKET_MS;
  const keys: CalendarReservationKey[] = [];
  for (let cursor = firstBucket; cursor < endMs; cursor += OCCUPANCY_BUCKET_MS) {
    keys.push(
      buildCalendarReservationKey({
        role: input.role,
        userId: input.userId,
        startAt: new Date(cursor),
        endAt: new Date(cursor + OCCUPANCY_BUCKET_MS),
      }),
    );
  }
  return keys;
}

function isDuplicateKey(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  return code === 11000 || code === 11001;
}

export async function reserveCalendarKeys(
  input: {
    sourceType: CalendarReservationSource;
    sourceId: Types.ObjectId | string;
    keys: CalendarReservationKey[];
  },
  session?: ClientSession,
): Promise<void> {
  if (input.keys.length === 0) return;
  const docs = input.keys.map((entry) => ({
    key: entry.key,
    sourceType: input.sourceType,
    sourceId: new Types.ObjectId(String(input.sourceId)),
    role: entry.role,
    userId: new Types.ObjectId(String(entry.userId)),
    startAt: entry.startAt,
    endAt: entry.endAt,
  }));
  try {
    await CalendarReservation.insertMany(docs, { session, ordered: true });
  } catch (error) {
    if (isDuplicateKey(error)) {
      throw new UserFacingError(
        409,
        "That time was just reserved. Refresh the available slots and choose another one.",
        "SLOT_UNAVAILABLE",
      );
    }
    throw error;
  }
}

export async function releaseCalendarReservations(
  sourceType: CalendarReservationSource,
  sourceId: Types.ObjectId | string,
  session?: ClientSession,
): Promise<void> {
  await CalendarReservation.deleteMany(
    { sourceType, sourceId: new Types.ObjectId(String(sourceId)) },
    session ? { session } : undefined,
  );
}

/**
 * Serializes the check+write with other calendar writers through the unique
 * reservation collection. Mongo retries transient write conflicts itself.
 *
 * The driver may replay the callback after a transient conflict. A captured
 * Mongoose document that was already saved by the aborted attempt has had its
 * modified paths and in-memory `__v` reset, so a plain `session.withTransaction`
 * replay makes `doc.save()` an empty-update no-op: the other commands commit
 * while the document transition is silently lost. `Connection#transaction()`
 * wires Mongoose's change tracking into the driver's retry loop, restoring the
 * pre-attempt modified paths/version before the callback runs again. Callbacks
 * must therefore only assign absolute values (no network or external side
 * effects); every calendar writer follows that rule.
 */
export async function withCalendarTransaction<T>(
  fn: (session: ClientSession) => Promise<T>,
): Promise<T> {
  const result = await mongoose.connection.transaction(fn);
  if (result === undefined) {
    throw new Error("Calendar transaction finished without a result");
  }
  return result;
}

/**
 * Booking handlers use this variant so unit tests (no DB) can exercise the
 * handler logic without opening a transaction, while every connected server
 * still gets the same atomic reservation+write boundary.
 */
export async function withCalendarTransactionIfConnected<T>(
  fn: (session: ClientSession | undefined) => Promise<T>,
): Promise<T> {
  if (mongoose.connection.readyState !== 1) {
    if (process.env.NODE_ENV === "test") {
      return fn(undefined);
    }
    throw new Error("Calendar transaction requires a MongoDB connection");
  }
  return withCalendarTransaction(fn);
}
