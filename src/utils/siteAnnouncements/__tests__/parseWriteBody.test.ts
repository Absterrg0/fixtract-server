import { describe, expect, it } from 'vitest';
import { parseIsActiveBody, parseSiteAnnouncementPatchBody, parseSiteAnnouncementWriteBody } from '../parseWriteBody';

import type { SiteAnnouncementActiveBody, SiteAnnouncementWriteBody } from '../types';

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
