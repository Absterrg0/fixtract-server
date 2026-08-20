import MarketingSubscriber, { type MarketingLocale } from '../../models/marketingSubscriber';
import { MARKETING_AUDIENCE_TYPES, type MarketingAudienceType, type MarketingCampaignType, type ICampaignAudience } from '../../models/marketingCampaign';
import { MARKETING_AUDIENCE_LIMIT } from './audience';
import { normalizeEmail, isValidEmail } from './normalizeEmail';
import { MARKETING_LOCALES, normalizeMarketingLocale } from './marketingCatalog';

export type ResolvedMarketingRecipient = {
  email: string;
  firstName?: string;
  locale: MarketingLocale;
  country?: string;
  serviceKeys: string[];
  role?: 'customer' | 'professional';
  source: 'subscriber';
  subscriberId: string;
  userId?: string;
};

export type MarketingAudienceResolution = {
  recipients: ResolvedMarketingRecipient[];
  exactTotal: number;
  bySource: { subscribers: number; leads: number };
  deduplicated: number;
  excluded: {
    suppressed: number;
    invalidEmail: number;
    missingLocale: number;
    roleMismatch: number;
  };
  fallbackLocaleCount: number;
  overLimit: boolean;
  criteriaHash: string;
};

export type ResolveMarketingAudienceInput = {
  campaignType: MarketingCampaignType;
  audienceType?: MarketingAudienceType;
  filters: ICampaignAudience;
  contentLocales?: readonly string[];
  inactiveDays?: number;
  limitMode?: 'delivery' | 'preview';
};

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function canonicalFilters(filters: ICampaignAudience) {
  return {
    countries: [...(filters.countries || [])].map((v) => clean(v).toUpperCase()).filter(Boolean).sort(),
    interestedServices: [...(filters.interestedServices || [])].map(clean).filter(Boolean).sort(),
    serviceKeys: [...(filters.serviceKeys || [])].map(clean).filter(Boolean).sort(),
    locales: [...(filters.locales || [])].map((v) => clean(v).toLowerCase()).filter(Boolean).sort(),
    roles: [...(filters.roles || [])].sort(),
  };
}

function hashCriteria(value: unknown): string {
  const json = JSON.stringify(value);
  let hash = 2166136261;
  for (let i = 0; i < json.length; i += 1) {
    hash ^= json.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function audienceQuery(filters: ICampaignAudience, inactiveDays?: number): Record<string, unknown> {
  const clauses: Record<string, unknown>[] = [
    { unsubscribedAt: null },
    { consentVerifiedAt: { $type: 'date' } },
    { brevoUnsubscribedAt: null },
  ];
  const normalized = canonicalFilters(filters);
  if (normalized.countries.length) clauses.push({ region: { $in: normalized.countries } });
  if (normalized.locales.length) clauses.push({ locale: { $in: normalized.locales } });
  if (normalized.serviceKeys.length && normalized.interestedServices.length) {
    clauses.push({ $or: [{ serviceKeys: { $in: normalized.serviceKeys } }, { interestedServices: { $in: normalized.interestedServices } }] });
  } else if (normalized.serviceKeys.length) {
    clauses.push({ serviceKeys: { $in: normalized.serviceKeys } });
  } else if (normalized.interestedServices.length) {
    clauses.push({ interestedServices: { $in: normalized.interestedServices } });
  }
  const roles = normalized.roles.length ? normalized.roles : ['customer', 'professional'];
  if (roles.length === 1) clauses.push({ $or: [{ role: roles[0] }, ...(roles[0] === 'customer' ? [{ role: null }, { role: { $exists: false } }] : [])] });
  if (inactiveDays && inactiveDays > 0) {
    const cutoff = new Date(Date.now() - inactiveDays * 24 * 60 * 60 * 1000);
    clauses.push({ subscribedAt: { $lte: cutoff } });
    clauses.push({ $or: [{ lastEngagedAt: { $lte: cutoff } }, { lastEngagedAt: null }, { lastEngagedAt: { $exists: false } }] });
  }
  return { $and: clauses };
}

function firstNameForSubscriber(subscriber: any): string | undefined {
  if (typeof subscriber.firstName === 'string' && subscriber.firstName.trim()) return subscriber.firstName.trim();
  if (typeof subscriber.name === 'string' && subscriber.name.trim()) return subscriber.name.trim().split(/\s+/)[0];
  return undefined;
}

export async function resolveMarketingAudience(input: ResolveMarketingAudienceInput): Promise<MarketingAudienceResolution> {
  const audienceType = input.audienceType || 'subscribers';
  if (!(MARKETING_AUDIENCE_TYPES as readonly string[]).includes(audienceType)) {
    throw new Error('Invalid audience type');
  }
  if (audienceType !== 'subscribers') {
    throw new Error('Lead audiences are not available until lead outreach is enabled');
  }
  const filters = canonicalFilters(input.filters);
  const contentLocales = new Set((input.contentLocales || MARKETING_LOCALES).map((locale) => normalizeMarketingLocale(locale)).filter(Boolean));
  const query = audienceQuery(input.filters, input.inactiveDays);
  const exactTotal = await MarketingSubscriber.countDocuments(query);
  const limit = input.limitMode === 'delivery' ? MARKETING_AUDIENCE_LIMIT : Math.min(MARKETING_AUDIENCE_LIMIT, 10000);
  const rows = await MarketingSubscriber.find(query).sort({ _id: 1 }).limit(limit + 1).lean();
  const seen = new Set<string>();
  const recipients: ResolvedMarketingRecipient[] = [];
  let invalidEmail = 0;
  let missingLocale = 0;
  let deduplicated = 0;
  let fallbackLocaleCount = 0;
  for (const row of rows) {
    const email = normalizeEmail(row.emailNormalized || row.email);
    if (!isValidEmail(email)) {
      invalidEmail += 1;
      continue;
    }
    if (seen.has(email)) {
      deduplicated += 1;
      continue;
    }
    seen.add(email);
    const locale = normalizeMarketingLocale(row.locale) || 'en';
    if (!contentLocales.has(locale)) {
      if (contentLocales.has('en')) fallbackLocaleCount += 1;
      else {
        missingLocale += 1;
        continue;
      }
    }
    recipients.push({
      email,
      firstName: firstNameForSubscriber(row),
      locale: contentLocales.has(locale) ? locale : 'en',
      country: row.region || undefined,
      serviceKeys: Array.isArray(row.serviceKeys) && row.serviceKeys.length ? row.serviceKeys : (row.interestedServices || []),
      role: row.role,
      source: 'subscriber',
      subscriberId: String(row._id),
      userId: row.userId ? String(row.userId) : undefined,
    });
  }
  const overLimit = exactTotal > MARKETING_AUDIENCE_LIMIT;
  return {
    recipients: input.limitMode === 'delivery' ? recipients.slice(0, MARKETING_AUDIENCE_LIMIT) : recipients,
    exactTotal,
    bySource: { subscribers: exactTotal, leads: 0 },
    deduplicated,
    excluded: { suppressed: 0, invalidEmail, missingLocale, roleMismatch: 0 },
    fallbackLocaleCount,
    overLimit,
    criteriaHash: hashCriteria({ campaignType: input.campaignType, audienceType, filters, contentLocales: [...contentLocales], inactiveDays: input.inactiveDays || null }),
  };
}
