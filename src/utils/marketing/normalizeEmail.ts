/**
 * Delivery identity for marketing addresses.
 *
 * Deliberately only trims whitespace and normalizes case. Provider-specific
 * transformations (plus tags, dot folding, etc.) can change the recipient and
 * are therefore never applied here.
 */
export function normalizeEmail(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function isValidEmail(value: unknown): boolean {
  const email = normalizeEmail(value);
  return email.length > 3 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
