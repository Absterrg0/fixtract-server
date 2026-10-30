import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../utils/support/attachments', () => ({
  presignSupportAttachment: vi.fn(async (url: string) => `https://signed.example/${url.split('/').pop()}`),
}));

import {
  serializeLegacyMeetingRequest,
  serializeSupportTicketsForExport,
  serializeSupportTicketAdmin,
  serializeSupportTicketUser,
} from '../../../utils/support/serializers';

const ticket = (overrides: Record<string, unknown> = {}) => ({
  _id: '507f1f77bcf86cd799439011',
  userId: { _id: '507f1f77bcf86cd799439012', name: 'Jan', email: 'jan@example.com', role: 'customer' },
  ticketNumber: 'SUP-2026-000001',
  kind: 'ticket',
  subject: 'Broken invoice',
  description: 'The invoice is wrong',
  reason: 'payment_payout',
  userType: 'customer',
  locale: 'nl',
  status: 'open',
  booking: {
    bookingId: '507f1f77bcf86cd799439013',
    bookingNumber: 'BK-2026-000123',
    projectTitle: 'Bathroom',
    counterpartyName: 'Bouw BV',
    label: 'BK-2026-000123 - Bathroom - Bouw BV',
  },
  attachment: {
    key: 'support-attachments/user/file.pdf',
    url: 'https://bucket.s3.eu-west-1.amazonaws.com/support-attachments/user/file.pdf',
    name: 'invoice.pdf',
    mimeType: 'application/pdf',
    size: 1234,
  },
  replies: [
    { authorId: '507f1f77bcf86cd799439014', authorRole: 'admin', body: 'We are checking', createdAt: new Date('2026-10-24T10:00:00Z') },
  ],
  createdAt: new Date('2026-10-24T09:00:00Z'),
  updatedAt: new Date('2026-10-24T10:00:00Z'),
  internalNotes: [{ body: 'SECRET NOTE' }],
  ...overrides,
});

describe('support serializers', () => {
  it('returns the user DTO with tags and no private meeting/slot data', async () => {
    const data = await serializeSupportTicketUser(ticket());
    const serialized = JSON.stringify(data);
    expect(data).toMatchObject({
      _id: '507f1f77bcf86cd799439011',
      id: '507f1f77bcf86cd799439011',
      kind: 'ticket',
      ticketNumber: 'SUP-2026-000001',
      reason: 'payment_payout',
      reasonLabel: 'Payment / payout',
      requesterRole: 'customer',
      tags: {
        reason: 'payment_payout',
        userType: 'customer',
        kind: 'ticket',
      },
    });
    expect(serialized).not.toContain('SECRET NOTE');
    expect(serialized).not.toContain('slotKeys');
    expect(serialized).not.toContain('adminId');
    expect(data.attachment.url).toBe('https://signed.example/file.pdf');
    expect(data.attachments).toHaveLength(1);
  });

  it('exposes display status for meetings but never the admin assignment to users', async () => {
    const data = await serializeSupportTicketUser(ticket({
      kind: 'meeting',
      userType: 'professional',
      userId: { _id: 'p1', name: 'Piet', email: 'piet@example.com', role: 'professional' },
      meeting: {
        status: 'scheduled',
        scheduledAt: new Date('2026-11-04T08:30:00Z'),
        durationMinutes: 30,
        timeZone: 'Europe/Brussels',
        adminId: { _id: 'a1', name: 'Admin One', email: 'admin@example.com' },
        meetingLink: 'https://meet.example/abc',
        slotKeys: ['admin:a1:2026-11-04T08:30:00.000Z'],
      },
    }));
    expect(data.status).toBe('scheduled');
    expect(data.ticketStatus).toBe('open');
    expect(data.meeting).toMatchObject({
      status: 'scheduled',
      endAt: '2026-11-04T09:00:00.000Z',
      durationMinutes: 30,
      meetingLink: 'https://meet.example/abc',
      linkActive: true,
      assignedAdminName: null,
    });
    expect(JSON.stringify(data)).not.toContain('slotKeys');
    expect(JSON.stringify(data)).not.toContain('adminId');
  });

  it('shows a pending meeting without a link and hides the admin identity', async () => {
    const data = await serializeSupportTicketUser(ticket({
      kind: 'meeting',
      userType: 'professional',
      userId: { _id: 'p1', name: 'Piet', email: 'piet@example.com', role: 'professional' },
      meeting: {
        status: 'pending',
        scheduledAt: new Date('2030-11-04T08:30:00Z'),
        durationMinutes: 30,
        timeZone: 'Europe/Brussels',
        adminId: { _id: 'a1', name: 'Admin One', email: 'admin@example.com' },
        slotKeys: ['admin:a1:2030-11-04T08:30:00.000Z'],
      },
    }));
    expect(data.status).toBe('pending');
    expect(data.meeting).toMatchObject({
      status: 'pending',
      meetingLink: null,
      linkActive: false,
      confirmationEmailSentAt: null,
      assignedAdminName: null,
    });
    expect(JSON.stringify(data)).not.toContain('Admin One');
    expect(JSON.stringify(data)).not.toContain('slotKeys');
  });

  it('includes private notes only in the admin DTO', async () => {
    const adminData = await serializeSupportTicketAdmin(
      ticket({
        kind: 'meeting',
        userType: 'professional',
        userId: { _id: 'p1', name: 'Piet', email: 'piet@example.com', role: 'professional' },
        meeting: {
          status: 'scheduled',
          scheduledAt: new Date('2026-11-04T08:30:00Z'),
          durationMinutes: 30,
          timeZone: 'Europe/Brussels',
          adminId: { _id: 'a1', name: 'Admin One', email: 'admin@example.com' },
        },
      }),
      [{
        _id: 'note1',
        ticketId: '507f1f77bcf86cd799439011',
        adminId: { _id: 'a1', name: 'Admin One' },
        body: 'SECRET NOTE',
        createdAt: new Date('2026-10-24T11:00:00Z'),
      }],
    );
    expect(adminData.user).toMatchObject({ name: 'Piet', role: 'professional' });
    expect(adminData.meetingAdmin).toMatchObject({ name: 'Admin One' });
    expect(adminData.internalNotes).toEqual([
      expect.objectContaining({ body: 'SECRET NOTE', admin: { _id: 'a1', name: 'Admin One' } }),
    ]);
    expect(adminData.meeting.assignedAdminName).toBe('Admin One');
  });

  it('falls back safely for historical tickets with absent new fields', async () => {
    const data = await serializeSupportTicketUser({
      _id: 'legacy1',
      userId: { _id: 'p1', name: 'Old Pro', email: 'old@example.com', role: 'professional' },
      subject: 'Old ticket',
      description: 'No reason existed',
      status: 'resolved',
      replies: [{ authorId: 'p1', authorRole: 'professional', body: 'reply', createdAt: new Date() }],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(data).toMatchObject({
      kind: 'ticket',
      ticketNumber: null,
      reason: null,
      reasonLabel: null,
      requesterRole: 'professional',
      booking: null,
      attachment: null,
      meeting: null,
    });
  });

  it('adapts legacy MeetingRequest rows read-only', () => {
    const data = serializeLegacyMeetingRequest({
      _id: 'mr1',
      userId: { _id: 'p1', name: 'Old Pro', email: 'old@example.com' },
      topic: 'Talk about a project',
      preferredTimes: 'Monday morning',
      durationMinutes: 45,
      status: 'scheduled',
      adminResponse: 'See you',
      scheduledAt: new Date('2026-11-04T09:00:00Z'),
      createdAt: new Date('2026-10-01T00:00:00Z'),
      updatedAt: new Date('2026-10-02T00:00:00Z'),
    });
    expect(data).toMatchObject({
      kind: 'meeting',
      ticketNumber: null,
      subject: 'Talk about a project',
      description: '',
      reason: null,
      status: 'scheduled',
      meeting: {
        durationMinutes: 45,
        meetingLink: null,
        preferredTimes: 'Monday morning',
        adminResponse: 'See you',
        legacy: true,
      },
    });
  });

  it('never includes a download URL in the GDPR export', async () => {
    const [exported] = await serializeSupportTicketsForExport([ticket()]);
    expect(exported.attachment.url).toBeNull();
    expect(JSON.stringify(exported)).not.toContain('SECRET NOTE');
    expect(JSON.stringify(exported)).not.toContain('slotKeys');
  });
});
