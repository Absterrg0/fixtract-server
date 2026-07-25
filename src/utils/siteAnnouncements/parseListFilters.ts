import {
  ANNOUNCEMENT_LIMITS,
  isAnnouncementListStatus,
  isAnnouncementType,
} from './constants';
import type { AdminListFilters, PublicListFilters } from './types';

function firstQueryValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

function parsePositiveInt(
  value: unknown,
  fallback: number,
  bounds: { min: number; max: number },
): number {
  const raw = firstQueryValue(value);
  const n = raw ? Number.parseInt(raw, 10) : fallback;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(bounds.max, Math.max(bounds.min, n));
}

export function parseAdminListFilters(query: unknown): AdminListFilters {
  const record =
    typeof query === 'object' && query !== null
      ? (query as Record<string, unknown>)
      : {};

  const statusRaw = firstQueryValue(record.status)?.trim();
  const typeRaw = firstQueryValue(record.type)?.trim();
  const searchRaw = firstQueryValue(record.search)?.trim();

  return {
    status:
      statusRaw && isAnnouncementListStatus(statusRaw) ? statusRaw : undefined,
    type: typeRaw && isAnnouncementType(typeRaw) ? typeRaw : undefined,
    search: searchRaw
      ? searchRaw.slice(0, ANNOUNCEMENT_LIMITS.search.max)
      : undefined,
    page: parsePositiveInt(record.page, 1, { min: 1, max: Number.MAX_SAFE_INTEGER }),
    limit: parsePositiveInt(record.limit, ANNOUNCEMENT_LIMITS.listLimit.default, {
      min: ANNOUNCEMENT_LIMITS.listLimit.min,
      max: ANNOUNCEMENT_LIMITS.listLimit.max,
    }),
  };
}

export function parsePublicListFilters(query: unknown): PublicListFilters {
  const record =
    typeof query === 'object' && query !== null
      ? (query as Record<string, unknown>)
      : {};

  const localeRaw = firstQueryValue(record.locale)?.trim().toLowerCase() || 'en';
  const countryRaw = firstQueryValue(record.country)?.trim().toUpperCase() || '';
  const typeRaw = firstQueryValue(record.type)?.trim();

  return {
    locale: localeRaw.slice(0, ANNOUNCEMENT_LIMITS.locale.max) || 'en',
    countryCode: /^[A-Z]{2}$/.test(countryRaw) ? countryRaw : undefined,
    type: typeRaw && isAnnouncementType(typeRaw) ? typeRaw : undefined,
  };
}
