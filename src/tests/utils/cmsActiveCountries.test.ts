import { describe, expect, it } from 'vitest';
import {
  cmsCountryVisibilityFilter,
  isCmsCountryCode,
  isCmsContentVisibleForCountry,
  parseCmsCountryCode,
  sanitizeCmsActiveCountries,
} from '../../utils/cms/activeCountries';

describe('CMS country targeting', () => {
  it('keeps empty targeting global and requires an exact visitor match otherwise', () => {
    expect(isCmsContentVisibleForCountry([], undefined)).toBe(true);
    expect(isCmsContentVisibleForCountry(['BE', 'NL'], 'BE')).toBe(true);
    expect(isCmsContentVisibleForCountry(['BE', 'NL'], 'FR')).toBe(false);
    expect(isCmsContentVisibleForCountry(['BE', 'NL'], undefined)).toBe(false);
  });

  it('normalizes and bounds country values saved by the admin API', () => {
    expect(sanitizeCmsActiveCountries(['be', ' BE ', 'NL', 'invalid', 42])).toEqual(['BE', 'NL']);
    expect(parseCmsCountryCode(' be ')).toBe('BE');
    expect(parseCmsCountryCode('BEL')).toBeUndefined();
    expect(isCmsCountryCode('ZZ')).toBe(false);
    expect(sanitizeCmsActiveCountries(['ZZ', 'BE'])).toEqual(['BE']);
  });

  it('queries global content plus country-specific content for known visitors', () => {
    expect(cmsCountryVisibilityFilter('BE')).toEqual({
      $or: [
        { activeCountries: { $size: 0 } },
        { activeCountries: { $exists: false } },
        { activeCountries: 'BE' },
      ],
    });
    expect(cmsCountryVisibilityFilter()).toEqual({
      $or: [
        { activeCountries: { $size: 0 } },
        { activeCountries: { $exists: false } },
      ],
    });
  });
});
