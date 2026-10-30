import { beforeEach, describe, expect, it, vi } from 'vitest';

const { supportFind, meetingFind, legacyFind, bookingRanges } = vi.hoisted(() => ({
  supportFind: vi.fn(),
  meetingFind: vi.fn(),
  legacyFind: vi.fn(),
  bookingRanges: vi.fn(async () => []),
}));

vi.mock('../../../models/supportTicket', () => ({ default: { find: supportFind } }));
vi.mock('../../../models/meeting', () => ({ default: { find: meetingFind } }));
vi.mock('../../../models/meetingRequest', () => ({ default: { find: legacyFind } }));
vi.mock('../../../utils/bookingBlocks', () => ({ buildBookingBlockedRanges: bookingRanges }));

import {
  buildAdminBusyIntervals,
  buildProfessionalBusyIntervals,
  generateSupportSlots,
  type SupportAdminLike,
} from '../../../utils/support/availability';

const adminId = '507f1f77bcf86cd799439014';
const professionalId = '507f1f77bcf86cd799439012';
const start = new Date('2026-11-02T09:00:00.000Z');

const chain = (docs: unknown[]) => ({
  select: () => ({ lean: async () => docs }),
});

const admin = (): SupportAdminLike => ({
  _id: adminId,
  name: 'Admin',
  timeZone: 'UTC',
  adminAvailabilityConfigured: true,
  availability: { monday: { available: true, startTime: '09:00', endTime: '11:00' } },
  blockedDates: [],
  blockedRanges: [],
});

const meetingRow = {
  userId: professionalId,
  kind: 'meeting',
  status: 'open',
  meeting: {
    status: 'pending',
    scheduledAt: start,
    durationMinutes: 30,
    adminId,
  },
};

describe('support meetings in existing calendar reads', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    supportFind.mockReturnValue(chain([meetingRow]));
    meetingFind.mockReturnValue(chain([]));
    legacyFind.mockReturnValue(chain([]));
  });

  it('blocks a pending support meeting on the assigned admin calendar', async () => {
    const busy = await buildAdminBusyIntervals([adminId]);
    expect(supportFind).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'meeting',
      'meeting.status': { $in: ['pending', 'scheduled'] },
    }));
    expect(busy.get(adminId)).toEqual([{
      start: start.getTime(),
      end: start.getTime() + 30 * 60 * 1000,
    }]);

    const slots = generateSupportSlots({
      admins: [admin()],
      adminBusy: busy,
      from: new Date('2026-11-02T00:00:00.000Z'),
      to: new Date('2026-11-02T23:59:59.000Z'),
      timeZone: 'UTC',
      now: new Date('2026-10-01T00:00:00.000Z'),
    });
    expect(slots.map((slot) => slot.start)).not.toContain(start.toISOString());
  });

  it('blocks the same pending support meeting on the professional calendar', async () => {
    const busy = await buildProfessionalBusyIntervals(professionalId, 'UTC');
    expect(supportFind).toHaveBeenCalledWith(expect.objectContaining({
      userId: professionalId,
      kind: 'meeting',
      'meeting.status': { $in: ['pending', 'scheduled'] },
    }));
    expect(busy).toContainEqual({
      start: start.getTime(),
      end: start.getTime() + 30 * 60 * 1000,
    });

    const slots = generateSupportSlots({
      admins: [admin()],
      professionalBusy: busy,
      from: new Date('2026-11-02T00:00:00.000Z'),
      to: new Date('2026-11-02T23:59:59.000Z'),
      timeZone: 'UTC',
      now: new Date('2026-10-01T00:00:00.000Z'),
    });
    expect(slots.map((slot) => slot.start)).not.toContain(start.toISOString());
  });

  it('includes the professional bookings/buffers in the same busy set', async () => {
    bookingRanges.mockResolvedValueOnce([
      { startDate: '2026-11-02T11:00:00.000Z', endDate: '2026-11-02T12:00:00.000Z' },
    ]);
    const busy = await buildProfessionalBusyIntervals(professionalId, 'UTC');
    expect(busy).toContainEqual({
      start: new Date('2026-11-02T11:00:00.000Z').getTime(),
      end: new Date('2026-11-02T12:00:00.000Z').getTime(),
    });
  });

  it('interprets legacy Meeting local times in the professional stored timezone, not the display zone', async () => {
    meetingFind.mockReturnValue(chain([{
      professionalId,
      scheduledDate: new Date('2026-11-02T00:00:00.000Z'),
      startTime: '10:00',
      endTime: '11:00',
    }]));

    // Displayed for a New York requester, but the Meeting belongs to a
    // Brussels professional: 10:00 local is 09:00Z, never 15:00Z.
    const busy = await buildProfessionalBusyIntervals(
      professionalId,
      'America/New_York',
      undefined,
      undefined,
      'Europe/Brussels',
    );
    expect(busy).toContainEqual({
      start: new Date('2026-11-02T09:00:00.000Z').getTime(),
      end: new Date('2026-11-02T10:00:00.000Z').getTime(),
    });
    expect(busy).not.toContainEqual(expect.objectContaining({
      start: new Date('2026-11-02T15:00:00.000Z').getTime(),
    }));

    const slots = generateSupportSlots({
      admins: [admin()],
      professionalBusy: busy,
      from: new Date('2026-11-02T09:00:00.000Z'),
      to: new Date('2026-11-02T09:30:00.000Z'),
      timeZone: 'America/New_York',
      now: new Date('2026-10-01T00:00:00.000Z'),
    });
    expect(slots).toEqual([]);
  });
});
