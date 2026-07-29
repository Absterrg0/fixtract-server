/**
 * Shared date utility functions for consistent date handling across the application.
 * Handles MongoDB Extended JSON format ({$date: "..."}), Date instances, and string dates.
 */

export type DateInput = string | Date | { $date: string } | null | undefined;

function isMongoExtendedDate(value: object): value is { $date: string } {
  return '$date' in value && typeof (value as { $date: unknown }).$date === 'string';
}

function matchesUtcCalendarParts(parsed: Date, year: number, month: number, day: number): boolean {
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

function parseStrictIsoString(value: string): Date | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (dateOnly) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]);
    const day = Number(dateOnly[3]);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    return matchesUtcCalendarParts(parsed, year, month, day) ? parsed : null;
  }

  const dateTime = /^(\d{4})-(\d{2})-(\d{2})T/.exec(trimmed);
  if (dateTime) {
    // Require Z or an explicit numeric offset so parsing is not host-local.
    if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(trimmed)) return null;
    const year = Number(dateTime[1]);
    const month = Number(dateTime[2]);
    const day = Number(dateTime[3]);
    // Validate the written calendar day (not the UTC day after offset apply).
    const probe = new Date(Date.UTC(year, month - 1, day));
    if (!matchesUtcCalendarParts(probe, year, month, day)) return null;
    const parsed = new Date(trimmed);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Coerce supported date inputs into a valid `Date`.
 * Returns null for missing/invalid values — never throws.
 */
export const toDate = (value: unknown): Date | null => {
  if (value == null) return null;

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  if (typeof value === 'string') {
    return parseStrictIsoString(value);
  }

  if (typeof value === 'object' && isMongoExtendedDate(value)) {
    return parseStrictIsoString(value.$date);
  }

  return null;
};

/**
 * Converts various date formats to ISO string.
 * Handles MongoDB Extended JSON format {$date: "..."}, Date instances, and string dates.
 * Validates all inputs to ensure they represent valid dates.
 *
 * @param date - The date value to convert (string, Date, {$date: string}, null, or undefined)
 * @returns ISO string if valid, null otherwise
 */
export const toISOString = (date: DateInput): string | null => {
  const parsed = toDate(date);
  return parsed ? parsed.toISOString() : null;
};

/**
 * Extracts a date string from various formats.
 * Similar to toISOString but returns the original string format for string inputs
 * if they are valid dates.
 *
 * @param date - The date value to extract
 * @returns Date string if valid, null otherwise
 */
export const extractDateString = (date: DateInput): string | null => {
  if (date == null) return null;

  if (typeof date === 'string') {
    return toDate(date) ? date : null;
  }

  if (typeof date === 'object' && !(date instanceof Date) && isMongoExtendedDate(date)) {
    return toDate(date) ? date.$date : null;
  }

  const parsed = toDate(date);
  return parsed ? parsed.toISOString() : null;
};
