import express from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import {
  createOrGetConversation,
  listMyConversations,
  getMyUnreadConversationCount,
  getConversationMessages,
  sendMessage,
  markConversationRead,
  uploadChatImage,
  uploadChatFile,
  getConversationInfo,
  toggleStar,
  toggleArchive,
  addLabel,
  removeLabel,
  reportMessage,
  searchMessages,
} from "../../handlers/Chat";
import { protect } from "../../middlewares/auth";
import { upload } from "../../utils/s3Upload";

const router = express.Router();

const userKeyGenerator = (req: express.Request) => {
  const userId = req.user?._id;
  return userId ? String(userId) : ipKeyGenerator(req.ip ?? "unknown");
};

const chatSendLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userKeyGenerator,
  message: { success: false, msg: "Too many messages, please try again later" },
});

const chatUploadLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 15,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userKeyGenerator,
  message: { success: false, msg: "Too many uploads, please try again later" },
});

const chatReadLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userKeyGenerator,
  message: { success: false, msg: "Too many requests, please try again later" },
});

const chatToggleLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userKeyGenerator,
  message: { success: false, msg: "Too many requests, please try again later" },
});

const chatReportLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userKeyGenerator,
  message: { success: false, msg: "Too many reports, please try again later" },
});

const chatSearchLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 15,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userKeyGenerator,
  message: { success: false, msg: "Too many searches, please try again later" },
});

router.use(protect);

router.post("/conversations", createOrGetConversation);
router.get("/conversations/unread-count", getMyUnreadConversationCount);
router.get("/conversations", listMyConversations);
router.get("/conversations/:conversationId/messages", getConversationMessages);
router.get("/conversations/:conversationId/info", chatReadLimiter, getConversationInfo);
router.post("/conversations/:conversationId/messages", chatSendLimiter, sendMessage);
router.patch("/conversations/:conversationId/read", markConversationRead);
router.post("/upload-image", chatUploadLimiter, upload.single("image"), uploadChatImage);
router.post("/upload-file", chatUploadLimiter, upload.single("file"), uploadChatFile);
router.patch("/conversations/:conversationId/star", chatToggleLimiter, toggleStar);
router.patch("/conversations/:conversationId/archive", chatToggleLimiter, toggleArchive);
router.post("/conversations/:conversationId/label", chatToggleLimiter, addLabel);
router.delete("/conversations/:conversationId/label/:label", chatToggleLimiter, removeLabel);
router.post("/messages/:messageId/report", chatReportLimiter, reportMessage);
router.get("/conversations/:conversationId/messages/search", chatSearchLimiter, searchMessages);

export default router;
