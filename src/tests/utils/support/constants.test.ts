import { describe, expect, it } from 'vitest';
import {
  SUPPORT_MEETING_DURATION_MINUTES,
  SUPPORT_REASON_IDS,
  SUPPORT_REASON_LABELS,
  SUPPORT_REASON_OPTIONS,
  normalizeSupportLocale,
  normalizeSupportReason,
  supportReasonLabel,
} from '../../../constants/support';

describe('support reason contract', () => {
  it('keeps the exact 13 stable IDs and original English labels', () => {
    expect(SUPPORT_REASON_OPTIONS).toEqual([
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
    ]);
    expect(SUPPORT_REASON_IDS).toHaveLength(13);
    expect(SUPPORT_REASON_LABELS.booking).toBe('Booking');
  });

  it('normalizes canonical IDs and exact English labels', () => {
    expect(normalizeSupportReason('payment_payout')).toBe('payment_payout');
    expect(normalizeSupportReason('Payment / payout')).toBe('payment_payout');
    expect(normalizeSupportReason('  SERVICES & PRICING ')).toBe('services_pricing');
    expect(normalizeSupportReason('Payment')).toBeUndefined();
    expect(normalizeSupportReason(undefined)).toBeUndefined();
  });

  it('returns the English label for validation/emails and keeps the duration at 30', () => {
    expect(supportReasonLabel('warranty_complaint')).toBe('Warranty / complaint');
    expect(supportReasonLabel('unknown')).toBeNull();
    expect(SUPPORT_MEETING_DURATION_MINUTES).toBe(30);
  });

  it('falls back to English for unsupported locales', () => {
    expect(normalizeSupportLocale('nl')).toBe('nl');
    expect(normalizeSupportLocale('FR')).toBe('fr');
    expect(normalizeSupportLocale('de', 'nl')).toBe('nl');
    expect(normalizeSupportLocale(undefined, undefined)).toBe('en');
  });
});
