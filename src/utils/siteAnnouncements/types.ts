import type { AnnouncementType } from '../../models/siteAnnouncement';
import type { AnnouncementListStatus } from './constants';

export type ParseSuccess<T> = { ok: true; value: T };
export type ParseFailure = { ok: false; error: string };
export type ParseResult<T> = ParseSuccess<T> | ParseFailure;

/** Normalized write payload ready for Mongoose create/update. */
export interface SiteAnnouncementWriteInput {
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
}

export interface AdminListFilters {
  status?: AnnouncementListStatus;
  type?: AnnouncementType;
  search?: string;
  page: number;
  limit: number;
}

export interface PublicListFilters {
  countryCode?: string;
  locale: string;
  type?: AnnouncementType;
}
