import MarketingLead from '../../models/marketingLead';
import MarketingSubscriber, { type MarketingLocale } from '../../models/marketingSubscriber';
import MarketingSuppression from '../../models/marketingSuppression';
import {
  MARKETING_AUDIENCE_TYPES,
  type MarketingAudienceType,
  type MarketingCampaignType,
  type ICampaignAudience,
} from '../../models/marketingCampaign';
import { MARKETING_AUDIENCE_LIMIT } from './audience';
import { isValidEmail, normalizeEmail } from './normalizeEmail';
import {
  MARKETING_LOCALES,
  defaultMarketingLocaleForCountry,
  normalizeMarketingLocale,
} from './marketingCatalog';

export type ResolvedMarketingRecipient = {
  email: string;
  firstName?: string;
  locale: MarketingLocale;
  country?: string;
  serviceKeys: string[];
  role?: 'customer' | 'professional';
  source: 'subscriber' | 'lead';
  subscriberId?: string;
  leadId?: string;
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

export function isLeadOutreachEnabled(): boolean {
  return process.env.MARKETING_LEAD_OUTREACH_ENABLED === 'true'
    && process.env.MARKETING_LEAD_LEGAL_APPROVED === 'true';
}

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

function inactiveClauses(inactiveDays?: number): Record<string, unknown>[] {
  if (!inactiveDays || inactiveDays <= 0) return [];
  const cutoff = new Date(Date.now() - inactiveDays * 24 * 60 * 60 * 1000);
  return [
    { subscribedAt: { $lte: cutoff } },
    { $or: [{ lastEngagedAt: { $lte: cutoff } }, { lastEngagedAt: null }, { lastEngagedAt: { $exists: false } }] },
  ];
}

function subscriberQuery(filters: ICampaignAudience, inactiveDays?: number): Record<string, unknown> {
  const normalized = canonicalFilters(filters);
  const clauses: Record<string, unknown>[] = [
    { unsubscribedAt: null },
    { consentVerifiedAt: { $type: 'date' } },
    { brevoUnsubscribedAt: null },
  ];
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
  if (roles.length === 1) {
    clauses.push({ $or: [{ role: roles[0] }, ...(roles[0] === 'customer' ? [{ role: null }, { role: { $exists: false } }] : [])] });
  }
  clauses.push(...inactiveClauses(inactiveDays));
  return { $and: clauses };
}

function leadQuery(filters: ICampaignAudience): Record<string, unknown> {
  const normalized = canonicalFilters(filters);
  const clauses: Record<string, unknown>[] = [{ status: 'active' }, { unsubscribedAt: null }];
  if (normalized.countries.length) clauses.push({ country: { $in: normalized.countries } });
  if (normalized.locales.length) clauses.push({ locale: { $in: normalized.locales } });
  if (normalized.serviceKeys.length) clauses.push({ serviceKeys: { $in: normalized.serviceKeys } });
  if (normalized.roles.length === 1 && normalized.roles[0] === 'customer') clauses.push({ _id: { $in: [] } });
  return { $and: clauses };
}

function firstNameForSubscriber(subscriber: any): string | undefined {
  if (typeof subscriber.firstName === 'string' && subscriber.firstName.trim()) return subscriber.firstName.trim();
  if (typeof subscriber.name === 'string' && subscriber.name.trim()) return subscriber.name.trim().split(/\s+/)[0];
  return undefined;
}

function firstNameForLead(lead: any): string | undefined {
  if (typeof lead.firstName === 'string' && lead.firstName.trim()) return lead.firstName.trim();
  return undefined;
}

function resolvedLocale(raw: unknown, country: unknown, contentLocales: Set<MarketingLocale>): { locale?: MarketingLocale; fallback: boolean } {
  const explicit = normalizeMarketingLocale(raw);
  const countryDefault = defaultMarketingLocaleForCountry(country);
  const candidate = explicit || countryDefault;
  if (contentLocales.has(candidate)) return { locale: candidate, fallback: !explicit };
  if (contentLocales.has('en')) return { locale: 'en', fallback: true };
  return { locale: undefined, fallback: true };
}

async function suppressedEmailSet(): Promise<Set<string>> {
  const [suppressionRows, unsubscribedRows] = await Promise.all([
    MarketingSuppression.find().select('emailNormalized').lean(),
    MarketingSubscriber.find({ unsubscribedAt: { $ne: null } }).select('emailNormalized email').lean(),
  ]);
  return new Set([
    ...suppressionRows.map((row) => normalizeEmail(row.emailNormalized)),
    ...unsubscribedRows.map((row) => normalizeEmail(row.emailNormalized || row.email)),
  ].filter(Boolean));
}

export async function resolveMarketingAudience(input: ResolveMarketingAudienceInput): Promise<MarketingAudienceResolution> {
  const audienceType = input.audienceType || 'subscribers';
  if (!(MARKETING_AUDIENCE_TYPES as readonly string[]).includes(audienceType)) throw new Error('Invalid audience type');
  if (audienceType !== 'subscribers') {
    if (input.campaignType !== 'invitation') throw new Error('Only invitation campaigns may target leads');
    if (!isLeadOutreachEnabled()) throw new Error('Lead outreach is not enabled or legally approved');
  }

  const filters = canonicalFilters(input.filters);
  const contentLocales = new Set(
    (input.contentLocales && input.contentLocales.length ? input.contentLocales : MARKETING_LOCALES)
      .map((locale) => normalizeMarketingLocale(locale))
      .filter((locale): locale is MarketingLocale => Boolean(locale)),
  );
  const [suppressed, subscribers, leads] = await Promise.all([
    suppressedEmailSet(),
    audienceType === 'leads' ? Promise.resolve([]) : MarketingSubscriber.find(subscriberQuery(input.filters, input.inactiveDays)).sort({ _id: 1 }).lean(),
    audienceType === 'subscribers' ? Promise.resolve([]) : MarketingLead.find(leadQuery(input.filters)).sort({ _id: 1 }).lean(),
  ]);

  const seen = new Set<string>();
  const recipients: ResolvedMarketingRecipient[] = [];
  const sourceCounts = { subscribers: 0, leads: 0 };
  let invalidEmail = 0;
  let missingLocale = 0;
  let suppressedCount = 0;
  let roleMismatch = 0;
  let deduplicated = 0;
  let fallbackLocaleCount = 0;

  const add = (row: any, source: 'subscriber' | 'lead') => {
    const email = normalizeEmail(row.emailNormalized || row.email);
    if (!isValidEmail(email)) {
      invalidEmail += 1;
      return;
    }
    if (suppressed.has(email) || row.unsubscribedAt) {
      suppressedCount += 1;
      return;
    }
    if (seen.has(email)) {
      deduplicated += 1;
      return;
    }
    const role = source === 'lead' ? 'professional' : row.role;
    const requestedRoles = filters.roles.length ? filters.roles : ['customer', 'professional'];
    if (role && !requestedRoles.includes(role)) {
      roleMismatch += 1;
      return;
    }
    const locale = resolvedLocale(row.locale, source === 'lead' ? row.country : row.region, contentLocales);
    if (!locale.locale) {
      missingLocale += 1;
      return;
    }
    seen.add(email);
    if (locale.fallback) fallbackLocaleCount += 1;
    sourceCounts[source === 'subscriber' ? 'subscribers' : 'leads'] += 1;
    recipients.push({
      email,
      firstName: source === 'subscriber' ? firstNameForSubscriber(row) : firstNameForLead(row),
      locale: locale.locale,
      country: source === 'lead' ? row.country : row.region,
      serviceKeys: Array.isArray(row.serviceKeys) && row.serviceKeys.length ? row.serviceKeys : (row.interestedServices || []),
      role,
      source,
      subscriberId: source === 'subscriber' ? String(row._id) : undefined,
      leadId: source === 'lead' ? String(row._id) : undefined,
      userId: source === 'subscriber' && row.userId ? String(row.userId) : undefined,
    });
  };

  for (const row of subscribers) add(row, 'subscriber');
  for (const row of leads) add(row, 'lead');

  const overLimit = recipients.length > MARKETING_AUDIENCE_LIMIT;
  const criteriaHash = hashCriteria({ campaignType: input.campaignType, audienceType, filters, contentLocales: [...contentLocales], inactiveDays: input.inactiveDays || null });
  return {
    recipients: input.limitMode === 'delivery' ? recipients.slice(0, MARKETING_AUDIENCE_LIMIT) : recipients,
    exactTotal: recipients.length,
    bySource: sourceCounts,
    deduplicated,
    excluded: { suppressed: suppressedCount, invalidEmail, missingLocale, roleMismatch },
    fallbackLocaleCount,
    overLimit,
    criteriaHash,
  };
}
