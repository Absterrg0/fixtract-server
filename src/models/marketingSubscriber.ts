import mongoose, { Document, Schema } from 'mongoose';

export const MARKETING_LOCALES = ['en', 'nl', 'fr'] as const;
export type MarketingLocale = (typeof MARKETING_LOCALES)[number];

export interface IMarketingSubscriber extends Document {
  email: string;
  userId?: mongoose.Types.ObjectId;
  region?: string;
  interestedServices: string[];
  locale: MarketingLocale;
  subscribedAt: Date;
  unsubscribedAt?: Date | null;
  unsubscribeToken: string;
  source: 'user_sync' | 'manual' | 'signup';
  lastCampaignSentAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const marketingSubscriberSchema = new Schema<IMarketingSubscriber>(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      index: true,
    },
    region: {
      type: String,
      trim: true,
      uppercase: true,
      index: true,
    },
    interestedServices: {
      type: [String],
      default: [],
    },
    locale: {
      type: String,
      enum: MARKETING_LOCALES,
      default: 'en',
      index: true,
    },
    subscribedAt: {
      type: Date,
      default: Date.now,
    },
    unsubscribedAt: {
      type: Date,
      default: null,
      index: true,
    },
    unsubscribeToken: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    source: {
      type: String,
      enum: ['user_sync', 'manual', 'signup'],
      default: 'user_sync',
    },
    lastCampaignSentAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true },
);

marketingSubscriberSchema.index({ unsubscribedAt: 1, region: 1, locale: 1 });

const MarketingSubscriber = mongoose.model<IMarketingSubscriber>(
  'MarketingSubscriber',
  marketingSubscriberSchema,
);

export default MarketingSubscriber;
