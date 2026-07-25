import { ANNOUNCEMENT_LIMITS, isAnnouncementType } from './constants';
import { parseScheduleEnd, parseScheduleStart } from './scheduleDates';
import type {
  ParseResult,
  SiteAnnouncementActiveBody,
  SiteAnnouncementWriteBody,
  SiteAnnouncementWriteInput,
} from './types';

function trimString(value: string | number | boolean | null | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

function optionalTrimmed(value: string | null | undefined): string | undefined {
  const trimmed = trimString(value);
  return trimmed || undefined;
}

function numberOr(value: number | string | null | undefined, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

/**
 * Normalize and validate a create/update announcement payload.
 */
export function parseSiteAnnouncementWriteBody(
  body: SiteAnnouncementWriteBody,
): ParseResult<SiteAnnouncementWriteInput> {
  const name = trimString(body.name);
  if (name.length < ANNOUNCEMENT_LIMITS.name.min) {
    return { ok: false, error: 'Name is required (min 2 characters)' };
  }
  if (name.length > ANNOUNCEMENT_LIMITS.name.max) {
    return { ok: false, error: `Name must be at most ${ANNOUNCEMENT_LIMITS.name.max} characters` };
  }

  if (typeof body.type !== 'string' || !isAnnouncementType(body.type)) {
    return { ok: false, error: 'Type must be top_bar, modal, or exit_intent' };
  }

  const title = trimString(body.title);
  if (title.length < ANNOUNCEMENT_LIMITS.title.min) {
    return { ok: false, error: 'Title is required' };
  }
  if (title.length > ANNOUNCEMENT_LIMITS.title.max) {
    return { ok: false, error: `Title must be at most ${ANNOUNCEMENT_LIMITS.title.max} characters` };
  }

  const message = trimString(body.message);
  if (message.length < ANNOUNCEMENT_LIMITS.message.min) {
    return { ok: false, error: 'Message is required' };
  }
  if (message.length > ANNOUNCEMENT_LIMITS.message.max) {
    return { ok: false, error: `Message must be at most ${ANNOUNCEMENT_LIMITS.message.max} characters` };
  }

  const ctaLabel = optionalTrimmed(body.ctaLabel);
  if (ctaLabel && ctaLabel.length > ANNOUNCEMENT_LIMITS.ctaLabel.max) {
    return { ok: false, error: `ctaLabel must be at most ${ANNOUNCEMENT_LIMITS.ctaLabel.max} characters` };
  }

  const ctaUrl = optionalTrimmed(body.ctaUrl);
  if (ctaUrl) {
    if (ctaUrl.length > ANNOUNCEMENT_LIMITS.ctaUrl.max) {
      return { ok: false, error: `ctaUrl must be at most ${ANNOUNCEMENT_LIMITS.ctaUrl.max} characters` };
    }
    if (!(ctaUrl.startsWith('/') || ctaUrl.startsWith('https://') || ctaUrl.startsWith('http://'))) {
      return { ok: false, error: 'ctaUrl must be a relative path or http(s) URL' };
    }
  }

  const discountCode = optionalTrimmed(body.discountCode)?.toUpperCase();
  if (discountCode && discountCode.length > ANNOUNCEMENT_LIMITS.discountCode.max) {
    return {
      ok: false,
      error: `discountCode must be at most ${ANNOUNCEMENT_LIMITS.discountCode.max} characters`,
    };
  }

  let activeCountries: string[] = [];
  if (body.activeCountries !== undefined) {
    if (!Array.isArray(body.activeCountries)) {
      return { ok: false, error: 'activeCountries must be an array of country codes' };
    }
    for (const entry of body.activeCountries) {
      if (typeof entry !== 'string') {
        return { ok: false, error: 'activeCountries must contain only strings' };
      }
      const code = entry.trim().toUpperCase();
      if (!code) continue;
      if (!/^[A-Z]{2}$/.test(code)) {
        return { ok: false, error: 'activeCountries must contain ISO 3166-1 alpha-2 codes' };
      }
      if (!activeCountries.includes(code)) activeCountries.push(code);
    }
  }

  const locale = (optionalTrimmed(body.locale) || 'en').toLowerCase();
  if (locale.length > ANNOUNCEMENT_LIMITS.locale.max) {
    return { ok: false, error: `locale must be at most ${ANNOUNCEMENT_LIMITS.locale.max} characters` };
  }

  const startsAt = parseScheduleStart(body.startsAt);
  const endsAt = parseScheduleEnd(body.endsAt);
  if (!startsAt || !endsAt) {
    return { ok: false, error: 'startsAt and endsAt are required dates' };
  }
  if (endsAt <= startsAt) {
    return { ok: false, error: 'endsAt must be after startsAt' };
  }

  const delaySeconds = Math.min(
    ANNOUNCEMENT_LIMITS.delaySeconds.max,
    Math.max(
      ANNOUNCEMENT_LIMITS.delaySeconds.min,
      numberOr(body.delaySeconds, ANNOUNCEMENT_LIMITS.delaySeconds.default),
    ),
  );

  return {
    ok: true,
    value: {
      name,
      type: body.type,
      title,
      message,
      ctaLabel,
      ctaUrl,
      discountCode,
      activeCountries,
      locale,
      startsAt,
      endsAt,
      isActive: typeof body.isActive === 'boolean' ? body.isActive : true,
      priority: numberOr(body.priority, 0),
      delaySeconds,
      dismissible: typeof body.dismissible === 'boolean' ? body.dismissible : true,
      requireMarketingConsent:
        typeof body.requireMarketingConsent === 'boolean'
          ? body.requireMarketingConsent
          : true,
    },
  };
}

export function parseIsActiveBody(
  body: SiteAnnouncementActiveBody,
): ParseResult<boolean> {
  if (typeof body.isActive !== 'boolean') {
    return { ok: false, error: 'isActive must be a boolean' };
  }
  return { ok: true, value: body.isActive };
}
