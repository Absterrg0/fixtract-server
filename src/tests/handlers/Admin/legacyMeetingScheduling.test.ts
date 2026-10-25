import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import type { Request, Response } from 'express';

const {
  meetingRequestFindById,
  userFindById,
  busyConflict,
  adminAvailable,
  releaseReservations,
  reserveKeys,
} = vi.hoisted(() => ({
  meetingRequestFindById: vi.fn(),
  userFindById: vi.fn(),
  busyConflict: vi.fn(),
  adminAvailable: vi.fn(),
  releaseReservations: vi.fn(async () => undefined),
  reserveKeys: vi.fn(async () => undefined),
}));

vi.mock('../../../models/meetingRequest', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../models/meetingRequest')>();
  return {
    ...actual,
    default: { findById: meetingRequestFindById, find: vi.fn() },
  };
});
vi.mock('../../../models/supportTicket', () => ({ default: { find: vi.fn() } }));
vi.mock('../../../models/user', () => ({ default: { findById: userFindById } }));
vi.mock('../../../config/db', () => ({ default: vi.fn(async () => undefined) }));
vi.mock('../../../handlers/User/adminAvailability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../handlers/User/adminAvailability')>();
  return { ...actual, isAdminAvailableForMeeting: adminAvailable };
});
vi.mock('../../../utils/support/availability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../utils/support/availability')>();
  return { ...actual, professionalHasBusyConflict: busyConflict };
});
vi.mock('../../../utils/support/calendarReservations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../utils/support/calendarReservations')>();
  return {
    ...actual,
    releaseCalendarReservations: releaseReservations,
    reserveCalendarKeys: reserveKeys,
  };
});

import { adminUpdateMeetingRequest } from '../../../handlers/Admin/support';

const admin = { _id: new Types.ObjectId('507f1f77bcf86cd799439014'), name: 'Admin' };
const ownerId = new Types.ObjectId('507f1f77bcf86cd799439012');

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

const requestDoc = () => ({
  _id: new Types.ObjectId('507f1f77bcf86cd799439011'),
  userId: ownerId,
  status: 'pending',
  durationMinutes: 30,
  scheduledAt: undefined,
  save: vi.fn(async () => undefined),
});

describe('legacy admin MeetingRequest scheduling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    userFindById.mockReturnValue({
      select: async () => ({
        _id: ownerId,
        name: 'Piet',
        timeZone: 'Europe/Brussels',
        businessInfo: { timezone: 'Europe/Brussels' },
        deletedAt: null,
      }),
    });
    adminAvailable.mockReturnValue(true);
    busyConflict.mockResolvedValue(false);
  });

  it('rejects a slot occupied by a booking/support/Meeting on the professional calendar', async () => {
    const doc = requestDoc();
    meetingRequestFindById.mockResolvedValue(doc);
    busyConflict.mockResolvedValue(true);
    const res = mockRes();

    await adminUpdateMeetingRequest(
      {
        admin,
        params: { id: String(doc._id) },
        body: { status: 'scheduled', scheduledAt: '2030-11-04T09:00:00.000Z' },
      } as unknown as Request,
      res,
    );

    expect(res.statusCode).toBe(409);
    expect(busyConflict).toHaveBeenCalledWith(
      ownerId,
      'Europe/Brussels',
      new Date('2030-11-04T09:00:00.000Z'),
      30,
      undefined,
      expect.objectContaining({
        calendarTimeZone: 'Europe/Brussels',
        excludeMeetingRequestId: String(doc._id),
      }),
    );
    expect(reserveKeys).not.toHaveBeenCalled();
    expect(doc.save).not.toHaveBeenCalled();
  });
});
