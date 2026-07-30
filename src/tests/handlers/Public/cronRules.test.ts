import { describe, expect, it } from 'vitest';
import { shouldRunScheduledKpiMonthly } from '../../../utils/cronSchedule';

describe('shouldRunScheduledKpiMonthly', () => {
  it('allows the scheduled monthly report only on the first UTC day', () => {
    expect(shouldRunScheduledKpiMonthly(new Date('2026-08-01T23:59:59.999Z'))).toBe(true);
    expect(shouldRunScheduledKpiMonthly(new Date('2026-08-02T00:00:00.000Z'))).toBe(false);
  });
});
