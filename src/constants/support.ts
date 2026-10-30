export const SUPPORT_KINDS = ['ticket', 'meeting'] as const;
export type SupportKind = (typeof SUPPORT_KINDS)[number];

export const SUPPORT_TICKET_STATUSES = ['open', 'in_progress', 'resolved', 'closed'] as const;
export type SupportTicketStatus = (typeof SUPPORT_TICKET_STATUSES)[number];

export const SUPPORT_MEETING_STATUSES = [
  'pending',
  'scheduled',
  'declined',
  'cancelled',
  'completed',
] as const;
export type SupportMeetingStatus = (typeof SUPPORT_MEETING_STATUSES)[number];

/** Statuses searchable/displayed across both kinds. */
export const SUPPORT_DISPLAY_STATUSES = [
  ...SUPPORT_TICKET_STATUSES,
  ...SUPPORT_MEETING_STATUSES,
] as const;
export type SupportDisplayStatus = (typeof SUPPORT_DISPLAY_STATUSES)[number];

export const SUPPORT_USER_TYPES = ['customer', 'professional'] as const;
export type SupportUserType = (typeof SUPPORT_USER_TYPES)[number];

export const SUPPORT_LOCALES = ['en', 'nl', 'fr'] as const;
export type SupportLocale = (typeof SUPPORT_LOCALES)[number];

export const SUPPORT_MEETING_DURATION_MINUTES = 30;

/** Stable reason IDs plus the original English labels required by the product. */
export const SUPPORT_REASONS = [
  { id: 'booking', label: 'Booking' },
  { id: 'project_creation', label: 'Project creation' },
  { id: 'customer', label: 'Customer' },
  { id: 'payment_payout', label: 'Payment / payout' },
  { id: 'cancellation', label: 'Cancellation' },
  { id: 'dispute', label: 'Dispute' },
  { id: 'warranty_complaint', label: 'Warranty / complaint' },
  { id: 'account_profile', label: 'Account / profile' },
  { id: 'verification_documents', label: 'Verification / documents' },
  { id: 'services_pricing', label: 'Services & pricing' },
  { id: 'availability_service_area', label: 'Availability / service area' },
  { id: 'technical_problem', label: 'Technical problem' },
  { id: 'other', label: 'Other' },
] as const;

export type SupportReasonId = (typeof SUPPORT_REASONS)[number]['id'];

export const SUPPORT_REASON_IDS = SUPPORT_REASONS.map((reason) => reason.id) as SupportReasonId[];

const REASON_BY_ID = new Map<string, (typeof SUPPORT_REASONS)[number]>(
  SUPPORT_REASONS.map((reason) => [reason.id, reason]),
);

const REASON_BY_LABEL = new Map<string, (typeof SUPPORT_REASONS)[number]>(
  SUPPORT_REASONS.map((reason) => [reason.label.toLowerCase(), reason]),
);

export function isSupportReasonId(value: unknown): value is SupportReasonId {
  return typeof value === 'string' && REASON_BY_ID.has(value);
}

/**
 * Accepts the canonical ID or the exact English label (legacy/form fallback).
 * Returns undefined for anything else so callers can produce a field error.
 */
export function normalizeSupportReason(value: unknown): SupportReasonId | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const byId = REASON_BY_ID.get(trimmed);
  if (byId) return byId.id;
  const byLabel = REASON_BY_LABEL.get(trimmed.toLowerCase());
  return byLabel?.id;
}

export function supportReasonLabel(reason: unknown): string | null {
  if (typeof reason !== 'string') return null;
  return REASON_BY_ID.get(reason)?.label ?? null;
}

export function supportReasonById(reason: string): (typeof SUPPORT_REASONS)[number] | undefined {
  return REASON_BY_ID.get(reason);
}

export function isSupportKind(value: unknown): value is SupportKind {
  return typeof value === 'string' && (SUPPORT_KINDS as readonly string[]).includes(value);
}

export function isSupportTicketStatus(value: unknown): value is SupportTicketStatus {
  return typeof value === 'string' && (SUPPORT_TICKET_STATUSES as readonly string[]).includes(value);
}

export function isSupportMeetingStatus(value: unknown): value is SupportMeetingStatus {
  return typeof value === 'string' && (SUPPORT_MEETING_STATUSES as readonly string[]).includes(value);
}

export function isSupportUserType(value: unknown): value is SupportUserType {
  return typeof value === 'string' && (SUPPORT_USER_TYPES as readonly string[]).includes(value);
}

export function normalizeSupportLocale(value: unknown, fallback?: unknown): SupportLocale {
  const candidates = [value, fallback];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const normalized = candidate.trim().toLowerCase();
    if ((SUPPORT_LOCALES as readonly string[]).includes(normalized)) {
      return normalized as SupportLocale;
    }
  }
  return 'en';
}

export function isSupportLocale(value: unknown): value is SupportLocale {
  return typeof value === 'string' && (SUPPORT_LOCALES as readonly string[]).includes(value);
}

export interface SupportReasonOption {
  id: SupportReasonId;
  label: string;
}

export const SUPPORT_REASON_OPTIONS: SupportReasonOption[] = SUPPORT_REASONS.map((reason) => ({
  id: reason.id,
  label: reason.label,
}));

export const SUPPORT_REASON_LABELS: Record<SupportReasonId, string> = SUPPORT_REASONS.reduce(
  (acc, reason) => {
    acc[reason.id] = reason.label;
    return acc;
  },
  {} as Record<SupportReasonId, string>,
);
