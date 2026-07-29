import {
  ANNOUNCEMENT_LIMITS,
  isAnnouncementListStatus,
  isAnnouncementType,
} from './constants';
import type {
  AdminListFilters,
  AdminListQuery,
  PublicListFilters,
  PublicListQuery,
  QueryParam,
} from './types';

function firstQueryValue(value: QueryParam): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

function parsePositiveInt(
  value: QueryParam,
  fallback: number,
  bounds: { min: number; max: number },
): number {
  const raw = firstQueryValue(value);
  const n = raw ? Number.parseInt(raw, 10) : fallback;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(bounds.max, Math.max(bounds.min, n));
}

export function parseAdminListFilters(query: AdminListQuery): AdminListFilters {
  const statusRaw = firstQueryValue(query.status)?.trim();
  const typeRaw = firstQueryValue(query.type)?.trim();
  const searchRaw = firstQueryValue(query.search)?.trim();

  return {
    status:
      statusRaw && isAnnouncementListStatus(statusRaw) ? statusRaw : undefined,
    type: typeRaw && isAnnouncementType(typeRaw) ? typeRaw : undefined,
    search: searchRaw
      ? searchRaw.slice(0, ANNOUNCEMENT_LIMITS.search.max)
      : undefined,
    page: parsePositiveInt(query.page, 1, { min: 1, max: Number.MAX_SAFE_INTEGER }),
    limit: parsePositiveInt(query.limit, ANNOUNCEMENT_LIMITS.listLimit.default, {
      min: ANNOUNCEMENT_LIMITS.listLimit.min,
      max: ANNOUNCEMENT_LIMITS.listLimit.max,
    }),
  };
}

export function parsePublicListFilters(query: PublicListQuery): PublicListFilters {
  const localeRaw = firstQueryValue(query.locale)?.trim().toLowerCase() || 'en';
  const countryRaw = firstQueryValue(query.country)?.trim().toUpperCase() || '';
  const typeRaw = firstQueryValue(query.type)?.trim();

  return {
    locale: localeRaw.slice(0, ANNOUNCEMENT_LIMITS.locale.max) || 'en',
    countryCode: /^[A-Z]{2}$/.test(countryRaw) ? countryRaw : undefined,
    type: typeRaw && isAnnouncementType(typeRaw) ? typeRaw : undefined,
  };
}
