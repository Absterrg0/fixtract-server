import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

const { campaignCreate } = vi.hoisted(() => ({
  campaignCreate: vi.fn(),
}));

vi.mock('../../../models/marketingCampaign', () => ({
  default: {
    create: campaignCreate,
  },
  MARKETING_CAMPAIGN_TYPES: ['newsletter', 'promotion', 'reengagement'],
  MARKETING_LOCALES: ['en', 'nl', 'fr'],
}));

vi.mock('../../../models/marketingSubscriber', () => ({
  default: {},
}));

vi.mock('../../../utils/marketing/audience', () => ({
  countCampaignAudience: vi.fn(),
  syncSubscribersFromUsers: vi.fn(),
}));

vi.mock('../../../utils/marketing/sendCampaign', () => ({
  refreshCampaignStats: vi.fn(),
  sendMarketingCampaign: vi.fn(),
}));

vi.mock('../../../utils/marketing/brevoMarketing', () => ({
  listActiveBrevoTemplates: vi.fn(),
}));

import { createMarketingCampaign } from '../../../handlers/Admin/marketingCampaigns';

function mockRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res as Response & { statusCode: number; body: unknown };
}

describe('marketing campaign admin handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('attributes campaign creation to the authenticated admin', async () => {
    campaignCreate.mockImplementation(async (payload) => ({
      toObject: () => ({ _id: '507f1f77bcf86cd799439011', ...payload }),
    }));
    const res = mockRes();

    await createMarketingCampaign(
      {
        admin: { _id: '507f1f77bcf86cd799439012' },
        body: {
          name: 'August newsletter',
          type: 'newsletter',
          content: {
            en: {
              subject: 'August updates',
              htmlContent: '<p>Here are the latest platform updates.</p>',
            },
          },
          audience: {
            locales: ['en'],
            roles: ['customer'],
            countries: [],
            interestedServices: [],
          },
        },
      } as unknown as Request,
      res,
    );

    expect(res.statusCode).toBe(201);
    expect(campaignCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        createdBy: '507f1f77bcf86cd799439012',
      }),
    );
  });
});
