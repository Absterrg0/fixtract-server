import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { buildPublicListQuery } from '../buildQueries';
import {
  ANNOUNCEMENT_MARKET_TZ,
  parseScheduleEnd,
  parseScheduleStart,
} from '../scheduleDates';

describe('parseScheduleStart / parseScheduleEnd', () => {
  it('expands date-only start to start of day in Europe/Brussels', () => {
    const start = parseScheduleStart('2026-08-31');
    expect(start).not.toBeNull();
    const expected = DateTime.fromISO('2026-08-31', { zone: ANNOUNCEMENT_MARKET_TZ })
      .startOf('day')
      .toUTC()
      .toJSDate();
    expect(start!.getTime()).toBe(expected.getTime());
  });

  it('expands date-only end to end of day in Europe/Brussels', () => {
    const end = parseScheduleEnd('2026-08-31');
    expect(end).not.toBeNull();
    const expected = DateTime.fromISO('2026-08-31', { zone: ANNOUNCEMENT_MARKET_TZ })
      .endOf('day')
      .toUTC()
      .toJSDate();
    expect(end!.getTime()).toBe(expected.getTime());
  });

  it('keeps same-day date-only start before end', () => {
    const start = parseScheduleStart('2026-08-31');
    const end = parseScheduleEnd('2026-08-31');
    expect(start).not.toBeNull();
    expect(end).not.toBeNull();
    expect(end!.getTime()).toBeGreaterThan(start!.getTime());
  });

  it('passes through explicit ISO instants', () => {
    const iso = '2026-08-31T15:30:00.000Z';
    expect(parseScheduleStart(iso)?.toISOString()).toBe(iso);
    expect(parseScheduleEnd(iso)?.toISOString()).toBe(iso);
  });
});

describe('buildPublicListQuery', () => {
  const now = new Date('2026-07-15T12:00:00.000Z');

  it('matches global or country campaigns when country is known', () => {
    const query = buildPublicListQuery({ locale: 'nl', countryCode: 'BE' }, now);
    expect(query.$or).toEqual([
      { activeCountries: { $size: 0 } },
      { activeCountries: 'BE' },
    ]);
  });

  it('matches only global campaigns when country is unknown', () => {
    const query = buildPublicListQuery({ locale: 'en' }, now);
    expect(query.$or).toEqual([{ activeCountries: { $size: 0 } }]);
  });
});
