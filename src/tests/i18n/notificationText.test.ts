import { describe, expect, it } from 'vitest';

import { localizeNotificationText } from '../../i18n/notificationText';
import { NOTIFICATION_REGISTRY } from '../../utils/notifications/registry';

/**
 * In-app notifications are stored in English and translated when the inbox is
 * read. Every sentence an event builder can produce must therefore be in the
 * message catalog; this renders every event with and without its optional
 * context and checks the copy comes back in Dutch and French.
 */
const FULL_CONTEXT = {
  actorName: 'Alex',
  professionalName: 'Pro Painters',
  customerName: 'Sam',
  requesterName: 'Sam',
  counterpartyName: 'Sam',
  projectTitle: 'Interior painting',
  milestoneTitle: 'Phase 1',
  reason: 'Missing photos',
  clarification: 'Not covered',
  levelName: 'Gold',
  invoiceNumber: 'INV-2026-0001',
  amountLabel: '€120.00',
  extraCostTotal: 120,
  daysRemaining: 2,
  isPartialRefund: true,
  bookingId: 'b1',
  conversationId: 'c1',
};

/** Bodies that are user-written content (chat previews) are shown as written. */
const USER_CONTENT_BODIES = new Set(['user.chat_message']);

const render = (eventKey: string, ctx: Record<string, unknown>) => {
  const built = NOTIFICATION_REGISTRY[eventKey].build(ctx as any);
  return { title: built.title, body: built.body };
};

describe('notification copy is catalogued for the inbox', () => {
  // admin.* events are read in the English-only admin area.
  const cases = Object.keys(NOTIFICATION_REGISTRY).filter((eventKey) => !eventKey.startsWith('admin.')).flatMap((eventKey) => [
    { eventKey, variant: 'full', ctx: FULL_CONTEXT },
    { eventKey, variant: 'empty', ctx: {} },
    { eventKey, variant: 'no-reason', ctx: { ...FULL_CONTEXT, reason: undefined, clarification: undefined, isPartialRefund: false, extraCostTotal: 0, invoiceNumber: undefined, daysRemaining: undefined } },
  ]);

  it.each(cases)('$eventKey ($variant)', ({ eventKey, ctx }) => {
    const { title, body } = render(eventKey, ctx);
    for (const locale of ['nl', 'fr'] as const) {
      const localizedTitle = localizeNotificationText(title, locale);
      expect(localizedTitle, `${locale} title of ${eventKey}: ${title}`).not.toBe(title);
      if (USER_CONTENT_BODIES.has(eventKey) || /unread_(support_)?chat$/.test(eventKey)) continue;
      const localizedBody = localizeNotificationText(body, locale);
      expect(localizedBody, `${locale} body of ${eventKey}: ${body}`).not.toBe(body);
    }
  });

  it('keeps interpolated values and leaves English / unknown text alone', () => {
    expect(localizeNotificationText('"Interior painting" is now live.', 'nl')).toBe('"Interior painting" staat nu online.');
    expect(localizeNotificationText('Pro Painters sent you a quotation.', 'fr')).toBe('Pro Painters vous a envoyé un devis.');
    expect(localizeNotificationText('Payment confirmed', 'en')).toBe('Payment confirmed');
    expect(localizeNotificationText('Hello, can you come on Monday?', 'nl')).toBe('Hello, can you come on Monday?');
    expect(localizeNotificationText('Payment confirmed', null)).toBe('Payment confirmed');
  });
});
