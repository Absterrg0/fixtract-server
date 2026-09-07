/**
 * Leaf VAT country helpers (no imports from vatManagement/vatFlowchart).
 * Both SSOT layers import from here to avoid import cycles.
 */

export const REVERSE_CHARGE_LABEL = "Reverse Charge";
export const ARTICLE_47_FIELD_NAME = "article47_immovable";

export const B2B_SAME_AS_B2C_COUNTRIES = new Set(["CH", "LI", "NO", "GR"]);

const COUNTRY_ALIASES: Record<string, string> = {
  AUSTRIA: "AT",
  BELGIUM: "BE",
  BULGARIA: "BG",
  CROATIA: "HR",
  CYPRUS: "CY",
  CZECHIA: "CZ",
  "CZECH REPUBLIC": "CZ",
  DENMARK: "DK",
  ESTONIA: "EE",
  FINLAND: "FI",
  FRANCE: "FR",
  MONACO: "MC",
  GERMANY: "DE",
  GREECE: "GR",
  HUNGARY: "HU",
  IRELAND: "IE",
  ITALY: "IT",
  LATVIA: "LV",
  LITHUANIA: "LT",
  LUXEMBOURG: "LU",
  MALTA: "MT",
  NETHERLANDS: "NL",
  "THE NETHERLANDS": "NL",
  NEDERLAND: "NL",
  HOLLAND: "NL",
  POLAND: "PL",
  PORTUGAL: "PT",
  ROMANIA: "RO",
  SLOVAKIA: "SK",
  SLOVENIA: "SI",
  SPAIN: "ES",
  SWEDEN: "SE",
  SWITZERLAND: "CH",
  LIECHTENSTEIN: "LI",
  NORWAY: "NO",
  "UNITED KINGDOM": "GB",
  UK: "GB",
  "GREAT BRITAIN": "GB",
  ENGLAND: "GB",
  SCOTLAND: "GB",
  WALES: "GB",
  "UNITED STATES": "US",
  USA: "US",
  "UNITED STATES OF AMERICA": "US",
  CANADA: "CA",
  AUSTRALIA: "AU",
  "NEW ZEALAND": "NZ",
  INDIA: "IN",
  UKRAINE: "UA",
  MOLDOVA: "MD",
  ANDORRA: "AD",
  "SAN MARINO": "SM",
  TURKEY: "TR",
  TÜRKIYE: "TR",
  TURKIYE: "TR",
};

export const STANDARD_RATES: Record<string, number> = {
  BE: 21, NL: 21, DE: 19, CH: 8.1, AT: 20, LI: 8.1, FR: 20, MC: 20, GB: 20,
  IE: 23, LT: 21, LV: 21, EE: 24, ES: 21, AD: 4.5, PT: 23, IT: 22, SM: 0,
  DK: 25, NO: 25, SE: 25, FI: 25.5, PL: 23, CZ: 21, UA: 20, RO: 21, MD: 20,
  SK: 23, HU: 27, SI: 22, HR: 25, GR: 24, CY: 19, BG: 20, TR: 20,
  US: 0, CA: 0, AU: 0, NZ: 0, IN: 0,
};

const KNOWN_COUNTRY_CODES = new Set([
  ...Object.keys(STANDARD_RATES),
  ...Object.values(COUNTRY_ALIASES),
]);

export type Article47Classification = "movable" | "immovable" | "project_dependent";

export const normalizeArticle47Classification = (
  classification?: string | null,
): Article47Classification | undefined => {
  if (classification === "movable" || classification === "immovable" || classification === "project_dependent") {
    return classification;
  }
  return undefined;
};

export const parseVatCountryCode = (country?: string | null): string => {
  if (country == null || String(country).trim() === "") return "";
  const raw = String(country).trim();
  const upper = raw.toUpperCase();
  if (upper === "EL") return "GR";
  if (/^[A-Z]{2}$/.test(upper)) return KNOWN_COUNTRY_CODES.has(upper) ? upper : "";
  if (COUNTRY_ALIASES[upper]) return COUNTRY_ALIASES[upper];
  const normalizedName = upper.replace(/[.,']/g, "").replace(/\s+/g, " ");
  if (COUNTRY_ALIASES[normalizedName]) return COUNTRY_ALIASES[normalizedName];
  return "";
};

export const firstVatCountry = (...candidates: Array<string | null | undefined>): string => {
  for (const candidate of candidates) {
    const parsed = parseVatCountryCode(candidate);
    if (parsed) return parsed;
  }
  return "";
};

export const getStandardVatRate = (country?: string | null): number => {
  const normalized = parseVatCountryCode(country);
  if (!normalized) return 0;
  return STANDARD_RATES[normalized] ?? 0;
};
