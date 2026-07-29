import { describe, expect, it } from 'vitest';
import { toDate, toISOString } from '../dateUtils';

describe('toDate', () => {
  it('parses ISO strings and Date instances', () => {
    const fromString = toDate('2026-07-25T00:00:00.000Z');
    expect(fromString).toBeInstanceOf(Date);
    expect(fromString?.toISOString()).toBe('2026-07-25T00:00:00.000Z');

    const source = new Date('2026-01-01T12:00:00.000Z');
    expect(toDate(source)?.getTime()).toBe(source.getTime());
  });

  it('parses Mongo extended JSON', () => {
    const parsed = toDate({ $date: '2026-07-25T00:00:00.000Z' });
    expect(parsed?.toISOString()).toBe('2026-07-25T00:00:00.000Z');
  });

  it('returns null for invalid input', () => {
    expect(toDate(null)).toBeNull();
    expect(toDate(undefined)).toBeNull();
    expect(toDate('not-a-date')).toBeNull();
    expect(toDate(new Date('invalid'))).toBeNull();
    expect(toDate('2026-02-30T00:00:00.000Z')).toBeNull();
    expect(toDate('2026-02-30')).toBeNull();
    expect(toDate({ $date: '2026-02-30T00:00:00.000Z' })).toBeNull();
  });

  it('accepts offset-bearing ISO timestamps whose UTC day differs', () => {
    const parsed = toDate('2026-07-25T00:30:00+01:00');
    expect(parsed?.toISOString()).toBe('2026-07-24T23:30:00.000Z');
  });

  it('rejects offset-less date-time strings', () => {
    expect(toDate('2026-07-25T10:00:00')).toBeNull();
    expect(toDate({ $date: '2026-07-25T10:00:00' })).toBeNull();
  });

  it('powers toISOString', () => {
    expect(toISOString('2026-07-25T00:00:00.000Z')).toBe('2026-07-25T00:00:00.000Z');
    expect(toISOString('nope')).toBeNull();
  });
});
