import { Request, Response } from "express";
import mongoose from "mongoose";
import connectDB from "../../config/db";
import MeetingRequest from "../../models/meetingRequest";
import SupportTicket, { type ISupportTicket } from "../../models/supportTicket";
import type { IUser } from "../../models/user";
import { UserFacingError } from "../../utils/appErrors";
import { toDate } from "../../utils/dateUtils";
import { sendHandlerError } from "../../utils/handlerErrors";
import {
  getSupportAvailabilityForProfessional,
  isValidIanaTimeZone,
  parseSupportAvailabilityRange,
  resolveSupportTimeZone,
} from "../../utils/support/availability";
import {
  cancelSupportMeeting,
  rescheduleSupportMeeting,
} from "../../utils/support/meetingReservation";
import { listSupportCalendarEvents } from "../../utils/support/calendarEvents";
import { serializeSupportTicketUser } from "../../utils/support/serializers";
import { requireSupportUser } from "./service";

function firstQueryString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}

export const getSupportMeetingAvailability = async (req: Request, res: Response) => {
  try {
    const user = requireSupportUser(req.user as IUser | undefined);
    if (user.role !== "professional") {
      throw new UserFacingError(
        403,
        "Support meeting availability is only available for professional accounts.",
        "FORBIDDEN",
      );
    }
    await connectDB();
    const timeZone = resolveSupportTimeZone(user, firstQueryString(req.query.timeZone));
    if (!isValidIanaTimeZone(timeZone)) {
      throw new UserFacingError(400, "A valid IANA time zone is required.", "VALIDATION", "timeZone");
    }
    const range = parseSupportAvailabilityRange(
      firstQueryString(req.query.from),
      firstQueryString(req.query.to),
      timeZone,
    );
    const excludeItemId = firstQueryString(req.query.excludeItemId);
    if (excludeItemId && !mongoose.Types.ObjectId.isValid(excludeItemId)) {
      throw new UserFacingError(400, "Invalid excludeItemId.", "VALIDATION", "excludeItemId");
    }

    const result = await getSupportAvailabilityForProfessional({
      professional: user,
      timeZone,
      from: range.from,
      to: range.to,
      ...(excludeItemId ? { excludeItemId } : {}),
    });
    const events = await listSupportCalendarEvents({
      viewer: "professional",
      userId: String(user._id),
      from: range.from,
      to: range.to,
      timeZone: result.timeZone,
    });

    return res.status(200).json({
      success: true,
      data: {
        timeZone: result.timeZone,
        durationMinutes: result.durationMinutes,
        slots: result.slots.map((slot) => ({
          start: slot.start,
          end: slot.end,
          localStart: slot.localStart,
          localEnd: slot.localEnd,
        })),
        events,
      },
    });
  } catch (error) {
    return sendHandlerError(res, error, "We couldn't load meeting availability. Please try again.");
  }
};

function requesterFromUser(user: IUser) {
  return {
    _id: String(user._id),
    id: String(user._id),
    name: user.name,
    email: user.email,
    role: user.role,
  };
}

export const updateSupportItemMeeting = async (req: Request, res: Response) => {
  try {
    const user = requireSupportUser(req.user as IUser | undefined);
    await connectDB();
    const { id, kind } = req.params;
    if (kind !== "meeting") {
      throw new UserFacingError(400, "Only support meetings can be updated.", "VALIDATION", "kind");
    }
    if (!mongoose.Types.ObjectId.isValid(String(id))) {
      throw new UserFacingError(404, "Support item not found.", "NOT_FOUND");
    }

    const ticket = await SupportTicket.findOne({
      _id: id,
      userId: user._id,
      kind: "meeting",
    }).populate("userId", "name email role");
    if (!ticket) {
      const legacy = await MeetingRequest.findOne({ _id: id, userId: user._id })
        .select("_id")
        .lean();
      if (legacy) {
        throw new UserFacingError(
          409,
          "Historical meeting requests are read-only. Please open a new ticket for changes.",
          "CONFLICT",
        );
      }
      throw new UserFacingError(404, "Support item not found.", "NOT_FOUND");
    }

    const meetingUpdate = req.body?.meeting;
    if (!meetingUpdate || typeof meetingUpdate !== "object") {
      throw new UserFacingError(400, "A meeting action is required.", "VALIDATION", "meeting");
    }
    const action = (meetingUpdate as Record<string, unknown>).action;

    if (action === "cancel") {
      const reason = typeof (meetingUpdate as Record<string, unknown>).reason === "string"
        ? String((meetingUpdate as Record<string, unknown>).reason)
        : undefined;
      const result = await cancelSupportMeeting({
        ticket,
        actorId: user._id,
        actorRole: "user",
        owner: user,
        reason,
      });
      return res.status(200).json({
        success: true,
        data: await serializeSupportTicketUser(result.ticket as ISupportTicket, {
          requester: requesterFromUser(user),
        }),
        ...(result.emailAttempted ? { emailSent: result.emailSent } : {}),
      });
    }

    if (action === "reschedule") {
      // A role change does not revoke the owner's ability to cancel, but only a
      // current professional can pick from professional meeting availability.
      if (user.role !== "professional") {
        throw new UserFacingError(
          403,
          "Only professional accounts can reschedule support meetings.",
          "FORBIDDEN",
        );
      }
      const rawStart = typeof (meetingUpdate as Record<string, unknown>).scheduledAt === "string"
        ? String((meetingUpdate as Record<string, unknown>).scheduledAt)
        : "";
      const start = toDate(rawStart);
      if (!start) {
        throw new UserFacingError(
          400,
          "Choose a valid meeting time in UTC (ISO 8601).",
          "VALIDATION",
          "scheduledAt",
        );
      }
      const timeZone = resolveSupportTimeZone(
        user,
        (meetingUpdate as Record<string, unknown>).timeZone,
      );
      const result = await rescheduleSupportMeeting({
        ticket,
        professional: user,
        start,
        timeZone,
        owner: user,
      });
      return res.status(200).json({
        success: true,
        data: await serializeSupportTicketUser(result.ticket as ISupportTicket, {
          requester: requesterFromUser(user),
        }),
        ...(result.emailAttempted ? { emailSent: result.emailSent } : {}),
      });
    }

    throw new UserFacingError(400, "Invalid meeting action.", "VALIDATION", "action");
  } catch (error) {
    return sendHandlerError(res, error, "We couldn't update this meeting. Please try again.");
  }
};
