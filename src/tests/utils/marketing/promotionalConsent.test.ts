import { describe, expect, it } from 'vitest';
import { promotionalEmailOptIn } from '../../../utils/marketing/promotionalConsent';

describe('promotional email opt-in', () => {
  it('treats the promotional-email toggle as a subscribe, even without a Date instance', () => {
    const result = promotionalEmailOptIn({
      notificationPreferences: { promotions: { email: true, push: true } },
      marketingConsentAt: null,
    });
    expect(result.optedIn).toBe(true);
    expect(result.consentVerifiedAt).toBeInstanceOf(Date);
  });

  it('accepts an ISO consent timestamp from a lean document', () => {
    const result = promotionalEmailOptIn({
      notificationPreferences: { promotions: { email: true } },
      marketingConsentAt: '2026-09-01T12:00:00.000Z',
    });
    expect(result.optedIn).toBe(true);
    expect(result.consentVerifiedAt?.toISOString()).toBe('2026-09-01T12:00:00.000Z');
  });

  it('does not subscribe when promotional email is off', () => {
    expect(
      promotionalEmailOptIn({
        notificationPreferences: { promotions: { email: false } },
        marketingConsentAt: new Date(),
      }).optedIn,
    ).toBe(false);
  });
});
