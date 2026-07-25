import Conversation from '../../models/conversation';
import { notify } from './notify';
import {
  formatMirrorInboxBody,
  loadUnreadMirrorLines,
  unreadChatConversationFilter,
  unreadChatCutoff,
  unreadChatMirrorThrottleOk,
  unreadChatReminderTargets,
  type ChatMirrorLine,
} from './chatEmailMirror';

export async function processUnreadChatMirrorReminders(): Promise<{
  sent: number;
  errors: string[];
}> {
  const cutoff = unreadChatCutoff();
  const errors: string[] = [];
  let sent = 0;

  const conversations = await Conversation.find(unreadChatConversationFilter(cutoff))
    .select(
      '_id type customerId professionalId supportAdminId supportTargetUserId customerUnreadCount professionalUnreadCount lastMessageSenderId unreadChatReminderLastSentAt lastMessageAt',
    )
    .limit(300);

  const now = new Date();

  for (const conv of conversations) {
    if (!unreadChatMirrorThrottleOk(conv.unreadChatReminderLastSentAt, now.getTime())) {
      continue;
    }

    const targets = unreadChatReminderTargets(conv);
    if (targets.length === 0) continue;

    let notifiedAnyone = false;

    for (const target of targets) {
      try {
        const lines = await loadUnreadMirrorLines(String(conv._id), target.userId);
        const counterpartyName = lines[lines.length - 1]?.senderLabel;
        const mirrorLines: ChatMirrorLine[] = lines;

        await notify({
          userId: target.userId,
          eventKey: target.eventKey,
          entityType: 'conversation',
          entityId: String(conv._id),
          context: {
            conversationId: String(conv._id),
            conversationType: conv.type,
            counterpartyName,
            chatMirrorLines: mirrorLines,
          },
        });
        notifiedAnyone = true;
        sent++;
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`unreadChat ${conv._id} → ${target.userId}: ${message}`);
      }
    }

    if (notifiedAnyone) {
      await Conversation.updateOne(
        { _id: conv._id },
        { $set: { unreadChatReminderLastSentAt: now } },
      );
    }
  }

  return { sent, errors };
}

export { formatMirrorInboxBody };
