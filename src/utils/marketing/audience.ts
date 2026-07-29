import User from '../../models/user';
import Booking from '../../models/booking';
import MarketingSubscriber, {
  type IMarketingSubscriber,
  type MarketingLocale,
  MARKETING_LOCALES,
} from '../../models/marketingSubscriber';
import type { ICampaignAudience } from '../../models/marketingCampaign';
import { generateUnsubscribeToken } from './unsubscribeToken';

export type AudienceMember = {
  email: string;
  name?: string;
  locale: MarketingLocale;
  region?: string;
  userId?: string;
  subscriberId?: string;
};

function normalizeCountry(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().toUpperCase();
  return trimmed || undefined;
}

function userCountry(user: any): string | undefined {
  return (
    normalizeCountry(user?.location?.country) ||
    normalizeCountry(user?.companyAddress?.country) ||
    normalizeCountry(user?.businessInfo?.country)
  );
}

function normalizeLocale(value: unknown): MarketingLocale {
  if (typeof value === 'string') {
    const lower = value.trim().toLowerCase().slice(0, 2);
    if ((MARKETING_LOCALES as readonly string[]).includes(lower)) {
      return lower as MarketingLocale;
    }
  }
  return 'en';
}

/** Sync opted-in users into MarketingSubscriber collection. */
export async function syncSubscribersFromUsers(): Promise<{
  upserted: number;
  unsubscribed: number;
}> {
  const SYNC_BATCH_SIZE = 500;
  const baseQuery = {
    email: { $exists: true, $nin: [null, ''] },
    role: { $in: ['customer', 'professional'] },
    deletedAt: { $exists: false },
  };
  let lastUserId: unknown;
  let upserted = 0;
  let unsubscribed = 0;

  // Stable _id keyset pagination bounds memory without permanently omitting users
  // beyond an arbitrary daily cap.
  while (true) {
    const users = await User.find(
      lastUserId ? { ...baseQuery, _id: { $gt: lastUserId } } : baseQuery,
    )
      .select(
        'email name role location companyAddress businessInfo notificationPreferences serviceCategories preferredLocale locale language',
      )
      .sort({ _id: 1 })
      .limit(SYNC_BATCH_SIZE)
      .lean();

    if (users.length === 0) break;

    const serviceInterestByUser = new Map<string, string[]>();
    const userIds = users.map((u) => u._id);
    const bookingServices = await Booking.aggregate<{
      _id: unknown;
      services: string[];
    }>([
      { $match: { customer: { $in: userIds }, 'rfqData.serviceType': { $exists: true, $ne: '' } } },
      {
        $group: {
          _id: '$customer',
          services: { $addToSet: '$rfqData.serviceType' },
        },
      },
    ]);
    for (const row of bookingServices) {
      serviceInterestByUser.set(String(row._id), (row.services || []).filter(Boolean));
    }

    for (const user of users) {
      const email = String(user.email).toLowerCase().trim();
      if (!email) continue;

      const promotionsEmail = (user as any).notificationPreferences?.promotions?.email;
      const optedIn = promotionsEmail !== false;
      const region = userCountry(user);
      const fromBookings = serviceInterestByUser.get(String(user._id)) || [];
      const fromPro =
        Array.isArray((user as any).serviceCategories) ? (user as any).serviceCategories : [];
      const interestedServices = Array.from(new Set([...fromBookings, ...fromPro].map(String)));
      // Seed locale from preference fields when present (schema may not declare them yet)
      const locale = normalizeLocale(
        (user as any).preferredLocale ?? (user as any).locale ?? (user as any).language,
      );

      const existing = await MarketingSubscriber.findOne({ email });
      if (!optedIn) {
        if (existing && !existing.unsubscribedAt) {
          existing.unsubscribedAt = new Date();
          await existing.save();
          unsubscribed += 1;
        }
        continue;
      }

      if (existing) {
        existing.userId = user._id as any;
        existing.region = region;
        existing.interestedServices = interestedServices;
        if (!existing.locale || existing.locale === 'en') existing.locale = locale;
        if (existing.unsubscribedAt) existing.unsubscribedAt = null;
        if (!existing.unsubscribeToken) existing.unsubscribeToken = generateUnsubscribeToken();
        await existing.save();
        upserted += 1;
      } else {
        await MarketingSubscriber.create({
          email,
          userId: user._id,
          region,
          interestedServices,
          locale,
          unsubscribeToken: generateUnsubscribeToken(),
          source: 'user_sync',
          subscribedAt: new Date(),
          unsubscribedAt: null,
        });
        upserted += 1;
      }
    }

    lastUserId = users[users.length - 1]._id;
    if (users.length < SYNC_BATCH_SIZE) break;
  }

  return { upserted, unsubscribed };
}

function matchesAudience(sub: IMarketingSubscriber | any, audience: ICampaignAudience): boolean {
  if (sub.unsubscribedAt) return false;

  const countries = (audience.countries || []).map((c) => c.trim().toUpperCase()).filter(Boolean);
  if (countries.length > 0) {
    const region = normalizeCountry(sub.region);
    if (!region || !countries.includes(region)) return false;
  }

  const services = (audience.interestedServices || []).map((s) => s.trim()).filter(Boolean);
  if (services.length > 0) {
    const set = new Set((sub.interestedServices || []).map(String));
    if (!services.some((s) => set.has(s))) return false;
  }

  const locales = (audience.locales || []) as MarketingLocale[];
  if (locales.length > 0) {
    const locale = normalizeLocale(sub.locale);
    if (!locales.includes(locale)) return false;
  }

  return true;
}

/** Resolve active subscribers matching campaign audience filters. */
export async function resolveCampaignAudience(
  audience: ICampaignAudience,
  opts?: { inactiveDays?: number; max?: number },
): Promise<AudienceMember[]> {
  const query: Record<string, unknown> = { unsubscribedAt: null };
  const countries = (audience.countries || []).map((c) => c.trim().toUpperCase()).filter(Boolean);
  if (countries.length > 0) query.region = { $in: countries };

  const locales = (audience.locales || []) as MarketingLocale[];
  if (locales.length > 0) query.locale = { $in: locales };

  const services = (audience.interestedServices || []).map((s) => s.trim()).filter(Boolean);
  if (services.length > 0) query.interestedServices = { $in: services };

  if (opts?.inactiveDays && opts.inactiveDays > 0) {
    const cutoff = new Date(Date.now() - opts.inactiveDays * 24 * 60 * 60 * 1000);
    query.$or = [
      { lastCampaignSentAt: { $lte: cutoff } },
      { lastCampaignSentAt: null },
      { lastCampaignSentAt: { $exists: false } },
    ];
    query.subscribedAt = { $lte: cutoff };
  }

  const limit = Math.min(Math.max(opts?.max || 5000, 1), 10000);
  const subs = await MarketingSubscriber.find(query).limit(limit).lean();

  // Role filter via linked user when roles are restricted
  const roles = audience.roles?.length ? audience.roles : ['customer', 'professional'];
  const needRoleFilter =
    !(roles.includes('customer') && roles.includes('professional')) || roles.length === 1;

  let filtered = subs.filter((s) => matchesAudience(s as any, audience));

  if (needRoleFilter) {
    const userIds = filtered.map((s) => s.userId).filter(Boolean);
    const users = await User.find({ _id: { $in: userIds } })
      .select('role')
      .lean();
    const roleById = new Map(users.map((u) => [String(u._id), u.role]));
    filtered = filtered.filter((s) => {
      if (!s.userId) return roles.includes('customer'); // orphan subscribers treated as customers
      const role = roleById.get(String(s.userId));
      return role === 'customer' || role === 'professional' ? roles.includes(role as any) : false;
    });
  }

  return filtered.map((s) => ({
    email: s.email,
    locale: normalizeLocale(s.locale),
    region: s.region || undefined,
    userId: s.userId ? String(s.userId) : undefined,
    subscriberId: String(s._id),
  }));
}

export async function countCampaignAudience(
  audience: ICampaignAudience,
  opts?: { inactiveDays?: number },
): Promise<{ count: number; truncated: boolean }> {
  const max = 10000;
  const members = await resolveCampaignAudience(audience, { ...opts, max });
  return { count: members.length, truncated: members.length >= max };
}
