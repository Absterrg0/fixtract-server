import { describe, expect, it } from 'vitest';
import {
  classifyMirrorEmailOutcome,
  formatMessageMirrorText,
  formatMirrorInboxBody,
  unreadChatMirrorThrottleOk,
  unreadChatReminderTargets,
} from '../../../utils/notifications/chatEmailMirror';

describe('unreadChatReminderTargets', () => {
  it('notifies customer and professional on direct chats with unread counts', () => {
    const targets = unreadChatReminderTargets({
      type: 'direct',
      customerId: { toString: () => 'cust-1' } as any,
      professionalId: { toString: () => 'prof-1' } as any,
      customerUnreadCount: 2,
      professionalUnreadCount: 0,
      lastMessageSenderId: { toString: () => 'prof-1' } as any,
    });
    expect(targets).toEqual([{ userId: 'cust-1', eventKey: 'customer.unread_chat' }]);
  });

  it('skips the party who sent the last message', () => {
    const targets = unreadChatReminderTargets({
      type: 'direct',
      customerId: { toString: () => 'cust-1' } as any,
      professionalId: { toString: () => 'prof-1' } as any,
      customerUnreadCount: 1,
      professionalUnreadCount: 1,
      lastMessageSenderId: { toString: () => 'cust-1' } as any,
    });
    expect(targets).toEqual([{ userId: 'prof-1', eventKey: 'professional.unread_chat' }]);
  });

  it('covers support user unread and admin awaiting reply', () => {
    const base = {
      type: 'support' as const,
      supportAdminId: { toString: () => 'admin-1' } as any,
      supportTargetUserId: { toString: () => 'user-1' } as any,
      professionalUnreadCount: 0,
    };

    expect(
      unreadChatReminderTargets({
        ...base,
        customerUnreadCount: 1,
        lastMessageSenderId: { toString: () => 'admin-1' } as any,
      }),
    ).toEqual([{ userId: 'user-1', eventKey: 'user.unread_support_chat' }]);

    expect(
      unreadChatReminderTargets({
        ...base,
        customerUnreadCount: 0,
        professionalUnreadCount: 1,
        lastMessageSenderId: { toString: () => 'user-1' } as any,
      }),
    ).toEqual([{ userId: 'admin-1', eventKey: 'admin.unread_support_chat' }]);

    expect(
      unreadChatReminderTargets({
        ...base,
        customerUnreadCount: 0,
        professionalUnreadCount: 0,
        lastMessageSenderId: { toString: () => 'user-1' } as any,
      }),
    ).toEqual([]);
  });
});

describe('unreadChatMirrorThrottleOk', () => {
  const now = Date.parse('2026-07-20T12:00:00.000Z');

  it('allows first send and blocks within 24h', () => {
    expect(unreadChatMirrorThrottleOk(null, now)).toBe(true);
    expect(unreadChatMirrorThrottleOk(new Date(now - 12 * 60 * 60 * 1000), now)).toBe(false);
    expect(unreadChatMirrorThrottleOk(new Date(now - 25 * 60 * 60 * 1000), now)).toBe(true);
  });
});

describe('classifyMirrorEmailOutcome', () => {
  it('treats sent and terminal outcomes as handled, retryable as not', () => {
    expect(classifyMirrorEmailOutcome({ emailOutcome: 'sent' })).toBe('sent');
    expect(classifyMirrorEmailOutcome({ emailOutcome: 'not_eligible' })).toBe('terminal');
    expect(classifyMirrorEmailOutcome({ skipped: 'user_not_found' })).toBe('terminal');
    expect(classifyMirrorEmailOutcome({ emailOutcome: 'failed' })).toBe('retryable');
    expect(classifyMirrorEmailOutcome({})).toBe('retryable');
  });
});

describe('formatMessageMirrorText', () => {
  it('prefers text and falls back to attachment labels', () => {
    expect(formatMessageMirrorText({ text: ' Hello ', images: [], attachments: [] })).toBe('Hello');
    expect(formatMessageMirrorText({ text: '', images: ['a'], attachments: [] })).toBe('[Image attachment]');
    expect(formatMessageMirrorText({ text: '', images: [], attachments: [{}, {}] as any })).toBe(
      '[2 attachments]',
    );
  });
});

describe('formatMirrorInboxBody', () => {
  it('summarizes multiple unread lines', () => {
    const body = formatMirrorInboxBody(
      [
        { senderLabel: 'Alex', text: 'First', sentAtIso: '2026-07-20T10:00:00.000Z' },
        { senderLabel: 'Alex', text: 'Second message', sentAtIso: '2026-07-20T11:00:00.000Z' },
      ],
      'Alex',
    );
    expect(body).toContain('Alex: Second message');
    expect(body).toContain('+1 more unread');
  });
});
