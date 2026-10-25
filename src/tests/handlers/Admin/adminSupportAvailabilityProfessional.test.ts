import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import type { Request, Response } from 'express';

const {
  ticketFindOne,
  legacyFindOne,
  userFindById,
  availability,
  events,
} = vi.hoisted(() => ({
  ticketFindOne: vi.fn(),
  legacyFindOne: vi.fn(),
  userFindById: vi.fn(),
  availability: vi.fn(),
  events: vi.fn(async () => []),
}));

vi.mock('../../../models/supportTicket', () => ({ default: { findOne: ticketFindOne } }));
vi.mock('../../../models/meetingRequest', () => ({ default: { findOne: legacyFindOne } }));
vi.mock('../../../models/user', () => ({ default: { findById: userFindById } }));
vi.mock('../../../config/db', () => ({ default: vi.fn(async () => undefined) }));
vi.mock('../../../utils/support/calendarEvents', () => ({ listSupportCalendarEvents: events }));
vi.mock('../../../utils/support/availability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../utils/support/availability')>();
  return { ...actual, getSupportAvailabilityForAdmin: availability };
});

import { adminGetSupportAvailability } from '../../../handlers/Admin/supportItems';

const admin = { _id: new Types.ObjectId('507f1f77bcf86cd799439014'), name: 'Admin One' };
const professionalId = new Types.ObjectId('507f1f77bcf86cd799439012');
const meetingId = new Types.ObjectId('507f1f77bcf86cd799439011');

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

const leanChain = (value: unknown) => ({
  select: () => ({ lean: async () => value }),
});

describe('admin support availability professional context', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    availability.mockResolvedValue({
      timeZone: 'Europe/Brussels',
      durationMinutes: 30,
      admins: [{ _id: admin._id, name: 'Admin One', timeZone: 'UTC' }],
      slots: [],
    });
    ticketFindOne.mockReturnValue(leanChain({ userId: professionalId }));
    legacyFindOne.mockReturnValue(leanChain(null));
    userFindById.mockReturnValue({
      select: async () => ({
        _id: professionalId,
        name: 'Piet',
        role: 'professional',
        timeZone: 'Europe/Brussels',
        businessInfo: { timezone: 'Europe/Brussels' },
        deletedAt: null,
      }),
    });
  });

  it('loads the meeting owner professional from excludeItemId and returns the source timezone', async () => {
    const res = mockRes();
    await adminGetSupportAvailability(
      {
        admin,
        query: {
          from: '2026-10-25',
          to: '2026-11-24',
          timeZone: 'Europe/Brussels',
          excludeItemId: String(meetingId),
        },
      } as unknown as Request,
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(availability).toHaveBeenCalledWith(expect.objectContaining({
      excludeItemId: String(meetingId),
      professional: expect.objectContaining({ _id: professionalId }),
    }));
    expect(res.body.data.professional).toEqual({
      id: String(professionalId),
      name: 'Piet',
      timeZone: 'Europe/Brussels',
    });
  });

  it('rejects an explicit professionalId that does not own the excluded meeting', async () => {
    const res = mockRes();
    await adminGetSupportAvailability(
      {
        admin,
        query: {
          from: '2026-10-25',
          to: '2026-11-24',
          timeZone: 'Europe/Brussels',
          excludeItemId: String(meetingId),
          professionalId: new Types.ObjectId().toString(),
        },
      } as unknown as Request,
      res,
    );

    expect(res.statusCode).toBe(400);
    expect(availability).not.toHaveBeenCalled();
  });

  it('rejects a missing/deleted selected professional', async () => {
    userFindById.mockReturnValue({ select: async () => null });
    const res = mockRes();
    await adminGetSupportAvailability(
      {
        admin,
        query: {
          from: '2026-10-25',
          to: '2026-11-24',
          timeZone: 'Europe/Brussels',
          professionalId: String(professionalId),
        },
      } as unknown as Request,
      res,
    );
    expect(res.statusCode).toBe(404);
  });
});
