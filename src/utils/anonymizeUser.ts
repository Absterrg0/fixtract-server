import mongoose from 'mongoose';
import User from '../models/user';
import ChatMessage from '../models/chatMessage';
import SupportTicket from '../models/supportTicket';
import SupportTicketInternalNote from '../models/supportTicketInternalNote';
import SupportMeetingNotification from '../models/supportMeetingNotification';
import { deleteFromS3, parseS3KeyFromUrl, isAllowedS3Url } from './s3Upload';
import { deleteSupportAttachment } from './support/attachments';
import { releaseCalendarReservations } from './support/calendarReservations';
import {
  beginAccountDataRemoval,
  completeAccountDataRemoval,
} from './support/accountGuard';

const tryDeleteS3 = async (url?: string | null) => {
  if (!url) return;
  if (!isAllowedS3Url(url)) return;
  const key = parseS3KeyFromUrl(url);
  if (!key) return;
  try {
    await deleteFromS3(key);
  } catch (err) {
    console.error(`anonymizeUser: failed to delete S3 object ${key}`, err);
  }
};

export interface AnonymizeResult {
  userId: string;
  anonymizedAt: Date;
  redactedMessageCount: number;
}

export const anonymizeUser = async (
  userId: mongoose.Types.ObjectId | string,
  actorId: mongoose.Types.ObjectId | string
): Promise<AnonymizeResult> => {
  const id = typeof userId === 'string' ? new mongoose.Types.ObjectId(userId) : userId;
  const actor = typeof actorId === 'string' ? new mongoose.Types.ObjectId(actorId) : actorId;

  const user = await User.findById(id);
  if (!user) {
    throw new Error('User not found');
  }
  if (user.deletedAt) {
    throw new Error('User is already anonymized');
  }
  if (user.role === 'admin') {
    throw new Error('Admin users cannot be anonymized through this path');
  }

  await beginAccountDataRemoval(id, 'anonymizing');

  await tryDeleteS3(user.profileImage);
  await tryDeleteS3(user.idProofUrl);

  // Support content is user-authored PII, stored in a collection the user
  // record does not otherwise expose. Redact it, drop private notes and
  // attachments, and release any meeting reservation after the redacting
  // update (so a racing reschedule cannot recreate keys afterwards). Ticket/
  // meeting history remains for support audit without the personal content.
  const supportTickets = await SupportTicket.find({ userId: id })
    .select("_id attachment replies meeting booking")
    .lean();
  for (const ticket of supportTickets as Array<{
    _id: mongoose.Types.ObjectId;
    attachment?: { key?: string; url?: string };
    replies?: Array<Record<string, unknown>>;
    meeting?: { status?: string };
    booking?: { bookingId?: unknown };
  }>) {
    if (ticket.attachment?.key) await deleteSupportAttachment(ticket.attachment.key);
    if (ticket.attachment?.url) await tryDeleteS3(ticket.attachment.url);
    await SupportTicketInternalNote.deleteMany({ ticketId: ticket._id });
    await SupportMeetingNotification.deleteMany({ ticketId: ticket._id });

    const activeMeeting = ['pending', 'scheduled'].includes(ticket.meeting?.status || '');
    await SupportTicket.updateOne(
      { _id: ticket._id },
      {
        $set: {
          subject: '[deleted]',
          description: '[deleted]',
          replies: (ticket.replies || []).map((reply) => ({
            ...reply,
            body: '[deleted]',
          })),
          ...(ticket.booking?.bookingId
            ? {
                'booking.projectTitle': '[deleted]',
                'booking.counterpartyName': '[deleted]',
                'booking.label': '[deleted]',
              }
            : {}),
          ...(activeMeeting
            ? {
                'meeting.status': 'cancelled',
                'meeting.cancelledAt': new Date(),
                'meeting.cancelledByRole': 'admin',
                'meeting.cancellationReason': 'Account anonymized',
                status: 'closed',
              }
            : {}),
        },
        $unset: {
          attachment: 1,
          ...(ticket.meeting ? { 'meeting.slotKeys': 1, 'meeting.meetingLink': 1 } : {}),
        },
        $inc: { __v: 1 },
      },
    );
    // Release after the redacting update bumped the ticket version. A
    // reschedule that committed before it is cleaned here; one that tries to
    // save after it gets a VersionError and rolls its new keys back.
    await releaseCalendarReservations('support', ticket._id);
  }

  const placeholderEmail = `deleted-${id.toString()}@anon.local`;
  const placeholderPhone = `DELETED-${id.toString()}`;

  user.name = '[deleted user]';
  user.email = placeholderEmail;
  user.phone = placeholderPhone;
  user.password = undefined;
  user.username = undefined;
  user.vatNumber = undefined;
  user.isVatVerified = false;
  user.businessName = undefined;
  user.companyAddress = undefined;
  user.location = undefined;
  user.businessInfo = undefined;
  user.profileImage = undefined;
  user.idProofUrl = undefined;
  user.idProofFileName = undefined;
  user.idCountryOfIssue = undefined;
  user.idExpirationDate = undefined;
  user.isIdVerified = false;
  user.pendingIdChanges = [];
  user.verificationCode = undefined;
  user.verificationCodeExpires = undefined;
  user.referralCode = undefined;
  user.deletedAt = new Date();
  user.deletedBy = actor;

  await user.save({ validateBeforeSave: false });
  await completeAccountDataRemoval(id, 'anonymized');

  const messageUpdate = await ChatMessage.updateMany(
    { senderId: id },
    { $set: { text: '[deleted message]' } }
  );

  return {
    userId: id.toString(),
    anonymizedAt: user.deletedAt!,
    redactedMessageCount: messageUpdate.modifiedCount ?? 0,
  };
};
