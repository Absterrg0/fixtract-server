import { MARKETING_LOCALES } from '../marketing/marketingCatalog';

export interface AnnouncementTranslationContent {
  title: string;
  message: string;
  ctaLabel?: string;
}

export type AnnouncementTranslations = Record<string, AnnouncementTranslationContent>;

interface GoogleTranslationResponse {
  data?: {
    translations?: Array<{ translatedText?: string }>;
  };
}

function baseLocale(locale: string): string {
  return locale.trim().toLowerCase().split('-')[0] || 'en';
}

async function translateContent(
  content: AnnouncementTranslationContent,
  source: string,
  target: string,
  apiKey: string,
): Promise<AnnouncementTranslationContent> {
  const values = [content.title, content.message, content.ctaLabel].filter(
    (value): value is string => Boolean(value),
  );
  const response = await fetch(
    `https://translation.googleapis.com/language/translate/v2?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: values, source, target, format: 'text' }),
      signal: AbortSignal.timeout(15_000),
    },
  );

  if (!response.ok) {
    throw new Error(`Automatic announcement translation failed for ${target}`);
  }

  const payload = (await response.json()) as GoogleTranslationResponse;
  const translated = payload.data?.translations?.map((item) => item.translatedText);
  if (!translated || translated.length !== values.length || translated.some((value) => !value)) {
    throw new Error(`Automatic announcement translation returned incomplete ${target} content`);
  }

  let index = 0;
  const result: AnnouncementTranslationContent = {
    title: translated[index++] as string,
    message: translated[index++] as string,
  };
  if (content.ctaLabel) result.ctaLabel = translated[index] as string;
  return result;
}

/**
 * Translate one source announcement into every supported visitor language.
 * Translations are generated at save time, so public requests never depend on
 * a third-party translation service being available.
 */
export async function buildAnnouncementTranslations(input: {
  title: string;
  message: string;
  ctaLabel?: string | null;
  locale: string;
  autoTranslate: boolean;
}): Promise<AnnouncementTranslations> {
  const source = baseLocale(input.locale);
  const sourceContent: AnnouncementTranslationContent = {
    title: input.title,
    message: input.message,
    ...(input.ctaLabel ? { ctaLabel: input.ctaLabel } : {}),
  };

  if (!input.autoTranslate) return { [source]: sourceContent };

  const apiKey = process.env.GOOGLE_TRANSLATE_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('Automatic announcement translation is not configured: GOOGLE_TRANSLATE_API_KEY is missing');
  }

  const targets = MARKETING_LOCALES.filter((locale) => locale !== source);
  const translatedEntries = await Promise.all(
    targets.map(async (target) => [
      target,
      await translateContent(sourceContent, source, target, apiKey),
    ] as const),
  );

  return Object.fromEntries([[source, sourceContent], ...translatedEntries]);
}
