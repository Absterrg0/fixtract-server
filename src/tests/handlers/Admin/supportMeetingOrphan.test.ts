import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import type { Request, Response } from 'express';

const {
  ticketFindOne,
  noteFind,
  meetingRequestFindOne,
  userFindById,
  cancelMeeting,
  completeMeeting,
} = vi.hoisted(() => ({
  ticketFindOne: vi.fn(),
  noteFind: vi.fn(),
  meetingRequestFindOne: vi.fn(),
  userFindById: vi.fn(),
  cancelMeeting: vi.fn(),
  completeMeeting: vi.fn(),
}));

vi.mock('../../../models/supportTicket', () => ({ default: { findOne: ticketFindOne } }));
vi.mock('../../../models/supportTicketInternalNote', () => ({
  default: { find: noteFind, create: vi.fn() },
}));
vi.mock('../../../models/meetingRequest', () => ({ default: { findOne: meetingRequestFindOne } }));
vi.mock('../../../models/user', () => ({ default: { findById: userFindById } }));
vi.mock('../../../config/db', () => ({ default: vi.fn(async () => undefined) }));
vi.mock('../../../utils/support/meetingReservation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../utils/support/meetingReservation')>();
  return {
    ...actual,
    cancelSupportMeeting: cancelMeeting,
    completeSupportMeeting: completeMeeting,
  };
});

import { adminUpdateSupportMeeting } from '../../../handlers/Admin/supportItems';

const admin = { _id: new Types.ObjectId('507f1f77bcf86cd799439014'), name: 'Admin One' };

const orphanTicket = () => ({
  _id: new Types.ObjectId('507f1f77bcf86cd799439011'),
  userId: new Types.ObjectId('507f1f77bcf86cd799439012'),
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
    adminId: admin._id,
  },
  createdAt: new Date('2026-10-24T09:00:00Z'),
  updatedAt: new Date('2026-10-24T09:00:00Z'),
});

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

const notesChain = () => ({
  populate: () => ({ sort: () => ({ lean: async () => [] }) }),
});

describe('admin meeting cleanup with a hard-deleted owner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    noteFind.mockReturnValue(notesChain());
    meetingRequestFindOne.mockReturnValue({ select: () => ({ lean: async () => null }) });
    userFindById.mockReturnValue({ select: async () => null });
  });

  it('cancels an orphaned meeting and releases reservations without a 404', async () => {
    const ticket = orphanTicket();
    ticketFindOne.mockReturnValue({ populate: () => ({ populate: async () => ticket }) });
    const cancelled = { ...ticket, status: 'closed', meeting: { ...ticket.meeting, status: 'cancelled' } };
    cancelMeeting.mockResolvedValue({
      ticket: cancelled,
      emailSent: false,
      emailAttempted: false,
    });
    const res = mockRes();

    await adminUpdateSupportMeeting(
      {
        admin,
        params: { kind: 'meeting', id: String(ticket._id) },
        body: { meeting: { action: 'cancel', reason: 'owner deleted' } },
      } as unknown as Request,
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(cancelMeeting).toHaveBeenCalledWith(expect.objectContaining({
      ticket,
      owner: null,
      actorRole: 'admin',
      allowPast: true,
    }));
    expect(res.body).toMatchObject({
      success: true,
      data: expect.objectContaining({
        meeting: expect.objectContaining({ status: 'cancelled' }),
      }),
    });
    expect(res.body).not.toHaveProperty('emailSent');
  });

  it('completes an orphaned confirmed meeting without requiring an owner', async () => {
    const ticket = orphanTicket();
    ticket.meeting.status = 'scheduled';
    ticket.meeting.meetingLink = 'https://meet.example/room';
    ticketFindOne.mockReturnValue({ populate: () => ({ populate: async () => ticket }) });
    completeMeeting.mockResolvedValue({
      ...ticket,
      status: 'resolved',
      meeting: { ...ticket.meeting, status: 'completed' },
    });
    const res = mockRes();

    await adminUpdateSupportMeeting(
      {
        admin,
        params: { kind: 'meeting', id: String(ticket._id) },
        body: { meeting: { action: 'complete' } },
      } as unknown as Request,
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(completeMeeting).toHaveBeenCalledWith(expect.objectContaining({ ticket }));
    expect(userFindById).not.toHaveBeenCalled();
    expect(res.body).toMatchObject({
      success: true,
      data: expect.objectContaining({
        meeting: expect.objectContaining({ status: 'completed' }),
      }),
    });
  });

  it('still requires a resolvable owner for a link confirmation', async () => {
    const ticket = orphanTicket();
    ticketFindOne.mockReturnValue({ populate: () => ({ populate: async () => ticket }) });
    const res = mockRes();

    await adminUpdateSupportMeeting(
      {
        admin,
        params: { kind: 'meeting', id: String(ticket._id) },
        body: { meeting: { action: 'set_link', meetingLink: 'https://meet.example/room' } },
      } as unknown as Request,
      res,
    );

    expect(res.statusCode).toBe(404);
    expect(cancelMeeting).not.toHaveBeenCalled();
  });
});
