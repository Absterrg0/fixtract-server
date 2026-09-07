/**
 * Real service/question units -> display labels + UBL UNECE unit codes.
 * SSOT for unit propagation to PDF and UBL.
 * Unknown units are REJECTED (never silently mapped to C62).
 */

const UNIT_ALIASES: Record<string, string> = {
  "m2": "m²",
  "m^2": "m²",
  "sqm": "m²",
  "mètre carré": "m²",
  "hour": "hour",
  "hours": "hour",
  "heure": "hour",
  "heures": "hour",
  "uur": "hour",
  "uren": "hour",
  "day": "day",
  "days": "day",
  "room": "room",
  "rooms": "room",
  "piece": "piece",
  "pieces": "piece",
  "unit": "unit",
  "units": "unit",
};

const KNOWN_UNITS = new Set([
  "m²", "m", "m³", "hour", "day", "kg", "kwh", "kw", "kwp", "wp",
  "l", "room", "piece", "unit",
]);

const UNECE_BY_UNIT: Record<string, string> = {
  "m²": "MTK",
  "m": "MTR",
  "m³": "MTQ",
  "hour": "HUR",
  "day": "DAY",
  "kg": "KGM",
  "kwh": "KWH",
  "kw": "KWT",
  "kwp": "KWT",
  "wp": "KWT",
  "l": "LTR",
  "room": "C62",
  "piece": "C62",
  "unit": "C62",
};

export function normalizeUnitLabel(unit?: string | null): string | undefined {
  if (unit == null) return undefined;
  const trimmed = String(unit).trim();
  if (!trimmed) return undefined;
  const lower = trimmed.toLowerCase();
  if (UNIT_ALIASES[lower]) return UNIT_ALIASES[lower];
  return trimmed;
}

/** True when the unit is in the validated catalogue (case/alias-insensitive). */
export function isKnownInvoiceUnit(unit?: string | null): boolean {
  const normalized = normalizeUnitLabel(unit)?.toLowerCase();
  if (!normalized) return false;
  return KNOWN_UNITS.has(normalized);
}

/** Throw on unknown units; callers must not silently fall back to C62. */
export function assertValidInvoiceUnit(unit?: string | null, context = "invoice unit"): string | undefined {
  if (unit == null) return undefined;
  const trimmed = String(unit).trim();
  if (!trimmed) return undefined;
  const normalized = normalizeUnitLabel(trimmed);
  if (!normalized || !KNOWN_UNITS.has(normalized.toLowerCase())) {
    throw new Error(`Unknown ${context} "${trimmed}". Use a validated UNECE unit (m², hour, day, kg, kWh, kW, room, piece, unit, ...).`);
  }
  return normalized;
}

/**
 * UNECE Recommendation 20 unit codes for Peppol/UBL.
 * - undefined/empty (fixed-price, qty 1, no unit) -> C62 explicitly (documented
 *   service-unit default, not a silent unknown mapping).
 * - known units -> mapped code.
 * - unknown units -> throws (never silently C62).
 */
export function mapUnitToUneceCode(unit?: string | null): string {
  if (unit == null || String(unit).trim() === "") return "C62";
  const normalized = assertValidInvoiceUnit(unit, "UBL unit");
  const code = UNECE_BY_UNIT[normalized!.toLowerCase()];
  if (!code) throw new Error(`No UNECE mapping for unit "${String(unit)}".`);
  return code;
}

/** Resolve a VAT answer's configured unit from service-config questions. */
export function resolveVatAnswerUnit(
  fieldName: string,
  config?: {
    reducedVatQuestions?: Array<{ fieldName?: string; unit?: string }>;
    professionalVatQuestions?: Array<{ fieldName?: string; unit?: string }>;
  } | null,
): string | undefined {
  if (!fieldName || !config) return undefined;
  const all = [
    ...(config.reducedVatQuestions || []),
    ...(config.professionalVatQuestions || []),
  ];
  const match = all.find((q) => String(q?.fieldName || "").trim() === String(fieldName).trim());
  return normalizeUnitLabel(match?.unit);
}

/** Format a VAT answer value with its configured unit for invoices. */
export function formatVatAnswerWithUnit(
  fieldName: string,
  value: unknown,
  config?: Parameters<typeof resolveVatAnswerUnit>[1],
): string {
  const unit = resolveVatAnswerUnit(fieldName, config);
  const rendered = Array.isArray(value) ? value.join(", ") : String(value ?? "");
  if (!unit) return `- ${fieldName}: ${rendered}`;
  // Booleans / yes-no answers don't take units.
  const lower = rendered.trim().toLowerCase();
  if (["true", "false", "yes", "no", "y", "n"].includes(lower)) {
    return `- ${fieldName}: ${rendered}`;
  }
  return `- ${fieldName}: ${rendered} ${unit}`;
}
