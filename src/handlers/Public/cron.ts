import { Request, Response } from 'express';
import { runNotificationReminders } from '../../utils/notifications/runNotificationReminders';

function isAuthorizedCron(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error('[Cron] CRON_SECRET is not configured');
    return false;
  }
  const auth = req.headers.authorization;
  return auth === `Bearer ${secret}`;
}

/**
 * Vercel Cron entrypoint for daily notification reminder sweeps.
 * Secured via Authorization: Bearer ${CRON_SECRET}.
 */
export const runNotificationRemindersCron = async (req: Request, res: Response) => {
  if (!isAuthorizedCron(req)) {
    return res.status(401).json({ success: false, msg: 'Unauthorized' });
  }

  try {
    const startedAt = Date.now();
    const result = await runNotificationReminders();
    const durationMs = Date.now() - startedAt;
    console.log('[Cron] Notification reminders completed', {
      durationMs,
      unreadChat: result.unreadChat,
      errorCount: result.errors.length,
    });
    return res.json({ success: true, data: { ...result, durationMs } });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[Cron] Notification reminders failed:', error);
    return res.status(500).json({ success: false, msg: 'Notification reminders failed', error: message });
  }
};
