import MarketingSubscriber, { type MarketingLocale } from '../../models/marketingSubscriber';
import MarketingSuppression from '../../models/marketingSuppression';
import User from '../../models/user';
import {
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
  subscriberId?: string;
  userId?: string;
};

export type MarketingAudienceResolution = {
  recipients: ResolvedMarketingRecipient[];
  exactTotal: number;
  byLocale: Record<string, number>;
  byRole: { customer: number; professional: number };
  deduplicated: number;
  excluded: {
    suppressed: number;
    invalidEmail: number;
    missingLocale: number;
    roleMismatch: number;
    localeMismatch: number;
  };
  fallbackLocaleCount: number;
  overLimit: boolean;
  criteriaHash: string;
};

export type ResolveMarketingAudienceInput = {
  campaignType: MarketingCampaignType;
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

function firstNameForSubscriber(subscriber: any, user?: any): string | undefined {
  if (typeof subscriber.firstName === 'string' && subscriber.firstName.trim()) return subscriber.firstName.trim();
  if (typeof subscriber.name === 'string' && subscriber.name.trim()) return subscriber.name.trim().split(/\s+/)[0];
  if (typeof user?.name === 'string' && user.name.trim()) return user.name.trim().split(/\s+/)[0];
  return undefined;
}

function resolvedLocale(raw: unknown, country: unknown, contentLocales: Set<MarketingLocale>, userLocale?: unknown): { locale?: MarketingLocale; fallback: boolean } {
  const explicit = normalizeMarketingLocale(userLocale) || normalizeMarketingLocale(raw);
  const countryDefault = defaultMarketingLocaleForCountry(country);
  const candidate = explicit || countryDefault;
  if (contentLocales.has(candidate)) return { locale: candidate, fallback: !explicit };
  if (contentLocales.has('en')) return { locale: 'en', fallback: true };
  return { locale: undefined, fallback: true };
}

async function suppressedEmailSet(emails: string[]): Promise<Set<string>> {
  if (emails.length === 0) return new Set();
  const [suppressionRows, unsubscribedRows] = await Promise.all([
    MarketingSuppression.find({ emailNormalized: { $in: emails } }).select('emailNormalized').lean(),
    MarketingSubscriber.find({
      emailNormalized: { $in: emails },
      unsubscribedAt: { $ne: null },
    })
      .select('emailNormalized email')
      .lean(),
  ]);
  return new Set([
    ...suppressionRows.map((row) => normalizeEmail(row.emailNormalized)),
    ...unsubscribedRows.map((row) => normalizeEmail(row.emailNormalized || row.email)),
  ].filter(Boolean));
}

export async function resolveMarketingAudience(input: ResolveMarketingAudienceInput): Promise<MarketingAudienceResolution> {
  const filters = canonicalFilters(input.filters);
  const contentLocales = new Set(
    (input.contentLocales && input.contentLocales.length ? input.contentLocales : MARKETING_LOCALES)
      .map((locale) => normalizeMarketingLocale(locale))
      .filter((locale): locale is MarketingLocale => Boolean(locale)),
  );
  const query = subscriberQuery(input.filters, input.inactiveDays);
  const [subscribers, matchedSubscriberCount] = await Promise.all([
    MarketingSubscriber.find(query)
      .sort({ _id: 1 })
      .limit(MARKETING_AUDIENCE_LIMIT + 1)
      .lean(),
    MarketingSubscriber.countDocuments(query),
  ]);
  const candidateEmails = subscribers
    .map((row: any) => normalizeEmail(row.emailNormalized || row.email))
    .filter(Boolean);
  const suppressed = await suppressedEmailSet(candidateEmails);

  const userIds = subscribers.map((row: any) => row.userId).filter(Boolean);
  const users = userIds.length > 0
    ? await User.find({ _id: { $in: userIds } }).select('name marketingLocale').lean()
    : [];
  const usersById = new Map(users.map((user: any) => [String(user._id), user]));

  const seen = new Set<string>();
  const recipients: ResolvedMarketingRecipient[] = [];
  const byLocale: Record<string, number> = {};
  const byRole = { customer: 0, professional: 0 };
  let invalidEmail = 0;
  let missingLocale = 0;
  let suppressedCount = 0;
  let roleMismatch = 0;
  let localeMismatch = 0;
  let deduplicated = 0;
  let fallbackLocaleCount = 0;

  const add = (row: any) => {
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
    const user = row.userId ? usersById.get(String(row.userId)) : undefined;
    const role = row.role as 'customer' | 'professional' | undefined;
    const requestedRoles = filters.roles.length ? filters.roles : ['customer', 'professional'];
    if (role && !requestedRoles.includes(role)) {
      roleMismatch += 1;
      return;
    }
    const locale = resolvedLocale(
      row.locale,
      row.region,
      contentLocales,
      user?.marketingLocale,
    );
    if (!locale.locale) {
      missingLocale += 1;
      return;
    }
    if (filters.locales.length > 0 && !filters.locales.includes(locale.locale)) {
      localeMismatch += 1;
      return;
    }
    seen.add(email);
    if (locale.fallback) fallbackLocaleCount += 1;
    const resolvedRole = role === 'professional' ? 'professional' : 'customer';
    byLocale[locale.locale] = (byLocale[locale.locale] || 0) + 1;
    byRole[resolvedRole] += 1;
    recipients.push({
      email,
      firstName: firstNameForSubscriber(row, user),
      locale: locale.locale,
      country: row.region,
      serviceKeys: Array.isArray(row.serviceKeys) && row.serviceKeys.length ? row.serviceKeys : (row.interestedServices || []),
      role: resolvedRole,
      subscriberId: String(row._id),
      userId: row.userId ? String(row.userId) : undefined,
    });
  };

  for (const row of subscribers) add(row);

  const overLimit = matchedSubscriberCount > MARKETING_AUDIENCE_LIMIT || recipients.length > MARKETING_AUDIENCE_LIMIT;
  const exactTotal =
    matchedSubscriberCount > MARKETING_AUDIENCE_LIMIT
      ? matchedSubscriberCount
      : recipients.length;
  const criteriaHash = hashCriteria({ campaignType: input.campaignType, filters, contentLocales: [...contentLocales], inactiveDays: input.inactiveDays || null });
  return {
    recipients: input.limitMode === 'delivery' ? recipients.slice(0, MARKETING_AUDIENCE_LIMIT) : recipients,
    exactTotal,
    byLocale,
    byRole,
    deduplicated,
    excluded: { suppressed: suppressedCount, invalidEmail, missingLocale, roleMismatch, localeMismatch },
    fallbackLocaleCount,
    overLimit,
    criteriaHash,
  };
}
