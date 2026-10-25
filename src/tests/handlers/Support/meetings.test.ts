import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import type { Request, Response } from 'express';

const { ticketFindOne, legacyFindOne, cancelMeeting, calendarEvents, availability } = vi.hoisted(() => ({
  ticketFindOne: vi.fn(),
  legacyFindOne: vi.fn(),
  cancelMeeting: vi.fn(),
  calendarEvents: vi.fn(async () => []),
  availability: vi.fn(),
}));

vi.mock('../../../models/supportTicket', () => ({ default: { findOne: ticketFindOne } }));
vi.mock('../../../models/meetingRequest', () => ({ default: { findOne: legacyFindOne } }));
vi.mock('../../../config/db', () => ({ default: vi.fn(async () => undefined) }));
vi.mock('../../../utils/support/bookings', () => ({
  resolveSupportBooking: vi.fn(),
  listSupportBookingOptions: vi.fn(async () => []),
}));
vi.mock('../../../utils/support/meetingReservation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../utils/support/meetingReservation')>();
  return { ...actual, cancelSupportMeeting: cancelMeeting };
});
vi.mock('../../../utils/support/calendarEvents', () => ({ listSupportCalendarEvents: calendarEvents }));
vi.mock('../../../utils/support/availability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../utils/support/availability')>();
  return { ...actual, getSupportAvailabilityForProfessional: availability };
});

import { getSupportMeetingAvailability, updateSupportItemMeeting } from '../../../handlers/Support/meetings';

const ownerId = new Types.ObjectId('507f1f77bcf86cd799439012');

const meetingTicket = (overrides: Record<string, unknown> = {}) => {
  const doc: any = {
    _id: new Types.ObjectId('507f1f77bcf86cd799439011'),
    userId: { _id: ownerId, name: 'Piet', email: 'piet@example.com', role: 'professional' },
    ticketNumber: 'SUP-2026-000001',
    kind: 'meeting',
    subject: 'Support meeting',
    description: 'Need help',
    reason: 'technical_problem',
    userType: 'professional',
    locale: 'en',
    status: 'open',
    replies: [],
    meeting: {
      status: 'pending',
      scheduledAt: new Date('2030-11-04T08:30:00.000Z'),
      durationMinutes: 30,
      timeZone: 'Europe/Brussels',
      adminId: new Types.ObjectId('507f1f77bcf86cd799439014'),
      slotKeys: ['admin:slot', 'professional:slot'],
    },
    createdAt: new Date('2026-10-24T09:00:00Z'),
    updatedAt: new Date('2026-10-24T09:00:00Z'),
    save: vi.fn(async () => doc),
    markModified: vi.fn(),
    ...overrides,
  };
  return doc;
};

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

describe('owner meeting updates after a role change', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cancelMeeting.mockImplementation(async ({ ticket }: any) => {
      ticket.meeting.status = 'cancelled';
      ticket.status = 'closed';
      return { ticket, emailSent: true };
    });
    legacyFindOne.mockReturnValue({ select: () => ({ lean: async () => null }) });
  });

  it('lets a former professional (now customer) cancel their existing meeting', async () => {
    const ticket = meetingTicket({ userType: 'professional' });
    ticketFindOne.mockReturnValue({ populate: async () => ticket });
    const res = mockRes();

    await updateSupportItemMeeting(
      {
        user: { _id: ownerId, name: 'Piet', email: 'piet@example.com', role: 'customer' },
        params: { kind: 'meeting', id: String(ticket._id) },
        body: { meeting: { action: 'cancel', reason: 'No longer needed' } },
      } as unknown as Request,
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(cancelMeeting).toHaveBeenCalledWith(expect.objectContaining({
      ticket,
      actorRole: 'user',
    }));
    expect(res.body.data.meeting.status).toBe('cancelled');
  });

  it('keeps rescheduling professional-only after a role change', async () => {
    const ticket = meetingTicket();
    ticketFindOne.mockReturnValue({ populate: async () => ticket });
    const res = mockRes();

    await updateSupportItemMeeting(
      {
        user: { _id: ownerId, name: 'Piet', email: 'piet@example.com', role: 'customer' },
        params: { kind: 'meeting', id: String(ticket._id) },
        body: { meeting: { action: 'reschedule', scheduledAt: '2030-11-05T09:00:00.000Z' } },
      } as unknown as Request,
      res,
    );

    expect(res.statusCode).toBe(403);
    expect(cancelMeeting).not.toHaveBeenCalled();
  });

  it('returns owner-safe support calendar events with availability slots', async () => {
    availability.mockResolvedValue({
      timeZone: 'UTC',
      durationMinutes: 30,
      admins: [],
      slots: [{
        start: '2030-11-04T08:30:00.000Z',
        end: '2030-11-04T09:00:00.000Z',
        localStart: '2030-11-04T08:30:00.000Z',
        localEnd: '2030-11-04T09:00:00.000Z',
        adminIds: [],
      }],
    });
    calendarEvents.mockResolvedValue([{
      source: 'support',
      kind: 'meeting',
      id: 't1',
      status: 'pending',
      start: '2030-11-04T08:30:00.000Z',
      meetingLink: null,
      linkActive: false,
    }]);
    const res = mockRes();

    await getSupportMeetingAvailability(
      {
        user: { _id: ownerId, role: 'professional', name: 'Piet', email: 'piet@example.com', timeZone: 'UTC' },
        query: { from: '2030-11-01', to: '2030-11-08', timeZone: 'UTC' },
      } as unknown as Request,
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(calendarEvents).toHaveBeenCalledWith(expect.objectContaining({
      viewer: 'professional',
      userId: String(ownerId),
      timeZone: 'UTC',
    }));
    expect(res.body.data.slots).toHaveLength(1);
    expect(res.body.data.events).toEqual([
      expect.objectContaining({ id: 't1', linkActive: false }),
    ]);
  });

  it('keeps historical MeetingRequest rows read-only', async () => {
    ticketFindOne.mockReturnValue({ populate: async () => null });
    legacyFindOne.mockReturnValue({ select: () => ({ lean: async () => ({ _id: 'mr1' }) }) });
    const res = mockRes();

    await updateSupportItemMeeting(
      {
        user: { _id: ownerId, name: 'Piet', email: 'piet@example.com', role: 'professional' },
        params: { kind: 'meeting', id: String(new Types.ObjectId()) },
        body: { meeting: { action: 'cancel' } },
      } as unknown as Request,
      res,
    );

    expect(res.statusCode).toBe(409);
  });
});
