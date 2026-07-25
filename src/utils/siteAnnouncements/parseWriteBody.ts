import { toDate, type DateInput } from '../dateUtils';
import {
  ANNOUNCEMENT_LIMITS,
  isAnnouncementType,
} from './constants';
import type {
  ParseFailure,
  ParseResult,
  SiteAnnouncementWriteInput,
} from './types';

function fail(error: string): ParseFailure {
  return { ok: false, error };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asDateInput(value: unknown): DateInput {
  if (value == null) return null;
  if (value instanceof Date || typeof value === 'string') return value;
  if (
    typeof value === 'object' &&
    '$date' in value &&
    typeof (value as { $date: unknown }).$date === 'string'
  ) {
    return value as { $date: string };
  }
  return null;
}

function parseRequiredTrimmedString(
  value: unknown,
  field: string,
  limits: { min: number; max: number },
): ParseResult<string> {
  if (typeof value !== 'string') {
    return fail(`${field} is required`);
  }
  const trimmed = value.trim();
  if (trimmed.length < limits.min) {
    return fail(`${field} is required (min ${limits.min} characters)`);
  }
  if (trimmed.length > limits.max) {
    return fail(`${field} must be at most ${limits.max} characters`);
  }
  return { ok: true, value: trimmed };
}

function parseOptionalTrimmedString(
  value: unknown,
  field: string,
  max: number,
): ParseResult<string | undefined> {
  if (value === undefined || value === null || value === '') {
    return { ok: true, value: undefined };
  }
  if (typeof value !== 'string') {
    return fail(`${field} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return { ok: true, value: undefined };
  }
  if (trimmed.length > max) {
    return fail(`${field} must be at most ${max} characters`);
  }
  return { ok: true, value: trimmed };
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function parseFiniteNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function parseCountryCodes(value: unknown): ParseResult<string[]> {
  if (value === undefined) {
    return { ok: true, value: [] };
  }
  if (!Array.isArray(value)) {
    return fail('activeCountries must be an array of country codes');
  }

  const codes: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') {
      return fail('activeCountries must contain only strings');
    }
    const code = entry.trim().toUpperCase();
    if (!code) continue;
    if (!/^[A-Z]{2}$/.test(code)) {
      return fail('activeCountries must contain ISO 3166-1 alpha-2 codes');
    }
    if (!codes.includes(code)) codes.push(code);
  }
  return { ok: true, value: codes };
}

function parseCtaUrl(value: unknown): ParseResult<string | undefined> {
  const parsed = parseOptionalTrimmedString(value, 'ctaUrl', ANNOUNCEMENT_LIMITS.ctaUrl.max);
  if (!parsed.ok) return parsed;
  if (!parsed.value) return { ok: true, value: undefined };

  const url = parsed.value;
  const isRelative = url.startsWith('/');
  const isHttp = url.startsWith('https://') || url.startsWith('http://');
  if (!isRelative && !isHttp) {
    return fail('ctaUrl must be a relative path or http(s) URL');
  }
  return { ok: true, value: url };
}

/**
 * Parse and normalize a create/update site-announcement body.
 * Accepts `unknown` so callers do not pass `any`.
 */
export function parseSiteAnnouncementWriteBody(
  body: unknown,
): ParseResult<SiteAnnouncementWriteInput> {
  if (!isRecord(body)) {
    return fail('Request body must be an object');
  }

  const name = parseRequiredTrimmedString(body.name, 'Name', ANNOUNCEMENT_LIMITS.name);
  if (!name.ok) return name;

  if (typeof body.type !== 'string' || !isAnnouncementType(body.type)) {
    return fail('Type must be top_bar, modal, or exit_intent');
  }

  const title = parseRequiredTrimmedString(body.title, 'Title', ANNOUNCEMENT_LIMITS.title);
  if (!title.ok) return title;

  const message = parseRequiredTrimmedString(body.message, 'Message', ANNOUNCEMENT_LIMITS.message);
  if (!message.ok) return message;

  const ctaLabel = parseOptionalTrimmedString(
    body.ctaLabel,
    'ctaLabel',
    ANNOUNCEMENT_LIMITS.ctaLabel.max,
  );
  if (!ctaLabel.ok) return ctaLabel;

  const ctaUrl = parseCtaUrl(body.ctaUrl);
  if (!ctaUrl.ok) return ctaUrl;

  const discountCodeRaw = parseOptionalTrimmedString(
    body.discountCode,
    'discountCode',
    ANNOUNCEMENT_LIMITS.discountCode.max,
  );
  if (!discountCodeRaw.ok) return discountCodeRaw;

  const countries = parseCountryCodes(body.activeCountries);
  if (!countries.ok) return countries;

  const localeRaw = parseOptionalTrimmedString(
    body.locale,
    'locale',
    ANNOUNCEMENT_LIMITS.locale.max,
  );
  if (!localeRaw.ok) return localeRaw;

  const startsAt = toDate(asDateInput(body.startsAt));
  const endsAt = toDate(asDateInput(body.endsAt));
  if (!startsAt || !endsAt) {
    return fail('startsAt and endsAt are required dates');
  }
  if (endsAt <= startsAt) {
    return fail('endsAt must be after startsAt');
  }

  const delay = parseFiniteNumber(
    body.delaySeconds,
    ANNOUNCEMENT_LIMITS.delaySeconds.default,
  );
  const delaySeconds = Math.min(
    ANNOUNCEMENT_LIMITS.delaySeconds.max,
    Math.max(ANNOUNCEMENT_LIMITS.delaySeconds.min, delay),
  );

  return {
    ok: true,
    value: {
      name: name.value,
      type: body.type,
      title: title.value,
      message: message.value,
      ctaLabel: ctaLabel.value,
      ctaUrl: ctaUrl.value,
      discountCode: discountCodeRaw.value
        ? discountCodeRaw.value.toUpperCase()
        : undefined,
      activeCountries: countries.value,
      locale: (localeRaw.value || 'en').toLowerCase(),
      startsAt,
      endsAt,
      isActive: parseBoolean(body.isActive, true),
      priority: parseFiniteNumber(body.priority, 0),
      delaySeconds,
      dismissible: parseBoolean(body.dismissible, true),
      requireMarketingConsent: parseBoolean(body.requireMarketingConsent, true),
    },
  };
}

export function parseIsActiveBody(body: unknown): ParseResult<boolean> {
  if (!isRecord(body)) {
    return fail('Request body must be an object');
  }
  if (typeof body.isActive !== 'boolean') {
    return fail('isActive must be a boolean');
  }
  return { ok: true, value: body.isActive };
}
