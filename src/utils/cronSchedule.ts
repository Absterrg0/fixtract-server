/** The scheduled daily cron may send the monthly report only on the first UTC day. */
export function shouldRunScheduledKpiMonthly(now = new Date()): boolean {
  return now.getUTCDate() === 1;
}
