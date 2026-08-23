import mongoose, { Document, Schema } from 'mongoose';
import {
  ANNOUNCEMENT_FREQUENCIES,
  ANNOUNCEMENT_TYPES,
  type AnnouncementFrequency,
} from '../utils/siteAnnouncements/constants';

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
  frequency: AnnouncementFrequency;
  startsAt: Date;
  endsAt: Date;
  isActive: boolean;
  priority: number;
  delaySeconds: number;
  dismissible: boolean;
  requireMarketingConsent: boolean;
  impressions: number;
  clicks: number;
  dismissals: number;
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
    enum: [...ANNOUNCEMENT_TYPES],
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
  frequency: {
    type: String,
    enum: [...ANNOUNCEMENT_FREQUENCIES],
    default: 'once_pageview',
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
  impressions: {
    type: Number,
    default: 0,
    min: 0,
  },
  clicks: {
    type: Number,
    default: 0,
    min: 0,
  },
  dismissals: {
    type: Number,
    default: 0,
    min: 0,
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
