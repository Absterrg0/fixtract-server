import { Request, Response } from 'express';
import User from '../../models/user';
import CronJobLock from '../../models/cronJobLock';
import { runNotificationReminders } from '../../utils/notifications/runNotificationReminders';
import { hasPermission, resolveAdminRole } from '../../utils/adminRbac/rolePermissions';
import { syncPendingBrevoUnsubscribes, syncSubscribersFromUsers } from '../../utils/marketing/audience';
import {
  MARKETING_SEND_LEASE_MS,
  runReengagementSweep,
  sendMarketingCampaign,
} from '../../utils/marketing/sendCampaign';
import MarketingCampaign from '../../models/marketingCampaign';
import { randomUUID } from 'node:crypto';
import { generateKpiPdf } from '../../utils/kpiReport';
import { sendKpiReportEmail } from '../../utils/emailService';
import { uploadBufferToS3 } from '../../utils/s3Upload';

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
const KPI_LOCK_LEASE_MS = 30 * 60 * 1000;
class KpiLockLostError extends Error {}

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
async function executeKpiMonthlyReport(
  lock?: { key: string; claimId: string; sentRecipients: Set<string> },
): Promise<KpiMonthlyReportResult> {
  const { from, to } = previousCalendarMonthUtc();
  const startedAt = Date.now();
  let recipients: AdminRecipient[] = [];

  try {
    const override = kpiReportEmailOverride();

    const admins = await User.find({
      role: 'admin',
      deletedAt: { $exists: false },
      accountStatus: { $nin: ['suspended', 'rejected'] },
    })
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

    const buffer = await generateKpiPdf(from, to);
    const key = `kpi-reports/monthly/${from.toISOString().slice(0, 7)}.pdf`;
    const reportUrl = await uploadBufferToS3(buffer, key, 'application/pdf');

    let sent = 0;
    let failed = 0;
    const errors: string[] = [];
    for (const admin of recipients) {
      const email = String(admin.email).trim().toLowerCase();
      if (lock?.sentRecipients.has(email)) continue;
      try {
        const delivered = await sendKpiReportEmail(email, { from, to, reportUrl });
        if (!delivered) throw new Error('email provider rejected delivery');
        sent += 1;
        if (lock) {
          lock.sentRecipients.add(email);
          const checkpoint = await CronJobLock.updateOne(
            { key: lock.key, claimId: lock.claimId, completedAt: { $exists: false } },
            { $addToSet: { sentRecipients: email } },
          );
          if (checkpoint.matchedCount !== 1) {
            throw new KpiLockLostError('KPI lock ownership was lost');
          }
        }
      } catch (err: any) {
        if (err instanceof KpiLockLostError) throw err;
        failed += 1;
        errors.push(`${email}: ${err?.message || 'send failed'}`);
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

async function maybeRunKpiMonthly(): Promise<
  KpiMonthlyReportResult | { error: string; skipped?: boolean; reason?: string } | undefined
> {
  const monthKey = previousCalendarMonthUtc().from.toISOString().slice(0, 7);
  const lockKey = `kpi_monthly:${monthKey}`;
  const staleBefore = new Date(Date.now() - KPI_LOCK_LEASE_MS);
  const claimId = randomUUID();
  let lock: { sentRecipients?: string[]; claimId?: string } | null = null;

  try {
    lock = await CronJobLock.findOneAndUpdate(
      {
        key: lockKey,
        completedAt: { $exists: false },
        $or: [
          { claimedAt: { $lte: staleBefore } },
          { claimedAt: { $exists: false } },
        ],
      },
      {
        $set: { claimedAt: new Date(), claimId },
        $setOnInsert: { key: lockKey, sentRecipients: [] },
      },
      { upsert: true, new: true },
    ).lean();
  } catch (error: unknown) {
    const code =
      error && typeof error === 'object' && 'code' in error
        ? (error as { code?: number | string }).code
        : undefined;
    if (code === 11000 || code === '11000') {
      const existing = await CronJobLock.findOne({ key: lockKey })
        .select('completedAt')
        .lean();
      const reason = existing?.completedAt ? 'already_ran' : 'already_claimed';
      console.log(`[Cron] Monthly KPI ${reason} for`, monthKey);
      return { skipped: true, reason, sent: 0, failed: 0, durationMs: 0 };
    }
    throw error;
  }

  if (!lock) {
    return { skipped: true, reason: 'already_claimed', sent: 0, failed: 0, durationMs: 0 };
  }

  try {
    const result = await executeKpiMonthlyReport({
      key: lockKey,
      claimId,
      sentRecipients: new Set(lock.sentRecipients || []),
    });
    if (result.failed === 0) {
      await CronJobLock.updateOne(
        { key: lockKey, claimId },
        { $set: { completedAt: new Date() } },
      );
    } else {
      await CronJobLock.updateOne(
        { key: lockKey, claimId, completedAt: { $exists: false } },
        { $set: { claimedAt: new Date(0) } },
      );
    }
    return result;
  } catch (error: unknown) {
    try {
      await CronJobLock.updateOne(
        { key: lockKey, claimId, completedAt: { $exists: false } },
        { $set: { claimedAt: new Date(0) } },
      );
    } catch (unlockErr) {
      console.error('[Cron] Failed to release KPI monthly lock', unlockErr);
    }
    const message = error instanceof Error ? error.message : 'Monthly KPI report failed';
    console.error('[Cron] Piggybacked monthly KPI report failed:', error);
    return { error: message };
  }
}

/**
 * Vercel Cron entrypoint (Hobby allows only one cron).
 * Runs daily notification reminders, then marketing campaigns;
 * on the 1st UTC also sends the monthly KPI report.
 * KPI + marketing are attempted even if reminders fail so they are not blocked.
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

  // The completed lock makes this cheap after success and allows retries on later days.
  const kpiMonthly = await maybeRunKpiMonthly();

  let marketing:
    | Awaited<ReturnType<typeof executeMarketingCampaignsDaily>>
    | { error: string }
    | undefined;
  try {
    marketing = await executeMarketingCampaignsDaily();
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : 'Marketing campaigns cron failed';
    console.error('[Cron] Piggybacked marketing campaigns failed:', error);
    marketing = { error: message };
  }

  const durationMs = Date.now() - startedAt;

  const kpiError =
    kpiMonthly &&
    ('error' in kpiMonthly || (!kpiMonthly.skipped && kpiMonthly.failed > 0));
  const marketingError =
    marketing &&
    ('error' in marketing ||
      marketing.scheduledResults.some((result) => !result.ok) ||
      Boolean(marketing.reengagement.error));

  if (remindersError || kpiError || marketingError) {
    return res.status(500).json({
      success: false,
      msg: 'One or more scheduled jobs failed',
      data: {
        durationMs,
        error: remindersError,
        ...(kpiMonthly ? { kpiMonthly } : {}),
        ...(marketing ? { marketing } : {}),
      },
    });
  }

  return res.json({
    success: true,
    data: {
      ...reminders!,
      durationMs,
      ...(kpiMonthly ? { kpiMonthly } : {}),
      ...(marketing ? { marketing } : {}),
    },
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
    const data = await maybeRunKpiMonthly();
    if (data && ('error' in data || (!data.skipped && data.failed > 0))) {
      return res.status(502).json({
        success: false,
        msg: 'Monthly KPI report email delivery failed',
        data,
      });
    }
    return res.json({ success: true, data });
  } catch (error: unknown) {
    return res.status(500).json({
      success: false,
      msg: 'Monthly KPI report failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

type MarketingCampaignsDailyResult = {
  sync: Awaited<ReturnType<typeof syncSubscribersFromUsers>> & {
    brevoUnsubscribes: Awaited<ReturnType<typeof syncPendingBrevoUnsubscribes>>;
  };
  scheduledResults: Array<{ id: string; ok: boolean; error?: string }>;
  reengagement: Awaited<ReturnType<typeof runReengagementSweep>>;
  durationMs: number;
};

/** Reconcile explicit consent before resolving any campaign audience. */
async function executeMarketingCampaignsDaily(): Promise<MarketingCampaignsDailyResult> {
  const startedAt = Date.now();
  const sync = await syncSubscribersFromUsers();
  const brevoUnsubscribes = await syncPendingBrevoUnsubscribes();
  const staleSendBefore = new Date(Date.now() - MARKETING_SEND_LEASE_MS);
  const claimableSend = {
    $or: [
      {
        status: 'scheduled',
        scheduledAt: { $lte: new Date() },
      },
      {
        status: 'sending',
        $or: [
          { sendStartedAt: { $lte: staleSendBefore } },
          { sendStartedAt: null },
          { sendStartedAt: { $exists: false } },
        ],
      },
    ],
  };

  const due = await MarketingCampaign.find(claimableSend)
    .select('_id')
    .limit(10)
    .lean();

  const scheduledResults: Array<{ id: string; ok: boolean; error?: string }> = [];
  for (const row of due) {
    const claimId = randomUUID();
    // Atomically claim scheduled → sending to prevent double-send races
    const claimed = await MarketingCampaign.findOneAndUpdate(
      {
        _id: row._id,
        ...claimableSend,
      },
      {
        $set: {
          status: 'sending',
          sendClaimId: claimId,
          sendStartedAt: new Date(),
        },
        $unset: { lastError: 1 },
      },
      { new: true },
    );
    if (!claimed) {
      scheduledResults.push({
        id: String(row._id),
        ok: false,
        error: 'skipped: claim failed (already claimed or status changed)',
      });
      continue;
    }

    const result = await sendMarketingCampaign(String(row._id), {
      forceNow: true,
      claimId,
    });
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

  return { sync: { ...sync, brevoUnsubscribes }, scheduledResults, reengagement, durationMs };
}

/**
 * Manual / alternate HTTP entrypoint for marketing campaigns.
 * Not registered as a separate Vercel cron (Hobby limit = 1; piggybacked daily).
 * Secured via Authorization: Bearer ${CRON_SECRET}.
 */
export const runMarketingCampaignsCron = async (req: Request, res: Response) => {
  if (!isAuthorizedCron(req)) {
    return res.status(401).json({ success: false, msg: 'Unauthorized' });
  }

  try {
    const data = await executeMarketingCampaignsDaily();
    return res.json({ success: true, data });
  } catch (error: unknown) {
    console.error('[Cron] Marketing campaigns failed:', error);
    return res.status(500).json({ success: false, msg: 'Marketing campaigns cron failed' });
  }
};
