/**
 * Customer "recorded savings" read-model.
 *
 * Single shared aggregation for the customer benefits UI (and any dashboard
 * reuse): sums ONLY persisted discount snapshots written at checkout.
 * No credit creation, no reward-logic changes, no currency conversion.
 *
 * Sources, per settled payment (never both for the same payment):
 * - `paymentDiscountLedger`: one immutable entry per succeeded PaymentIntent,
 *   keyed by intent id and milestone index. It survives the next milestone
 *   checkout replacing `booking.payment`.
 * - Legacy fallback: the current `booking.payment.discount`, used only for
 *   the payment it belongs to and only when the ledger has no entry for that
 *   PaymentIntent. Payments settled before the ledger existed and already
 *   replaced by a later checkout have no snapshot anywhere: they stay
 *   `unrecorded` (unknown), never inferred from `milestonePayments`.
 *
 * Settled payments:
 * - Milestone bookings: each milestone marked `paid` is one settled payment.
 * - Other bookings: the booking payment once `payment.status === 'completed'`.
 *
 * Hard rules:
 * - Pending, authorized (non-milestone), failed payments are excluded.
 * - Bookings whose current payment is `partially_refunded` or `disputed`, or
 *   whose booking is under an unresolved dispute, are excluded from totals
 *   AND surfaced as uncertain: no per-payment refund allocation exists.
 * - A fully refunded single payment is excluded (no saving). A refunded
 *   milestone booking that has other settled milestones is uncertain, because
 *   refunds are only tracked against the current PaymentIntent.
 * - Referral savings use explicit checkout attribution only. Historical
 *   snapshots without attribution remain unknown; rewards/points are separate.
 * - One currency group per currency; never summed across currencies.
 * - Per payment, parts are capped at that payment's `originalAmount`.
 * - Each payment counts once: ledger entries are deduplicated by intent id and
 *   by milestone index, and a ledger entry for the current intent suppresses
 *   the legacy snapshot.
 */

export type SavingsCoverage = 'complete' | 'partial';

export interface RecordedDiscountSnapshot {
  loyaltyAmount?: unknown;
  repeatBuyerAmount?: unknown;
  pointsDiscountAmount?: unknown;
  codeDiscountAmount?: unknown;
  referralDiscountAmount?: unknown;
  originalAmount?: unknown;
  codeLabel?: unknown;
  codeId?: unknown;
}

export interface SavingsLedgerEntryInput extends RecordedDiscountSnapshot {
  paymentIntentId?: unknown;
  milestoneIndex?: unknown;
  currency?: unknown;
}

export interface SavingsBookingInput {
  /** Booking lifecycle status; `dispute` makes the booking uncertain. */
  status?: unknown;
  payment?: {
    status?: unknown;
    currency?: unknown;
    stripePaymentIntentId?: unknown;
    milestoneIndex?: unknown;
    discount?: RecordedDiscountSnapshot | null;
  };
  milestonePayments?: unknown;
  /** Per-payment snapshots recorded when each PaymentIntent succeeded. */
  paymentDiscountLedger?: unknown;
}

export interface SavingsByType {
  /** Recurring/repeat-buyer discount. */
  recurring: number;
  /** Loyalty-tier discount. */
  loyalty: number;
  /** Discount-code discount. */
  discountCode: number;
  /** Redeemed-points money (only when actually redeemed, by construction). */
  points: number;
}

export interface SavingsCurrencyGroup {
  currency: string;
  byType: SavingsByType;
  /** Null when any included snapshot lacks referral attribution. */
  referral: number | null;
  recordedReferral: number;
  totalRecorded: number;
  bookingCount: number;
  coverage: SavingsCoverage;
  /** Partially-refunded settled bookings excluded for lack of ledger allocation. */
  excludedUncertain: number;
  /** Settled bookings with at least one payment lacking a snapshot (unknown, never 0). */
  unrecorded: number;
  /** Settled payments whose discount snapshot was summed. */
  recordedPaymentCount: number;
  /** Settled payments without any snapshot (legacy data). */
  unrecordedPaymentCount: number;
}

export interface RecordedSavingsSummary {
  groups: SavingsCurrencyGroup[];
  /** True only when every settled booking had a recorded snapshot. */
  complete: boolean;
  settledBookingCount: number;
  unrecordedBookingCount: number;
  excludedUncertainCount: number;
  /** Settled payments (milestones or whole-booking payments) counted. */
  settledPaymentCount: number;
  unrecordedPaymentCount: number;
}

const SETTLED_PAYMENT_STATUS = 'completed';
const EXCLUDED_UNCERTAIN_STATUSES = new Set(['partially_refunded', 'disputed']);
const REFUNDED_PAYMENT_STATUS = 'refunded';
/** Statuses under which the current payment's own intent has succeeded. */
const SUCCEEDED_PAYMENT_STATUSES = new Set(['authorized', 'completed']);

const DISPUTED_BOOKING_STATUS = 'dispute';

const toAmount = (value: unknown): number => {
  const amount = typeof value === 'string' ? Number(value) : (value as number);
  return typeof amount === 'number' && Number.isFinite(amount) && amount > 0 ? amount : 0;
};

const toIndex = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;

const toIntentId = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

const normalizeCurrency = (value: unknown): string => {
  const code = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return /^[A-Z]{3}$/.test(code) ? code : 'UNKNOWN';
};

const hasSnapshot = (snapshot: RecordedDiscountSnapshot | null | undefined): boolean =>
  Boolean(snapshot) &&
  (toAmount(snapshot?.loyaltyAmount) > 0 ||
    toAmount(snapshot?.repeatBuyerAmount) > 0 ||
    toAmount(snapshot?.pointsDiscountAmount) > 0 ||
    toAmount(snapshot?.codeDiscountAmount) > 0 ||
    toAmount(snapshot?.originalAmount) > 0);

const partsOf = (snapshot: RecordedDiscountSnapshot): SavingsByType => ({
  recurring: toAmount(snapshot.repeatBuyerAmount),
  loyalty: toAmount(snapshot.loyaltyAmount),
  discountCode: toAmount(snapshot.codeDiscountAmount),
  points: toAmount(snapshot.pointsDiscountAmount),
});

/** Indexes of milestone rows marked paid (empty for non-milestone bookings). */
const paidMilestoneIndexes = (milestonePayments: unknown): number[] =>
  Array.isArray(milestonePayments)
    ? milestonePayments.flatMap((milestone, index) =>
        (milestone as { status?: unknown } | null)?.status === 'paid' ? [index] : [])
    : [];

/** Ledger entries with a PaymentIntent id, first entry per intent and per milestone. */
const ledgerEntries = (ledger: unknown): SavingsLedgerEntryInput[] => {
  if (!Array.isArray(ledger)) return [];
  const seenIntents = new Set<string>();
  const seenMilestones = new Set<number>();
  const entries: SavingsLedgerEntryInput[] = [];
  for (const raw of ledger) {
    const entry = raw as SavingsLedgerEntryInput | null;
    const intentId = toIntentId(entry?.paymentIntentId);
    if (!entry || !intentId || seenIntents.has(intentId)) continue;
    const milestoneIndex = toIndex(entry.milestoneIndex);
    if (milestoneIndex !== undefined && seenMilestones.has(milestoneIndex)) continue;
    seenIntents.add(intentId);
    if (milestoneIndex !== undefined) seenMilestones.add(milestoneIndex);
    entries.push(entry);
  }
  return entries;
};

/** A settled payment and the snapshot recorded for it, if any. */
interface SettledPayment {
  currency: string;
  snapshot: RecordedDiscountSnapshot | null;
}

/**
 * Resolve each settled payment of one booking to exactly one snapshot source.
 * The legacy current-payment snapshot is used only when no ledger entry exists
 * for the current PaymentIntent, and for at most one settled payment.
 */
const settledPaymentsOf = (booking: SavingsBookingInput): SettledPayment[] => {
  const payment = booking?.payment;
  const status = payment?.status;
  const currentIntent = toIntentId(payment?.stripePaymentIntentId);
  const currentMilestone = toIndex(payment?.milestoneIndex);
  const fallbackCurrency = normalizeCurrency(payment?.currency);
  const entries = ledgerEntries(booking?.paymentDiscountLedger);
  const currentHasLedgerEntry = Boolean(currentIntent) &&
    entries.some((entry) => toIntentId(entry.paymentIntentId) === currentIntent);
  let legacyAvailable = !currentHasLedgerEntry &&
    typeof status === 'string' && SUCCEEDED_PAYMENT_STATUSES.has(status) &&
    hasSnapshot(payment?.discount);

  const fromEntry = (entry: SavingsLedgerEntryInput): SettledPayment => ({
    currency: entry.currency !== undefined ? normalizeCurrency(entry.currency) : fallbackCurrency,
    snapshot: entry,
  });
  const fromLegacy = (): SettledPayment => {
    legacyAvailable = false;
    return { currency: fallbackCurrency, snapshot: payment!.discount! };
  };

  const paidMilestones = paidMilestoneIndexes(booking?.milestonePayments);
  if (paidMilestones.length > 0) {
    const resolved = new Map<number, SettledPayment | null>();
    for (const index of paidMilestones) {
      const entry = entries.find((candidate) => toIndex(candidate.milestoneIndex) === index);
      if (entry) resolved.set(index, fromEntry(entry));
      else if (legacyAvailable && currentMilestone === index) resolved.set(index, fromLegacy());
      else resolved.set(index, null);
    }
    // Legacy payments without a stored milestone index: the current snapshot
    // belongs to one paid milestone, so it covers one unresolved milestone.
    if (legacyAvailable && currentMilestone === undefined) {
      const open = paidMilestones.find((index) => resolved.get(index) === null);
      if (open !== undefined) resolved.set(open, fromLegacy());
    }
    return paidMilestones.map((index) =>
      resolved.get(index) ?? { currency: fallbackCurrency, snapshot: null });
  }

  if (status !== SETTLED_PAYMENT_STATUS) return [];
  const entry = currentIntent
    ? entries.find((candidate) => toIntentId(candidate.paymentIntentId) === currentIntent)
    : undefined;
  if (entry) return [fromEntry(entry)];
  if (legacyAvailable) return [fromLegacy()];
  return [{ currency: fallbackCurrency, snapshot: null }];
};

export function aggregateRecordedSavings(
  bookings: SavingsBookingInput[],
): RecordedSavingsSummary {
  const groups = new Map<string, SavingsCurrencyGroup>();
  let settledBookingCount = 0;
  let unrecordedBookingCount = 0;
  let excludedUncertainCount = 0;
  let settledPaymentCount = 0;
  let unrecordedPaymentCount = 0;

  const groupFor = (currency: string): SavingsCurrencyGroup => {
    let group = groups.get(currency);
    if (!group) {
      group = {
        currency,
        byType: { recurring: 0, loyalty: 0, discountCode: 0, points: 0 },
        referral: 0,
        recordedReferral: 0,
        totalRecorded: 0,
        bookingCount: 0,
        coverage: 'complete',
        excludedUncertain: 0,
        unrecorded: 0,
        recordedPaymentCount: 0,
        unrecordedPaymentCount: 0,
      };
      groups.set(currency, group);
    }
    return group;
  };

  const markUncertain = (currency: unknown) => {
    excludedUncertainCount += 1;
    const group = groupFor(normalizeCurrency(currency));
    group.excludedUncertain += 1;
    group.coverage = 'partial';
  };

  /** Add one payment's capped snapshot, allocating the cap in cents. */
  const addSnapshot = (group: SavingsCurrencyGroup, snapshot: RecordedDiscountSnapshot) => {
    const parts = { ...partsOf(snapshot), referral: toAmount(snapshot.referralDiscountAmount) };
    if (snapshot.referralDiscountAmount === undefined) group.referral = null;
    const original = toAmount(snapshot.originalAmount);
    const keys = Object.keys(parts) as (keyof typeof parts)[];
    const sum = keys.reduce((total, key) => total + parts[key], 0);
    // Allocate the capped total in cents, preserving proportions and the total
    // even when rounding several component rows would otherwise add a cent.
    const totalCents = Math.round((original > 0 ? Math.min(sum, original) : sum) * 100);
    const allocations = keys.map((key) => {
      const exact = sum > 0 ? parts[key] / sum * totalCents : 0;
      return { key, cents: Math.floor(exact), remainder: exact - Math.floor(exact) };
    });
    const remaining = totalCents - allocations.reduce((total, part) => total + part.cents, 0);
    allocations.sort((a, b) => b.remainder - a.remainder);
    for (let i = 0; i < remaining; i++) allocations[i].cents += 1;
    for (const { key, cents } of allocations) {
      if (key === 'referral') {
        group.recordedReferral += cents / 100;
        if (group.referral !== null) group.referral += cents / 100;
      } else group.byType[key] += cents / 100;
    }
    group.totalRecorded += totalCents / 100;
  };

  for (const booking of bookings || []) {
    const status = booking?.payment?.status;
    const currency = booking?.payment?.currency;
    const settled = settledPaymentsOf(booking);
    const isUncertainPayment = typeof status === 'string' && EXCLUDED_UNCERTAIN_STATUSES.has(status);

    // An open dispute leaves payment.status untouched, but the settlement is
    // no longer certain: exclude it from totals and mark coverage partial.
    if (booking?.status === DISPUTED_BOOKING_STATUS && (settled.length > 0 || isUncertainPayment)) {
      markUncertain(currency);
      continue;
    }
    if (isUncertainPayment) {
      markUncertain(currency);
      continue;
    }
    if (status === REFUNDED_PAYMENT_STATUS) {
      // Refunds are tracked against the current PaymentIntent only. Earlier
      // paid milestones of a refunded booking may or may not be refunded.
      if (settled.length > 0) markUncertain(currency);
      continue;
    }
    if (settled.length === 0) continue;

    settledBookingCount += 1;
    const touched = new Set<SavingsCurrencyGroup>();
    let bookingUnrecorded = false;
    for (const settledPayment of settled) {
      settledPaymentCount += 1;
      const group = groupFor(settledPayment.currency);
      // A ledger entry is a recorded value even when every part is zero.
      if (!settledPayment.snapshot) {
        unrecordedPaymentCount += 1;
        group.unrecordedPaymentCount += 1;
        group.coverage = 'partial';
        group.referral = null;
        if (!bookingUnrecorded) {
          bookingUnrecorded = true;
          unrecordedBookingCount += 1;
          group.unrecorded += 1;
        }
        continue;
      }
      addSnapshot(group, settledPayment.snapshot);
      group.recordedPaymentCount += 1;
      touched.add(group);
    }
    for (const group of touched) group.bookingCount += 1;
  }

  // Round money to cents after accumulation.
  for (const group of groups.values()) {
    group.byType.recurring = Math.round(group.byType.recurring * 100) / 100;
    group.byType.loyalty = Math.round(group.byType.loyalty * 100) / 100;
    group.byType.discountCode = Math.round(group.byType.discountCode * 100) / 100;
    group.byType.points = Math.round(group.byType.points * 100) / 100;
    group.recordedReferral = Math.round(group.recordedReferral * 100) / 100;
    if (group.referral !== null) group.referral = Math.round(group.referral * 100) / 100;
    group.totalRecorded = Math.round(group.totalRecorded * 100) / 100;
  }

  return {
    groups: [...groups.values()],
    complete: unrecordedBookingCount === 0 && excludedUncertainCount === 0,
    settledBookingCount,
    unrecordedBookingCount,
    excludedUncertainCount,
    settledPaymentCount,
    unrecordedPaymentCount,
  };
}
