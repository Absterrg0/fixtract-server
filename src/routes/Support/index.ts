import express, { type Request, type Response } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { protect } from "../../middlewares/auth";
import { rfqUpload } from "../../utils/s3Upload";
import {
  createSupportItem,
  getSupportItem,
  listSupportItems,
  replySupportItem,
} from "../../handlers/Support/tickets";
import {
  getSupportBookings,
  getSupportCapabilities,
} from "../../handlers/Support/config";
import {
  getSupportMeetingAvailability,
  updateSupportItemMeeting,
} from "../../handlers/Support/meetings";

const router = express.Router();

const userKey = (req: Request) => {
  const userId = req.user?._id;
  return userId ? String(userId) : ipKeyGenerator(req.ip ?? "unknown");
};

const createLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userKey,
  message: {
    success: false,
    msg: "Too many support requests. Please wait a minute and try again.",
    code: "RATE_LIMITED",
  },
});

const replyLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userKey,
  message: {
    success: false,
    msg: "Too many replies. Please wait a minute and try again.",
    code: "RATE_LIMITED",
  },
});

const availabilityLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userKey,
  message: {
    success: false,
    msg: "Too many availability requests. Please wait a minute and try again.",
    code: "RATE_LIMITED",
  },
});

router.use(protect);

router.get("/capabilities", getSupportCapabilities);
router.get("/config", getSupportCapabilities);
router.get("/bookings", getSupportBookings);

router.post("/items", createLimiter, rfqUpload.single("attachment"), createSupportItem);
router.get("/items", listSupportItems);
router.get("/items/:kind/:id", getSupportItem);
router.post("/items/:kind/:id/replies", replyLimiter, replySupportItem);
router.patch("/items/:kind/:id", updateSupportItemMeeting);

router.get("/meeting-availability", availabilityLimiter, getSupportMeetingAvailability);
router.get("/meetings/availability", availabilityLimiter, getSupportMeetingAvailability);

// Compatibility aliases used by the earlier proposed contract.
const forceTicketKind = (req: Request, _res: Response, next: () => void) => {
  if (!req.body) req.body = {};
  req.body.kind = "ticket";
  next();
};
const forceMeetingKind = (req: Request, _res: Response, next: () => void) => {
  if (!req.body) req.body = {};
  req.body.kind = "meeting";
  next();
};
router.post("/tickets", createLimiter, rfqUpload.single("attachment"), forceTicketKind, createSupportItem);
router.post("/meetings", createLimiter, rfqUpload.single("attachment"), forceMeetingKind, createSupportItem);
router.get("/tickets", (req, _res, next) => {
  Object.defineProperty(req, "query", {
    value: { ...req.query, kind: "ticket" },
    configurable: true,
  });
  next();
}, listSupportItems);
router.get("/tickets/:id", (req, _res, next) => {
  (req.params as Record<string, string>).kind = "ticket";
  next();
}, getSupportItem);
router.post("/tickets/:id/replies", replyLimiter, (req, _res, next) => {
  (req.params as Record<string, string>).kind = "ticket";
  next();
}, replySupportItem);

export default router;
