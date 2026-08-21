export const MARKETING_LOCALES = ['en', 'nl', 'fr', 'de'] as const;
export type MarketingLocale = (typeof MARKETING_LOCALES)[number];

export const MARKETING_LANGUAGE_CATALOG: ReadonlyArray<{
  code: MarketingLocale;
  name: string;
  countries: readonly string[];
}> = [
  { code: 'en', name: 'English', countries: ['BE', 'NL', 'FR', 'DE'] },
  { code: 'nl', name: 'Nederlands', countries: ['BE', 'NL'] },
  { code: 'fr', name: 'Français', countries: ['BE', 'FR'] },
  { code: 'de', name: 'Deutsch', countries: ['DE'] },
];

const DEFAULT_LOCALE_BY_COUNTRY: Record<string, MarketingLocale> = {
  BE: 'nl',
  NL: 'nl',
  FR: 'fr',
  DE: 'de',
};

export function isMarketingLocale(value: unknown): value is MarketingLocale {
  return typeof value === 'string' && (MARKETING_LOCALES as readonly string[]).includes(value.toLowerCase());
}

export function normalizeMarketingLocale(value: unknown): MarketingLocale | undefined {
  if (!isMarketingLocale(value)) return undefined;
  return String(value).toLowerCase() as MarketingLocale;
}

export function defaultMarketingLocaleForCountry(country: unknown): MarketingLocale {
  const code = typeof country === 'string' ? country.trim().toUpperCase() : '';
  return DEFAULT_LOCALE_BY_COUNTRY[code] || 'en';
}

export function resolveSubscriberLocale(
  user: any,
  country?: string,
): { locale: MarketingLocale; source: 'explicit' | 'country_default' | 'fallback' } {
  const explicitLocale = normalizeMarketingLocale(user?.marketingLocale);
  if (explicitLocale) return { locale: explicitLocale, source: 'explicit' };

  // Keep legacy preference fields readable while the canonical marketingLocale
  // field rolls out. They still represent an explicit user choice.
  const legacyLocale = normalizeMarketingLocale(
    user?.preferredLocale ?? user?.locale ?? user?.language,
  );
  if (legacyLocale) return { locale: legacyLocale, source: 'explicit' };

  if (country) {
    return {
      locale: defaultMarketingLocaleForCountry(country),
      source: 'country_default',
    };
  }
  return { locale: 'en', source: 'fallback' };
}

export function marketingLanguagesForCountries(countries: readonly string[]): MarketingLocale[] {
  if (countries.length === 0) return [...MARKETING_LOCALES];
  const normalized = new Set(countries.map((country) => country.trim().toUpperCase()));
  return MARKETING_LANGUAGE_CATALOG
    .filter((language) => language.countries.some((country) => normalized.has(country)))
    .map((language) => language.code);
}
