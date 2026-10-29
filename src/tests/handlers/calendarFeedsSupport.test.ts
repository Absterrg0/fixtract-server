import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

const {
  meetingFind,
  userFindById,
  supportEvents,
  effectiveAccess,
} = vi.hoisted(() => ({
  meetingFind: vi.fn(),
  userFindById: vi.fn(),
  supportEvents: vi.fn(),
  effectiveAccess: vi.fn(),
}));

vi.mock('../../models/meeting', () => ({ default: { find: meetingFind } }));
vi.mock('../../models/user', () => ({ default: { findById: userFindById } }));
vi.mock('../../utils/bookingBlocks', () => ({ buildBookingBlockedRanges: vi.fn(async () => []) }));
vi.mock('../../utils/support/calendarEvents', () => ({
  listSupportCalendarEvents: supportEvents,
}));
vi.mock('../../utils/adminRbac/roleAccess', () => ({
  getEffectiveAccessForUser: effectiveAccess,
}));

import { getAllMeetings } from '../../handlers/Meeting';
import { getAdminAvailability } from '../../handlers/User/adminAvailability';

const professionalId = '507f1f77bcf86cd799439012';

const mockRes = () => {
  const res = {
    statusCode: 200,
    body: undefined as any,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res as Response & { statusCode: number; body: any };
};

const meetingsChain = () => ({
  sort: () => ({ select: async () => [] }),
});

const supportEvent = {
  source: 'support',
  kind: 'meeting',
  id: '665000000000000000000001',
  ticketNumber: 'SUP-2026-000001',
  subject: 'Support meeting',
  status: 'pending',
  ticketStatus: 'open',
  start: '2030-11-04T08:30:00.000Z',
  end: '2030-11-04T09:00:00.000Z',
  localStart: '2030-11-04T09:30:00.000+01:00',
  localEnd: '2030-11-04T10:00:00.000+01:00',
  displayTimeZone: 'Europe/Brussels',
  timeZone: 'Europe/Brussels',
  durationMinutes: 30,
  meetingLink: null,
  linkActive: false,
  legacy: false,
};

describe('normal calendar readers include support events', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    meetingFind.mockReturnValue(meetingsChain());
    userFindById.mockReturnValue({
      select: async () => ({ timeZone: 'Europe/Brussels', businessInfo: { timezone: 'Europe/Brussels' } }),
    });
    supportEvents.mockResolvedValue([supportEvent]);
    effectiveAccess.mockResolvedValue({ support: 'read' });
  });

  it('GET /api/meetings keeps data and adds owner-safe supportEvents', async () => {
    const res = mockRes();
    await getAllMeetings(
      {
        user: { professionalId },
        query: { startDate: '2030-11-04', endDate: '2030-11-05' },
      } as unknown as Request,
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.supportEvents).toEqual([supportEvent]);
    expect(supportEvents).toHaveBeenCalledWith(expect.objectContaining({
      viewer: 'professional',
      userId: professionalId,
      timeZone: 'Europe/Brussels',
    }));
  });

  it('GET /api/user/admin/availability adds support events for support-read admins only', async () => {
    const res = mockRes();
    await getAdminAvailability(
      {
        user: {
          _id: '665000000000000000000002',
          role: 'admin',
          timeZone: 'Europe/Brussels',
        },
        query: { from: '2030-11-04', to: '2030-11-05' },
      } as unknown as Request,
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.data.events).toEqual([supportEvent]);
    expect(res.body.data.supportEvents).toEqual([supportEvent]);

    effectiveAccess.mockResolvedValue({ bookings: 'read' });
    supportEvents.mockClear();
    const noSupportRes = mockRes();
    await getAdminAvailability(
      {
        user: {
          _id: '665000000000000000000003',
          role: 'admin',
          timeZone: 'Europe/Brussels',
        },
        query: { from: '2030-11-04', to: '2030-11-05' },
      } as unknown as Request,
      noSupportRes,
    );
    expect(noSupportRes.statusCode).toBe(200);
    expect(noSupportRes.body.data.events).toEqual([]);
    expect(supportEvents).not.toHaveBeenCalled();
  });
});
