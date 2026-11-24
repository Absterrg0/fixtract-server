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

/** Locale of the inbox request (Accept-Language sent by the web app). */
export function notificationLocaleOf(header: unknown): MessageLocale | null {
  return resolveMessageLocale(header);
}
