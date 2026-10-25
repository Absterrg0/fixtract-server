import mongoose from "mongoose";
import User from "../models/user";
import Booking from "../models/booking";
import Conversation from "../models/conversation";
import ChatMessage from "../models/chatMessage";
import Project from "../models/project";
import Referral from "../models/referral";
import PointTransaction from "../models/pointTransaction";
import Meeting from "../models/meeting";
import MeetingRequest from "../models/meetingRequest";
import SupportTicket from "../models/supportTicket";
import SupportTicketInternalNote from "../models/supportTicketInternalNote";
import SupportMeetingNotification from "../models/supportMeetingNotification";
import WarrantyClaim from "../models/warrantyClaim";
import ChatReport from "../models/chatReport";
import Favorite from "../models/favorite";
import { invalidateFavoritesOverviewCache } from "../handlers/Admin/favoritesAdmin";
import { deleteFromS3, parseS3KeyFromUrl, isAllowedS3Url } from "./s3Upload";
import { releaseCalendarReservations } from "./support/calendarReservations";
import { deleteSupportAttachment } from "./support/attachments";
import {
  beginAccountDataRemoval,
  completeAccountDataRemoval,
} from "./support/accountGuard";

async function deleteS3Files(urls: (string | undefined | null)[]) {
  for (const url of urls) {
    if (!url) continue;
    if (!isAllowedS3Url(url)) continue;
    const key = parseS3KeyFromUrl(url);
    if (!key) continue;
    try {
      await deleteFromS3(key);
    } catch (err) {
      console.error(`Failed to delete S3 file: ${key}`, err);
    }
  }
}

async function collectBookingS3Urls(bookings: any[]): Promise<string[]> {
  const urls: string[] = [];
  for (const b of bookings) {
    if (b.rfq?.attachments) urls.push(...b.rfq.attachments);
    if (b.completionDetails?.images) urls.push(...b.completionDetails.images);
    if (b.completionDetails?.attachments) urls.push(...b.completionDetails.attachments);
    if (b.extraCosts) {
      for (const cost of b.extraCosts) {
        if (cost.attachments) urls.push(...cost.attachments);
      }
    }
  }
  return urls;
}

async function collectChatS3Urls(conversationIds: mongoose.Types.ObjectId[]): Promise<string[]> {
  const urls: string[] = [];
  const messages = await ChatMessage.find({ conversationId: { $in: conversationIds } }).lean();
  for (const msg of messages) {
    if ((msg as any).images) urls.push(...(msg as any).images);
    if ((msg as any).attachments) {
      for (const att of (msg as any).attachments) {
        if (att.url) urls.push(att.url);
      }
    }
  }
  return urls;
}

async function collectProjectS3Urls(projects: any[]): Promise<string[]> {
  const urls: string[] = [];
  for (const p of projects) {
    if (p.professionalAttachments) urls.push(...p.professionalAttachments);
    if (p.questions) {
      for (const q of p.questions) {
        if (q.professionalAttachments) urls.push(...q.professionalAttachments);
      }
    }
  }
  return urls;
}

async function collectWarrantyS3Urls(claims: any[]): Promise<string[]> {
  const urls: string[] = [];
  for (const c of claims) {
    if (c.evidence) urls.push(...c.evidence);
    if (c.resolution?.attachments) urls.push(...c.resolution.attachments);
  }
  return urls;
}

export async function deleteUserData(userId: mongoose.Types.ObjectId) {
  const user = await User.findById(userId);
  if (!user) throw new Error("User not found");

  // Mark the account before discovering support rows. A concurrent support
  // create that started earlier either appears in the queries below or is
  // removed by its own post-insert guard check.
  await beginAccountDataRemoval(userId, "deleting");

  const bookings = await Booking.find({ $or: [{ customer: userId }, { professional: userId }] }).lean();

  const conversations = await Conversation.find({
    $or: [{ customerId: userId }, { professionalId: userId }],
  }).lean();
  const conversationIds = conversations.map((c) => c._id);

  const projects = await Project.find({ professionalId: userId }).lean();
  const projectIds = projects.map((p) => p._id);

  const warrantyClaims = await WarrantyClaim.find({
    $or: [{ customer: userId }, { professional: userId }],
  }).lean();

  const supportTickets = await SupportTicket.find({ userId })
    .select("_id attachment")
    .lean();
  const supportTicketIds = supportTickets.map((ticket) => ticket._id);

  const meetingOwnerFilter = {
    $or: [
      { professionalId: userId },
      { professionalId: userId.toString() },
      { "attendees.userId": userId.toString() },
      { createdBy: userId.toString() },
    ],
  };
  const meetings = await Meeting.collection
    .find(meetingOwnerFilter)
    .project({ _id: 1 })
    .toArray();

  const meetingRequests = await MeetingRequest.find({ userId })
    .select("_id")
    .lean();

  await deleteS3Files([user.profileImage]);
  await deleteS3Files(await collectBookingS3Urls(bookings));
  await deleteS3Files(await collectChatS3Urls(conversationIds as mongoose.Types.ObjectId[]));
  await deleteS3Files(await collectProjectS3Urls(projects));
  await deleteS3Files(await collectWarrantyS3Urls(warrantyClaims));
  for (const ticket of supportTickets as Array<{ attachment?: { key?: string; url?: string } }>) {
    if (ticket.attachment?.key) await deleteSupportAttachment(ticket.attachment.key);
    if (ticket.attachment?.url) await deleteS3Files([ticket.attachment.url]);
  }

  // Delete the source rows first, then release their shared calendar keys. A
  // reschedule/cancel that committed before the delete is cleaned by the later
  // release; one that tries to save after the delete fails its transaction and
  // rolls its reservation changes back. The ids are kept in memory above, so no
  // source row or user data is resurrected. Support/Meeting/MeetingRequest/
  // booking writers all share this collection, so leaving rows behind would
  // block other people's calendars forever.
  if (supportTicketIds.length > 0) {
    await SupportTicketInternalNote.deleteMany({ ticketId: { $in: supportTicketIds } });
    await SupportMeetingNotification.deleteMany({ ticketId: { $in: supportTicketIds } });
    await SupportTicket.deleteMany({ _id: { $in: supportTicketIds } });
  }
  for (const ticketId of supportTicketIds) {
    await releaseCalendarReservations("support", ticketId);
  }

  await ChatMessage.deleteMany({ conversationId: { $in: conversationIds } });
  await Conversation.deleteMany({ $or: [{ customerId: userId }, { professionalId: userId }] });
  await Booking.deleteMany({ $or: [{ customer: userId }, { professional: userId }] });
  for (const booking of bookings) {
    await releaseCalendarReservations("booking", booking._id);
  }
  await mongoose.connection.collection("payments").deleteMany({ $or: [{ customer: userId }, { professional: userId }] });
  await Project.deleteMany({ professionalId: userId });
  await Referral.deleteMany({ $or: [{ referrer: userId }, { referredUser: userId }] });
  await PointTransaction.deleteMany({ userId });
  await Meeting.collection.deleteMany(meetingOwnerFilter);
  for (const meeting of meetings) {
    await releaseCalendarReservations("meeting", meeting._id);
  }
  await MeetingRequest.deleteMany({ userId });
  for (const request of meetingRequests) {
    await releaseCalendarReservations("meeting_request", request._id);
  }
  await WarrantyClaim.deleteMany({ $or: [{ customer: userId }, { professional: userId }] });
  await ChatReport.deleteMany({ reportedBy: userId });
  const favResult = await Favorite.deleteMany({
    $or: [
      { user: userId },
      { targetType: "professional", targetId: userId },
      { targetType: "project", targetId: { $in: projectIds } },
    ],
  });
  if ((favResult.deletedCount ?? 0) > 0) {
    invalidateFavoritesOverviewCache();
  }
  await User.deleteOne({ _id: userId });
  await completeAccountDataRemoval(userId, "deleted");
}
