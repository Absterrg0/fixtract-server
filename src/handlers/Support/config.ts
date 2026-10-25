import { Request, Response } from "express";
import connectDB from "../../config/db";
import type { IUser } from "../../models/user";
import {
  SUPPORT_LOCALES,
  SUPPORT_MEETING_DURATION_MINUTES,
  SUPPORT_REASON_LABELS,
  SUPPORT_REASON_OPTIONS,
  SUPPORT_REASON_IDS,
} from "../../constants/support";
import { UserFacingError } from "../../utils/appErrors";
import { sendHandlerError } from "../../utils/handlerErrors";
import { listSupportBookingOptions } from "../../utils/support/bookings";
import { SUPPORT_MEETING_LINK_MODE } from "../../utils/support/meetingLink";
import { isSupportChatEnabled, supportChannelsForRole } from "../../utils/support/settings";

function supportUser(req: Request): IUser {
  const user = req.user as IUser | undefined;
  if (!user) throw new UserFacingError(401, "Please sign in to continue.", "AUTH_REQUIRED");
  if (user.role !== "customer" && user.role !== "professional") {
    throw new UserFacingError(
      403,
      "Support is only available for customer and professional accounts.",
      "FORBIDDEN",
    );
  }
  return user;
}

export const getSupportCapabilities = async (req: Request, res: Response) => {
  try {
    const user = supportUser(req);
    await connectDB();
    const supportChatEnabled = await isSupportChatEnabled();
    const role = user.role as "customer" | "professional";
    return res.status(200).json({
      success: true,
      data: {
        role,
        channels: supportChannelsForRole(role, supportChatEnabled),
        canCreateTicket: true,
        canPlanMeeting: role === "professional",
        canUseSupportChat: role === "professional" && supportChatEnabled,
        supportChatEnabled,
        // Legacy flag kept for older clients: support meeting booking is available.
        // There is no external provider requirement; an admin supplies the link.
        meetingProviderAvailable: true,
        meetingBookingAvailable: true,
        meetingLinkMode: SUPPORT_MEETING_LINK_MODE,
        meetingLinkSuppliedByAdmin: true,
        meetingConfirmationRequiresLink: true,
        meetingDurationMinutes: SUPPORT_MEETING_DURATION_MINUTES,
        locales: [...SUPPORT_LOCALES],
        ticketReasons: [...SUPPORT_REASON_IDS],
        reasons: SUPPORT_REASON_OPTIONS,
        reasonLabels: SUPPORT_REASON_LABELS,
      },
    });
  } catch (error) {
    return sendHandlerError(res, error, "We couldn't load support options. Please try again.");
  }
};

export const getSupportBookings = async (req: Request, res: Response) => {
  try {
    const user = supportUser(req);
    await connectDB();
    const items = await listSupportBookingOptions(user._id);
    return res.status(200).json({ success: true, data: { items } });
  } catch (error) {
    return sendHandlerError(res, error, "We couldn't load your bookings. Please try again.");
  }
};

export const getSupportConfig = getSupportCapabilities;
