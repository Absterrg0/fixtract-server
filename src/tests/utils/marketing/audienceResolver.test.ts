import { beforeEach, describe, expect, it, vi } from 'vitest';

const { subscriberFind, leadFind, suppressionFind } = vi.hoisted(() => ({
  subscriberFind: vi.fn(),
  leadFind: vi.fn(),
  suppressionFind: vi.fn(),
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
vi.mock('../../../models/marketingLead', () => ({
  default: { find: leadFind },
}));
vi.mock('../../../models/marketingSuppression', () => ({
  default: { find: suppressionFind },
}));
vi.mock('../../../models/marketingCampaign', () => ({
  MARKETING_AUDIENCE_TYPES: ['subscribers', 'leads', 'both'],
}));
vi.mock('../../../utils/marketing/audience', () => ({ MARKETING_AUDIENCE_LIMIT: 5000 }));

import { resolveMarketingAudience } from '../../../utils/marketing/audienceResolver';

describe('resolveMarketingAudience', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.MARKETING_LEAD_OUTREACH_ENABLED;
    delete process.env.MARKETING_LEAD_LEGAL_APPROVED;
    suppressionFind.mockReturnValue(queryResult([{ emailNormalized: 'optedout@example.com' }]));
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
        ]));
    leadFind.mockReturnValue(queryResult([
      {
        _id: 'lead-1',
        email: 'person@example.com',
        emailNormalized: 'person@example.com',
        firstName: 'Lead',
        country: 'DE',
        locale: 'de',
        serviceKeys: ['plumbing'],
        status: 'active',
        unsubscribedAt: null,
      },
      {
        _id: 'lead-2',
        email: 'optedout@example.com',
        emailNormalized: 'optedout@example.com',
        country: 'DE',
        locale: 'de',
        serviceKeys: ['plumbing'],
        status: 'active',
        unsubscribedAt: null,
      },
    ]));
  });

  it('deduplicates both audiences with subscriber metadata winning and suppressions excluded', async () => {
    process.env.MARKETING_LEAD_OUTREACH_ENABLED = 'true';
    process.env.MARKETING_LEAD_LEGAL_APPROVED = 'true';
    const result = await resolveMarketingAudience({
      campaignType: 'invitation',
      audienceType: 'both',
      filters: { countries: ['DE'], interestedServices: [], serviceKeys: ['plumbing'], locales: ['de'], roles: ['professional'] },
      contentLocales: ['de'],
      limitMode: 'preview',
    });

    expect(result.exactTotal).toBe(1);
    expect(result.bySource).toEqual({ subscribers: 1, leads: 0 });
    expect(result.deduplicated).toBe(1);
    expect(result.excluded.suppressed).toBe(1);
    expect(result.recipients[0]).toMatchObject({
      email: 'person@example.com',
      firstName: 'Person',
      source: 'subscriber',
      subscriberId: 'subscriber-1',
    });
  });

  it('keeps lead audiences disabled without both safety flags', async () => {
    await expect(resolveMarketingAudience({
      campaignType: 'invitation',
      audienceType: 'leads',
      filters: { countries: [], interestedServices: [], serviceKeys: [], locales: ['en'], roles: ['professional'] },
      contentLocales: ['en'],
    })).rejects.toThrow('not enabled');
  });
});
