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

const previousCalendarMonthUtc = (): { from: Date; to: Date } => {
  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1, 0, 0, 0, 0));
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0, 23, 59, 59, 999));
  return { from, to };
};

type KpiMonthlyReportResult = {
  sent: number;
  failed: number;
  skipped?: boolean;
  reason?: string;
  errors?: string[];
  range?: { from: string; to: string };
  reportUrl?: string;
  durationMs: number;
};

type AdminRecipient = { _id?: unknown; email?: string | null };

function kpiReportEmailOverride(): string[] {
  return (process.env.KPI_REPORT_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

function recipientsFromEmailOverride(): AdminRecipient[] {
  return kpiReportEmailOverride().map((email) => ({ email }));
}

async function notifyKpiFailure(
  recipients: AdminRecipient[],
  from: Date,
  to: Date,
  message: string
): Promise<void> {
  const notifyList = recipients.length > 0 ? recipients : recipientsFromEmailOverride();
  if (notifyList.length === 0) {
    console.error('[Cron] KPI failure with no recipients and no KPI_REPORT_EMAILS fallback');
    return;
  }

  try {
    const { sendKpiReportEmail } = await import('../../utils/emailService');
    for (const admin of notifyList) {
      if (!admin.email) continue;
      try {
        await sendKpiReportEmail(String(admin.email), { from, to, error: message });
      } catch (notifyErr) {
        console.error(
          '[Cron] Failed to send KPI failure email to admin',
          admin._id ? String(admin._id) : '[override-recipient]',
          notifyErr
        );
      }
    }
  } catch (notifySetupErr) {
    console.error('[Cron] Failed to load KPI failure mailer', notifySetupErr);
  }
}

/**
 * Core monthly KPI PDF email job (previous UTC calendar month).
 * Kept callable from the daily Vercel cron (Hobby = 1 cron) and the manual HTTP route.
 */
async function executeKpiMonthlyReport(): Promise<KpiMonthlyReportResult> {
  const { from, to } = previousCalendarMonthUtc();
  const startedAt = Date.now();
  let recipients: AdminRecipient[] = [];

  try {
    const override = kpiReportEmailOverride();

    const admins = await User.find({ role: 'admin' })
      .select('_id email adminRole')
      .lean();

    // KPI_REPORT_EMAILS is authoritative when set — include addresses even if not in admin collection.
    if (override.length > 0) {
      const byEmail = new Map<string, AdminRecipient>();
      for (const admin of admins) {
        const email = typeof admin.email === 'string' ? admin.email.trim().toLowerCase() : '';
        if (email) byEmail.set(email, { _id: admin._id, email });
      }
      recipients = override.map((email) => byEmail.get(email) || { email });
    } else {
      recipients = admins.filter((admin: any) => {
        const email = typeof admin.email === 'string' ? admin.email.trim().toLowerCase() : '';
        if (!email) return false;
        const role = resolveAdminRole(admin.adminRole);
        return hasPermission(role, 'kpi.read');
      });
    }

    if (recipients.length === 0) {
      return {
        sent: 0,
        failed: 0,
        skipped: true,
        reason: 'no_recipients',
        durationMs: Date.now() - startedAt,
      };
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
    return {
      sent,
      failed,
      errors,
      range: { from: from.toISOString(), to: to.toISOString() },
      reportUrl,
      durationMs,
    };
  } catch (error: unknown) {
    console.error('[Cron] Monthly KPI report failed:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    await notifyKpiFailure(recipients, from, to, message);
    throw error;
  }
}

async function maybeRunDay1KpiMonthly(): Promise<
  KpiMonthlyReportResult | { error: string } | undefined
> {
  if (new Date().getUTCDate() !== 1) return undefined;
  try {
    return await executeKpiMonthlyReport();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Monthly KPI report failed';
    console.error('[Cron] Piggybacked monthly KPI report failed:', error);
    return { error: message };
  }
}

/**
 * Vercel Cron entrypoint (Hobby allows only one cron).
 * Runs daily notification reminders; on the 1st UTC also sends the monthly KPI report.
 * KPI is attempted even if reminders fail so the monthly job is not blocked.
 * Secured via Authorization: Bearer ${CRON_SECRET}.
 */
export const runNotificationRemindersCron = async (req: Request, res: Response) => {
  if (!isAuthorizedCron(req)) {
    return res.status(401).json({ success: false, msg: 'Unauthorized' });
  }

  let reminders:
    | Awaited<ReturnType<typeof runNotificationReminders>>
    | undefined;
  let remindersError: string | undefined;
  const startedAt = Date.now();

  try {
    reminders = await runNotificationReminders();
    console.log('[Cron] Notification reminders completed', {
      durationMs: Date.now() - startedAt,
      unreadChat: reminders.unreadChat,
      errorCount: reminders.errors.length,
    });
  } catch (error: unknown) {
    remindersError = error instanceof Error ? error.message : 'Notification reminders failed';
    console.error('[Cron] Notification reminders failed:', error);
  }

  // Day-1 KPI must not depend on reminders succeeding (only scheduled Hobby trigger).
  const kpiMonthly = await maybeRunDay1KpiMonthly();
  const durationMs = Date.now() - startedAt;

  if (remindersError) {
    return res.status(500).json({
      success: false,
      msg: 'Notification reminders failed',
      data: {
        durationMs,
        error: remindersError,
        ...(kpiMonthly ? { kpiMonthly } : {}),
      },
    });
  }

  return res.json({
    success: true,
    data: { ...reminders!, durationMs, ...(kpiMonthly ? { kpiMonthly } : {}) },
  });
};

/**
 * Manual / alternate HTTP entrypoint for the monthly KPI report.
 * Not registered as a separate Vercel cron (Hobby limit = 1).
 * Secured via Authorization: Bearer ${CRON_SECRET}.
 */
export const runKpiMonthlyReportCron = async (req: Request, res: Response) => {
  if (!isAuthorizedCron(req)) {
    return res.status(401).json({ success: false, msg: 'Unauthorized' });
  }

  try {
    const data = await executeKpiMonthlyReport();
    return res.json({ success: true, data });
  } catch {
    return res.status(500).json({ success: false, msg: 'Monthly KPI report failed' });
  }
};
