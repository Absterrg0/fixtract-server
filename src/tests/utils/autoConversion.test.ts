import { describe, expect, it } from 'vitest';
import {
  AutoConversionValidationError,
  normalizeCountryCode,
  parseAutoConversionInput,
  serializeAdminAutoConversion,
  serializePublicAutoConversion,
} from '../../utils/autoConversion';

describe('auto-conversion country rules', () => {
  it('accepts only real ISO 3166-1 alpha-2 country codes', () => {
    expect(normalizeCountryCode(' be ')).toBe('BE');
    expect(normalizeCountryCode('NL')).toBe('NL');
    expect(normalizeCountryCode('XK')).toBe('XK');
    for (const bad of ['BEL', 'B', 'XX', 'EU', 'UN', 'ZZ', '12', '', null, 3]) {
      expect(normalizeCountryCode(bad)).toBeNull();
    }
  });

  it('uppercases, dedupes and sorts enabled countries', () => {
    expect(parseAutoConversionInput({ enabledCountries: ['nl', 'BE', 'be', 'fr'], defaultCountry: 'nl' }))
      .toEqual({ enabledCountries: ['BE', 'FR', 'NL'], defaultCountry: 'NL' });
  });

  it('allows an empty roll-out list and falls back to the stored or BE default country', () => {
    expect(parseAutoConversionInput({ enabledCountries: [] })).toEqual({ enabledCountries: [], defaultCountry: 'BE' });
    expect(parseAutoConversionInput({ enabledCountries: [] }, { defaultCountry: 'FR' }).defaultCountry).toBe('FR');
  });

  it('rejects invalid input with the offending field and codes', () => {
    const run = (input: any) => {
      try {
        parseAutoConversionInput(input);
      } catch (error) {
        return error as AutoConversionValidationError;
      }
      throw new Error('expected a validation error');
    };
    expect(run({ enabledCountries: 'BE' }).field).toBe('enabledCountries');
    expect(run({ enabledCountries: ['BE', 'XX', 'Belgium'] })).toMatchObject({ field: 'enabledCountries', invalid: ['XX', 'Belgium'] });
    expect(run({ enabledCountries: ['BE'], defaultCountry: 'EU' }).field).toBe('defaultCountry');
  });

  it('reports configured only after an admin saved the roll-out', () => {
    expect(serializeAdminAutoConversion(undefined)).toBeNull();
    expect(serializeAdminAutoConversion({ enabledCountries: ['BE'], defaultCountry: 'BE' })).toBeNull();
    expect(serializePublicAutoConversion(undefined)).toEqual({ configured: false, enabledCountries: [], defaultCountry: 'BE' });
    const configuredAt = new Date('2026-11-03T00:00:00.000Z');
    expect(serializePublicAutoConversion({ enabledCountries: [], defaultCountry: 'NL', configuredAt }))
      .toEqual({ configured: true, enabledCountries: [], defaultCountry: 'NL' });
  });
});
