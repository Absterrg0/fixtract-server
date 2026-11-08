import type { InvoiceViewerRole } from './invoiceVisibility';

/** Depth bound for the customer-view walk. Real payloads are shallow; deeper subtrees are withheld. */
export const CUSTOMER_VIEW_MAX_DEPTH = 40;

/**
 * Professional-side money and commission amounts. Withheld from every viewer
 * who is not the professional or a payments-authorized admin, wherever they
 * appear in the payload. A rule with `within` only matches under those keys.
 * Customer amounts (`customerTotals.customerNetAmount`, `payment.amount`,
 * VAT) are not listed and stay visible.
 */
const WITHHELD_FIELDS: ReadonlyArray<{ key: string; within?: readonly string[] }> = [
  { key: 'professionalNetAmount' },
  { key: 'totalAmountProfessional' },
  { key: 'totalProfessionalAmount' },
  { key: 'professionalAmount' },
  { key: 'platformCommission' },
  { key: 'professionalPayout' },
  { key: 'extraCostPlatformCommission' },
  { key: 'extraCostPlatformFee' },
  { key: 'extraCostProfessionalPayout' },
  { key: 'extraCostNetAmount' },
];

const isCommissionPercentKey = (key: string): boolean => {
  const normalized = key.replace(/[^a-z]/gi, '').toLowerCase();
  return normalized.includes('commission') && /percent|pct|rate/.test(normalized);
};

/** True when the object path ends with `suffix` (array indices are not part of the path). */
const pathEndsWith = (path: readonly string[], suffix: readonly string[]): boolean => path.length >= suffix.length
  && suffix.every((segment, index) => path[path.length - suffix.length + index] === segment);

/** `path` holds the object keys above `key`. */
const isWithheld = (key: string, path: readonly string[]): boolean => {
  if (isCommissionPercentKey(key)) return true;
  return WITHHELD_FIELDS.some((rule) => rule.key === key && (!rule.within || pathEndsWith(path, rule.within)));
};

const isLeaf = (value: object): boolean => value instanceof Date
  || Buffer.isBuffer(value)
  || typeof (value as { _bsontype?: unknown })._bsontype === 'string';

/**
 * Customer-view walk over the JSON form that `res.json` serializes. Objects
 * with `toJSON` (Mongoose documents) are read through it, as JSON.stringify
 * would. Plain objects, arrays and class instances without `toJSON` keep only
 * their own enumerable keys, which is what JSON serialization keeps too. The
 * source is never mutated, and an unchanged subtree is returned by reference.
 * A back-edge (cycle) or a subtree deeper than CUSTOMER_VIEW_MAX_DEPTH is
 * withheld rather than traversed.
 */
const customerView = (value: unknown, path: readonly string[], ancestors: readonly object[]): unknown => {
  if (value === null || typeof value !== 'object') return value;
  if (isLeaf(value as object)) return value;
  if (ancestors.length >= CUSTOMER_VIEW_MAX_DEPTH || ancestors.includes(value as object)) return undefined;
  const source: any = typeof (value as { toJSON?: unknown }).toJSON === 'function'
    ? (value as { toJSON: () => unknown }).toJSON()
    : value;
  if (source === null || typeof source !== 'object' || isLeaf(source)) return source;
  const nextAncestors = [...ancestors, value as object];
  if (Array.isArray(source)) {
    let changed = source !== value;
    const out = source.map((item) => {
      const next = customerView(item, path, nextAncestors);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? out : source;
  }
  let changed = source !== value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    const child = source[key];
    if (isWithheld(key, path)) {
      changed = true;
      continue;
    }
    const next = customerView(child, [...path, key], nextAncestors);
    if (next !== child) changed = true;
    out[key] = next;
  }
  return changed ? out : source;
};

/** One response boundary for recorded quote data, including legacy nested bags.
 * Amounts remain as recorded; percentage and professional-side amounts are
 * withheld from every viewer except the professional and payments-authorized admins.
 */
export const quotationForViewer = <T>(
  value: T,
  role: InvoiceViewerRole,
  canReadPayments = true,
): T => {
  if (role === 'professional' || (role === 'admin' && canReadPayments)) return value;
  return customerView(value, [], []) as T;
};

/** Only the existing public badge presets belong in the participant DTO. */
export const publicProfessionalTags = (tags: unknown): string[] => Array.isArray(tags)
  ? tags.filter((tag): tag is string => typeof tag === 'string' && ['verified', 'our choice'].includes(tag.toLowerCase()))
  : [];
