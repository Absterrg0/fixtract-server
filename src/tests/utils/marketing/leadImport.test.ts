import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import {
  MARKETING_LEAD_MAX_ROWS,
  validateLeadWorkbook,
} from '../../../utils/marketing/leadImport';

function workbookBuffer(rows: unknown[][]): Buffer {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(workbook, sheet, 'Leads');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

describe('marketing lead workbook validation', () => {
  it('normalizes headers and keeps only the first duplicate email', () => {
    const result = validateLeadWorkbook(
      workbookBuffer([
        [' EMAIL ', 'Country', 'LANGUAGE', 'Service', 'First name', 'Last name'],
        ['Person@Example.com', 'be', 'nl', 'Plumbing', 'Ada', 'Lovelace'],
        [' person@example.com ', 'BE', 'nl', 'Plumbing', 'Duplicate', 'Row'],
      ]),
      { resolveService: (value) => (value.toLowerCase() === 'plumbing' ? 'plumbing' : undefined) },
    );

    expect(result.validRows).toBe(1);
    expect(result.duplicateRows).toBe(1);
    expect(result.rows[0]).toMatchObject({
      emailNormalized: 'person@example.com',
      country: 'BE',
      locale: 'nl',
      serviceKeys: ['plumbing'],
      firstName: 'Ada',
    });
  });

  it('reports invalid rows and unresolved services without retaining the workbook', () => {
    const result = validateLeadWorkbook(
      workbookBuffer([
        ['Email', 'Country', 'Language', 'Service'],
        ['not-an-email', 'Belgium', 'xx', 'Unknown'],
      ]),
      { resolveService: () => undefined },
    );

    expect(result.validRows).toBe(0);
    expect(result.rejectedRows).toBe(1);
    expect(result.errors.map((error) => error.field)).toEqual(
      expect.arrayContaining(['email', 'country', 'language', 'service']),
    );
    expect(result).not.toHaveProperty('buffer');
  });

  it('rejects a workbook over the row limit before parsing all rows', () => {
    const rows = [['Email', 'Country', 'Language', 'Service']];
    for (let index = 0; index <= MARKETING_LEAD_MAX_ROWS; index += 1) {
      rows.push([`person-${index}@example.com`, 'BE', 'en', 'Plumbing']);
    }

    expect(() => validateLeadWorkbook(workbookBuffer(rows))).toThrow(
      `${MARKETING_LEAD_MAX_ROWS} data rows`,
    );
  });
});
