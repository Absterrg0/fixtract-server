import { DateTime } from 'luxon';
import { toDate } from '../dateUtils';

/** Fixera market timezone for date-only admin schedule fields. */
export const ANNOUNCEMENT_MARKET_TZ = 'Europe/Brussels';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse a schedule start: date-only → start of that day in Europe/Brussels;
 * otherwise coerce via shared toDate (ISO instants pass through).
 */
export function parseScheduleStart(value: unknown): Date | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (DATE_ONLY.test(trimmed)) {
      const dt = DateTime.fromISO(trimmed, { zone: ANNOUNCEMENT_MARKET_TZ }).startOf('day');
      return dt.isValid ? dt.toUTC().toJSDate() : null;
    }
  }
  return toDate(value);
}

/**
 * Parse a schedule end: date-only → end of that day in Europe/Brussels;
 * otherwise coerce via shared toDate (ISO instants pass through).
 */
export function parseScheduleEnd(value: unknown): Date | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (DATE_ONLY.test(trimmed)) {
      const dt = DateTime.fromISO(trimmed, { zone: ANNOUNCEMENT_MARKET_TZ }).endOf('day');
      return dt.isValid ? dt.toUTC().toJSDate() : null;
    }
  }
  return toDate(value);
}
