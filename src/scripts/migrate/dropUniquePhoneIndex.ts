import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { ensureNonUniquePhoneIndex } from '../../utils/ensureNonUniquePhoneIndex';

dotenv.config();

/**
 * One-time migration (safe to re-run): drops the unique index on users.phone
 * so multiple accounts can share a phone number. OTP verification is unchanged
 * and still required per account.
 *
 *   npx tsx src/scripts/migrate/dropUniquePhoneIndex.ts
 */
async function dropUniquePhoneIndex() {
  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!mongoUri) {
    throw new Error('MONGO_URI or MONGODB_URI not found in environment variables');
  }

  await mongoose.connect(mongoUri);
  console.log('Connected to MongoDB');

  await ensureNonUniquePhoneIndex();

  await mongoose.disconnect();
  console.log('Done.');
}

dropUniquePhoneIndex().catch((err) => {
  console.error('dropUniquePhoneIndex failed:', err);
  process.exit(1);
});
