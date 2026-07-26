import Conversation, { type IConversation } from '../../models/conversation';
import { notify } from './notify';
import {
  loadUnreadMirrorLines,
  unreadChatConversationFilter,
  unreadChatCutoff,
  unreadChatMirrorThrottleOk,
  unreadChatReminderTargets,
} from './chatEmailMirror';

const CONVERSATION_BATCH_SIZE = 25;

async function claimReminderSlot(
  conversationId: unknown,
  lastMessageAt: Date | undefined,
  previousReminderLastSentAt: Date | undefined | null,
  now: Date,
): Promise<boolean> {
  if (!lastMessageAt) return false;
  const result = await Conversation.updateOne(
    {
      _id: conversationId,
      lastMessageAt,
      unreadChatReminderLastSentAt: previousReminderLastSentAt ?? null,
    },
    { $set: { unreadChatReminderLastSentAt: now } },
  );
  return result.modifiedCount > 0;
}

async function releaseReminderClaim(
  conversationId: unknown,
  claimedAt: Date,
  previousReminderLastSentAt: Date | undefined | null,
): Promise<void> {
  if (previousReminderLastSentAt) {
    await Conversation.updateOne(
      { _id: conversationId, unreadChatReminderLastSentAt: claimedAt },
      { $set: { unreadChatReminderLastSentAt: previousReminderLastSentAt } },
    );
    return;
  }
  await Conversation.updateOne(
    { _id: conversationId, unreadChatReminderLastSentAt: claimedAt },
    { $unset: { unreadChatReminderLastSentAt: '' } },
  );
}

async function processConversationMirror(
  conv: Pick<
    IConversation,
    | '_id'
    | 'type'
    | 'customerId'
    | 'professionalId'
    | 'supportAdminId'
    | 'supportTargetUserId'
    | 'customerUnreadCount'
    | 'professionalUnreadCount'
    | 'lastMessageSenderId'
    | 'unreadChatReminderLastSentAt'
    | 'lastMessageAt'
  >,
  now: Date,
  nowMs: number,
): Promise<{ sent: number; errors: string[] }> {
  if (!unreadChatMirrorThrottleOk(conv.unreadChatReminderLastSentAt, nowMs)) {
    return { sent: 0, errors: [] };
  }

  const targets = unreadChatReminderTargets(conv);
  if (targets.length === 0) return { sent: 0, errors: [] };

  const previousStamp = conv.unreadChatReminderLastSentAt ?? null;
  const claimed = await claimReminderSlot(conv._id, conv.lastMessageAt, previousStamp, now);
  if (!claimed) {
    return { sent: 0, errors: [] };
  }

  const errors: string[] = [];
  let sent = 0;

  const results = await Promise.allSettled(
    targets.map(async (target) => {
      const lines = await loadUnreadMirrorLines(String(conv._id), target.userId);
      const counterpartyName = lines[lines.length - 1]?.senderLabel;

      await notify({
        userId: target.userId,
        eventKey: target.eventKey,
        entityType: 'conversation',
        entityId: String(conv._id),
        context: {
          conversationId: String(conv._id),
          conversationType: conv.type,
          counterpartyName,
          chatMirrorLines: lines,
        },
      });
    }),
  );

  for (const [index, result] of results.entries()) {
    if (result.status === 'fulfilled') {
      sent++;
    } else {
      const target = targets[index];
      const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
      errors.push(`unreadChat ${conv._id} → ${target.userId}: ${message}`);
    }
  }

  if (sent === 0) {
    await releaseReminderClaim(conv._id, now, previousStamp);
  }

  return { sent, errors };
}

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
    .sort({ lastMessageAt: 1 })
    .limit(300);

  const now = new Date();
  const nowMs = now.getTime();

  for (let offset = 0; offset < conversations.length; offset += CONVERSATION_BATCH_SIZE) {
    const batch = conversations.slice(offset, offset + CONVERSATION_BATCH_SIZE);
    const batchResults = await Promise.all(batch.map((conv) => processConversationMirror(conv, now, nowMs)));

    for (const result of batchResults) {
      sent += result.sent;
      errors.push(...result.errors);
    }
  }

  return { sent, errors };
}
