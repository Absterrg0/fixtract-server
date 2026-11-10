/**
 * Auto-conversion roll-out (Super Admin > Platform settings).
 *
 * Countries in `enabledCountries` get IP-derived region/language/currency;
 * every other visitor is served as `defaultCountry`. Until an admin saves
 * the setting once, `configured` is false and clients keep auto-converting
 * everywhere (the pre-roll-out behaviour).
 */

export const DEFAULT_AUTO_CONVERSION_COUNTRY = "BE";
const MAX_ENABLED_COUNTRIES = 250;
// Region codes Intl names that are not countries.
const NON_COUNTRY_REGIONS = new Set(["EU", "EZ", "UN", "QO", "ZZ"]);

let regionNames: Intl.DisplayNames | null = null;
const regionName = (code: string): string | undefined => {
  try {
    regionNames = regionNames || new Intl.DisplayNames(["en"], { type: "region" });
    return regionNames.of(code);
  } catch {
    return undefined;
  }
};

/** Uppercase ISO-3166 alpha-2 code, or null when `value` is not a real country code. */
export const normalizeCountryCode = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const code = value.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code) || NON_COUNTRY_REGIONS.has(code)) return null;
  const name = regionName(code);
  return name && name !== code ? code : null;
};

export type AutoConversionInput = { enabledCountries?: unknown; defaultCountry?: unknown };
export type AutoConversionValue = { enabledCountries: string[]; defaultCountry: string };

export class AutoConversionValidationError extends Error {
  constructor(message: string, public field: "enabledCountries" | "defaultCountry", public invalid?: string[]) {
    super(message);
    this.name = "AutoConversionValidationError";
  }
}

export const parseAutoConversionInput = (
  input: AutoConversionInput,
  current?: Partial<AutoConversionValue> | null,
): AutoConversionValue => {
  if (!Array.isArray(input.enabledCountries)) {
    throw new AutoConversionValidationError("enabledCountries must be an array of ISO country codes", "enabledCountries");
  }
  if (input.enabledCountries.length > MAX_ENABLED_COUNTRIES) {
    throw new AutoConversionValidationError("enabledCountries has too many entries", "enabledCountries");
  }
  const enabled: string[] = [];
  const invalid: string[] = [];
  for (const entry of input.enabledCountries) {
    const code = normalizeCountryCode(entry);
    if (!code) invalid.push(String(entry));
    else if (!enabled.includes(code)) enabled.push(code);
  }
  if (invalid.length > 0) {
    throw new AutoConversionValidationError(
      `Invalid country codes: ${invalid.slice(0, 10).join(", ")}`,
      "enabledCountries",
      invalid,
    );
  }

  let defaultCountry: string | null;
  if (input.defaultCountry === undefined || input.defaultCountry === null || input.defaultCountry === "") {
    defaultCountry = normalizeCountryCode(current?.defaultCountry) || DEFAULT_AUTO_CONVERSION_COUNTRY;
  } else {
    defaultCountry = normalizeCountryCode(input.defaultCountry);
    if (!defaultCountry) {
      throw new AutoConversionValidationError("defaultCountry must be an ISO 3166-1 alpha-2 country code", "defaultCountry");
    }
  }
  return { enabledCountries: enabled.sort(), defaultCountry };
};

/** Admin view: null until the roll-out has been saved once. */
export const serializeAdminAutoConversion = (value: any) =>
  value?.configuredAt
    ? {
        enabledCountries: Array.isArray(value.enabledCountries) ? [...value.enabledCountries] : [],
        defaultCountry: normalizeCountryCode(value.defaultCountry) || DEFAULT_AUTO_CONVERSION_COUNTRY,
        configuredAt: value.configuredAt,
      }
    : null;

/** Public view consumed by the frontend middleware. */
export const serializePublicAutoConversion = (value: any) => {
  const admin = serializeAdminAutoConversion(value);
  return {
    configured: Boolean(admin),
    enabledCountries: admin?.enabledCountries || [],
    defaultCountry: admin?.defaultCountry || DEFAULT_AUTO_CONVERSION_COUNTRY,
  };
};
