type RegionDisplayNames = {
  of: (code: string) => string | undefined;
};

const regionDisplayNames =
  typeof Intl !== "undefined" && "DisplayNames" in Intl
    ? new (
        Intl as typeof Intl & {
          DisplayNames: new (locales: string[], options: { type: "region" }) => RegionDisplayNames;
        }
      ).DisplayNames(["en"], { type: "region" })
    : undefined;

export function isCmsCountryCode(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const code = value.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return false;
  // Intl knows the ISO 3166-1 alpha-2 region list; unknown two-letter values
  // (for example ZZ) are returned unchanged and must not pass validation.
  const label = regionDisplayNames?.of(code);
  return Boolean(label && label !== code && label.toLowerCase() !== "unknown region");
}

export function parseCmsCountryCode(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const code = value.trim().toUpperCase();
  return isCmsCountryCode(code) ? code : undefined;
}

export function sanitizeCmsActiveCountries(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  for (const entry of input) {
    if (typeof entry !== "string") continue;
    const code = entry.trim().toUpperCase();
    if (!isCmsCountryCode(code)) continue;
    if (!out.includes(code)) out.push(code);
  }
  return out.slice(0, 50);
}

export function isCmsContentVisibleForCountry(
  activeCountries: string[] | undefined | null,
  countryCode?: string,
): boolean {
  const countries = activeCountries || [];
  if (countries.length === 0) return true;
  if (!countryCode) return false;
  return countries.includes(countryCode);
}

/** Empty/missing activeCountries = global; otherwise match visitor country or show global-only when unknown. */
export function cmsCountryVisibilityFilter(countryCode?: string): Record<string, unknown> {
  const globalContent = [
    { activeCountries: { $size: 0 } },
    { activeCountries: { $exists: false } },
  ];
  if (countryCode) {
    return {
      $or: [...globalContent, { activeCountries: countryCode }],
    };
  }
  return { $or: globalContent };
}

export const CMS_COUNTRY_TARGETED_TYPES = new Set(["blog", "news", "faq"]);
