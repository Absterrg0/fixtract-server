import MarketingCampaign, {
  type IMarketingCampaign,
  type MarketingLocale,
  MARKETING_LOCALES,
} from '../../models/marketingCampaign';
import MarketingSubscriber from '../../models/marketingSubscriber';
import { getFrontendUrl } from '../frontendUrl';
import { resolveCampaignAudience } from './audience';
import {
  createAndSendBrevoCampaign,
  createCampaignList,
  fetchBrevoCampaignStats,
  isBrevoMarketingConfigured,
  isMarketingDryRun,
  syncContactsToList,
} from './brevoMarketing';
import { signUnsubscribePayload } from './unsubscribeToken';

function contentForLocale(campaign: IMarketingCampaign, locale: MarketingLocale) {
  const content = campaign.content as any;
  return content?.[locale] || null;
}

function localesToSend(campaign: IMarketingCampaign): MarketingLocale[] {
  const requested = (campaign.audience?.locales || []) as MarketingLocale[];
  const available = MARKETING_LOCALES.filter((l) => {
    const c = contentForLocale(campaign, l);
    return c && c.subject && (c.htmlContent || c.brevoTemplateId);
  });
  if (requested.length === 0) return available;
  return available.filter((l) => requested.includes(l));
}

function injectUnsubscribeLink(html: string, email: string): string {
  // For list sends we can't personalize per-recipient HTML easily via createEmailCampaign htmlContent.
  // We inject a generic preferences + tokenized unsubscribe landing that verifies via query.
  // Per-recipient tokens are still useful when we append a footer note using Brevo params later.
  void email;
  const base = getFrontendUrl();
  const unsubUrl = `${base}/unsubscribe`;
  const prefsUrl = `${base}/profile?tab=notifications`;
  if (html.includes('{{unsubscribe}}') || html.includes('__UNSUBSCRIBE_URL__')) {
    return html
      .replace(/\{\{unsubscribe\}\}/g, unsubUrl)
      .replace(/__UNSUBSCRIBE_URL__/g, unsubUrl);
  }
  return `${html}
<div style="margin-top:32px;padding-top:16px;border-top:1px solid #e5e7eb;font-size:12px;color:#6b7280;text-align:center;">
  <p style="margin:0 0 8px 0;">You received this because you opted in to Fixtract promotions.</p>
  <p style="margin:0;">
    <a href="${unsubUrl}" style="color:#6b7280;text-decoration:underline;">Unsubscribe</a>
    &nbsp;·&nbsp;
    <a href="${prefsUrl}" style="color:#6b7280;text-decoration:underline;">Notification preferences</a>
  </p>
</div>`;
}

/** Append a one-click signed unsubscribe for single-recipient dry-run / future personalization. */
export function personalizedUnsubscribeFooter(email: string): string {
  const token = signUnsubscribePayload(email);
  const url = `${getFrontendUrl()}/unsubscribe?token=${encodeURIComponent(token)}`;
  return `<p style="font-size:12px;color:#6b7280;text-align:center;"><a href="${url}">Unsubscribe</a></p>`;
}

export async function sendMarketingCampaign(
  campaignId: string,
  opts?: { forceNow?: boolean },
): Promise<{ ok: true; campaign: IMarketingCampaign } | { ok: false; error: string }> {
  const campaign = await MarketingCampaign.findById(campaignId);
  if (!campaign) return { ok: false, error: 'Campaign not found' };

  if (!['draft', 'scheduled', 'failed'].includes(campaign.status)) {
    return { ok: false, error: `Cannot send campaign in status ${campaign.status}` };
  }

  if (!opts?.forceNow && campaign.scheduledAt && campaign.scheduledAt.getTime() > Date.now() + 60_000) {
    campaign.status = 'scheduled';
    await campaign.save();
    return { ok: true, campaign };
  }

  const locales = localesToSend(campaign);
  if (locales.length === 0) {
    return { ok: false, error: 'Add at least one locale with subject and HTML (or Brevo template id)' };
  }

  if (!isBrevoMarketingConfigured() && !isMarketingDryRun()) {
    return { ok: false, error: 'BREVO_API_KEY is not configured' };
  }

  campaign.status = 'sending';
  campaign.lastError = undefined;
  campaign.deliveries = [];
  await campaign.save();

  const members = await resolveCampaignAudience(campaign.audience, {
    inactiveDays: campaign.type === 'reengagement' ? campaign.inactiveDays : undefined,
  });

  if (members.length === 0) {
    campaign.status = 'failed';
    campaign.lastError = 'Audience is empty — sync subscribers and check filters';
    await campaign.save();
    return { ok: false, error: campaign.lastError };
  }

  const stamp = Date.now().toString(36);
  const deliveries: IMarketingCampaign['deliveries'] = [];

  try {
    for (const locale of locales) {
      const content = contentForLocale(campaign, locale);
      if (!content) continue;

      const localeMembers = members.filter((m) => m.locale === locale);
      // Fallback: if no one has this locale, only send en to unmatched when locale===en
      const recipients =
        localeMembers.length > 0
          ? localeMembers
          : locale === 'en'
            ? members.filter((m) => !locales.includes(m.locale) || m.locale === 'en')
            : [];

      if (recipients.length === 0) {
        deliveries.push({
          locale,
          recipientCount: 0,
          error: 'No recipients for locale',
        });
        continue;
      }

      if (isMarketingDryRun()) {
        deliveries.push({
          locale,
          recipientCount: recipients.length,
          stats: {
            sent: recipients.length,
            delivered: 0,
            uniqueViews: 0,
            uniqueClicks: 0,
            unsubscriptions: 0,
            softBounces: 0,
            hardBounces: 0,
          },
        });
        continue;
      }

      const listName = `fx-${campaign.type}-${locale}-${stamp}`.slice(0, 100);
      const listId = await createCampaignList(listName);
      await syncContactsToList(
        listId,
        recipients.map((r) => ({
          email: r.email,
          attributes: {
            REGION: r.region || '',
            LOCALE: r.locale,
            FIRSTNAME: r.name || '',
          },
        })),
      );

      const html = injectUnsubscribeLink(content.htmlContent, '');
      const { campaignId: brevoCampaignId } = await createAndSendBrevoCampaign({
        name: `${campaign.name} [${locale}]`,
        subject: content.subject,
        htmlContent: html,
        previewText: content.previewText,
        listId,
        templateId: content.brevoTemplateId,
        scheduledAt: opts?.forceNow ? null : campaign.scheduledAt,
        utmCampaign: campaign.utmCampaign || `fixtract_${campaign.type}_${campaign._id}`,
      });

      deliveries.push({
        locale,
        brevoListId: listId,
        brevoCampaignId,
        recipientCount: recipients.length,
      });

      const ids = recipients.map((r) => r.subscriberId).filter(Boolean);
      if (ids.length > 0) {
        await MarketingSubscriber.updateMany(
          { _id: { $in: ids } },
          { $set: { lastCampaignSentAt: new Date() } },
        );
      }
    }

    campaign.deliveries = deliveries;
    campaign.status = 'sent';
    campaign.sentAt = new Date();
    await campaign.save();
    return { ok: true, campaign };
  } catch (err: any) {
    campaign.deliveries = deliveries;
    campaign.status = 'failed';
    campaign.lastError = err?.message || String(err);
    await campaign.save();
    return { ok: false, error: campaign.lastError || 'Send failed' };
  }
}

export async function refreshCampaignStats(campaignId: string): Promise<IMarketingCampaign | null> {
  const campaign = await MarketingCampaign.findById(campaignId);
  if (!campaign) return null;
  if (isMarketingDryRun()) return campaign;

  for (const delivery of campaign.deliveries) {
    if (!delivery.brevoCampaignId) continue;
    try {
      const stats = await fetchBrevoCampaignStats(delivery.brevoCampaignId);
      delivery.stats = {
        sent: stats.sent,
        delivered: stats.delivered,
        uniqueViews: stats.uniqueViews,
        uniqueClicks: stats.uniqueClicks,
        unsubscriptions: stats.unsubscriptions,
        softBounces: stats.softBounces,
        hardBounces: stats.hardBounces,
      };
    } catch (err: any) {
      delivery.error = err?.message || 'Failed to refresh stats';
    }
  }
  campaign.markModified('deliveries');
  await campaign.save();
  return campaign;
}

/** Daily re-engagement: send the newest autoSend reengagement campaign that is draft/scheduled. */
export async function runReengagementSweep(): Promise<{
  attempted: boolean;
  campaignId?: string;
  error?: string;
  recipientHint?: number;
}> {
  const campaign = await MarketingCampaign.findOne({
    type: 'reengagement',
    autoSend: true,
    status: { $in: ['draft', 'scheduled'] },
  }).sort({ updatedAt: -1 });

  if (!campaign) return { attempted: false };

  const result = await sendMarketingCampaign(String(campaign._id), { forceNow: true });
  if (!result.ok) {
    return { attempted: true, campaignId: String(campaign._id), error: result.error };
  }
  const total = result.campaign.deliveries.reduce((n, d) => n + (d.recipientCount || 0), 0);
  return { attempted: true, campaignId: String(campaign._id), recipientHint: total };
}
