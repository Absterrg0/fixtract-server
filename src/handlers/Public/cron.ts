import { Request, Response } from 'express';
import User from '../../models/user';
import { runNotificationReminders } from '../../utils/notifications/runNotificationReminders';
import { hasPermission, resolveAdminRole } from '../../utils/adminRbac/rolePermissions';

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

const previousCalendarMonthUtc = (): { from: Date; to: Date } => {
  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1, 0, 0, 0, 0));
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0, 23, 59, 59, 999));
  return { from, to };
};

/**
 * Monthly KPI PDF email to admins with kpi.read (or KPI_REPORT_EMAILS override).
 * Secured via Authorization: Bearer ${CRON_SECRET}.
 */
export const runKpiMonthlyReportCron = async (req: Request, res: Response) => {
  if (!isAuthorizedCron(req)) {
    return res.status(401).json({ success: false, msg: 'Unauthorized' });
  }

  const { from, to } = previousCalendarMonthUtc();
  let recipients: Array<{ email?: string | null }> = [];

  try {
    const startedAt = Date.now();

    const override = (process.env.KPI_REPORT_EMAILS || '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);

    const admins = await User.find({ role: 'admin' })
      .select('_id email adminRole')
      .lean();

    recipients = admins.filter((admin: any) => {
      const email = typeof admin.email === 'string' ? admin.email.trim().toLowerCase() : '';
      if (!email) return false;
      if (override.length > 0) return override.includes(email);
      const role = resolveAdminRole(admin.adminRole);
      return hasPermission(role, 'kpi.read');
    });

    if (recipients.length === 0) {
      return res.json({
        success: true,
        data: { sent: 0, failed: 0, skipped: true, reason: 'no_recipients', durationMs: Date.now() - startedAt },
      });
    }

    const { generateKpiPdf } = await import('../../utils/kpiReport');
    const { sendKpiReportEmail } = await import('../../utils/emailService');
    const { uploadBufferToS3 } = await import('../../utils/s3Upload');

    const buffer = await generateKpiPdf(from, to);
    const key = `kpi-reports/monthly/${from.toISOString().slice(0, 7)}.pdf`;
    const reportUrl = await uploadBufferToS3(buffer, key, 'application/pdf');

    let sent = 0;
    let failed = 0;
    const errors: string[] = [];
    for (const admin of recipients) {
      try {
        await sendKpiReportEmail(String(admin.email), { from, to, reportUrl });
        sent += 1;
      } catch (err: any) {
        failed += 1;
        errors.push(`${admin.email}: ${err?.message || 'send failed'}`);
      }
    }

    const durationMs = Date.now() - startedAt;
    console.log('[Cron] Monthly KPI report completed', { sent, failed, durationMs, range: { from, to } });
    return res.json({
      success: true,
      data: {
        sent,
        failed,
        errors,
        range: { from: from.toISOString(), to: to.toISOString() },
        reportUrl,
        durationMs,
      },
    });
  } catch (error: unknown) {
    console.error('[Cron] Monthly KPI report failed:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    try {
      const { sendKpiReportEmail } = await import('../../utils/emailService');
      for (const admin of recipients) {
        if (!admin.email) continue;
        try {
          await sendKpiReportEmail(String(admin.email), { from, to, error: message });
        } catch (notifyErr) {
          console.error('[Cron] Failed to send KPI failure email to', admin.email, notifyErr);
        }
      }
    } catch (notifySetupErr) {
      console.error('[Cron] Failed to load KPI failure mailer', notifySetupErr);
    }
    return res.status(500).json({ success: false, msg: 'Monthly KPI report failed' });
  }
};
