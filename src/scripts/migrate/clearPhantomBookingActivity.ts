/**
 * Remove review/cancellation/dispute sub-objects that exist only because the
 * old Booking schema defaulted their timestamps to the creation time.
 *
 * Dry run by default; pass --apply to write. Each update re-checks, in its
 * filter, that the sub-object still has no recorded actor or content, so a
 * dispute/cancellation/review recorded concurrently is never removed.
 *
 *   npm run migrate:booking-phantom-activity            # report only
 *   npm run migrate:booking-phantom-activity -- --apply # write
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import { phantomBookingActivityUnset } from "../../utils/bookingActivity";

const EMPTY = { $in: [null, ""] };

/** Filter conditions proving each sub-object is still unrecorded at write time. */
export const PHANTOM_GUARDS: Record<string, Record<string, unknown>> = {
  dispute: {
    "dispute.raisedBy": null,
    "dispute.reason": EMPTY,
    "dispute.description": EMPTY,
    "dispute.resolvedAt": null,
    "dispute.slaDeadline": null,
  },
  cancellation: {
    "cancellation.cancelledBy": null,
    "cancellation.reason": EMPTY,
    "cancellation.adminResolutionNote": EMPTY,
    "cancellation.refundAmount": null,
  },
  customerReview: {
    "customerReview.communicationLevel": null,
    "customerReview.valueOfDelivery": null,
    "customerReview.qualityOfService": null,
    "customerReview.comment": EMPTY,
    "customerReview.reply.comment": EMPTY,
    $or: [{ "customerReview.images": { $exists: false } }, { "customerReview.images": { $size: 0 } }],
  },
  professionalReview: {
    "professionalReview.rating": null,
    "professionalReview.comment": EMPTY,
  },
};

export type PhantomCleanupResult = {
  scanned: number;
  affectedBookings: number;
  fields: Record<string, number>;
  modified: number;
  applied: boolean;
};

export const clearPhantomBookingActivity = async (
  collection: mongoose.mongo.Collection,
  options: { apply?: boolean; batchSize?: number } = {},
): Promise<PhantomCleanupResult> => {
  const apply = options.apply === true;
  const batchSize = options.batchSize ?? 500;
  const result: PhantomCleanupResult = { scanned: 0, affectedBookings: 0, fields: {}, modified: 0, applied: apply };
  const cursor = collection.find(
    {
      $or: [
        { dispute: { $exists: true } },
        { cancellation: { $exists: true } },
        { customerReview: { $exists: true } },
        { professionalReview: { $exists: true } },
      ],
    },
    { projection: { dispute: 1, cancellation: 1, customerReview: 1, professionalReview: 1 } },
  );

  let operations: any[] = [];
  const flush = async () => {
    if (!apply || operations.length === 0) {
      operations = [];
      return;
    }
    const write = await collection.bulkWrite(operations, { ordered: false });
    result.modified += write.modifiedCount;
    operations = [];
  };

  for await (const booking of cursor) {
    result.scanned += 1;
    const unset = phantomBookingActivityUnset(booking);
    if (!unset) continue;
    result.affectedBookings += 1;
    for (const field of Object.keys(unset)) {
      result.fields[field] = (result.fields[field] || 0) + 1;
      // One update per sub-object so each carries its own guard.
      operations.push({
        updateOne: {
          filter: { _id: booking._id, [field]: { $exists: true }, ...PHANTOM_GUARDS[field] },
          update: { $unset: { [field]: "" } },
        },
      });
    }
    if (operations.length >= batchSize) await flush();
  }
  await flush();
  return result;
};

const run = async () => {
  dotenv.config();
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) throw new Error("MONGODB_URI (or MONGO_URI) is required");
  const apply = process.argv.includes("--apply");
  await mongoose.connect(uri);
  try {
    const result = await clearPhantomBookingActivity(mongoose.connection.collection("bookings"), { apply });
    console.log(JSON.stringify(result, null, 2));
    if (!apply) console.log("Dry run only. Re-run with --apply to write these changes.");
  } finally {
    await mongoose.disconnect();
  }
};

if (require.main === module) {
  run().catch((error) => {
    console.error("Phantom booking activity cleanup failed:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
