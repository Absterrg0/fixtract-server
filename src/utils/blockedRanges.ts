import { UserFacingError } from './appErrors';

export type ParsedBlockedRange = {
  startDate: Date;
  endDate: Date;
  reason?: string;
  createdAt: Date;
  isHoliday?: boolean;
};

/**
 * Validate user-editable blocked ranges and return the stored shape.
 * Throws UserFacingError(400) so handlers can return a specific, correctable
 * message instead of the generic internal-error fallback.
 */
export function parseBlockedRanges(
  input: unknown,
  options: { itemLabel: string; includeHoliday?: boolean },
): ParsedBlockedRange[] {
  if (!Array.isArray(input)) {
    throw new UserFacingError(400, `${options.itemLabel}s must be an array.`, 'VALIDATION');
  }

  return input.map((raw, index) => {
    const position = index + 1;
    const range = (raw && typeof raw === 'object' ? raw : {}) as {
      startDate?: unknown;
      endDate?: unknown;
      reason?: unknown;
      isHoliday?: unknown;
    };

    if (!range.startDate || !range.endDate) {
      throw new UserFacingError(
        400,
        `${options.itemLabel} ${position}: both a start date and an end date are required.`,
        'VALIDATION',
      );
    }

    const startDate = new Date(range.startDate as string | number | Date);
    const endDate = new Date(range.endDate as string | number | Date);
    if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
      throw new UserFacingError(
        400,
        `${options.itemLabel} ${position}: start and end dates must be valid dates.`,
        'VALIDATION',
      );
    }
    if (startDate > endDate) {
      throw new UserFacingError(
        400,
        `${options.itemLabel} ${position}: the start date must be before or equal to the end date.`,
        'VALIDATION',
      );
    }

    return {
      startDate,
      endDate,
      reason: typeof range.reason === 'string' ? range.reason : undefined,
      createdAt: new Date(),
      ...(options.includeHoliday ? { isHoliday: Boolean(range.isHoliday) } : {}),
    };
  });
}
