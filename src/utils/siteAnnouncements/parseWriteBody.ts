import { ANNOUNCEMENT_LIMITS, isAnnouncementType } from './constants';
import { parseScheduleEnd, parseScheduleStart } from './scheduleDates';
import type {
  ParseResult,
  SiteAnnouncementActiveBody,
  SiteAnnouncementPatchBody,
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

function isPresent<T extends object, K extends keyof T>(body: T, key: K): boolean {
  return Object.prototype.hasOwnProperty.call(body, key);
}

/**
 * Validate only fields present in a PATCH body.
 */
export function parseSiteAnnouncementPatchBody(
  body: SiteAnnouncementPatchBody,
  existing: SiteAnnouncementWriteInput,
): ParseResult<Partial<SiteAnnouncementWriteInput>> {
  if (body == null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Request body must be a JSON object' };
  }

  const keys = Object.keys(body);
  if (keys.length === 0) {
    return { ok: false, error: 'At least one field is required' };
  }

  const update: Partial<SiteAnnouncementWriteInput> = {};

  if (isPresent(body, 'name')) {
    const name = trimString(body.name);
    if (name.length < ANNOUNCEMENT_LIMITS.name.min) {
      return { ok: false, error: 'Name is required (min 2 characters)' };
    }
    if (name.length > ANNOUNCEMENT_LIMITS.name.max) {
      return { ok: false, error: `Name must be at most ${ANNOUNCEMENT_LIMITS.name.max} characters` };
    }
    update.name = name;
  }

  if (isPresent(body, 'type')) {
    if (typeof body.type !== 'string' || !isAnnouncementType(body.type)) {
      return { ok: false, error: 'Type must be top_bar, modal, or exit_intent' };
    }
    update.type = body.type;
  }

  if (isPresent(body, 'title')) {
    const title = trimString(body.title);
    if (title.length < ANNOUNCEMENT_LIMITS.title.min) {
      return { ok: false, error: 'Title is required' };
    }
    if (title.length > ANNOUNCEMENT_LIMITS.title.max) {
      return { ok: false, error: `Title must be at most ${ANNOUNCEMENT_LIMITS.title.max} characters` };
    }
    update.title = title;
  }

  if (isPresent(body, 'message')) {
    const message = trimString(body.message);
    if (message.length < ANNOUNCEMENT_LIMITS.message.min) {
      return { ok: false, error: 'Message is required' };
    }
    if (message.length > ANNOUNCEMENT_LIMITS.message.max) {
      return { ok: false, error: `Message must be at most ${ANNOUNCEMENT_LIMITS.message.max} characters` };
    }
    update.message = message;
  }

  if (isPresent(body, 'ctaLabel')) {
    const ctaLabel = optionalTrimmed(body.ctaLabel);
    if (ctaLabel && ctaLabel.length > ANNOUNCEMENT_LIMITS.ctaLabel.max) {
      return { ok: false, error: `ctaLabel must be at most ${ANNOUNCEMENT_LIMITS.ctaLabel.max} characters` };
    }
    update.ctaLabel = ctaLabel;
  }

  if (isPresent(body, 'ctaUrl')) {
    const ctaUrl = optionalTrimmed(body.ctaUrl);
    if (ctaUrl) {
      if (ctaUrl.length > ANNOUNCEMENT_LIMITS.ctaUrl.max) {
        return { ok: false, error: `ctaUrl must be at most ${ANNOUNCEMENT_LIMITS.ctaUrl.max} characters` };
      }
      if (!(ctaUrl.startsWith('/') || ctaUrl.startsWith('https://') || ctaUrl.startsWith('http://'))) {
        return { ok: false, error: 'ctaUrl must be a relative path or http(s) URL' };
      }
    }
    update.ctaUrl = ctaUrl;
  }

  if (isPresent(body, 'discountCode')) {
    const discountCode = optionalTrimmed(body.discountCode)?.toUpperCase();
    if (discountCode && discountCode.length > ANNOUNCEMENT_LIMITS.discountCode.max) {
      return {
        ok: false,
        error: `discountCode must be at most ${ANNOUNCEMENT_LIMITS.discountCode.max} characters`,
      };
    }
    update.discountCode = discountCode;
  }

  if (isPresent(body, 'activeCountries')) {
    if (!Array.isArray(body.activeCountries)) {
      return { ok: false, error: 'activeCountries must be an array of country codes' };
    }
    const activeCountries: string[] = [];
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
    update.activeCountries = activeCountries;
  }

  if (isPresent(body, 'locale')) {
    const locale = (optionalTrimmed(body.locale) || 'en').toLowerCase();
    if (locale.length > ANNOUNCEMENT_LIMITS.locale.max) {
      return { ok: false, error: `locale must be at most ${ANNOUNCEMENT_LIMITS.locale.max} characters` };
    }
    update.locale = locale;
  }

  if (isPresent(body, 'startsAt')) {
    const startsAt = parseScheduleStart(body.startsAt);
    if (!startsAt) {
      return { ok: false, error: 'startsAt must be a valid date' };
    }
    update.startsAt = startsAt;
  }

  if (isPresent(body, 'endsAt')) {
    const endsAt = parseScheduleEnd(body.endsAt);
    if (!endsAt) {
      return { ok: false, error: 'endsAt must be a valid date' };
    }
    update.endsAt = endsAt;
  }

  const startsAt = update.startsAt ?? existing.startsAt;
  const endsAt = update.endsAt ?? existing.endsAt;
  if (endsAt <= startsAt) {
    return { ok: false, error: 'endsAt must be after startsAt' };
  }

  if (isPresent(body, 'isActive')) {
    if (typeof body.isActive !== 'boolean') {
      return { ok: false, error: 'isActive must be a boolean' };
    }
    update.isActive = body.isActive;
  }

  if (isPresent(body, 'priority')) {
    update.priority = numberOr(body.priority, existing.priority);
  }

  if (isPresent(body, 'delaySeconds')) {
    update.delaySeconds = Math.min(
      ANNOUNCEMENT_LIMITS.delaySeconds.max,
      Math.max(
        ANNOUNCEMENT_LIMITS.delaySeconds.min,
        numberOr(body.delaySeconds, existing.delaySeconds),
      ),
    );
  }

  if (isPresent(body, 'dismissible')) {
    if (typeof body.dismissible !== 'boolean') {
      return { ok: false, error: 'dismissible must be a boolean' };
    }
    update.dismissible = body.dismissible;
  }

  if (isPresent(body, 'requireMarketingConsent')) {
    if (typeof body.requireMarketingConsent !== 'boolean') {
      return { ok: false, error: 'requireMarketingConsent must be a boolean' };
    }
    update.requireMarketingConsent = body.requireMarketingConsent;
  }

  return { ok: true, value: update };
}

export function parseIsActiveBody(
  body: SiteAnnouncementActiveBody,
): ParseResult<boolean> {
  if (typeof body.isActive !== 'boolean') {
    return { ok: false, error: 'isActive must be a boolean' };
  }
  return { ok: true, value: body.isActive };
}
