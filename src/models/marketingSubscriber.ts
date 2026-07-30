import mongoose, { Document, Schema } from 'mongoose';

export const MARKETING_LOCALES = ['en', 'nl', 'fr'] as const;
export type MarketingLocale = (typeof MARKETING_LOCALES)[number];

export interface IMarketingSubscriber extends Document {
  email: string;
  name?: string;
  userId?: mongoose.Types.ObjectId;
  role?: 'customer' | 'professional';
  region?: string;
  interestedServices: string[];
  locale: MarketingLocale;
  subscribedAt: Date;
  consentVerifiedAt?: Date | null;
  unsubscribedAt?: Date | null;
  brevoUnsubscribedAt?: Date | null;
  brevoUnsubscribeError?: string;
  brevoResubscribeError?: string;
  unsubscribeToken: string;
  source: 'user_sync' | 'manual' | 'signup';
  lastEngagedAt?: Date | null;
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
    },
    name: { type: String, trim: true },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      index: true,
    },
    role: {
      type: String,
      enum: ['customer', 'professional'],
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
    consentVerifiedAt: {
      type: Date,
      default: null,
    },
    unsubscribedAt: { type: Date, default: null },
    brevoUnsubscribedAt: { type: Date, default: null },
    brevoUnsubscribeError: { type: String },
    brevoResubscribeError: { type: String },
    unsubscribeToken: {
      type: String,
      required: true,
      unique: true,
      select: false,
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
    lastEngagedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true },
);

marketingSubscriberSchema.index({ unsubscribedAt: 1, region: 1, locale: 1 });
marketingSubscriberSchema.index({ consentVerifiedAt: 1, unsubscribedAt: 1 });
marketingSubscriberSchema.index({ unsubscribedAt: 1, role: 1, subscribedAt: 1 });
marketingSubscriberSchema.index({ unsubscribedAt: 1, lastCampaignSentAt: 1, subscribedAt: 1 });
marketingSubscriberSchema.index({ unsubscribedAt: 1, lastEngagedAt: 1, subscribedAt: 1 });
marketingSubscriberSchema.index({ subscribedAt: -1 });

const MarketingSubscriber = mongoose.model<IMarketingSubscriber>(
  'MarketingSubscriber',
  marketingSubscriberSchema,
);

export default MarketingSubscriber;
