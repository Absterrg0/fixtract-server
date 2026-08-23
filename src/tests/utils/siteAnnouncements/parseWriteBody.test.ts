import { describe, expect, it } from 'vitest';
import { parseIsActiveBody, parseSiteAnnouncementPatchBody, parseSiteAnnouncementWriteBody } from '../../../utils/siteAnnouncements/parseWriteBody';

import type { SiteAnnouncementActiveBody, SiteAnnouncementWriteBody } from '../../../utils/siteAnnouncements/types';

const validBody: SiteAnnouncementWriteBody = {
  name: 'Summer BE promo',
  type: 'top_bar',
  title: 'Summer 10% off',
  message: 'Book this month and save',
  startsAt: '2026-07-01',
  endsAt: '2026-08-01',
  activeCountries: ['be', 'nl'],
  locale: 'EN',
  ctaUrl: '/services',
  discountCode: 'summer10',
};

describe('parseSiteAnnouncementWriteBody', () => {
  it('normalizes a valid payload', () => {
    const result = parseSiteAnnouncementWriteBody(validBody);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.name).toBe('Summer BE promo');
    expect(result.value.activeCountries).toEqual(['BE', 'NL']);
    expect(result.value.locale).toBe('en');
    expect(result.value.discountCode).toBe('SUMMER10');
    expect(result.value.startsAt).toBeInstanceOf(Date);
    expect(result.value.endsAt).toBeInstanceOf(Date);
    // Date-only ends must include the full final calendar day in Europe/Brussels.
    expect(result.value.endsAt.getTime()).toBeGreaterThan(
      Date.parse('2026-08-01T00:00:00.000Z'),
    );
  });

  it('keeps a same-day date-only schedule active for the whole day', () => {
    const result = parseSiteAnnouncementWriteBody({
      ...validBody,
      startsAt: '2026-08-31',
      endsAt: '2026-08-31',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.endsAt.getTime()).toBeGreaterThan(result.value.startsAt.getTime());
  });

  it('rejects invalid type', () => {
    const result = parseSiteAnnouncementWriteBody({ ...validBody, type: 'banner' });
    expect(result.ok).toBe(false);
  });

  it('rejects endsAt before startsAt', () => {
    const result = parseSiteAnnouncementWriteBody({
      ...validBody,
      startsAt: '2026-08-01',
      endsAt: '2026-07-01',
    });
    expect(result.ok).toBe(false);
  });

  it('rejects unsafe ctaUrl', () => {
    for (const ctaUrl of ['javascript:alert(1)', '//evil.com', '/\\evil.com']) {
      expect(parseSiteAnnouncementWriteBody({ ...validBody, ctaUrl }).ok).toBe(false);
    }
  });

  it('rejects non-ISO country codes', () => {
    const result = parseSiteAnnouncementWriteBody({
      ...validBody,
      activeCountries: ['Belgium'],
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a non-dismissible overlay without an action', () => {
    const result = parseSiteAnnouncementWriteBody({
      ...validBody,
      type: 'modal',
      dismissible: false,
      ctaUrl: '',
      discountCode: '',
    });
    expect(result).toEqual({
      ok: false,
      error: 'Non-dismissible overlays require a CTA URL or discount code',
    });
  });

  it('preserves a supported frequency for overlays', () => {
    const result = parseSiteAnnouncementWriteBody({
      ...validBody,
      type: 'modal',
      frequency: 'once_3_days',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.frequency).toBe('once_3_days');
  });

  it('rejects an unsupported frequency for overlays', () => {
    const result = parseSiteAnnouncementWriteBody({
      ...validBody,
      type: 'exit_intent',
      frequency: 'every_visit',
    });
    expect(result).toEqual({
      ok: false,
      error: 'frequency must be once, once_week, once_3_days, once_day, once_session, or once_pageview',
    });
  });
});

describe('parseSiteAnnouncementPatchBody', () => {
  const existing = {
    name: 'Summer BE promo',
    type: 'top_bar' as const,
    title: 'Summer 10% off',
    message: 'Book this month and save',
    activeCountries: ['BE'],
    locale: 'en',
    startsAt: new Date('2026-07-01T00:00:00.000Z'),
    endsAt: new Date('2026-08-31T23:59:59.999Z'),
    isActive: true,
    priority: 0,
    delaySeconds: 3,
    dismissible: true,
    requireMarketingConsent: true,
  };

  it('accepts a title-only patch', () => {
    const result = parseSiteAnnouncementPatchBody({ title: 'Updated title' }, existing);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ title: 'Updated title' });
  });

  it('rejects an empty patch body', () => {
    expect(parseSiteAnnouncementPatchBody({}, existing).ok).toBe(false);
  });

  it('validates schedule bounds against the existing document', () => {
    const result = parseSiteAnnouncementPatchBody({ endsAt: '2026-06-01' }, existing);
    expect(result.ok).toBe(false);
  });

  it('clears optional fields when present but empty', () => {
    const result = parseSiteAnnouncementPatchBody(
      { ctaLabel: '  ', ctaUrl: '', discountCode: '' },
      { ...existing, ctaLabel: 'Go', ctaUrl: '/services', discountCode: 'SAVE' },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      ctaLabel: null,
      ctaUrl: null,
      discountCode: null,
    });
  });

  it('does not allow a patch to remove the only exit from a locked overlay', () => {
    const result = parseSiteAnnouncementPatchBody(
      { ctaUrl: '', discountCode: '', dismissible: false },
      { ...existing, type: 'exit_intent', ctaUrl: '/services' },
    );
    expect(result.ok).toBe(false);
  });

  it('accepts a frequency patch for an overlay', () => {
    const result = parseSiteAnnouncementPatchBody(
      { frequency: 'once_week' },
      { ...existing, type: 'modal', frequency: 'once_pageview' },
    );
    expect(result).toEqual({ ok: true, value: { frequency: 'once_week' } });
  });
});

describe('parseIsActiveBody', () => {
  it('accepts boolean isActive', () => {
    expect(parseIsActiveBody({ isActive: true })).toEqual({ ok: true, value: true });
  });

  it('rejects non-boolean isActive', () => {
    expect(parseIsActiveBody({ isActive: 'true' } as SiteAnnouncementActiveBody).ok).toBe(
      false,
    );
  });
});
