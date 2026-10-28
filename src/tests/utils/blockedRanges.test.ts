import { describe, expect, it } from 'vitest';
import { parseBlockedRanges } from '../../utils/blockedRanges';
import { toHandlerError } from '../../utils/handlerErrors';

const thrown = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('Expected the call to throw');
};

describe('blocked range validation', () => {
  it('turns a missing end date into a specific 400 validation error', () => {
    const error = thrown(() => parseBlockedRanges([{ startDate: '2026-01-01' }], { itemLabel: 'Blocked range' }));
    expect(error).toMatchObject({ name: 'UserFacingError', status: 400, code: 'VALIDATION' });
    expect((error as Error).message).toContain('Blocked range 1');
    expect((error as Error).message).toContain('end date');

    const mapped = toHandlerError(error, 'fallback');
    expect(mapped.status).toBe(400);
    expect(mapped.body).toMatchObject({
      success: false,
      code: 'VALIDATION',
      msg: expect.stringContaining('Blocked range 1'),
    });
  });

  it('keeps the correctable reversed-date detail', () => {
    const error = thrown(() => parseBlockedRanges(
      [{ startDate: '2026-02-01', endDate: '2026-01-01' }],
      { itemLabel: 'Company blocked range', includeHoliday: true },
    ));
    expect(error).toMatchObject({ name: 'UserFacingError', status: 400, code: 'VALIDATION' });
    expect((error as Error).message).toContain('Company blocked range 1');
    expect((error as Error).message).toContain('before or equal');

    const mapped = toHandlerError(error, 'fallback');
    expect(mapped.status).toBe(400);
    expect(mapped.body.msg).toContain('before or equal');
  });

  it('accepts valid ranges and preserves the holiday flag where used', () => {
    const ranges = parseBlockedRanges(
      [{ startDate: '2026-01-01', endDate: '2026-01-03', reason: ' Holiday ', isHoliday: true }],
      { itemLabel: 'Company blocked range', includeHoliday: true },
    );
    expect(ranges).toEqual([
      expect.objectContaining({
        startDate: new Date('2026-01-01'),
        endDate: new Date('2026-01-03'),
        reason: ' Holiday ',
        isHoliday: true,
      }),
    ]);
  });

  it('rejects non-array input with a 400', () => {
    const error = thrown(() => parseBlockedRanges('nope', { itemLabel: 'Blocked range' }));
    expect(toHandlerError(error, 'fallback')).toMatchObject({
      status: 400,
      body: { code: 'VALIDATION', msg: 'Blocked ranges must be an array.' },
    });
  });
});
