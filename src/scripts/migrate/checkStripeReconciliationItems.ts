/**
 * checkStripeReconciliationItems (READ-ONLY preflight)
 * ----------------------------------------------------
 * Superseded-PaymentIntent reconciliation items are idempotent per intent
 * through the deterministic item `eventId`
 * ("reconciliation:superseded_payment_intent_succeeded:<pi>") under the unique
 * `stripeevents.eventId_1` index. This script verifies that index on the
 * deployed database and reports the open queue, including legacy items written
 * on a delivered event's own record and any intent with more than one open
 * item (possible only from the earlier per-event version).
 *
 *   npm run check:stripe-reconciliation
 *
 * It never writes, deletes, refunds or calls a provider. Duplicate legacy items
 * are reported for an operator to resolve by setting `reconciliation.resolvedAt`
 * (and `note`) on the extra records after checking the charge in Stripe; this
 * script does not do that.
 */
import dotenv from "dotenv";
import path from "path";
import mongoose from "mongoose";

export const RECONCILIATION_ITEM_PREFIX = "reconciliation:superseded_payment_intent_succeeded:";

export type ReconciliationPreflight = {
  eventIdIndexUnique: boolean;
  openItems: number;
  openLegacyItems: number;
  duplicateOpenIntents: Array<{ paymentIntentId: string; eventIds: string[] }>;
  safe: boolean;
};

export async function inspectStripeReconciliationItems(db: mongoose.mongo.Db): Promise<ReconciliationPreflight> {
  const collection = db.collection("stripeevents");
  const indexes = await collection.indexes().catch((error: any) => {
    // A database that never received a Stripe event has no collection yet.
    if (error?.codeName === "NamespaceNotFound" || error?.code === 26) return [];
    throw error;
  });
  const eventIdIndex = indexes.find((index) => {
    const keys = Object.keys(index.key || {});
    return keys.length === 1 && keys[0] === "eventId" && index.key.eventId === 1;
  });
  const eventIdIndexUnique = Boolean(eventIdIndex?.unique) && !eventIdIndex?.partialFilterExpression;
  const open = { "reconciliation.required": true, "reconciliation.resolvedAt": null };
  const openItems = await collection.countDocuments(open);
  const openLegacyItems = await collection.countDocuments({
    ...open,
    eventId: { $not: new RegExp(`^${RECONCILIATION_ITEM_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) },
  });
  const duplicates = await collection.aggregate<{ _id: string; eventIds: string[] }>([
    { $match: open },
    { $group: { _id: "$reconciliation.paymentIntentId", eventIds: { $push: "$eventId" }, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
    { $sort: { _id: 1 } },
  ]).toArray();
  return {
    eventIdIndexUnique,
    openItems,
    openLegacyItems,
    duplicateOpenIntents: duplicates.map((row) => ({ paymentIntentId: row._id, eventIds: row.eventIds.sort() })),
    safe: eventIdIndexUnique,
  };
}

async function main(): Promise<void> {
  dotenv.config({ path: path.resolve(__dirname, "../../../.env") });
  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!mongoUri) throw new Error("MONGO_URI or MONGODB_URI not found in environment variables");
  // Read-only: no index builds or collection creation from model definitions.
  await mongoose.connect(mongoUri, { autoIndex: false, autoCreate: false });
  try {
    const db = mongoose.connection.db;
    if (!db) throw new Error("MongoDB connection is missing database handle");
    const report = await inspectStripeReconciliationItems(db);
    console.log(JSON.stringify(report, null, 2));
    if (!report.eventIdIndexUnique) {
      throw new Error(
        "stripeevents.eventId_1 is not a unique index: webhook dedup and per-intent reconciliation items are not safe",
      );
    }
    if (report.duplicateOpenIntents.length > 0) {
      console.warn(
        `${report.duplicateOpenIntents.length} PaymentIntent(s) have more than one open legacy item; `
          + "check each charge once in Stripe and resolve the extra records manually.",
      );
    }
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
