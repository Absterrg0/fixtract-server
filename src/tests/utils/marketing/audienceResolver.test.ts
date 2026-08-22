import { beforeEach, describe, expect, it, vi } from 'vitest';

const { subscriberFind, suppressionFind, userFind } = vi.hoisted(() => ({
  subscriberFind: vi.fn(),
  suppressionFind: vi.fn(),
  userFind: vi.fn(),
}));

function queryResult(rows: unknown[]) {
  const query = {
    select: () => query,
    sort: () => query,
    lean: async () => rows,
  };
  return query;
}

vi.mock('../../../models/marketingSubscriber', () => ({
  default: { find: subscriberFind },
}));
vi.mock('../../../models/marketingSuppression', () => ({
  default: { find: suppressionFind },
}));
vi.mock('../../../models/user', () => ({
  default: { find: userFind },
}));
vi.mock('../../../utils/marketing/audience', () => ({ MARKETING_AUDIENCE_LIMIT: 5000 }));

import { resolveMarketingAudience } from '../../../utils/marketing/audienceResolver';

describe('resolveMarketingAudience', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    suppressionFind.mockReturnValue(queryResult([{ emailNormalized: 'optedout@example.com' }]));
    userFind.mockReturnValue(queryResult([]));
    subscriberFind.mockImplementation((query: Record<string, unknown>) => query.unsubscribedAt
      ? queryResult([{ emailNormalized: 'legacy-optout@example.com', email: 'legacy-optout@example.com' }])
      : queryResult([
          {
            _id: 'subscriber-1',
            email: 'PERSON@example.com',
            emailNormalized: 'person@example.com',
            name: 'Person Example',
            locale: 'de',
            region: 'DE',
            role: 'professional',
            serviceKeys: ['plumbing'],
            consentVerifiedAt: new Date(),
            unsubscribedAt: null,
            brevoUnsubscribedAt: null,
          },
          {
            _id: 'subscriber-duplicate',
            email: 'person@example.com',
            emailNormalized: 'person@example.com',
            locale: 'de',
            region: 'DE',
            role: 'professional',
            consentVerifiedAt: new Date(),
            unsubscribedAt: null,
            brevoUnsubscribedAt: null,
          },
          {
            _id: 'subscriber-opted-out',
            email: 'optedout@example.com',
            emailNormalized: 'optedout@example.com',
            locale: 'de',
            region: 'DE',
            role: 'professional',
            consentVerifiedAt: new Date(),
            unsubscribedAt: null,
            brevoUnsubscribedAt: null,
          },
        ]));
  });

  it('deduplicates subscribers and reports exact language and account-type counts', async () => {
    const result = await resolveMarketingAudience({
      campaignType: 'newsletter',
      filters: { countries: ['DE'], interestedServices: [], serviceKeys: ['plumbing'], locales: ['de'], roles: ['professional'] },
      contentLocales: ['de'],
      limitMode: 'preview',
    });

    expect(result.exactTotal).toBe(1);
    expect(result.byLocale).toEqual({ de: 1 });
    expect(result.byRole).toEqual({ customer: 0, professional: 1 });
    expect(result.deduplicated).toBe(1);
    expect(result.excluded.suppressed).toBe(1);
    expect(result.recipients[0]).toMatchObject({
      email: 'person@example.com',
      firstName: 'Person',
      subscriberId: 'subscriber-1',
    });
  });

  it('uses an explicit user language before the stored subscriber locale and reports mismatches', async () => {
    subscriberFind.mockImplementation((query: Record<string, unknown>) => query.unsubscribedAt
      ? queryResult([])
      : queryResult([{
          _id: 'subscriber-2',
          userId: 'user-2',
          email: 'language@example.com',
          emailNormalized: 'language@example.com',
          name: 'Language Example',
          locale: 'nl',
          region: 'BE',
          role: 'customer',
          consentVerifiedAt: new Date(),
          unsubscribedAt: null,
          brevoUnsubscribedAt: null,
        }]));
    userFind.mockReturnValue(queryResult([{ _id: 'user-2', name: 'User Name', marketingLocale: 'fr' }]));

    const result = await resolveMarketingAudience({
      campaignType: 'newsletter',
      filters: { countries: ['BE'], interestedServices: [], serviceKeys: [], locales: ['fr'], roles: ['customer'] },
      contentLocales: ['fr'],
      limitMode: 'preview',
    });

    expect(result.recipients[0]).toMatchObject({ locale: 'fr', firstName: 'Language' });
    expect(result.byLocale).toEqual({ fr: 1 });
    expect(result.byRole).toEqual({ customer: 1, professional: 0 });
    expect(result.excluded.localeMismatch).toBe(0);
  });
});
