import { describe, expect, it } from 'vitest';
import { parseIsActiveBody, parseSiteAnnouncementWriteBody } from '../parseWriteBody';

const validBody = {
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
    const result = parseSiteAnnouncementWriteBody({
      ...validBody,
      ctaUrl: 'javascript:alert(1)',
    });
    expect(result.ok).toBe(false);
  });

  it('rejects non-ISO country codes', () => {
    const result = parseSiteAnnouncementWriteBody({
      ...validBody,
      activeCountries: ['Belgium'],
    });
    expect(result.ok).toBe(false);
  });
});

describe('parseIsActiveBody', () => {
  it('accepts boolean isActive', () => {
    expect(parseIsActiveBody({ isActive: true })).toEqual({ ok: true, value: true });
  });

  it('rejects non-boolean isActive', () => {
    expect(parseIsActiveBody({ isActive: 'true' }).ok).toBe(false);
  });
});
