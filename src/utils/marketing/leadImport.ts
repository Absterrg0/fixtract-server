import * as XLSX from 'xlsx';
import { isValidEmail, normalizeEmail } from './normalizeEmail';
import { MARKETING_LOCALES, normalizeMarketingLocale, type MarketingLocale } from './marketingCatalog';

export const MARKETING_LEAD_MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MARKETING_LEAD_MAX_ROWS = 5000;

const REQUIRED_HEADERS = ['email', 'country', 'language', 'service'] as const;

export type LeadImportRow = {
  rowNumber: number;
  email: string;
  emailNormalized: string;
  firstName?: string;
  lastName?: string;
  country: string;
  locale: MarketingLocale;
  serviceValues: string[];
  serviceKeys: string[];
};

export type LeadImportError = {
  row: number;
  field?: string;
  message: string;
};

export type LeadImportValidation = {
  headers: string[];
  rows: LeadImportRow[];
  errors: LeadImportError[];
  totalRows: number;
  validRows: number;
  duplicateRows: number;
  rejectedRows: number;
};

export type LeadImportOptions = {
  /** Resolve a display value or legacy service name to a canonical key. */
  resolveService?: (value: string, country: string) => string | undefined;
  /** ISO-3166 country codes configured for the current deployment. */
  validCountries?: ReadonlySet<string>;
};

function normalizedHeader(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[._-]+/g, ' ')
    .replace(/\s+/g, ' ');
}

function fieldHeader(value: string): string {
  const normalized = normalizedHeader(value);
  if (normalized === 'firstname' || normalized === 'first name') return 'firstName';
  if (normalized === 'lastname' || normalized === 'last name') return 'lastName';
  if (normalized === 'language' || normalized === 'locale') return 'language';
  return normalized;
}

function cellText(value: unknown): string {
  return String(value ?? '').trim();
}

function splitServices(value: string): string[] {
  return value
    .split(/[;,\n]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function firstNonEmptyMatrixRow(matrix: unknown[][]): number {
  return matrix.findIndex((row) => row.some((cell) => cellText(cell).length > 0));
}

function readFirstNonEmptyWorksheet(buffer: Buffer): unknown[][] {
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(buffer, { type: 'buffer', raw: false, cellDates: false });
  } catch {
    throw new Error('The uploaded file is not a readable Excel workbook');
  }

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      defval: '',
      raw: false,
      blankrows: true,
    });
    if (firstNonEmptyMatrixRow(matrix) >= 0) return matrix;
  }
  throw new Error('The workbook does not contain a non-empty worksheet');
}

function pushError(errors: LeadImportError[], error: LeadImportError): void {
  // Keep the persisted report bounded while preserving aggregate rejectedRows.
  if (errors.length < 500) errors.push(error);
}

function normalizedOptionalName(value: unknown): string {
  return String(value || '').trim().toLowerCase();
}

function sameNormalizedImportRow(left: LeadImportRow, right: LeadImportRow): boolean {
  return normalizedOptionalName(left.firstName) === normalizedOptionalName(right.firstName)
    && normalizedOptionalName(left.lastName) === normalizedOptionalName(right.lastName)
    && left.country === right.country
    && left.locale === right.locale
    && JSON.stringify([...left.serviceKeys].sort()) === JSON.stringify([...right.serviceKeys].sort());
}

export function validateLeadWorkbook(
  buffer: Buffer,
  options: LeadImportOptions = {},
): LeadImportValidation {
  if (buffer.length > MARKETING_LEAD_MAX_FILE_BYTES) {
    throw new Error('The workbook must be 5 MB or smaller');
  }
  if (buffer.length === 0) throw new Error('The uploaded workbook is empty');

  const matrix = readFirstNonEmptyWorksheet(buffer);
  const headerIndex = firstNonEmptyMatrixRow(matrix);
  const rawHeaders = matrix[headerIndex] || [];
  const headers = rawHeaders.map((header) => fieldHeader(cellText(header)));
  const headerPositions = new Map<string, number>();
  const errors: LeadImportError[] = [];

  headers.forEach((header, index) => {
    if (!header) return;
    if (headerPositions.has(header)) {
      throw new Error(`Duplicate column header: ${cellText(rawHeaders[index])}`);
    }
    headerPositions.set(header, index);
  });

  const missingHeaders = REQUIRED_HEADERS.filter((header) => !headerPositions.has(header));
  if (missingHeaders.length > 0) {
    throw new Error(`Missing required columns: ${missingHeaders.join(', ')}`);
  }

  const dataRows = matrix.slice(headerIndex + 1).filter((row) => row.some((cell) => cellText(cell).length > 0));
  if (dataRows.length > MARKETING_LEAD_MAX_ROWS) {
    throw new Error(`The workbook contains more than ${MARKETING_LEAD_MAX_ROWS} data rows`);
  }

  const rows: LeadImportRow[] = [];
  const firstRowByEmail = new Map<string, LeadImportRow>();
  let duplicateRows = 0;
  let rejectedRows = 0;

  const valueAt = (row: unknown[], header: string): string => {
    const index = headerPositions.get(header);
    return index === undefined ? '' : cellText(row[index]);
  };

  dataRows.forEach((rawRow, offset) => {
    const rowNumber = headerIndex + offset + 2;
    const email = valueAt(rawRow, 'email');
    const emailNormalized = normalizeEmail(email);
    const country = valueAt(rawRow, 'country').toUpperCase();
    const rawLocale = valueAt(rawRow, 'language');
    const locale = normalizeMarketingLocale(rawLocale);
    const serviceValues = splitServices(valueAt(rawRow, 'service'));
    const rowErrors: LeadImportError[] = [];

    if (!isValidEmail(emailNormalized)) rowErrors.push({ row: rowNumber, field: 'email', message: 'Enter a valid email address' });
    if (!/^[A-Z]{2}$/.test(country)) rowErrors.push({ row: rowNumber, field: 'country', message: 'Country must be a two-letter ISO code' });
    if (options.validCountries && !options.validCountries.has(country)) {
      rowErrors.push({ row: rowNumber, field: 'country', message: `Unsupported country: ${country}` });
    }
    if (!locale || !(MARKETING_LOCALES as readonly string[]).includes(locale)) {
      rowErrors.push({ row: rowNumber, field: 'language', message: 'Language must be one of the supported marketing languages' });
    }
    if (serviceValues.length === 0) rowErrors.push({ row: rowNumber, field: 'service', message: 'Service is required' });

    const unresolvedServices = options.resolveService
      ? serviceValues.filter((value) => !options.resolveService?.(value, country))
      : [];
    if (unresolvedServices.length > 0) {
      rowErrors.push({
        row: rowNumber,
        field: 'service',
        message: `Unknown service: ${unresolvedServices.join(', ')}`,
      });
    }
    const serviceKeys = serviceValues
      .map((value) => options.resolveService?.(value, country) || value)
      .filter(Boolean);
    const candidateRow: LeadImportRow = {
      rowNumber,
      email,
      emailNormalized,
      firstName: valueAt(rawRow, 'firstName') || undefined,
      lastName: valueAt(rawRow, 'lastName') || undefined,
      country,
      locale: locale as MarketingLocale,
      serviceValues,
      serviceKeys,
    };
    if (rowErrors.length === 0 && !firstRowByEmail.has(emailNormalized)) {
      firstRowByEmail.set(emailNormalized, candidateRow);
      rows.push(candidateRow);
    } else if (rowErrors.length === 0 && firstRowByEmail.has(emailNormalized)) {
      const firstRow = firstRowByEmail.get(emailNormalized)!;
      if (sameNormalizedImportRow(firstRow, candidateRow)) {
        duplicateRows += 1;
        pushError(errors, { row: rowNumber, field: 'email', message: 'Duplicate email in this workbook; identical row skipped' });
      } else {
        rejectedRows += 1;
        pushError(errors, { row: rowNumber, field: 'email', message: 'Conflicting duplicate email in this workbook; first row kept' });
      }
    }

    if (rowErrors.length > 0) {
      rejectedRows += 1;
      rowErrors.forEach((error) => pushError(errors, error));
    }
  });

  return {
    headers,
    rows,
    errors,
    totalRows: dataRows.length,
    validRows: rows.length,
    duplicateRows,
    rejectedRows,
  };
}
