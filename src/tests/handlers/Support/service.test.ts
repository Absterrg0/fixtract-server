import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import { UserFacingError } from '../../../utils/appErrors';

const {
  ticketCreate,
  nextSequence,
  uploadAttachment,
  deleteAttachment,
  resolveBooking,
  sendAck,
  selectSlot,
  reservedCreate,
  assertWritable,
  discardCreation,
} = vi.hoisted(() => ({
  ticketCreate: vi.fn(),
  nextSequence: vi.fn(),
  uploadAttachment: vi.fn(),
  deleteAttachment: vi.fn(),
  resolveBooking: vi.fn(),
  sendAck: vi.fn(),
  selectSlot: vi.fn(),
  reservedCreate: vi.fn(),
  assertWritable: vi.fn(async () => undefined),
  discardCreation: vi.fn(async () => undefined),
}));

vi.mock('../../../models/supportTicket', () => ({
  default: { create: ticketCreate, findOne: vi.fn() },
}));
vi.mock('../../../models/meetingRequest', () => ({ default: { findOne: vi.fn() } }));
vi.mock('../../../utils/counterSequence', () => ({ getNextSequence: nextSequence }));
vi.mock('../../../utils/support/attachments', () => ({
  uploadSupportAttachment: uploadAttachment,
  deleteSupportAttachment: deleteAttachment,
}));
vi.mock('../../../utils/support/bookings', () => ({
  resolveSupportBooking: resolveBooking,
}));
vi.mock('../../../utils/support/emails', () => ({
  sendSupportTicketAcknowledgementEmail: sendAck,
}));
vi.mock('../../../utils/support/meetingReservation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../utils/support/meetingReservation')>();
  return {
    ...actual,
    selectSupportMeetingSlot: selectSlot,
    createReservedSupportMeetingRecord: reservedCreate,
  };
});
vi.mock('../../../utils/support/accountGuard', () => ({
  assertSupportAccountWritable: assertWritable,
  discardSupportCreation: discardCreation,
}));

import { createSupportItemForUser } from '../../../handlers/Support/service';

const userId = new Types.ObjectId('507f1f77bcf86cd799439012');
const customer = {
  _id: userId,
  name: 'Jan',
  email: 'jan@example.com',
  role: 'customer',
  isEmailVerified: true,
  marketingLocale: 'nl',
} as any;
const professional = { ...customer, name: 'Piet', role: 'professional' } as any;

const baseBody = {
  subject: 'Invoice issue',
  description: 'Please help with this invoice',
  reason: 'payment_payout',
  locale: 'en',
};

const createdTicket = (payload: any) => ({
  _id: new Types.ObjectId('507f1f77bcf86cd799439099'),
  ...payload,
  userId,
  replies: [],
  createdAt: new Date(),
  updatedAt: new Date(),
});

describe('create support item service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    assertWritable.mockResolvedValue(undefined);
    discardCreation.mockResolvedValue(undefined);
    nextSequence.mockResolvedValue('SUP-2026-000001');
    ticketCreate.mockImplementation(async ([doc]: any[]) => [createdTicket(doc)]);
    uploadAttachment.mockResolvedValue({
      key: 'support-attachments/user/file.pdf',
      url: 'https://bucket.s3.eu-west-1.amazonaws.com/support-attachments/user/file.pdf',
      name: 'proof.pdf',
      mimeType: 'application/pdf',
      size: 10,
    });
    deleteAttachment.mockResolvedValue(undefined);
    sendAck.mockResolvedValue(true);
    resolveBooking.mockResolvedValue({
      bookingId: '507f1f77bcf86cd799439013',
      bookingNumber: 'BK-2026-000123',
      projectTitle: 'Bathroom',
      counterpartyName: 'Bouw BV',
      label: 'BK-2026-000123 - Bathroom - Bouw BV',
    });
    selectSlot.mockResolvedValue({
      start: new Date('2026-11-04T08:30:00.000Z'),
      end: new Date('2026-11-04T09:00:00.000Z'),
      admin: { _id: '507f1f77bcf86cd799439014' },
      adminIds: ['507f1f77bcf86cd799439014'],
    });
    reservedCreate.mockImplementation(async (input: any) => createdTicket({
      ...input,
      kind: 'meeting',
      status: 'open',
      meeting: { ...input.meeting, status: 'pending', meetingLink: undefined },
      ticketNumber: 'SUP-2026-000002',
    }));
  });

  it('creates a customer ticket with a reason, locale, booking snapshot and attachment', async () => {
    const result = await createSupportItemForUser({
      user: customer,
      body: { ...baseBody, bookingId: '507f1f77bcf86cd799439013' },
      file: { originalname: 'proof.pdf' } as Express.Multer.File,
    });

    expect(ticketCreate).toHaveBeenCalledWith(
      [expect.objectContaining({
        userId,
        kind: 'ticket',
        reason: 'payment_payout',
        userType: 'customer',
        locale: 'en',
        ticketNumber: 'SUP-2026-000001',
        booking: expect.objectContaining({ bookingNumber: 'BK-2026-000123' }),
        attachment: expect.objectContaining({ key: 'support-attachments/user/file.pdf' }),
      })],
      undefined,
    );
    expect(sendAck).toHaveBeenCalledWith(customer, expect.anything(), 'ticket');
    expect(result.emailSent).toBe(true);
  });

  it('accepts the exact English reason label and falls back to the account locale', async () => {
    await createSupportItemForUser({
      user: { ...customer, marketingLocale: 'fr' },
      body: { ...baseBody, reason: 'Technical problem', locale: undefined },
    });
    expect(ticketCreate).toHaveBeenCalledWith(
      [expect.objectContaining({ reason: 'technical_problem', locale: 'fr' })],
      undefined,
    );
  });

  it('requires a valid reason and does not persist invalid requests', async () => {
    await expect(createSupportItemForUser({
      user: customer,
      body: { ...baseBody, reason: '' },
    })).rejects.toMatchObject({ status: 400, code: 'VALIDATION', field: 'reason' });
    await expect(createSupportItemForUser({
      user: customer,
      body: { ...baseBody, reason: 'Payment' },
    })).rejects.toMatchObject({ status: 400, field: 'reason' });
    expect(ticketCreate).not.toHaveBeenCalled();
  });

  it('rejects meetings for customers', async () => {
    await expect(createSupportItemForUser({
      user: customer,
      body: { ...baseBody, kind: 'meeting', scheduledAt: '2026-11-04T08:30:00.000Z', timeZone: 'Europe/Brussels' },
    })).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
    expect(reservedCreate).not.toHaveBeenCalled();
  });

  it('rejects a booking that is not owned by the requester', async () => {
    resolveBooking.mockRejectedValue(new UserFacingError(404, 'Booking not found.', 'NOT_FOUND'));
    await expect(createSupportItemForUser({
      user: customer,
      body: { ...baseBody, bookingId: '507f1f77bcf86cd799439099' },
    })).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect(ticketCreate).not.toHaveBeenCalled();
  });

  it('creates a pending meeting, reserves the real slot, and sends no link or confirmation', async () => {
    const result = await createSupportItemForUser({
      user: professional,
      body: {
        ...baseBody,
        kind: 'meeting',
        scheduledAt: '2026-11-04T08:30:00.000Z',
        timeZone: 'Europe/Brussels',
      },
      file: { originalname: 'proof.pdf' } as Express.Multer.File,
    });

    expect(selectSlot).toHaveBeenCalledWith(expect.objectContaining({
      professional,
      timeZone: 'Europe/Brussels',
      start: new Date('2026-11-04T08:30:00.000Z'),
    }));
    expect(reservedCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'meeting',
        attachment: expect.objectContaining({ key: 'support-attachments/user/file.pdf' }),
        meeting: expect.objectContaining({
          status: 'pending',
          scheduledAt: new Date('2026-11-04T08:30:00.000Z'),
          timeZone: 'Europe/Brussels',
          adminId: new Types.ObjectId('507f1f77bcf86cd799439014'),
          slotKeys: [
            'admin:507f1f77bcf86cd799439014:2026-11-04T08:30:00.000Z',
            'professional:507f1f77bcf86cd799439012:2026-11-04T08:30:00.000Z',
          ],
        }),
      }),
      {
        adminId: '507f1f77bcf86cd799439014',
        professionalId: userId,
        start: new Date('2026-11-04T08:30:00.000Z'),
      },
    );
    expect((reservedCreate.mock.calls[0][0].meeting as Record<string, unknown>).meetingLink).toBeUndefined();
    expect(sendAck).toHaveBeenCalledWith(professional, result.ticket, 'meeting');
    expect(deleteAttachment).not.toHaveBeenCalled();
    expect(result.emailSent).toBe(true);
    expect(result.ticket.meeting?.status).toBe('pending');
    expect(result.ticket.meeting?.meetingLink).toBeUndefined();
  });

  it('keeps the reserved meeting when the acknowledgement email fails', async () => {
    sendAck.mockResolvedValue(false);
    const result = await createSupportItemForUser({
      user: professional,
      body: {
        ...baseBody,
        kind: 'meeting',
        scheduledAt: '2026-11-04T08:30:00.000Z',
        timeZone: 'Europe/Brussels',
      },
    });
    expect(result.ticket).toBeDefined();
    expect(result.emailSent).toBe(false);
    expect(reservedCreate).toHaveBeenCalledTimes(1);
  });

  it('deletes the attachment when meeting slot selection rejects', async () => {
    selectSlot.mockRejectedValue(new UserFacingError(409, 'Slot taken.', 'SLOT_UNAVAILABLE'));
    await expect(createSupportItemForUser({
      user: professional,
      body: {
        ...baseBody,
        kind: 'meeting',
        scheduledAt: '2026-11-04T08:30:00.000Z',
        timeZone: 'Europe/Brussels',
      },
      file: { originalname: 'proof.pdf' } as Express.Multer.File,
    })).rejects.toMatchObject({ status: 409, code: 'SLOT_UNAVAILABLE' });
    expect(reservedCreate).not.toHaveBeenCalled();
    expect(deleteAttachment).toHaveBeenCalledWith('support-attachments/user/file.pdf');
  });

  it('removes a reserved meeting inserted after the owner entered deletion', async () => {
    assertWritable
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new UserFacingError(403, 'Account is being deleted.', 'FORBIDDEN'));

    await expect(createSupportItemForUser({
      user: professional,
      body: {
        ...baseBody,
        kind: 'meeting',
        scheduledAt: '2026-11-04T08:30:00.000Z',
        timeZone: 'Europe/Brussels',
      },
    })).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });

    expect(reservedCreate).toHaveBeenCalledTimes(1);
    expect(discardCreation).toHaveBeenCalledWith(expect.anything());
    expect(sendAck).not.toHaveBeenCalled();
  });

  it('keeps the ticket when the acknowledgement email fails', async () => {
    sendAck.mockResolvedValue(false);
    const result = await createSupportItemForUser({ user: customer, body: baseBody });
    expect(result.ticket).toBeDefined();
    expect(result.emailSent).toBe(false);
  });
});
