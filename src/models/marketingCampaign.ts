import mongoose, { Document, Schema } from 'mongoose';
import { MARKETING_LOCALES, type MarketingLocale } from './marketingSubscriber';

export const MARKETING_CAMPAIGN_TYPES = ['newsletter', 'promotion', 'reengagement'] as const;
export type MarketingCampaignType = (typeof MARKETING_CAMPAIGN_TYPES)[number];

export const MARKETING_CAMPAIGN_STATUSES = [
  'draft',
  'scheduled',
  'sending',
  'sent',
  'failed',
  'cancelled',
] as const;
export type MarketingCampaignStatus = (typeof MARKETING_CAMPAIGN_STATUSES)[number];

export interface ICampaignLocaleContent {
  subject: string;
  htmlContent: string;
  previewText?: string;
  brevoTemplateId?: number;
}

export interface ICampaignAudience {
  /** ISO country codes; empty = all regions */
  countries: string[];
  /** Service interest strings; empty = all services */
  interestedServices: string[];
  /** Locales to send; empty = all locales that have content */
  locales: MarketingLocale[];
  /** Include customers / professionals; defaults both true via empty = both */
  roles: Array<'customer' | 'professional'>;
}

export interface ICampaignLocaleDelivery {
  locale: MarketingLocale;
  brevoListId?: number;
  brevoCampaignId?: number;
  recipientCount: number;
  stats?: {
    sent: number;
    delivered: number;
    uniqueViews: number;
    uniqueClicks: number;
    unsubscriptions: number;
    softBounces: number;
    hardBounces: number;
  };
  error?: string;
}

export interface IMarketingCampaign extends Document {
  name: string;
  type: MarketingCampaignType;
  status: MarketingCampaignStatus;
  /** Content keyed by locale */
  content: Partial<Record<MarketingLocale, ICampaignLocaleContent>>;
  audience: ICampaignAudience;
  /** For reengagement auto-sends: inactive for this many days */
  inactiveDays?: number;
  /** When true, daily cron may pick this draft/scheduled reengagement campaign */
  autoSend: boolean;
  scheduledAt?: Date | null;
  sentAt?: Date | null;
  createdBy?: mongoose.Types.ObjectId;
  deliveries: ICampaignLocaleDelivery[];
  lastError?: string;
  utmCampaign?: string;
  createdAt: Date;
  updatedAt: Date;
}

const localeContentSchema = new Schema<ICampaignLocaleContent>(
  {
    subject: { type: String, required: true, trim: true },
    htmlContent: { type: String, required: true },
    previewText: { type: String, trim: true },
    brevoTemplateId: { type: Number },
  },
  { _id: false },
);

const audienceSchema = new Schema<ICampaignAudience>(
  {
    countries: { type: [String], default: [] },
    interestedServices: { type: [String], default: [] },
    locales: { type: [String], enum: MARKETING_LOCALES, default: [] },
    roles: {
      type: [String],
      enum: ['customer', 'professional'],
      default: ['customer', 'professional'],
    },
  },
  { _id: false },
);

const deliverySchema = new Schema<ICampaignLocaleDelivery>(
  {
    locale: { type: String, enum: MARKETING_LOCALES, required: true },
    brevoListId: { type: Number },
    brevoCampaignId: { type: Number },
    recipientCount: { type: Number, default: 0 },
    stats: {
      sent: { type: Number, default: 0 },
      delivered: { type: Number, default: 0 },
      uniqueViews: { type: Number, default: 0 },
      uniqueClicks: { type: Number, default: 0 },
      unsubscriptions: { type: Number, default: 0 },
      softBounces: { type: Number, default: 0 },
      hardBounces: { type: Number, default: 0 },
    },
    error: { type: String },
  },
  { _id: false },
);

const marketingCampaignSchema = new Schema<IMarketingCampaign>(
  {
    name: { type: String, required: true, trim: true, index: true },
    type: {
      type: String,
      enum: MARKETING_CAMPAIGN_TYPES,
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: MARKETING_CAMPAIGN_STATUSES,
      default: 'draft',
      index: true,
    },
    content: {
      type: {
        en: { type: localeContentSchema, required: false },
        nl: { type: localeContentSchema, required: false },
        fr: { type: localeContentSchema, required: false },
      },
      default: {},
    },
    audience: {
      type: audienceSchema,
      default: () => ({
        countries: [],
        interestedServices: [],
        locales: [],
        roles: ['customer', 'professional'],
      }),
    },
    inactiveDays: { type: Number, min: 1 },
    autoSend: { type: Boolean, default: false },
    scheduledAt: { type: Date, default: null, index: true },
    sentAt: { type: Date, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    deliveries: { type: [deliverySchema], default: [] },
    lastError: { type: String },
    utmCampaign: { type: String, trim: true },
  },
  { timestamps: true },
);

marketingCampaignSchema.index({ type: 1, autoSend: 1, status: 1 });

const MarketingCampaign = mongoose.model<IMarketingCampaign>(
  'MarketingCampaign',
  marketingCampaignSchema,
);

export default MarketingCampaign;
export { MARKETING_LOCALES };
export type { MarketingLocale };
