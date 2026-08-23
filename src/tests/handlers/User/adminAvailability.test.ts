import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import type { IUser } from '../../../models/user';
import { isAdminAvailableForMeeting } from '../../../handlers/User/adminAvailability';

const meetingAt = (value: string, timeZone: string) =>
  DateTime.fromISO(value, { zone: timeZone }).toUTC().toJSDate();

describe('admin support meeting availability', () => {
  const admin: Pick<IUser, 'timeZone' | 'adminAvailabilityConfigured' | 'availability' | 'blockedDates' | 'blockedRanges'> = {
    timeZone: 'Europe/Brussels',
    adminAvailabilityConfigured: true,
    availability: {
      monday: { available: true, startTime: '09:00', endTime: '17:00' },
      tuesday: { available: false },
    },
    blockedDates: [],
    blockedRanges: [],
  };

  it('accepts a meeting inside the admin schedule and rejects one outside it', () => {
    expect(isAdminAvailableForMeeting(admin, meetingAt('2026-08-24T10:00', admin.timeZone), 60)).toBe(true);
    expect(isAdminAvailableForMeeting(admin, meetingAt('2026-08-24T16:30', admin.timeZone), 60)).toBe(false);
  });

  it('honours full-day and time-range blocks in the admin timezone', () => {
    expect(isAdminAvailableForMeeting({ ...admin, blockedDates: [{ date: meetingAt('2026-08-24T00:00', admin.timeZone) }] }, meetingAt('2026-08-24T10:00', admin.timeZone), 30)).toBe(false);
    expect(isAdminAvailableForMeeting({ ...admin, blockedRanges: [{ startDate: meetingAt('2026-08-24T11:00', admin.timeZone), endDate: meetingAt('2026-08-24T12:00', admin.timeZone) }] }, meetingAt('2026-08-24T11:30', admin.timeZone), 30)).toBe(false);
  });

  it('keeps legacy admins without a configured weekly schedule available', () => {
    expect(isAdminAvailableForMeeting({ timeZone: 'UTC', blockedDates: [], blockedRanges: [] }, new Date('2026-08-24T10:00:00.000Z'), 30)).toBe(true);
  });

  it('rejects meetings when an explicit all-unavailable schedule was saved', () => {
    expect(
      isAdminAvailableForMeeting(
        {
          timeZone: 'UTC',
          adminAvailabilityConfigured: true,
          availability: {
            monday: { available: false },
            tuesday: { available: false },
            wednesday: { available: false },
            thursday: { available: false },
            friday: { available: false },
            saturday: { available: false },
            sunday: { available: false },
          },
          blockedDates: [],
          blockedRanges: [],
        },
        new Date('2026-08-24T10:00:00.000Z'),
        30,
      ),
    ).toBe(false);
  });

  it('rejects meetings that continue into a blocked date', () => {
    expect(
      isAdminAvailableForMeeting(
        {
          ...admin,
          blockedDates: [{ date: meetingAt('2026-08-25T00:00', admin.timeZone) }],
        },
        meetingAt('2026-08-24T23:30', admin.timeZone),
        60,
      ),
    ).toBe(false);
  });
});
