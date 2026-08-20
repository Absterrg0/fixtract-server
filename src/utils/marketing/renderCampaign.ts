import { getFrontendUrl } from '../frontendUrl';
import { defaultMarketingLocaleForCountry, type MarketingLocale } from './marketingCatalog';

export type CampaignRenderContent = {
  subject: string;
  htmlContent: string;
  previewText?: string;
  brevoTemplateId?: number;
};

const GENERIC_GREETING: Record<MarketingLocale, string> = {
  en: 'Hi there,',
  nl: 'Hallo,',
  fr: 'Bonjour,',
  de: 'Hallo,',
};

const UNSUBSCRIBE_COPY: Record<MarketingLocale, { optedIn: string; unsubscribe: string; preferences: string }> = {
  en: { optedIn: 'You received this because you opted in to Fixtract promotions.', unsubscribe: 'Unsubscribe', preferences: 'Notification preferences' },
  nl: { optedIn: 'Je ontvangt dit omdat je je hebt ingeschreven voor Fixtract-promoties.', unsubscribe: 'Uitschrijven', preferences: 'Meldingsvoorkeuren' },
  fr: { optedIn: 'Vous recevez cet e-mail parce que vous avez accepté les promotions Fixtract.', unsubscribe: 'Se désabonner', preferences: 'Préférences de notification' },
  de: { optedIn: 'Sie erhalten diese E-Mail, weil Sie Fixtract-Werbung abonniert haben.', unsubscribe: 'Abmelden', preferences: 'Benachrichtigungseinstellungen' },
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

export function resolveGreeting(firstName: unknown, locale: MarketingLocale): string {
  if (firstName === '{{ contact.FIRSTNAME }}') {
    const prefix = locale === 'nl' ? 'Hallo' : locale === 'fr' ? 'Bonjour' : 'Hi';
    return `${prefix} {{ contact.FIRSTNAME }},`;
  }
  const name = typeof firstName === 'string' ? firstName.trim().split(/\s+/)[0] : '';
  if (!name) return GENERIC_GREETING[locale] || GENERIC_GREETING.en;
  const prefix = locale === 'nl' || locale === 'de' ? 'Hallo' : locale === 'fr' ? 'Bonjour' : 'Hi';
  return `${prefix} ${escapeHtml(name)},`;
}

export function renderMarketingFooter(locale: MarketingLocale, unsubscribeToken = '{{ contact.UNSUB_TOKEN }}'): string {
  const copy = UNSUBSCRIBE_COPY[locale] || UNSUBSCRIBE_COPY.en;
  const base = getFrontendUrl();
  const unsubUrl = `${base}/unsubscribe?token=${unsubscribeToken}`;
  const prefsUrl = `${base}/profile?tab=notifications`;
  return `<div data-fixera-marketing-footer="true" style="margin-top:32px;padding-top:16px;border-top:1px solid #e5e7eb;font-size:12px;color:#6b7280;text-align:center;">` +
    `<p style="margin:0 0 8px 0;">${copy.optedIn}</p><p style="margin:0;">` +
    `<a href="${escapeHtml(unsubUrl)}" style="color:#6b7280;text-decoration:underline;">${copy.unsubscribe}</a>` +
    ` &nbsp;·&nbsp; <a href="${escapeHtml(prefsUrl)}" style="color:#6b7280;text-decoration:underline;">${copy.preferences}</a></p></div>`;
}

export function renderMarketingEmail(input: {
  content: CampaignRenderContent;
  locale?: MarketingLocale;
  firstName?: string;
  country?: string;
  unsubscribeToken?: string;
}): { subject: string; previewText?: string; htmlContent: string } {
  const locale = input.locale || defaultMarketingLocaleForCountry(input.country);
  const body = input.content.htmlContent || '';
  const greeting = `<p>${resolveGreeting(input.firstName, locale)}</p>`;
  return {
    subject: input.content.subject,
    previewText: input.content.previewText,
    htmlContent: `${greeting}${body}${renderMarketingFooter(locale, input.unsubscribeToken)}`,
  };
}

export function assertInlineMarketingContent(content: CampaignRenderContent): void {
  if (content.brevoTemplateId && (!content.htmlContent || content.htmlContent.trim().length <= 10)) {
    throw new Error('Test sends require inline HTML content so the greeting and footer can be verified');
  }
  if (!content.subject?.trim() || !content.htmlContent?.trim()) {
    throw new Error('Campaign content requires a subject and HTML body');
  }
}
