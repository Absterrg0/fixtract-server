import { Request, Response } from "express";
import mongoose from "mongoose";
import ChatReport from "../../models/chatReport";
import ChatMessage from "../../models/chatMessage";
import Conversation from "../../models/conversation";
import User from "../../models/user";

const VALID_STATUSES = ["pending", "reviewed", "dismissed"] as const;

const parsePagination = (query: any) => {
  const page = Math.max(1, Math.floor(Number(query.page) || 1));
  const limit = Math.min(100, Math.max(1, Math.floor(Number(query.limit) || 20)));
  return { page, limit, skip: (page - 1) * limit };
};

export const listChatReports = async (req: Request, res: Response) => {
  try {
    const { status } = req.query;
    const { page, limit, skip } = parsePagination(req.query);

    const filter: any = {};
    if (typeof status === "string" && (VALID_STATUSES as readonly string[]).includes(status)) {
      filter.status = status;
    }

    const [items, total] = await Promise.all([
      ChatReport.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("reportedBy", "name email role")
        .populate({ path: "messageId", select: "text senderId senderRole createdAt" })
        .populate({
          path: "conversationId",
          select: "type customerId professionalId supportAdminId supportTargetUserId",
          populate: [
            { path: "customerId", select: "name email" },
            { path: "professionalId", select: "name email" },
          ],
        })
        .lean(),
      ChatReport.countDocuments(filter),
    ]);

    return res.json({ success: true, data: { items, total, page, limit } });
  } catch (error: any) {
    console.error("List chat reports error:", error);
    return res.status(500).json({ success: false, msg: "Failed to load chat reports" });
  }
};

export const getChatReport = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, msg: "Invalid id" });
    }
    const report = await ChatReport.findById(id)
      .populate("reportedBy", "name email role")
      .populate({ path: "messageId", select: "text senderId senderRole createdAt" })
      .populate({
        path: "conversationId",
        select: "type customerId professionalId supportAdminId supportTargetUserId",
        populate: [
          { path: "customerId", select: "name email" },
          { path: "professionalId", select: "name email" },
        ],
      })
      .lean();

    if (!report) {
      return res.status(404).json({ success: false, msg: "Report not found" });
    }

    let surroundingMessages: any[] = [];
    const reportedMessageId = (report as any).messageId?._id;
    const conversationId = (report as any).conversationId?._id;
    if (reportedMessageId && conversationId) {
      const before = await ChatMessage.find({
        conversationId,
        _id: { $lt: reportedMessageId },
      })
        .sort({ _id: -1 })
        .limit(10)
        .populate("senderId", "name email")
        .lean();
      const after = await ChatMessage.find({
        conversationId,
        _id: { $gt: reportedMessageId },
      })
        .sort({ _id: 1 })
        .limit(10)
        .populate("senderId", "name email")
        .lean();
      surroundingMessages = [...before.reverse(), ...after];
    }

    return res.json({ success: true, data: { report, surroundingMessages } });
  } catch (error: any) {
    console.error("Get chat report error:", error);
    return res.status(500).json({ success: false, msg: "Failed to load chat report" });
  }
};

export const resolveChatReport = async (req: Request, res: Response) => {
  try {
    const adminIdRaw = (req as any).admin?._id ?? (req as any).user?._id;
    const adminId = adminIdRaw?.toString();
    const { id } = req.params;
    const { action, notes } = req.body || {};
    if (!adminId || !mongoose.Types.ObjectId.isValid(adminId)) {
      return res.status(401).json({ success: false, msg: "Unauthorized" });
    }
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, msg: "Invalid id" });
    }
    if (!["warn", "ban", "dismiss"].includes(action)) {
      return res.status(400).json({ success: false, msg: "action must be warn, ban, or dismiss" });
    }

    const adminObjectId = new mongoose.Types.ObjectId(adminId);

    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      const report = await ChatReport.findById(id).populate("messageId").session(session);
      if (!report) {
        await session.abortTransaction();
        return res.status(404).json({ success: false, msg: "Report not found" });
      }
      if (report.status !== "pending") {
        await session.abortTransaction();
        return res.status(409).json({ success: false, msg: `Report is already ${report.status}` });
      }

      const messageDoc: any = report.messageId;
      if (!messageDoc) {
        await session.abortTransaction();
        return res.status(409).json({ success: false, msg: "Reported message not found" });
      }
      const reportedSenderId = messageDoc.senderId?.toString();

      if (action === "warn") {
        const warnText = `⚠️ Admin warning: this conversation is being reviewed for reported content.${notes ? ` Note: ${notes}` : ""}`;
        const [createdMessage] = await ChatMessage.create(
          [{
            conversationId: report.conversationId,
            senderId: adminObjectId,
            senderRole: "admin",
            text: warnText,
            messageType: "text",
            readBy: [{ userId: adminObjectId, readAt: new Date() }],
          }],
          { session }
        );
        await Conversation.findByIdAndUpdate(
          report.conversationId,
          {
            $set: {
              lastMessageAt: createdMessage?.createdAt || new Date(),
              lastMessagePreview: warnText.slice(0, 200),
              lastMessageSenderId: adminObjectId,
            },
          },
          { session }
        );
        report.status = "reviewed";
      } else if (action === "ban") {
        if (!reportedSenderId || !mongoose.Types.ObjectId.isValid(reportedSenderId)) {
          await session.abortTransaction();
          return res.status(400).json({
            success: false,
            msg: "Cannot ban: reported message has no valid sender",
          });
        }
        const result = await User.updateOne(
          { _id: reportedSenderId, role: { $in: ["customer", "professional"] } },
          {
            $set: {
              accountStatus: "suspended",
              suspensionReason: typeof notes === "string" && notes.trim()
                ? `Banned by admin: ${notes.trim()}`
                : "Banned by admin (chat moderation)",
            },
          },
          { session }
        );
        if (result.matchedCount === 0) {
          await session.abortTransaction();
          return res.status(409).json({
            success: false,
            msg: "Cannot ban this user (admin/system accounts cannot be suspended via chat moderation)",
          });
        }
        report.status = "reviewed";
      } else {
        report.status = "dismissed";
      }

      await report.save({ session });
      await session.commitTransaction();
      return res.json({ success: true, data: { report } });
    } catch (innerErr: any) {
      try { await session.abortTransaction(); } catch {}
      throw innerErr;
    } finally {
      session.endSession();
    }
  } catch (error: any) {
    console.error("Resolve chat report error:", error);
    return res.status(500).json({ success: false, msg: "Failed to resolve report" });
  }
};

export const adminGetConversation = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, msg: "Invalid id" });
    }
    const conversation = await Conversation.findById(id)
      .populate("customerId", "name email")
      .populate("professionalId", "name email")
      .populate("supportAdminId", "name email")
      .populate("supportTargetUserId", "name email")
      .lean();
    if (!conversation) {
      return res.status(404).json({ success: false, msg: "Conversation not found" });
    }
    return res.json({ success: true, data: conversation });
  } catch (error: any) {
    console.error("Admin get conversation error:", error);
    return res.status(500).json({ success: false, msg: "Failed to load conversation" });
  }
};

export const adminGetConversationMessages = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { page, limit, skip } = parsePagination(req.query);
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, msg: "Invalid id" });
    }
    const [messages, total] = await Promise.all([
      ChatMessage.find({ conversationId: id })
        .sort({ _id: -1 })
        .skip(skip)
        .limit(limit)
        .populate("senderId", "name email")
        .lean(),
      ChatMessage.countDocuments({ conversationId: id }),
    ]);
    return res.json({ success: true, data: { items: messages.reverse(), total, page, limit } });
  } catch (error: any) {
    console.error("Admin get messages error:", error);
    return res.status(500).json({ success: false, msg: "Failed to load messages" });
  }
};

export const adminStartSupportChat = async (req: Request, res: Response) => {
  try {
    const adminIdRaw = (req as any).admin?._id ?? (req as any).user?._id;
    const adminId = adminIdRaw?.toString();
    const { targetUserId, initialMessage } = req.body || {};
    if (!adminId || !mongoose.Types.ObjectId.isValid(adminId)) {
      return res.status(401).json({ success: false, msg: "Unauthorized" });
    }
    if (!mongoose.Types.ObjectId.isValid(targetUserId)) {
      return res.status(400).json({ success: false, msg: "Invalid targetUserId" });
    }
    if (adminId === String(targetUserId)) {
      return res.status(400).json({ success: false, msg: "Cannot start a support chat with yourself" });
    }
    if (typeof initialMessage !== "string" || !initialMessage.trim() || initialMessage.length > 2000) {
      return res.status(400).json({ success: false, msg: "initialMessage is required (max 2000 chars)" });
    }

    const targetUser = await User.findById(targetUserId).select("_id role name email").lean();
    if (!targetUser) {
      return res.status(404).json({ success: false, msg: "Target user not found" });
    }
    if (targetUser.role !== "customer" && targetUser.role !== "professional") {
      return res.status(400).json({
        success: false,
        msg: "Support chats are only available for customers or professionals",
      });
    }

    const adminObjectId = new mongoose.Types.ObjectId(adminId);
    const targetObjectId = new mongoose.Types.ObjectId(targetUserId);

    let conversation = await Conversation.findOne({
      type: "support",
      supportAdminId: adminObjectId,
      supportTargetUserId: targetObjectId,
    });
    if (!conversation) {
      try {
        conversation = await Conversation.create({
          type: "support",
          supportAdminId: adminObjectId,
          supportTargetUserId: targetObjectId,
          initiatedBy: adminObjectId,
          status: "active",
        } as any);
      } catch (err: any) {
        if (err?.code === 11000) {
          conversation = await Conversation.findOne({
            type: "support",
            supportAdminId: adminObjectId,
            supportTargetUserId: targetObjectId,
          });
        } else {
          throw err;
        }
      }
      if (!conversation) {
        return res.status(500).json({ success: false, msg: "Failed to create or load support conversation" });
      }
    }

    const message = await ChatMessage.create({
      conversationId: conversation._id,
      senderId: adminObjectId,
      senderRole: "admin",
      text: initialMessage.trim(),
      messageType: "text",
      readBy: [{ userId: adminObjectId, readAt: new Date() }],
    });

    const unreadField =
      targetUser.role === "professional" ? "professionalUnreadCount" : "customerUnreadCount";
    await Conversation.findByIdAndUpdate(conversation._id, {
      $set: {
        lastMessageAt: new Date(),
        lastMessagePreview: initialMessage.trim().slice(0, 200),
        lastMessageSenderId: adminObjectId,
      },
      $inc: { [unreadField]: 1 },
    });

    return res.status(201).json({
      success: true,
      data: { conversationId: conversation._id, messageId: message._id },
    });
  } catch (error: any) {
    console.error("Admin start support chat error:", error);
    return res.status(500).json({ success: false, msg: "Failed to start support chat" });
  }
};
