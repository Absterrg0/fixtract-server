/**
 * Shared date utility functions for consistent date handling across the application.
 * Handles MongoDB Extended JSON format ({$date: "..."}), Date instances, and string dates.
 */

export type DateInput = string | Date | { $date: string } | null | undefined;

function isMongoExtendedDate(value: object): value is { $date: string } {
  return '$date' in value && typeof (value as { $date: unknown }).$date === 'string';
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
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  if (typeof value === 'object' && isMongoExtendedDate(value)) {
    const parsed = new Date(value.$date);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
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
