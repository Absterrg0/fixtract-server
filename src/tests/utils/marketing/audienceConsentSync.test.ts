import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  subscriberFind,
  subscriberUpdateOne,
  subscriberCountDocuments,
  restoreBrevoMarketingContact,
} = vi.hoisted(() => ({
  subscriberFind: vi.fn(),
  subscriberUpdateOne: vi.fn(),
  subscriberCountDocuments: vi.fn(),
  restoreBrevoMarketingContact: vi.fn(),
}));

vi.mock('../../../models/user', () => ({
  default: { find: vi.fn() },
}));

vi.mock('../../../models/booking', () => ({
  default: { aggregate: vi.fn() },
}));

vi.mock('../../../models/marketingSubscriber', () => ({
  default: {
    find: subscriberFind,
    updateOne: subscriberUpdateOne,
    countDocuments: subscriberCountDocuments,
  },
  MARKETING_LOCALES: ['en', 'nl', 'fr'],
}));

vi.mock('../../../utils/marketing/brevoMarketing', () => ({
  restoreBrevoMarketingContact,
  suppressBrevoMarketingContact: vi.fn(),
}));

import {
  countCampaignAudience,
  syncPendingBrevoResubscribes,
} from '../../../utils/marketing/audience';

function mockSubscriberFind(rows: Array<{ _id: string; email: string }>) {
  subscriberFind.mockReturnValue({
    select: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    lean: vi.fn().mockResolvedValue(rows),
  });
}

describe('marketing consent provider reconciliation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    subscriberUpdateOne.mockResolvedValue({ matchedCount: 1 });
  });

  it('clears the provider blacklist checkpoint only after Brevo reactivation succeeds', async () => {
    mockSubscriberFind([{ _id: 'subscriber-1', email: 'person@example.com' }]);
    restoreBrevoMarketingContact.mockResolvedValue(true);

    await expect(syncPendingBrevoResubscribes(1, 'PERSON@example.com')).resolves.toEqual({
      synced: 1,
      pending: 0,
    });

    expect(restoreBrevoMarketingContact).toHaveBeenCalledWith('person@example.com');
    expect(subscriberUpdateOne).toHaveBeenCalledWith(
      {
        _id: 'subscriber-1',
        unsubscribedAt: null,
        consentVerifiedAt: { $type: 'date' },
      },
      {
        $set: { brevoUnsubscribedAt: null },
        $unset: { brevoResubscribeError: 1, brevoUnsubscribeError: 1 },
      },
    );
  });

  it('keeps the subscriber pending when provider delivery is disabled', async () => {
    mockSubscriberFind([{ _id: 'subscriber-1', email: 'person@example.com' }]);
    restoreBrevoMarketingContact.mockResolvedValue(false);

    await expect(syncPendingBrevoResubscribes()).resolves.toEqual({
      synced: 0,
      pending: 1,
    });
    expect(subscriberUpdateOne).not.toHaveBeenCalled();
  });

  it('excludes contacts whose Brevo blacklist has not been reconciled', async () => {
    subscriberCountDocuments.mockResolvedValue(0);

    await countCampaignAudience({
      countries: [],
      interestedServices: [],
      locales: ['en'],
      roles: ['customer'],
    });

    expect(subscriberCountDocuments).toHaveBeenCalledWith(
      expect.objectContaining({
        $and: expect.arrayContaining([{ brevoUnsubscribedAt: null }]),
      }),
    );
  });
});
