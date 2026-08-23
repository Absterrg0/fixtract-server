import { Document, Schema, model } from 'mongoose';

export const MARKETING_SUPPRESSION_REASONS = ['unsubscribe', 'provider', 'admin'] as const;
export type MarketingSuppressionReason = (typeof MARKETING_SUPPRESSION_REASONS)[number];
export const MARKETING_SUPPRESSION_SOURCES = ['subscriber', 'lead', 'user', 'brevo'] as const;
export type MarketingSuppressionSource = (typeof MARKETING_SUPPRESSION_SOURCES)[number];

export interface IMarketingSuppression extends Document {
  emailNormalized: string;
  reason: MarketingSuppressionReason;
  source: MarketingSuppressionSource;
  createdAt: Date;
  updatedAt: Date;
}

const marketingSuppressionSchema = new Schema<IMarketingSuppression>(
  {
    emailNormalized: { type: String, required: true, trim: true, lowercase: true, unique: true },
    reason: { type: String, enum: MARKETING_SUPPRESSION_REASONS, required: true },
    source: { type: String, enum: MARKETING_SUPPRESSION_SOURCES, required: true },
  },
  { timestamps: true },
);

const MarketingSuppression = model<IMarketingSuppression>(
  'MarketingSuppression',
  marketingSuppressionSchema,
);

export default MarketingSuppression;
