import mongoose from "mongoose";
import dotenv from "dotenv";
import Payment from "../../models/payment";

dotenv.config();

type DuplicateGroup = {
  _id: { booking: mongoose.Types.ObjectId; milestoneIndex?: number | null };
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

    if (duplicateMilestones.length || duplicateBasePayments.length) {
      throw new Error(
        `Payment index migration aborted: ${duplicateMilestones.length} duplicate milestone group(s) and ` +
        `${duplicateBasePayments.length} duplicate base-payment group(s) require manual reconciliation.`,
      );
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
