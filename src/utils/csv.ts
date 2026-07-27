export const escapeCsv = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  let str = String(value);
  // Neutralize spreadsheet formulas even when preceded by leading whitespace.
  if (/^\s*[=+\-@\t\r]/.test(str)) {
    str = `'${str.trimStart()}`;
  }
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
};

export const buildCsv = (headers: string[], rows: unknown[][]): string => {
  const lines = [headers.map(escapeCsv).join(',')];
  for (const row of rows) {
    lines.push(row.map(escapeCsv).join(','));
  }
  return lines.join('\r\n');
};
