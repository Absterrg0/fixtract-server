import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sendEmail, logEmail } = vi.hoisted(() => ({
  sendEmail: vi.fn(async () => true),
  logEmail: vi.fn(async () => undefined),
}));

vi.mock('../../../utils/emailService', () => ({ sendEmail }));
vi.mock('../../../utils/emailLogger', () => ({ logEmail }));

import {
  sendSupportMeetingConfirmedEmail,
  sendSupportMeetingLinkUpdatedEmail,
  sendSupportMeetingRescheduledEmail,
  sendSupportReplyEmail,
  sendSupportTicketAcknowledgementEmail,
} from '../../../utils/support/emails';

const user = {
  _id: '507f1f77bcf86cd799439012',
  name: 'Jan',
  email: 'jan@example.com',
  isEmailVerified: true,
};

const ticket = {
  ticketNumber: 'SUP-2026-000001',
  subject: 'Invoice issue',
  reason: 'payment_payout',
  locale: 'en',
};

describe('support emails', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendEmail.mockResolvedValue(true);
    logEmail.mockResolvedValue(undefined);
  });

  it('sends the localized acknowledgement to the verified account', async () => {
    const sent = await sendSupportTicketAcknowledgementEmail(user, ticket);
    expect(sent).toBe(true);
    expect(sendEmail).toHaveBeenCalledWith(
      'jan@example.com',
      expect.stringContaining('support request'),
      expect.stringContaining('working on your request'),
      expect.objectContaining({ template: 'support_ticket_ack', relatedUser: user._id }),
    );
  });

  it('renders nl/fr copy and keeps the ticket number/reason', async () => {
    await sendSupportTicketAcknowledgementEmail(user, { ...ticket, locale: 'nl' });
    expect(sendEmail.mock.calls[0][1]).toContain('supportaanvraag');
    expect(sendEmail.mock.calls[0][2]).toContain('SUP-2026-000001');
    expect(sendEmail.mock.calls[0][2]).toContain('Betaling / uitbetaling');

    vi.clearAllMocks();
    await sendSupportTicketAcknowledgementEmail(user, { ...ticket, locale: 'fr' });
    expect(sendEmail.mock.calls[0][1]).toContain("demande d'assistance");
  });

  it('HTML-escapes the admin reply body and never adds private fields', async () => {
    await sendSupportReplyEmail(user, ticket, '<script>alert("x")</script> & more');
    const html = sendEmail.mock.calls[0][2] as string;
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('slotKeys');
    expect(html).not.toContain('internalNotes');
  });

  it('does not send to a missing or unverified account, but logs a skipped attempt', async () => {
    const sent = await sendSupportTicketAcknowledgementEmail(
      { ...user, isEmailVerified: false },
      ticket,
    );
    expect(sent).toBe(false);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(logEmail).toHaveBeenCalledWith(expect.objectContaining({
      status: 'skipped',
      template: 'support_ticket_ack',
    }));
  });

  it('returns false on provider failure without throwing', async () => {
    sendEmail.mockResolvedValueOnce(false);
    await expect(sendSupportTicketAcknowledgementEmail(user, ticket)).resolves.toBe(false);
  });

  it('includes the real meeting link and localized time in the confirmation', async () => {
    const sent = await sendSupportMeetingConfirmedEmail(user, {
      ...ticket,
      subject: 'Support meeting',
      locale: 'en',
      meeting: {
        scheduledAt: '2026-11-04T08:30:00.000Z',
        timeZone: 'Europe/Brussels',
        meetingLink: 'https://meet.example/abc',
      },
    });
    expect(sent).toBe(true);
    const html = sendEmail.mock.calls[0][2] as string;
    expect(html).toContain('https://meet.example/abc');
    expect(html).toContain('Europe/Brussels');
  });

  it('sends a truthful meeting acknowledgement without inventing a link', async () => {
    await sendSupportTicketAcknowledgementEmail(user, {
      ...ticket,
      subject: 'Support meeting',
      meeting: {
        scheduledAt: '2026-11-04T08:30:00.000Z',
        timeZone: 'Europe/Brussels',
      },
    }, 'meeting');
    const html = sendEmail.mock.calls[0][2] as string;
    expect(html).toContain('time has been reserved');
    expect(html).toContain('add the meeting link');
    expect(html).not.toContain('<a href="https://');
  });

  it('sends the link-updated email and rejects unsafe links in HTML', async () => {
    await sendSupportMeetingLinkUpdatedEmail(user, {
      ...ticket,
      subject: 'Support meeting',
      meeting: {
        scheduledAt: '2026-11-04T08:30:00.000Z',
        timeZone: 'Europe/Brussels',
        meetingLink: 'javascript:alert(1)',
      },
    });
    const html = sendEmail.mock.calls[0][2] as string;
    expect(html).not.toContain('javascript:alert');
    expect(html).not.toContain('href="javascript:');
  });

  it('rescheduling a pending meeting says the link is still to follow', async () => {
    await sendSupportMeetingRescheduledEmail(user, {
      ...ticket,
      subject: 'Support meeting',
      meeting: {
        scheduledAt: '2026-11-04T08:30:00.000Z',
        previousScheduledAt: '2026-11-03T08:30:00.000Z',
        timeZone: 'Europe/Brussels',
      },
    });
    const html = sendEmail.mock.calls[0][2] as string;
    expect(html).toContain('has not been added yet');
    expect(html).not.toContain('Join meeting');
  });
});
