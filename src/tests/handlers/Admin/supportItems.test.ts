import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import type { Request, Response } from 'express';

const { ticketFindOne, noteFind, noteCreate, sendReply, meetingRequestFindOne } = vi.hoisted(() => ({
  ticketFindOne: vi.fn(),
  noteFind: vi.fn(),
  noteCreate: vi.fn(),
  sendReply: vi.fn(),
  meetingRequestFindOne: vi.fn(),
}));

vi.mock('../../../models/supportTicket', () => ({ default: { findOne: ticketFindOne } }));
vi.mock('../../../models/supportTicketInternalNote', () => ({
  default: { find: noteFind, create: noteCreate },
}));
vi.mock('../../../models/meetingRequest', () => ({ default: { findOne: meetingRequestFindOne } }));
vi.mock('../../../config/db', () => ({ default: vi.fn(async () => undefined) }));
vi.mock('../../../utils/support/emails', () => ({ sendSupportReplyEmail: sendReply }));

import {
  adminReplySupportItem,
  adminUpdateSupportItem,
} from '../../../handlers/Admin/supportItems';

const admin = { _id: new Types.ObjectId('507f1f77bcf86cd799439014'), name: 'Admin One' };

const ticketDoc = (overrides: Record<string, unknown> = {}) => {
  const doc: any = {
    _id: new Types.ObjectId('507f1f77bcf86cd799439011'),
    userId: {
      _id: new Types.ObjectId('507f1f77bcf86cd799439012'),
      name: 'Jan',
      email: 'jan@example.com',
      role: 'customer',
      isEmailVerified: true,
    },
    ticketNumber: 'SUP-2026-000001',
    kind: 'ticket',
    subject: 'Invoice issue',
    description: 'Wrong invoice',
    reason: 'payment_payout',
    userType: 'customer',
    locale: 'nl',
    status: 'open',
    replies: [],
    meeting: undefined,
    createdAt: new Date('2026-10-24T09:00:00Z'),
    updatedAt: new Date('2026-10-24T09:00:00Z'),
    save: vi.fn(async () => doc),
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

describe('admin support replies and notes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    noteFind.mockReturnValue(notesChain([]));
    meetingRequestFindOne.mockReturnValue({ populate: async () => null, select: () => ({ lean: async () => null }) });
    sendReply.mockResolvedValue(true);
  });

  it('persists the public admin reply first and then emails the requester', async () => {
    const ticket = ticketDoc();
    ticketFindOne.mockReturnValue({ populate: () => ({ populate: async () => ticket }) });
    const res = mockRes();

    await adminReplySupportItem(
      {
        admin,
        params: { kind: 'ticket', id: String(ticket._id) },
        body: { body: 'We fixed the invoice.' },
      } as unknown as Request,
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(ticket.replies).toHaveLength(1);
    expect(ticket.replies[0]).toMatchObject({ authorRole: 'admin', body: 'We fixed the invoice.' });
    expect(ticket.save).toHaveBeenCalledTimes(1);
    expect(sendReply).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'jan@example.com' }),
      ticket,
      'We fixed the invoice.',
    );
    expect(res.body).toMatchObject({
      success: true,
      emailSent: true,
      data: expect.objectContaining({
        _id: String(ticket._id),
        internalNotes: [],
        replies: [expect.objectContaining({ authorRole: 'admin', body: 'We fixed the invoice.' })],
      }),
    });
  });

  it('blocked reply on a closed ticket is not persisted or emailed', async () => {
    const ticket = ticketDoc({ status: 'closed' });
    ticketFindOne.mockReturnValue({ populate: () => ({ populate: async () => ticket }) });
    const res = mockRes();

    await adminReplySupportItem(
      {
        admin,
        params: { kind: 'ticket', id: String(ticket._id) },
        body: { body: 'Too late' },
      } as unknown as Request,
      res,
    );

    expect(res.statusCode).toBe(400);
    expect(ticket.save).not.toHaveBeenCalled();
    expect(sendReply).not.toHaveBeenCalled();
  });

  it('adds an internal note without emailing it or exposing it to user DTOs', async () => {
    const ticket = ticketDoc();
    ticketFindOne.mockReturnValue({ populate: () => ({ populate: async () => ticket }) });
    const note = {
      _id: new Types.ObjectId('507f1f77bcf86cd799439015'),
      ticketId: ticket._id,
      adminId: admin._id,
      body: 'SECRET: check payout batch',
      createdAt: new Date('2026-10-24T12:00:00Z'),
      toObject: () => ({
        _id: new Types.ObjectId('507f1f77bcf86cd799439015'),
        ticketId: ticket._id,
        adminId: admin._id,
        body: 'SECRET: check payout batch',
        createdAt: new Date('2026-10-24T12:00:00Z'),
      }),
    };
    noteCreate.mockResolvedValue(note);
    noteFind.mockReturnValue(notesChain([note]));
    const res = mockRes();

    await adminUpdateSupportItem(
      {
        admin,
        params: { kind: 'ticket', id: String(ticket._id) },
        body: { internalNote: 'SECRET: check payout batch' },
      } as unknown as Request,
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(noteCreate).toHaveBeenCalledWith(expect.objectContaining({
      ticketId: ticket._id,
      adminId: admin._id,
      body: 'SECRET: check payout batch',
    }));
    expect(sendReply).not.toHaveBeenCalled();
    expect(res.body.data.internalNotes).toEqual([
      expect.objectContaining({ body: 'SECRET: check payout batch' }),
    ]);
  });

  it('the unified PATCH reply path also persists before emailing', async () => {
    const ticket = ticketDoc();
    ticketFindOne.mockReturnValue({ populate: () => ({ populate: async () => ticket }) });
    const res = mockRes();

    await adminUpdateSupportItem(
      {
        admin,
        params: { kind: 'ticket', id: String(ticket._id) },
        body: { reply: 'Public answer' },
      } as unknown as Request,
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(ticket.save).toHaveBeenCalledTimes(1);
    expect(ticket.replies[0]).toMatchObject({ authorRole: 'admin', body: 'Public answer' });
    expect(sendReply).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'jan@example.com' }),
      ticket,
      'Public answer',
    );
    expect(res.body.emailSent).toBe(true);
  });

  it('refuses to close a meeting ticket while the meeting is active', async () => {
    const ticket = ticketDoc({
      kind: 'meeting',
      meeting: { status: 'scheduled', scheduledAt: new Date('2026-11-04T08:30:00Z') },
    });
    ticketFindOne.mockReturnValue({ populate: () => ({ populate: async () => ticket }) });
    const res = mockRes();

    await adminUpdateSupportItem(
      {
        admin,
        params: { kind: 'meeting', id: String(ticket._id) },
        body: { status: 'closed' },
      } as unknown as Request,
      res,
    );

    expect(res.statusCode).toBe(409);
    expect(ticket.save).not.toHaveBeenCalled();
  });
});
