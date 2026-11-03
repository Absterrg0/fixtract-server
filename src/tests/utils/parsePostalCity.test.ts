import { describe, expect, it } from 'vitest';
import { parsePostalCity } from '../../handlers/User/validateVat';

describe('parsePostalCity', () => {
  it('parses spaceless Dutch postcodes without losing the postal code', () => {
    expect(parsePostalCity('5026SL TILBURG')).toEqual({ postalCode: '5026SL', city: 'TILBURG' });
  });

  it('still parses spaced Dutch postcodes', () => {
    expect(parsePostalCity('5026 SL TILBURG')).toEqual({ postalCode: '5026SL', city: 'TILBURG' });
  });

  it('trims surrounding whitespace before matching the postal code', () => {
    expect(parsePostalCity(' 5026SL TILBURG ')).toEqual({ postalCode: '5026SL', city: 'TILBURG' });
    expect(parsePostalCity('  1000 BRUSSELS', 'BE')).toEqual({ postalCode: '1000', city: 'BRUSSELS' });
  });

  it('accepts a stored Dutch country name for the Dutch postcode rule', () => {
    expect(parsePostalCity('5026SL TILBURG', 'Netherlands')).toEqual({ postalCode: '5026SL', city: 'TILBURG' });
  });

  it('keeps a short first city word in the city for non-Dutch countries', () => {
    // Belgian VIES line with a two-letter first city word.
    expect(parsePostalCity('1300 LA HULPE', 'BE')).toEqual({ postalCode: '1300', city: 'LA HULPE' });
    expect(parsePostalCity('1310 La Hulpe', 'BE')).toEqual({ postalCode: '1310', city: 'La Hulpe' });
    // Longer first words were swallowed the same way (up to five letters).
    expect(parsePostalCity('9100 SINT NIKLAAS', 'BE')).toEqual({ postalCode: '9100', city: 'SINT NIKLAAS' });
    expect(parsePostalCity('75001 PARIS CEDEX', 'FR')).toEqual({ postalCode: '75001', city: 'PARIS CEDEX' });
    expect(parsePostalCity('4000 LIEGE CENTRE', 'BE')).toEqual({ postalCode: '4000', city: 'LIEGE CENTRE' });
  });

  it('still keeps numeric second postcode parts (CZ/SE/PL/PT)', () => {
    expect(parsePostalCity('110 00 PRAHA 1', 'CZ')).toEqual({ postalCode: '110 00', city: 'PRAHA 1' });
    expect(parsePostalCity('114 55 STOCKHOLM', 'SE')).toEqual({ postalCode: '114 55', city: 'STOCKHOLM' });
    expect(parsePostalCity('00-950 WARSZAWA', 'PL')).toEqual({ postalCode: '00-950', city: 'WARSZAWA' });
    expect(parsePostalCity('1000-001 LISBOA', 'PT')).toEqual({ postalCode: '1000-001', city: 'LISBOA' });
  });

  it('still applies the Dutch rule for NL and unknown countries', () => {
    expect(parsePostalCity('1300 LA HULPE', 'NL')).toEqual({ postalCode: '1300LA', city: 'HULPE' });
    expect(parsePostalCity('2511 CV DEN HAAG', 'NL')).toEqual({ postalCode: '2511CV', city: 'DEN HAAG' });
  });

  it('keeps existing BE/FR/UK shapes intact', () => {
    expect(parsePostalCity('1000 BRUSSELS')).toEqual({ postalCode: '1000', city: 'BRUSSELS' });
    expect(parsePostalCity('75001 PARIS')).toEqual({ postalCode: '75001', city: 'PARIS' });
    const uk = parsePostalCity('W1A 1AA LONDON');
    expect(uk.city).toBe('LONDON');
    expect(uk.postalCode).toBeTruthy();
  });
});
