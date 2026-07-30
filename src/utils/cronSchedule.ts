/** The scheduled daily cron may send the monthly report only on the first UTC day. */
export function shouldRunScheduledKpiMonthly(now = new Date()): boolean {
  return now.getUTCDate() === 1;
}

/** Mongo selector for due, abandoned, or bounded-retry campaign sends. */
export function buildMarketingClaimableSendQuery(
  leaseMs: number,
  maxAttempts: number,
  now = new Date(),
): Record<string, unknown> {
  const staleSendBefore = new Date(now.getTime() - leaseMs);
  return {
    $or: [
      {
        status: 'scheduled',
        scheduledAt: { $lte: now },
      },
      {
        status: 'sending',
        $or: [
          { sendStartedAt: { $lte: staleSendBefore } },
          { sendStartedAt: null },
          { sendStartedAt: { $exists: false } },
        ],
      },
      {
        status: 'failed',
        $and: [
          {
            $or: [
              { sendAttempts: { $lt: maxAttempts } },
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
        ],
      },
    ],
  };
}
