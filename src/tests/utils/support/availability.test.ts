import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import type { IUser } from '../../../models/user';
import {
  generateSupportSlots,
  isEligibleSupportAdmin,
  parseSupportAvailabilityRange,
  type SupportAdminLike,
} from '../../../utils/support/availability';

const admin = (
  id: string,
  overrides: Partial<SupportAdminLike> = {},
): SupportAdminLike => ({
  _id: id,
  name: id,
  timeZone: 'UTC',
  adminAvailabilityConfigured: true,
  availability: {
    sunday: { available: true, startTime: '09:00', endTime: '11:00' },
    monday: { available: true, startTime: '09:00', endTime: '11:00' },
  },
  blockedDates: [],
  blockedRanges: [],
  ...overrides,
});

const range = (fromIso: string, toIso: string) => ({
  from: new Date(fromIso),
  to: new Date(toIso),
});

const starts = (slots: ReturnType<typeof generateSupportSlots>) =>
  slots.map((slot) => slot.start);

describe('combined support slot generation', () => {
  it('returns adjacent 30-minute slots that fit the schedule exactly', () => {
    const slots = generateSupportSlots({
      admins: [admin('a1')],
      ...range('2026-11-02T00:00:00.000Z', '2026-11-02T23:59:59.000Z'),
      timeZone: 'UTC',
      now: new Date('2026-10-01T00:00:00.000Z'),
    });
    expect(starts(slots)).toEqual([
      '2026-11-02T09:00:00.000Z',
      '2026-11-02T09:30:00.000Z',
      '2026-11-02T10:00:00.000Z',
      '2026-11-02T10:30:00.000Z',
    ]);
    expect(slots[0]).toMatchObject({
      end: '2026-11-02T09:30:00.000Z',
      localStart: '2026-11-02T09:00:00.000Z',
      adminIds: ['a1'],
    });
  });

  it('uses the union of admins and keeps a slot if one admin is free', () => {
    const blocked = admin('a1', {
      blockedRanges: [
        {
          startDate: new Date('2026-11-02T09:00:00.000Z'),
          endDate: new Date('2026-11-02T10:00:00.000Z'),
        },
      ],
    });
    const slots = generateSupportSlots({
      admins: [blocked, admin('a2')],
      ...range('2026-11-02T00:00:00.000Z', '2026-11-02T23:59:59.000Z'),
      timeZone: 'UTC',
      now: new Date('2026-10-01T00:00:00.000Z'),
    });
    const first = slots.find((slot) => slot.start === '2026-11-02T09:00:00.000Z');
    expect(first?.adminIds).toEqual(['a2']);
  });

  it('removes a slot when every eligible admin is busy with another meeting', () => {
    const busy = new Map([
      ['a1', [{ start: new Date('2026-11-02T09:00:00.000Z').getTime(), end: new Date('2026-11-02T09:30:00.000Z').getTime() }]],
      ['a2', [{ start: new Date('2026-11-02T09:00:00.000Z').getTime(), end: new Date('2026-11-02T09:30:00.000Z').getTime() }]],
    ]);
    const slots = generateSupportSlots({
      admins: [admin('a1'), admin('a2')],
      adminBusy: busy,
      ...range('2026-11-02T00:00:00.000Z', '2026-11-02T23:59:59.000Z'),
      timeZone: 'UTC',
      now: new Date('2026-10-01T00:00:00.000Z'),
    });
    expect(starts(slots)).not.toContain('2026-11-02T09:00:00.000Z');
    expect(starts(slots)).toContain('2026-11-02T09:30:00.000Z');
  });

  it('blocks every slot when the professional is busy', () => {
    const slots = generateSupportSlots({
      admins: [admin('a1')],
      professionalBusy: [
        { start: new Date('2026-11-02T09:00:00.000Z').getTime(), end: new Date('2026-11-02T11:00:00.000Z').getTime() },
      ],
      ...range('2026-11-02T00:00:00.000Z', '2026-11-02T23:59:59.000Z'),
      timeZone: 'UTC',
      now: new Date('2026-10-01T00:00:00.000Z'),
    });
    expect(slots).toEqual([]);
  });

  it('returns no slots when no eligible admin is configured', () => {
    expect(generateSupportSlots({
      admins: [],
      ...range('2026-11-02T00:00:00.000Z', '2026-11-02T23:59:59.000Z'),
      timeZone: 'UTC',
    })).toEqual([]);
  });

  it('removes past slots and slots that would end after the window', () => {
    const slots = generateSupportSlots({
      admins: [admin('a1')],
      ...range('2026-11-02T00:00:00.000Z', '2026-11-02T10:00:00.000Z'),
      timeZone: 'UTC',
      now: new Date('2026-11-02T09:10:00.000Z'),
    });
    expect(starts(slots)).toEqual(['2026-11-02T09:30:00.000Z']);
  });

  it('honours half-hour timezone offsets (Asia/Kolkata) without inventing 15-minute slots', () => {
    const slots = generateSupportSlots({
      admins: [admin('a1', {
        timeZone: 'Asia/Kolkata',
        availability: { monday: { available: true, startTime: '09:00', endTime: '10:00' } },
      })],
      ...range('2026-11-02T00:00:00.000Z', '2026-11-02T23:59:59.000Z'),
      timeZone: 'Europe/Brussels',
      now: new Date('2026-10-01T00:00:00.000Z'),
    });
    expect(starts(slots)).toEqual([
      '2026-11-02T03:30:00.000Z',
      '2026-11-02T04:00:00.000Z',
    ]);
  });

  it('handles DST spring-forward and fall-back in the admin timezone', () => {
    const springRange = {
      from: DateTime.fromISO('2026-03-29T00:00', { zone: 'Europe/Brussels' }).toUTC().toJSDate(),
      to: DateTime.fromISO('2026-03-30T00:00', { zone: 'Europe/Brussels' }).toUTC().toJSDate(),
    };
    const spring = generateSupportSlots({
      admins: [admin('a1', { timeZone: 'Europe/Brussels' })],
      ...springRange,
      timeZone: 'Europe/Brussels',
      now: new Date('2026-03-01T00:00:00.000Z'),
    });
    expect(starts(spring).slice(0, 2)).toEqual([
      '2026-03-29T07:00:00.000Z',
      '2026-03-29T07:30:00.000Z',
    ]);

    const fallRange = {
      from: DateTime.fromISO('2026-10-25T00:00', { zone: 'Europe/Brussels' }).toUTC().toJSDate(),
      to: DateTime.fromISO('2026-10-26T00:00', { zone: 'Europe/Brussels' }).toUTC().toJSDate(),
    };
    const fall = generateSupportSlots({
      admins: [admin('a1', { timeZone: 'Europe/Brussels' })],
      ...fallRange,
      timeZone: 'Europe/Brussels',
      now: new Date('2026-10-01T00:00:00.000Z'),
    });
    expect(starts(fall).slice(0, 2)).toEqual([
      '2026-10-25T08:00:00.000Z',
      '2026-10-25T08:30:00.000Z',
    ]);
  });
});

describe('availability range parsing', () => {
  it('treats date-only ranges as inclusive local days', () => {
    const parsed = parseSupportAvailabilityRange(
      '2026-11-01',
      '2026-11-02',
      'Europe/Brussels',
      new Date('2026-10-01T00:00:00.000Z'),
    );
    expect(parsed.from.toISOString()).toBe('2026-10-31T23:00:00.000Z');
    expect(parsed.to.toISOString()).toBe('2026-11-02T23:00:00.000Z');
  });

  it('rejects invalid zones, reversed ranges and ranges over 31 days', () => {
    expect(() => parseSupportAvailabilityRange('2026-11-01', '2026-11-02', 'Not/AZone')).toThrow(/IANA/);
    expect(() => parseSupportAvailabilityRange('2026-11-02', '2026-11-01', 'UTC')).toThrow(/end of the range/);
    expect(() => parseSupportAvailabilityRange('2026-01-01', '2026-03-01', 'UTC')).toThrow(/31 days/);
  });

  it('accepts a 31-calendar-day window across fall-back and spring-forward DST', () => {
    // 2026-10-25..2026-11-24 is 31 local days but 31d+1h in UTC after the
    // Europe/Brussels fall-back. The old elapsed-time guard rejected it.
    const fall = parseSupportAvailabilityRange(
      '2026-10-25',
      '2026-11-24',
      'Europe/Brussels',
      new Date('2026-10-01T00:00:00.000Z'),
    );
    expect(fall.from.toISOString()).toBe('2026-10-24T22:00:00.000Z');
    expect(fall.to.toISOString()).toBe('2026-11-24T23:00:00.000Z');

    const spring = parseSupportAvailabilityRange(
      '2026-03-01',
      '2026-03-31',
      'Europe/Brussels',
      new Date('2026-02-01T00:00:00.000Z'),
    );
    expect(spring.from.toISOString()).toBe('2026-02-28T23:00:00.000Z');
    expect(spring.to.toISOString()).toBe('2026-03-31T22:00:00.000Z');
  });

  it('still rejects a true 32-calendar-day window and an oversized instant range', () => {
    expect(() => parseSupportAvailabilityRange(
      '2026-10-25',
      '2026-11-25',
      'Europe/Brussels',
    )).toThrow(/31 days/);
    expect(() => parseSupportAvailabilityRange(
      '2026-10-25T00:00:00.000Z',
      '2026-11-26T00:00:00.000Z',
      'Europe/Brussels',
    )).toThrow(/31 days/);
    // Exactly 31 elapsed days is still valid.
    expect(() => parseSupportAvailabilityRange(
      '2026-10-25T00:00:00.000Z',
      '2026-11-25T00:00:00.000Z',
      'Europe/Brussels',
    )).not.toThrow();
  });
});

describe('eligible support admins', () => {
  const levels = { support: 'write' };
  const base = {
    adminRole: 'care' as const,
    adminPermissionLevels: levels,
    adminAvailabilityConfigured: true,
    accountStatus: 'active' as const,
    deletedAt: undefined,
  };

  it('requires an explicitly configured schedule and support write access', () => {
    expect(isEligibleSupportAdmin(base as unknown as IUser, levels)).toBe(true);
    expect(isEligibleSupportAdmin({ ...base, adminAvailabilityConfigured: false } as unknown as IUser, levels)).toBe(false);
    expect(isEligibleSupportAdmin(base as unknown as IUser, { support: 'read' })).toBe(false);
    expect(isEligibleSupportAdmin({ ...base, accountStatus: 'suspended' } as unknown as IUser, levels)).toBe(false);
  });

  it('keeps legacy admins without a role eligible through the super fallback', () => {
    expect(isEligibleSupportAdmin(
      { ...base, adminRole: undefined } as unknown as IUser,
      { support: 'write' },
    )).toBe(true);
  });
});
