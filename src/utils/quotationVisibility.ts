import type { InvoiceViewerRole } from './invoiceVisibility';

/** One response boundary for recorded quote data, including legacy nested bags.
 * Amounts remain as recorded; percentage confidentiality is independent of the
 * pending product decision about disclosing both pricing bases.
 */
export const quotationForViewer = <T>(
  value: T,
  role: InvoiceViewerRole,
  canReadPayments = true,
): T => {
  if (role === 'professional' || (role === 'admin' && canReadPayments)) return value;
  const visit = (entry: any): any => {
    if (entry == null || typeof entry !== 'object') return entry;
    if (entry instanceof Date || typeof entry.toHexString === 'function' || Buffer.isBuffer(entry)) return entry;
    if (Array.isArray(entry)) return entry.map(visit);
    const source = typeof entry.toObject === 'function' ? entry.toObject() : entry;
    const copy: Record<string, any> = {};
    for (const [key, child] of Object.entries(source)) {
      const normalized = key.replace(/[^a-z]/gi, '').toLowerCase();
      if (normalized.includes('commission') && /percent|pct|rate/.test(normalized)) continue;
      copy[key] = visit(child);
    }
    return copy;
  };
  return visit(value);
};

/** Only the existing public badge presets belong in the participant DTO. */
export const publicProfessionalTags = (tags: unknown): string[] => Array.isArray(tags)
  ? tags.filter((tag): tag is string => typeof tag === 'string' && ['verified', 'our choice'].includes(tag.toLowerCase()))
  : [];
