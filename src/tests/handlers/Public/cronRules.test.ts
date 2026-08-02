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
  it('includes due scheduled, stale sending reclaim, and bounded failed retries', () => {
    const now = new Date('2026-08-02T08:00:00.000Z');
    const leaseMs = 30 * 60 * 1000;
    const query = buildMarketingClaimableSendQuery(leaseMs, 3, now);
    const [scheduled, sending, failed] = query.$or as Array<Record<string, unknown>>;

    expect(scheduled).toEqual({
      status: 'scheduled',
      scheduledAt: { $lte: now },
    });

    expect(sending).toEqual({
      status: 'sending',
      $or: [
        { sendStartedAt: { $lte: new Date(now.getTime() - leaseMs) } },
        { sendStartedAt: null },
        { sendStartedAt: { $exists: false } },
      ],
    });

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
