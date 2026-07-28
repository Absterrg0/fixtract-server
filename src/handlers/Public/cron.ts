import { Request, Response } from 'express';
import { runNotificationReminders } from '../../utils/notifications/runNotificationReminders';
import { syncSubscribersFromUsers } from '../../utils/marketing/audience';
import { runReengagementSweep, sendMarketingCampaign } from '../../utils/marketing/sendCampaign';
import MarketingCampaign from '../../models/marketingCampaign';

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
    console.error('[Cron] Notification reminders failed:', error);
    return res.status(500).json({ success: false, msg: 'Notification reminders failed' });
  }
};

/**
 * Daily marketing: sync subscribers, send due scheduled campaigns, run re-engagement.
 */
export const runMarketingCampaignsCron = async (req: Request, res: Response) => {
  if (!isAuthorizedCron(req)) {
    return res.status(401).json({ success: false, msg: 'Unauthorized' });
  }

  try {
    const startedAt = Date.now();
    const sync = await syncSubscribersFromUsers();

    const due = await MarketingCampaign.find({
      status: 'scheduled',
      scheduledAt: { $lte: new Date() },
    })
      .select('_id')
      .limit(10)
      .lean();

    const scheduledResults: Array<{ id: string; ok: boolean; error?: string }> = [];
    for (const row of due) {
      const result = await sendMarketingCampaign(String(row._id), { forceNow: true });
      scheduledResults.push({
        id: String(row._id),
        ok: result.ok,
        error: result.ok ? undefined : result.error,
      });
    }

    const reengagement = await runReengagementSweep();
    const durationMs = Date.now() - startedAt;

    console.log('[Cron] Marketing campaigns completed', {
      durationMs,
      sync,
      scheduledCount: scheduledResults.length,
      reengagement,
    });

    return res.json({
      success: true,
      data: { sync, scheduledResults, reengagement, durationMs },
    });
  } catch (error: unknown) {
    console.error('[Cron] Marketing campaigns failed:', error);
    return res.status(500).json({ success: false, msg: 'Marketing campaigns cron failed' });
  }
};
