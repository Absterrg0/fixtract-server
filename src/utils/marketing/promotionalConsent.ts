/**
 * Promotional-email opt-in is the notification-preferences toggle.
 * marketingConsentAt is recorded on enable; treat parseable timestamps as consent
 * so lean/JSON documents still sync after the user turns the toggle on.
 */

export function isPromotionalEmailEnabled(preferences: unknown): boolean {
  const email = (preferences as { promotions?: { email?: unknown } } | undefined)?.promotions?.email;
  return email === true;
}

export function toConsentDate(value: unknown, fallback?: Date): Date | undefined {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return fallback;
}

export function promotionalEmailOptIn(user: {
  notificationPreferences?: unknown;
  marketingConsentAt?: unknown;
}): { optedIn: boolean; consentVerifiedAt?: Date } {
  if (!isPromotionalEmailEnabled(user.notificationPreferences)) {
    return { optedIn: false };
  }
  return {
    optedIn: true,
    consentVerifiedAt: toConsentDate(user.marketingConsentAt, new Date()),
  };
}
