import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/emailLogger', () => ({
  logEmail: vi.fn().mockResolvedValue(undefined),
}));

import { sendChatMirrorEmail } from '../../utils/emailService';
import { getEventDef } from '../../utils/notifications/registry';

describe('sendChatMirrorEmail', () => {
  const logs: string[] = [];

  beforeEach(() => {
    logs.length = 0;
    vi.spyOn(console, 'log').mockImplementation((msg?: unknown) => {
      if (typeof msg === 'string') logs.push(msg);
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const capturedHtml = () => logs.join('\n');

  it('renders populated message lines with escaped HTML and UTC timestamps', async () => {
    await sendChatMirrorEmail({
      to: 'user@example.com',
      userName: 'Sam <script>',
      subject: 'Unread messages waiting for you',
      intro: 'Waiting reply <b>now</b>',
      lines: [
        {
          senderLabel: 'Alex <img>',
          text: 'Hello <script>alert(1)</script> & friends',
          sentAtIso: '2026-07-20T10:05:00.000Z',
        },
      ],
      ctaUrl: 'https://app.example/chat?conversationId=c1',
      template: 'customer_unread_chat_mirror',
    });

    const html = capturedHtml();
    expect(html).toContain('Alex &lt;img&gt;');
    expect(html).toContain('Hello &lt;script&gt;alert(1)&lt;&#x2F;script&gt; &amp; friends');
    expect(html).toContain('Sam &lt;script&gt;');
    expect(html).toContain('Waiting reply &lt;b&gt;now&lt;&#x2F;b&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toMatch(/20 Jul 2026.*10:05.*UTC/s);
    expect(html).toContain('href="https://app.example/chat?conversationId=c1"');
    expect(html).toContain('Open conversation');
  });

  it('renders an empty-lines fallback instead of message cards', async () => {
    await sendChatMirrorEmail({
      to: 'user@example.com',
      userName: 'Sam',
      subject: 'Unread',
      intro: 'Check chat',
      lines: [],
      ctaUrl: 'https://app.example/chat?conversationId=c2',
      template: 'customer_unread_chat_mirror',
    });

    const html = capturedHtml();
    expect(html).toContain('Open the conversation in Fixtract to read the latest messages.');
    expect(html).not.toContain('border: 1px solid #e5e7eb');
  });

  it('embeds distinct user vs admin CTA URLs from registry builders', async () => {
    const conversationId = 'conv-42';
    const userBuild = getEventDef('user.unread_support_chat')!.build({
      conversationId,
      chatMirrorLines: [],
    });
    const adminBuild = getEventDef('admin.unread_support_chat')!.build({
      conversationId,
      chatMirrorLines: [],
    });

    expect(userBuild.clickUrl).toContain(`/chat?conversationId=${conversationId}`);
    expect(adminBuild.clickUrl).toContain(`/admin/chat?conversationId=${conversationId}`);

    await sendChatMirrorEmail({
      to: 'admin@example.com',
      userName: 'Admin',
      subject: adminBuild.title,
      intro: 'Support backlog',
      lines: [],
      ctaUrl: adminBuild.clickUrl,
      template: 'admin_unread_support_chat_mirror',
    });

    expect(capturedHtml()).toContain(`href="${adminBuild.clickUrl}"`);
  });
});
