import mongoose from "mongoose";
import dotenv from "dotenv";
import Payment from "../../models/payment";

dotenv.config();

type DuplicateGroup = {
  _id: { booking: mongoose.Types.ObjectId; milestoneIndex?: number | null };
  ids: mongoose.Types.ObjectId[];
  count: number;
};

type DuplicateIntentGroup = {
  _id: string;
  ids: mongoose.Types.ObjectId[];
  count: number;
};

/**
 * Rebuild the payment uniqueness indexes after the milestone-payment schema
 * change. The script refuses to delete or merge financial records: duplicate
 * rows must be reconciled by an operator before the unique index is installed.
 */
export default async function fixPaymentIndexes() {
  const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!mongoUri) throw new Error("MONGODB_URI or MONGO_URI is not defined");

  await mongoose.connect(mongoUri);
  try {
    const duplicateMilestones = await Payment.aggregate<DuplicateGroup>([
      { $group: {
        _id: { booking: "$booking", milestoneIndex: "$milestoneIndex" },
        ids: { $push: "$_id" },
        count: { $sum: 1 },
      } },
      { $match: { count: { $gt: 1 } } },
      { $limit: 50 },
    ]);

    const duplicateBasePayments = await Payment.aggregate<DuplicateGroup>([
      { $match: { $or: [{ milestoneIndex: { $exists: false } }, { milestoneIndex: null }] } },
      { $group: {
        _id: { booking: "$booking" },
        ids: { $push: "$_id" },
        count: { $sum: 1 },
      } },
      { $match: { count: { $gt: 1 } } },
      { $limit: 50 },
    ]);

    const duplicateStripePaymentIntents = await Payment.aggregate<DuplicateIntentGroup>([
      { $match: { stripePaymentIntentId: { $type: 'string' } } },
      { $group: { _id: '$stripePaymentIntentId', ids: { $push: '$_id' }, count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
      { $limit: 50 },
    ]);

    if (duplicateMilestones.length || duplicateBasePayments.length || duplicateStripePaymentIntents.length) {
      throw new Error(
        `Payment index migration aborted: ${duplicateMilestones.length} duplicate milestone group(s) and ` +
        `${duplicateBasePayments.length} duplicate base-payment group(s) and ` +
        `${duplicateStripePaymentIntents.length} duplicate Stripe payment-intent group(s) require manual reconciliation.`,
      );
    }

    // The previous sparse unique index included explicit null values. Drop that
    // legacy definition before syncing the partial index from the schema.
    const existingIndexes = await Payment.collection.listIndexes().toArray();
    const legacyStripeIndex = existingIndexes.find((index) =>
      index.name === 'stripePaymentIntentId_1' && index.sparse === true,
    );
    if (legacyStripeIndex?.name) {
      await Payment.collection.dropIndex(legacyStripeIndex.name);
    }

    await Payment.syncIndexes();
    console.log("Payment indexes synchronized successfully.");
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  fixPaymentIndexes().catch((error) => {
    console.error("Payment index migration failed:", error);
    process.exit(1);
  });
}
