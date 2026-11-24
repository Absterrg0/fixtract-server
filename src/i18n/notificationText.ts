import { resolveMessageLocale, type MessageLocale } from "./locale";
import { localizeMessage } from "./translate";

/**
 * In-app notification copy in the viewer's language.
 *
 * Notifications are stored with the English title/body their event builder
 * rendered (utils/notifications/registry.ts). Every builder sentence is
 * catalogued under `notification.*` in ./messages, so the inbox translates the
 * stored text when it is read — this also covers notifications created before
 * translation support. Text that is not catalogued (chat previews, names,
 * project titles on their own) is returned unchanged.
 */
export function localizeNotificationText(text: string, locale: MessageLocale | null): string {
  if (!locale || locale === "en" || typeof text !== "string" || !text) return text;
  try {
    return localizeMessage(text, locale)?.text ?? text;
  } catch {
    return text;
  }
}

/**
 * Events whose stored body is text a user wrote (the chat message preview).
 * It is shown as written, even when it happens to equal catalogued copy
 * ("Payment confirmed"); this covers notifications stored before the inbox
 * was localized too, since every notification has its eventKey.
 */
export const USER_WRITTEN_BODY_EVENTS: ReadonlySet<string> = new Set(["user.chat_message"]);

/** Body of a stored notification in the viewer's language (user-written bodies unchanged). */
export function localizeNotificationBody(
  eventKey: string | undefined,
  body: string,
  locale: MessageLocale | null
): string {
  if (eventKey && USER_WRITTEN_BODY_EVENTS.has(eventKey)) return body;
  return localizeNotificationText(body, locale);
}

/** Locale of the inbox request (Accept-Language sent by the web app). */
export function notificationLocaleOf(header: unknown): MessageLocale | null {
  return resolveMessageLocale(header);
}
