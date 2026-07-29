import { describe, expect, it } from 'vitest';
import { escapeCsv, buildCsv } from '../../utils/csv';

describe('escapeCsv', () => {
  it('prefixes formula characters at the start of a cell', () => {
    expect(escapeCsv('=1+1')).toBe("'=1+1");
    expect(escapeCsv('+cmd')).toBe("'+cmd");
    expect(escapeCsv('-1+1')).toBe("'-1+1");
    expect(escapeCsv('@SUM(A1)')).toBe("'@SUM(A1)");
  });

  it('neutralizes formulas that start after leading whitespace without trimming', () => {
    expect(escapeCsv(' =1+1')).toBe("' =1+1");
    expect(escapeCsv('  @cmd')).toBe("'  @cmd");
    expect(escapeCsv('\t=1+1')).toBe("'\t=1+1");
  });

  it('quotes cells that contain quotes or commas after neutralization', () => {
    expect(escapeCsv('=HYPERLINK("http://evil")')).toBe("\"'=HYPERLINK(\"\"http://evil\"\")\"");
    expect(escapeCsv(' =HYPERLINK("http://evil")')).toBe("\"' =HYPERLINK(\"\"http://evil\"\")\"");
  });

  it('leaves ordinary values alone', () => {
    expect(escapeCsv('admin@example.com')).toBe('admin@example.com');
    expect(escapeCsv(' hello ')).toBe(' hello ');
  });
});

describe('buildCsv', () => {
  it('escapes formula-like actorEmail and errorMessage cells', () => {
    const csv = buildCsv(
      ['Actor email', 'Error'],
      [[' =HYPERLINK("x")', ' @cmd'], ['ok@example.com', 'plain']]
    );
    expect(csv).toContain("' =HYPERLINK");
    expect(csv).toContain("' @cmd");
    expect(csv).toContain('ok@example.com');
  });
});
