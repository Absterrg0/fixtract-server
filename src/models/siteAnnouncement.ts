import mongoose, { Document, Schema } from 'mongoose';

export type AnnouncementType = 'top_bar' | 'modal' | 'exit_intent';

export interface ISiteAnnouncement extends Document {
  name: string;
  type: AnnouncementType;
  title: string;
  message: string;
  ctaLabel?: string;
  ctaUrl?: string;
  discountCode?: string;
  activeCountries: string[];
  locale: string;
  startsAt: Date;
  endsAt: Date;
  isActive: boolean;
  priority: number;
  delaySeconds: number;
  dismissible: boolean;
  requireMarketingConsent: boolean;
  createdBy: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const siteAnnouncementSchema = new Schema<ISiteAnnouncement>({
  name: {
    type: String,
    required: true,
    trim: true,
    maxlength: 120,
  },
  type: {
    type: String,
    enum: ['top_bar', 'modal', 'exit_intent'],
    required: true,
    index: true,
  },
  title: {
    type: String,
    required: true,
    trim: true,
    maxlength: 160,
  },
  message: {
    type: String,
    required: true,
    trim: true,
    maxlength: 500,
  },
  ctaLabel: {
    type: String,
    trim: true,
    maxlength: 60,
  },
  ctaUrl: {
    type: String,
    trim: true,
    maxlength: 500,
  },
  discountCode: {
    type: String,
    trim: true,
    uppercase: true,
    maxlength: 40,
  },
  activeCountries: {
    type: [String],
    default: [],
  },
  locale: {
    type: String,
    default: 'en',
    trim: true,
    lowercase: true,
    maxlength: 10,
  },
  startsAt: {
    type: Date,
    required: true,
  },
  endsAt: {
    type: Date,
    required: true,
  },
  isActive: {
    type: Boolean,
    default: true,
    index: true,
  },
  priority: {
    type: Number,
    default: 0,
  },
  delaySeconds: {
    type: Number,
    default: 3,
    min: 0,
    max: 120,
  },
  dismissible: {
    type: Boolean,
    default: true,
  },
  requireMarketingConsent: {
    type: Boolean,
    default: true,
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
}, {
  timestamps: true,
});

siteAnnouncementSchema.index({ isActive: 1, type: 1, startsAt: 1, endsAt: 1, priority: -1 });
siteAnnouncementSchema.index({ startsAt: 1, endsAt: 1 });
siteAnnouncementSchema.index({ isActive: 1, locale: 1, priority: -1 });
siteAnnouncementSchema.index({ isActive: 1, activeCountries: 1, locale: 1 });
siteAnnouncementSchema.index({ createdAt: -1 });

const SiteAnnouncement = mongoose.model<ISiteAnnouncement>('SiteAnnouncement', siteAnnouncementSchema);

export default SiteAnnouncement;
