import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import type { Request, Response } from 'express';

const {
  ticketFindOne,
  noteFind,
  meetingRequestFindOne,
  userFindById,
  setLink,
} = vi.hoisted(() => ({
  ticketFindOne: vi.fn(),
  noteFind: vi.fn(),
  meetingRequestFindOne: vi.fn(),
  userFindById: vi.fn(),
  setLink: vi.fn(),
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
  return { ...actual, setSupportMeetingLink: setLink };
});

import { adminUpdateSupportMeeting } from '../../../handlers/Admin/supportItems';

const admin = { _id: new Types.ObjectId('507f1f77bcf86cd799439014'), name: 'Admin One' };
const owner = {
  _id: new Types.ObjectId('507f1f77bcf86cd799439012'),
  name: 'Piet',
  email: 'piet@example.com',
  isEmailVerified: true,
  timeZone: 'Europe/Brussels',
};

const meetingTicket = (overrides: Record<string, unknown> = {}) => {
  const doc: any = {
    _id: new Types.ObjectId('507f1f77bcf86cd799439011'),
    userId: { _id: owner._id, name: owner.name, email: owner.email, role: 'professional' },
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

const notesChain = (notes: unknown[] = []) => ({
  populate: () => ({ sort: () => ({ lean: async () => notes }) }),
});

describe('admin manual meeting link action', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    noteFind.mockReturnValue(notesChain([]));
    meetingRequestFindOne.mockReturnValue({ select: () => ({ lean: async () => null }) });
    userFindById.mockReturnValue({ select: async () => owner });
  });

  it('sets the link through the support-write meeting endpoint action', async () => {
    const ticket = meetingTicket();
    ticketFindOne.mockReturnValue({ populate: () => ({ populate: async () => ticket }) });
    setLink.mockImplementation(async ({ ticket: current }: any) => {
      current.meeting.meetingLink = 'https://meet.example/room';
      current.meeting.status = 'scheduled';
      return { ticket: current, emailSent: true, emailAttempted: true, unchanged: false };
    });
    const res = mockRes();

    await adminUpdateSupportMeeting(
      {
        admin,
        params: { kind: 'meeting', id: String(ticket._id) },
        body: { meeting: { action: 'set_link', meetingLink: 'https://meet.example/room' } },
      } as unknown as Request,
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(setLink).toHaveBeenCalledWith(expect.objectContaining({
      ticket,
      adminId: admin._id,
      owner,
      meetingLink: 'https://meet.example/room',
    }));
    expect(res.body).toMatchObject({
      success: true,
      emailSent: true,
      unchanged: false,
      data: expect.objectContaining({
        meeting: expect.objectContaining({
          status: 'scheduled',
          meetingLink: 'https://meet.example/room',
        }),
      }),
    });
  });

  it('treats a bare meetingLink as set_link for older editors', async () => {
    const ticket = meetingTicket();
    ticketFindOne.mockReturnValue({ populate: () => ({ populate: async () => ticket }) });
    setLink.mockImplementation(async ({ ticket: current }: any) => ({
      ticket: current,
      emailSent: true,
      emailAttempted: true,
      unchanged: false,
    }));
    const res = mockRes();

    await adminUpdateSupportMeeting(
      {
        admin,
        params: { kind: 'meeting', id: String(ticket._id) },
        body: { meeting: { meetingLink: 'https://meet.example/room' } },
      } as unknown as Request,
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(setLink).toHaveBeenCalledWith(expect.objectContaining({
      meetingLink: 'https://meet.example/room',
    }));
    expect(res.body.emailSent).toBe(true);
  });

  it('omits emailSent when the same link needs no email', async () => {
    const ticket = meetingTicket();
    ticketFindOne.mockReturnValue({ populate: () => ({ populate: async () => ticket }) });
    setLink.mockResolvedValue({
      ticket,
      emailSent: false,
      emailAttempted: false,
      unchanged: true,
    });
    const res = mockRes();

    await adminUpdateSupportMeeting(
      {
        admin,
        params: { kind: 'meeting', id: String(ticket._id) },
        body: { meeting: { action: 'set_link', meetingLink: 'https://meet.example/room' } },
      } as unknown as Request,
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.unchanged).toBe(true);
    expect(res.body).not.toHaveProperty('emailSent');
  });
});
