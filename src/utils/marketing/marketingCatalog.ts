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

export function marketingLanguagesForCountries(countries: readonly string[]): MarketingLocale[] {
  if (countries.length === 0) return [...MARKETING_LOCALES];
  const normalized = new Set(countries.map((country) => country.trim().toUpperCase()));
  return MARKETING_LANGUAGE_CATALOG
    .filter((language) => language.countries.some((country) => normalized.has(country)))
    .map((language) => language.code);
}
