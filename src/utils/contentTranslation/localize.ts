/**
 * Read side of the catalogue/project translation memory.
 *
 * Public responses keep every original value (titles, option values, VAT
 * question text the booking flow matches on) and add
 *
 *   contentTranslations: { locale: "nl", texts: { "<source text>": "<nl text>" } }
 *
 * for exactly the strings in that response that have a stored translation in
 * the request locale. Old clients ignore the field; the web app shows
 * `texts[source] ?? source`. Only the request locale is ever returned, and
 * reads never call the provider (one indexed `$in` lookup).
 */
import type { Request } from "express";

import ContentTranslation from "../../models/contentTranslation";
import { resolveMessageLocale } from "../../i18n/locale";
import { contentTextHash, isContentLocale, isTranslatableText, type ContentLocale } from "./texts";

export interface ContentTranslations {
  locale: ContentLocale;
  texts: Record<string, string>;
}

/** Locale of the request (Accept-Language, as sent by the web app), or null. */
export function contentLocaleOf(req: Pick<Request, "headers"> | null | undefined): ContentLocale | null {
  const locale = resolveMessageLocale(req?.headers?.["accept-language"]);
  return isContentLocale(locale) ? locale : null;
}

/** Bound on one lookup; a project page has a few hundred strings at most. */
const MAX_LOOKUP_TEXTS = 2_000;

/**
 * Stored translations of `texts` into `locale`, keyed by the original string.
 * Strings whose source language is the locale itself are skipped (shown as
 * written). Returns undefined when nothing applies, so responses stay as before.
 */
export async function loadContentTranslations(
  texts: Iterable<string>,
  locale: ContentLocale | null | undefined
): Promise<ContentTranslations | undefined> {
  if (!locale) return undefined;
  const byHash = new Map<string, string[]>();
  for (const text of texts) {
    if (!isTranslatableText(text)) continue;
    const hash = contentTextHash(text);
    const originals = byHash.get(hash);
    if (originals) {
      if (!originals.includes(text)) originals.push(text);
    } else {
      if (byHash.size >= MAX_LOOKUP_TEXTS) break;
      byHash.set(hash, [text]);
    }
  }
  if (byHash.size === 0) return undefined;

  let rows: Array<Record<string, any>>;
  try {
    rows = (await ContentTranslation.find({
      hash: { $in: Array.from(byHash.keys()) },
      [`translations.${locale}`]: { $exists: true },
    })
      .select(`hash from translations.${locale}`)
      .lean()) as Array<Record<string, any>>;
  } catch (err) {
    // Translations are an enhancement: never fail the page because of them.
    console.error("[contentTranslations] lookup failed:", err);
    return undefined;
  }

  // Null prototype: any display string (even "__proto__") is an own key.
  const result: Record<string, string> = Object.create(null);
  for (const row of rows) {
    if (row.from === locale) continue;
    const translated = row.translations?.[locale];
    if (typeof translated !== "string" || !translated.trim()) continue;
    for (const original of byHash.get(String(row.hash)) || []) {
      if (translated !== original) result[original] = translated;
    }
  }
  return Object.keys(result).length ? { locale, texts: result } : undefined;
}
