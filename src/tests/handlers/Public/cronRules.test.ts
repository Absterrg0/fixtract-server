import { describe, expect, it } from 'vitest';
import {
  buildMarketingClaimableSendQuery,
  shouldRunScheduledKpiMonthly,
} from '../../../utils/cronSchedule';

describe('shouldRunScheduledKpiMonthly', () => {
  it('allows the scheduled monthly report only on the first UTC day', () => {
    expect(shouldRunScheduledKpiMonthly(new Date('2026-08-01T23:59:59.999Z'))).toBe(true);
    expect(shouldRunScheduledKpiMonthly(new Date('2026-08-02T00:00:00.000Z'))).toBe(false);
  });
});

describe('buildMarketingClaimableSendQuery', () => {
  it('includes bounded retries for due scheduled and auto-send re-engagement failures', () => {
    const now = new Date('2026-08-02T08:00:00.000Z');
    const query = buildMarketingClaimableSendQuery(30 * 60 * 1000, 3, now);
    const failed = (query.$or as Array<Record<string, unknown>>)[2];

    expect(failed.status).toBe('failed');
    expect(failed.$and).toEqual([
      {
        $or: [
          { sendAttempts: { $lt: 3 } },
          { sendAttempts: { $exists: false } },
        ],
      },
      {
        $or: [
          { nextRetryAt: { $lte: now } },
          { nextRetryAt: null },
          { nextRetryAt: { $exists: false } },
        ],
      },
      {
        $or: [
          { scheduledAt: { $ne: null, $lte: now } },
          { type: 'reengagement', autoSend: true },
        ],
      },
    ]);
  });
});
