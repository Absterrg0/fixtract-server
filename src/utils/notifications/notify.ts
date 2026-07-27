import mongoose from 'mongoose';
import Notification from '../../models/notification';
import User from '../../models/user';
import { sendPushToUser } from '../fcmService';
import { getEventDef, type NotifyContext } from './registry';
import { resolveChannels, type NotificationEntityType } from './types';

export interface NotifyDeliveryOptions {
  /** When false, skip in-app inbox row. Default true. */
  persistInbox?: boolean;
  /** Override registry/pref push channel resolution. */
  sendPush?: boolean;
  /** Override registry/pref email channel resolution. */
  sendEmail?: boolean;
}

export interface NotifyArgs {
  userId: string;
  eventKey: string;
  entityType?: NotificationEntityType;
  entityId?: string;
  meta?: Record<string, unknown>;
  context?: NotifyContext;
  delivery?: NotifyDeliveryOptions;
}

export type EmailDeliveryOutcome = 'sent' | 'not_eligible' | 'failed';

export interface NotifyResult {
  notificationId: string | null;
  emailSent: boolean;
  pushSent: boolean;
  emailOutcome?: EmailDeliveryOutcome;
  skipped?: 'unknown_event' | 'user_not_found';
}

/**
 * Central notification dispatcher:
 * 1. Always persist an inbox row
 * 2. Dispatch email/push according to registry tier + user prefs
 *
 * Channel failures are logged and never thrown to the caller.
 */
export async function notify(args: NotifyArgs): Promise<NotifyResult> {
  const def = getEventDef(args.eventKey);
  if (!def) {
    console.error(`[notify] Unknown eventKey: ${args.eventKey}`);
    return { notificationId: null, emailSent: false, pushSent: false, skipped: 'unknown_event' };
  }

  const user = await User.findById(args.userId).select(
    'email name notificationPreferences',
  );
  if (!user) {
    console.warn(`[notify] User not found: ${args.userId}`);
    return {
      notificationId: null,
      emailSent: false,
      pushSent: false,
      emailOutcome: 'not_eligible',
      skipped: 'user_not_found',
    };
  }

  const persistInbox = args.delivery?.persistInbox !== false;
  const ctx: NotifyContext = args.context ?? {};
  const built = def.build(ctx);
  const entityType = args.entityType ?? def.defaultEntityType;
  const entityId =
    args.entityId && mongoose.Types.ObjectId.isValid(args.entityId)
      ? new mongoose.Types.ObjectId(args.entityId)
      : undefined;

  let notificationId: string | null = null;
  if (persistInbox) {
    try {
      const doc = await Notification.create({
        userId: user._id,
        eventKey: args.eventKey,
        category: def.category,
        title: built.title,
        body: built.body,
        clickUrl: built.clickUrl,
        entityType,
        entityId,
        readAt: null,
        emailAttempted: false,
        emailSent: false,
        pushAttempted: false,
        pushSent: false,
        meta: args.meta,
      });
      notificationId = doc._id.toString();
    } catch (err) {
      console.error(`[notify] Failed to persist inbox for ${args.eventKey}:`, err);
      // Continue to attempt channels even if persist failed (best-effort)
    }
  }

  const channels = resolveChannels(def.tier, def.category, user.notificationPreferences);
  const sendEmail = args.delivery?.sendEmail ?? channels.sendEmail;
  const sendPush = args.delivery?.sendPush ?? channels.sendPush;
  let emailSent = false;
  let pushSent = false;
  let emailOutcome: EmailDeliveryOutcome | undefined;

  if (sendEmail && built.sendEmail && user.email) {
    try {
      if (notificationId) {
        await Notification.findByIdAndUpdate(notificationId, { emailAttempted: true });
      }
      emailSent = await built.sendEmail({
        email: user.email,
        name: user.name || 'User',
        userId: user._id.toString(),
      });
      emailOutcome = emailSent ? 'sent' : 'failed';
      if (notificationId && emailSent) {
        await Notification.findByIdAndUpdate(notificationId, { emailSent: true });
      }
    } catch (err) {
      emailOutcome = 'failed';
      console.error(`[notify] Email failed for ${args.eventKey}:`, err);
    }
  } else if (sendEmail && built.sendEmail) {
    emailOutcome = 'not_eligible';
  }

  if (sendPush) {
    try {
      if (notificationId) {
        await Notification.findByIdAndUpdate(notificationId, { pushAttempted: true });
      }
      await sendPushToUser(
        user._id.toString(),
        {
          title: built.title,
          body: built.body,
          type: def.category,
          clickUrl: built.clickUrl,
          data: {
            eventKey: args.eventKey,
            ...(args.entityId ? { entityId: args.entityId } : {}),
            ...(ctx.bookingId ? { bookingId: String(ctx.bookingId) } : {}),
            ...(ctx.conversationId ? { conversationId: String(ctx.conversationId) } : {}),
          },
        },
        { skipPrefCheck: true },
      );
      pushSent = true;
      if (notificationId) {
        await Notification.findByIdAndUpdate(notificationId, { pushSent: true });
      }
    } catch (err) {
      console.error(`[notify] Push failed for ${args.eventKey}:`, err);
    }
  }

  return { notificationId, emailSent, pushSent, emailOutcome };
}

/** Fire-and-forget wrapper for handlers that must not await notifications. */
export function notifyAsync(args: NotifyArgs): void {
  void notify(args).catch((err) => {
    console.error(`[notifyAsync] ${args.eventKey}:`, err);
  });
}
