import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';

const { userFind, supportFind, meetingFind, legacyFind, bookingRanges } = vi.hoisted(() => ({
  userFind: vi.fn(),
  supportFind: vi.fn(),
  meetingFind: vi.fn(),
  legacyFind: vi.fn(),
  bookingRanges: vi.fn(async () => []),
}));

vi.mock('../../../models/user', () => ({ default: { find: userFind } }));
vi.mock('../../../models/supportTicket', () => ({ default: { find: supportFind } }));
vi.mock('../../../models/meeting', () => ({ default: { find: meetingFind } }));
vi.mock('../../../models/meetingRequest', () => ({ default: { find: legacyFind } }));
vi.mock('../../../utils/bookingBlocks', () => ({ buildBookingBlockedRanges: bookingRanges }));

import { getSupportAvailabilityForAdmin } from '../../../utils/support/availability';

const adminId = '507f1f77bcf86cd799439014';
const otherAdminId = '507f1f77bcf86cd799439015';
const professionalId = '507f1f77bcf86cd799439012';
const meetingStart = new Date('2026-11-02T09:00:00.000Z');

const chain = (docs: unknown[]) => ({
  select: () => ({ lean: async () => docs }),
});

const adminRow = {
  _id: new Types.ObjectId(adminId),
  name: 'Admin',
  email: 'admin@example.com',
  timeZone: 'UTC',
  adminRole: 'care',
  adminPermissionLevels: { support: 'write' },
  accountStatus: 'active',
  deletedAt: null,
  adminAvailabilityConfigured: true,
  availability: { monday: { available: true, startTime: '09:00', endTime: '11:00' } },
  blockedDates: [],
  blockedRanges: [],
};

const professional = {
  _id: professionalId,
  name: 'Piet',
  timeZone: 'UTC',
  businessInfo: { timezone: 'UTC' },
};

const supportMeeting = {
  _id: new Types.ObjectId('507f1f77bcf86cd799439011'),
  userId: professionalId,
  kind: 'meeting',
  status: 'open',
  meeting: {
    status: 'pending',
    scheduledAt: meetingStart,
    durationMinutes: 30,
    adminId: new Types.ObjectId(otherAdminId),
  },
};

describe('admin support availability selected professional', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    userFind.mockReturnValue(chain([adminRow]));
    supportFind.mockImplementation((filter: any) => {
      const adminFilter = JSON.stringify(filter?.['meeting.adminId'] || {});
      return chain(adminFilter.includes(adminId) ? [] : [supportMeeting]);
    });
    meetingFind.mockReturnValue(chain([]));
    legacyFind.mockReturnValue(chain([]));
  });

  it('blocks a slot that is busy on the selected professional calendar even though the admin is free', async () => {
    const adminOnly = await getSupportAvailabilityForAdmin({
      from: new Date('2026-11-02T00:00:00.000Z'),
      to: new Date('2026-11-02T23:59:59.000Z'),
      timeZone: 'UTC',
      now: new Date('2026-10-01T00:00:00.000Z'),
    });
    expect(adminOnly.slots.map((slot) => slot.start)).toContain(meetingStart.toISOString());

    const combined = await getSupportAvailabilityForAdmin({
      from: new Date('2026-11-02T00:00:00.000Z'),
      to: new Date('2026-11-02T23:59:59.000Z'),
      timeZone: 'UTC',
      professional,
      now: new Date('2026-10-01T00:00:00.000Z'),
    });
    expect(combined.slots.map((slot) => slot.start)).not.toContain(meetingStart.toISOString());
  });
});
