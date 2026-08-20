import mongoose, { Document, Schema } from 'mongoose';
import { MARKETING_LOCALES, type MarketingLocale } from '../utils/marketing/marketingCatalog';

export const MARKETING_LEAD_STATUSES = ['active', 'deleted'] as const;
export type MarketingLeadStatus = (typeof MARKETING_LEAD_STATUSES)[number];

export interface IMarketingLead extends Document {
  email: string;
  emailNormalized: string;
  firstName?: string;
  lastName?: string;
  country: string;
  locale: MarketingLocale;
  serviceKeys: string[];
  sourceImportId: mongoose.Types.ObjectId;
  matchedSubscriberId?: mongoose.Types.ObjectId;
  status: MarketingLeadStatus;
  unsubscribedAt?: Date | null;
  deletedAt?: Date | null;
  lastCampaignSentAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const marketingLeadSchema = new Schema<IMarketingLead>(
  {
    email: { type: String, required: true, trim: true },
    emailNormalized: { type: String, required: true, trim: true, lowercase: true },
    firstName: { type: String, trim: true },
    lastName: { type: String, trim: true },
    country: { type: String, required: true, trim: true, uppercase: true, index: true },
    locale: { type: String, enum: MARKETING_LOCALES, required: true, index: true },
    serviceKeys: { type: [String], default: [] },
    sourceImportId: {
      type: Schema.Types.ObjectId,
      ref: 'MarketingLeadImport',
      required: true,
      index: true,
    },
    matchedSubscriberId: {
      type: Schema.Types.ObjectId,
      ref: 'MarketingSubscriber',
      index: true,
    },
    status: { type: String, enum: MARKETING_LEAD_STATUSES, default: 'active', index: true },
    unsubscribedAt: { type: Date, default: null, index: true },
    deletedAt: { type: Date, default: null },
    lastCampaignSentAt: { type: Date, default: null, index: true },
  },
  { timestamps: true },
);

marketingLeadSchema.index(
  { emailNormalized: 1 },
  { unique: true, partialFilterExpression: { status: 'active' } },
);
marketingLeadSchema.index({ status: 1, country: 1, locale: 1, serviceKeys: 1 });
marketingLeadSchema.index({ status: 1, createdAt: -1 });

const MarketingLead = mongoose.model<IMarketingLead>('MarketingLead', marketingLeadSchema);

export default MarketingLead;
