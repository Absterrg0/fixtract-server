import type { AnnouncementType } from '../../models/siteAnnouncement';
import type { DateInput } from '../dateUtils';
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

/**
 * Expected JSON shape for create/update announcement requests.
 * Runtime validation still narrows each field before persistence.
 */
export interface SiteAnnouncementWriteBody {
  name?: string;
  type?: string;
  title?: string;
  message?: string;
  ctaLabel?: string;
  ctaUrl?: string;
  discountCode?: string;
  activeCountries?: string[];
  locale?: string;
  startsAt?: DateInput;
  endsAt?: DateInput;
  isActive?: boolean;
  priority?: number | string;
  delaySeconds?: number | string;
  dismissible?: boolean;
  requireMarketingConsent?: boolean;
}

export type SiteAnnouncementPatchBody = Partial<SiteAnnouncementWriteBody>;

export interface SiteAnnouncementActiveBody {
  isActive?: boolean;
}

/** Express-style query parameter (string or repeated string). */
export type QueryParam = string | string[] | undefined;

export interface AdminListQuery {
  status?: QueryParam;
  type?: QueryParam;
  search?: QueryParam;
  page?: QueryParam;
  limit?: QueryParam;
}

export interface PublicListQuery {
  country?: QueryParam;
  locale?: QueryParam;
  type?: QueryParam;
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
