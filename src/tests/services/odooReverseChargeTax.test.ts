import { describe, expect, it } from 'vitest';
import { matchesReverseChargeTaxName } from '../../services/odooAccounting';

// Real 0%-rate sale tax names from Odoo company 2 (https://qlab.odoo.com).
// The domestic co-contractor tax is abbreviated "0% Cocont" — the previous
// /ic|intra|reverse|co-contractor/i matcher missed it, so every Peppol
// dispatch failed tax-coverage with "reverse-charge tax could not be resolved".
describe('matchesReverseChargeTaxName', () => {
  it('matches the Belgian co-contractor abbreviation', () => {
    expect(matchesReverseChargeTaxName('0% Cocont')).toBe(true);
  });
  it('still matches the long-standing spellings', () => {
    expect(matchesReverseChargeTaxName('0% Intra-community')).toBe(true);
    expect(matchesReverseChargeTaxName('Reverse Charge 0%')).toBe(true);
    expect(matchesReverseChargeTaxName('0% co-contractor')).toBe(true);
  });
  it('rejects non-reverse-charge taxes', () => {
    expect(matchesReverseChargeTaxName('21%')).toBe(false);
    expect(matchesReverseChargeTaxName('6% S')).toBe(false);
    expect(matchesReverseChargeTaxName('0% S')).toBe(false);
    expect(matchesReverseChargeTaxName(undefined)).toBe(false);
  });
});
