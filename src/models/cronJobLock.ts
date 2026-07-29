import mongoose, { Document, Schema } from 'mongoose';

/**
 * Atomic lock keys for scheduled jobs (e.g. kpi_monthly:2026-06).
 * Unique index prevents duplicate sends on cron retries.
 */
export interface ICronJobLock extends Document {
  key: string;
  claimedAt: Date;
  completedAt?: Date;
  sentRecipients: string[];
}

const CronJobLockSchema = new Schema<ICronJobLock>(
  {
    key: { type: String, required: true, unique: true, index: true },
    claimedAt: { type: Date, required: true, default: () => new Date() },
    completedAt: { type: Date },
    sentRecipients: { type: [String], default: [] },
  },
  { timestamps: false }
);

export default mongoose.model<ICronJobLock>('CronJobLock', CronJobLockSchema);
