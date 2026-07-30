import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

const { campaignCreate, campaignFindById } = vi.hoisted(() => ({
  campaignCreate: vi.fn(),
  campaignFindById: vi.fn(),
}));

vi.mock('../../../models/marketingCampaign', () => ({
  default: {
    create: campaignCreate,
    findById: campaignFindById,
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

import {
  createMarketingCampaign,
  updateMarketingCampaign,
} from '../../../handlers/Admin/marketingCampaigns';

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

  it('rejects create when audience locales lack matching content', async () => {
    const res = mockRes();

    await createMarketingCampaign(
      {
        admin: { _id: '507f1f77bcf86cd799439012' },
        body: {
          name: 'Bilingual promo',
          type: 'promotion',
          content: {
            en: {
              subject: 'English only',
              htmlContent: '<p>English body content here.</p>',
            },
          },
          audience: {
            locales: ['en', 'nl'],
            roles: ['customer'],
            countries: [],
            interestedServices: [],
          },
        },
      } as unknown as Request,
      res,
    );

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual(
      expect.objectContaining({
        success: false,
        msg: expect.stringContaining('nl'),
      }),
    );
    expect(campaignCreate).not.toHaveBeenCalled();
  });

  it('clears retry bookkeeping when a failed campaign is updated', async () => {
    const campaign = {
      status: 'failed',
      type: 'newsletter',
      name: 'Retry me',
      scheduledAt: null as Date | null,
      sendAttempts: 2,
      nextRetryAt: new Date('2026-08-01T00:00:00.000Z'),
      deliveries: [] as Array<{ brevoCampaignId?: string }>,
      audience: {
        locales: ['en'],
        roles: ['customer'],
        countries: [],
        interestedServices: [],
      },
      content: {
        en: {
          subject: 'Retry subject',
          htmlContent: '<p>Retry body content here.</p>',
        },
      },
      save: vi.fn().mockResolvedValue(undefined),
      toObject() {
        return {
          _id: '507f1f77bcf86cd799439011',
          status: this.status,
          sendAttempts: this.sendAttempts,
          nextRetryAt: this.nextRetryAt,
          content: this.content,
          audience: this.audience,
        };
      },
    };
    campaignFindById.mockResolvedValue(campaign);
    const res = mockRes();

    await updateMarketingCampaign(
      {
        params: { id: '507f1f77bcf86cd799439011' },
        body: { name: 'Retry me again' },
      } as unknown as Request,
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(campaign.sendAttempts).toBe(0);
    expect(campaign.nextRetryAt).toBeNull();
    expect(campaign.status).toBe('draft');
    expect(campaign.save).toHaveBeenCalled();
  });
});
