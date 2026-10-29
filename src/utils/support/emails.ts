import { normalizeSupportLocale } from "../../constants/support";
import { sendEmail } from "../emailService";
import { logEmail } from "../emailLogger";
import {
  localizedSupportReasonLabel,
  renderSupportEmail,
  type SupportEmailTemplateId,
} from "./emailTemplates";

export interface SupportEmailUser {
  _id?: unknown;
  name?: string;
  email?: string;
  isEmailVerified?: boolean;
  deletedAt?: Date | null;
}

export interface SupportEmailTicket {
  ticketNumber?: string | null;
  subject?: string | null;
  reason?: string | null;
  locale?: string | null;
  booking?: { bookingId?: unknown } | null;
  meeting?: {
    scheduledAt?: Date | string | null;
    timeZone?: string | null;
    meetingLink?: string | null;
    cancellationReason?: string | null;
    previousScheduledAt?: Date | string | null;
    previousTimeZone?: string | null;
  } | null;
}

function baseInput(user: SupportEmailUser, ticket: SupportEmailTicket) {
  const locale = normalizeSupportLocale(ticket.locale);
  return {
    locale,
    userName: user.name || null,
    ticketNumber: ticket.ticketNumber || null,
    subject: ticket.subject || null,
    reasonLabel: localizedSupportReasonLabel(ticket.reason, locale),
  };
}

function readyRecipient(user: SupportEmailUser): string | null {
  const email = typeof user.email === "string" ? user.email.trim() : "";
  if (!email) return null;
  if (user.deletedAt) return null;
  if (user.isEmailVerified !== true) return null;
  return email;
}

async function deliver(
  user: SupportEmailUser | null | undefined,
  ticket: SupportEmailTicket,
  template: SupportEmailTemplateId,
  input: Record<string, unknown>,
): Promise<boolean> {
  const safeUser = user || {};
  const to = readyRecipient(safeUser);
  const rendered = renderSupportEmail(template, {
    ...baseInput(safeUser, ticket),
    ...input,
  } as never);
  const relatedUser = safeUser._id as string | { toString(): string } | undefined;
  const relatedBooking = ticket.booking?.bookingId as string | { toString(): string } | undefined;
  if (!to) {
    await logEmail({
      to: typeof safeUser.email === "string" ? safeUser.email : "unknown",
      subject: rendered.subject,
      template,
      status: "skipped",
      errorMessage: "Account email is missing, deleted, or not verified",
      relatedUser: relatedUser as never,
      relatedBooking: relatedBooking as never,
    });
    return false;
  }
  try {
    return await sendEmail(to, rendered.subject, rendered.html, {
      template,
      // Support emails can contain meeting links with query tokens.
      redactLogUrls: true,
      ...(relatedUser ? { relatedUser: relatedUser as never } : {}),
      ...(relatedBooking ? { relatedBooking: relatedBooking as never } : {}),
    });
  } catch (error) {
    // Never log provider error bodies: they can echo the rendered message,
    // including a meeting link and its query parameters.
    console.error(`Support email ${template} failed`);
    return false;
  }
}

export function sendSupportTicketAcknowledgementEmail(
  user: SupportEmailUser,
  ticket: SupportEmailTicket,
  kind: "ticket" | "meeting" = "ticket",
): Promise<boolean> {
  return deliver(
    user,
    ticket,
    kind === "meeting" ? "support_meeting_ack" : "support_ticket_ack",
    kind === "meeting"
      ? {
          meetingAt: ticket.meeting?.scheduledAt || null,
          timeZone: ticket.meeting?.timeZone || null,
        }
      : {},
  );
}

export function sendSupportReplyEmail(
  user: SupportEmailUser,
  ticket: SupportEmailTicket,
  replyBody: string,
): Promise<boolean> {
  return deliver(user, ticket, "support_ticket_reply", { replyBody });
}

export function sendSupportMeetingConfirmedEmail(
  user: SupportEmailUser,
  ticket: SupportEmailTicket,
): Promise<boolean> {
  return deliver(user, ticket, "support_meeting_confirmed", {
    meetingAt: ticket.meeting?.scheduledAt || null,
    timeZone: ticket.meeting?.timeZone || null,
    meetingLink: ticket.meeting?.meetingLink || null,
  });
}

export function sendSupportMeetingLinkUpdatedEmail(
  user: SupportEmailUser,
  ticket: SupportEmailTicket,
): Promise<boolean> {
  return deliver(user, ticket, "support_meeting_link_updated", {
    meetingAt: ticket.meeting?.scheduledAt || null,
    timeZone: ticket.meeting?.timeZone || null,
    meetingLink: ticket.meeting?.meetingLink || null,
  });
}

export function sendSupportMeetingRescheduledEmail(
  user: SupportEmailUser,
  ticket: SupportEmailTicket,
): Promise<boolean> {
  return deliver(user, ticket, "support_meeting_rescheduled", {
    meetingAt: ticket.meeting?.scheduledAt || null,
    timeZone: ticket.meeting?.timeZone || null,
    previousMeetingAt: ticket.meeting?.previousScheduledAt || null,
    previousTimeZone: ticket.meeting?.previousTimeZone || ticket.meeting?.timeZone || null,
    meetingLink: ticket.meeting?.meetingLink || null,
    awaitingLink: !ticket.meeting?.meetingLink,
  });
}

export function sendSupportMeetingCancelledEmail(
  user: SupportEmailUser,
  ticket: SupportEmailTicket,
): Promise<boolean> {
  return deliver(user, ticket, "support_meeting_cancelled", {
    meetingAt: ticket.meeting?.scheduledAt || null,
    timeZone: ticket.meeting?.timeZone || null,
    cancellationReason: ticket.meeting?.cancellationReason || null,
  });
}

export function supportEmailWouldSend(user: SupportEmailUser): boolean {
  return readyRecipient(user) !== null;
}
