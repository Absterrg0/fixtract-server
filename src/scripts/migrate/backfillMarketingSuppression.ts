import dotenv from 'dotenv';
import mongoose from 'mongoose';
import path from 'path';
import connectDB from '../../config/db';
import MarketingSubscriber from '../../models/marketingSubscriber';
import MarketingSuppression from '../../models/marketingSuppression';
import { normalizeEmail } from '../../utils/marketing/normalizeEmail';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

async function main(): Promise<void> {
  try {
    await connectDB();
    const rows = await MarketingSubscriber.find({ unsubscribedAt: { $ne: null } })
      .select('email emailNormalized')
      .lean();
    const emails = new Set(
      rows
        .map((row) => normalizeEmail(row.emailNormalized || row.email))
        .filter(Boolean),
    );
    const operations = Array.from(emails).map((emailNormalized) => ({
      updateOne: {
        filter: { emailNormalized },
        update: {
          $setOnInsert: {
            emailNormalized,
            reason: 'unsubscribe' as const,
            source: 'subscriber' as const,
          },
        },
        upsert: true,
      },
    }));
    if (operations.length > 0) await MarketingSuppression.bulkWrite(operations, { ordered: false });
    console.log(`Backfilled ${operations.length} marketing suppressions.`);
    process.exitCode = 0;
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((error) => {
  console.error('Marketing suppression backfill failed:', error);
  process.exitCode = 1;
});
