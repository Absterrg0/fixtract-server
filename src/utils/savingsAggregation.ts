/**
 * Customer "recorded savings" read-model.
 *
 * Single shared aggregation for the customer benefits UI (and any dashboard
 * reuse): sums ONLY persisted discount snapshots written at checkout
 * (`payment.discount` on the booking).
 * No credit creation, no reward-logic changes, no currency conversion.
 *
 * Hard rules:
 * - Settled bookings only (`payment.status === 'completed'`). Pending,
 *   authorized, failed, refunded, disputed are excluded. `partially_refunded`
 *   bookings are excluded from totals AND surfaced as uncertain — no
 *   proportional invented allocation exists in the ledger.
 * - Referral savings are NOT separately recorded in any snapshot. Reported as
 *   `null` (not separately recorded), never 0, and points redemptions are
 *   never attributed to referrals.
 * - One currency group per currency; never summed across currencies.
 * - Completed bookings without a discount snapshot are counted as
 *   `unrecorded` (display "unknown"), never 0.
 * - Per booking, parts are capped at `originalAmount` (double-count guard).
 * - Milestones have no independent discount snapshot and are never added.
 *   Each milestone checkout replaces `booking.payment` (and its snapshot), so
 *   only the latest settled payment's discount survives. Earlier paid
 *   milestones are surfaced as unrecorded (lower-bound total), never inferred.
 * - Bookings under an unresolved dispute (`booking.status === 'dispute'`) are
 *   excluded as uncertain even when `payment.status` is still `completed`.
 */

export type SavingsCoverage = 'complete' | 'partial';

export interface RecordedDiscountSnapshot {
  loyaltyAmount?: unknown;
  repeatBuyerAmount?: unknown;
  pointsDiscountAmount?: unknown;
  codeDiscountAmount?: unknown;
  originalAmount?: unknown;
  codeLabel?: unknown;
  codeId?: unknown;
}

export interface SavingsBookingInput {
  /** Booking lifecycle status; `dispute` makes the booking uncertain. */
  status?: unknown;
  payment?: {
    status?: unknown;
    currency?: unknown;
    discount?: RecordedDiscountSnapshot | null;
  };
  milestonePayments?: unknown;
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
  /** Referral savings are not separately recorded — always null. */
  referral: null;
  totalRecorded: number;
  bookingCount: number;
  coverage: SavingsCoverage;
  /** Partially-refunded settled bookings excluded for lack of ledger allocation. */
  excludedUncertain: number;
  /** Completed bookings with no discount snapshot (unknown, never 0). */
  unrecorded: number;
}

export interface RecordedSavingsSummary {
  groups: SavingsCurrencyGroup[];
  /** True only when every settled booking had a recorded snapshot. */
  complete: boolean;
  settledBookingCount: number;
  unrecordedBookingCount: number;
  excludedUncertainCount: number;
}

const SETTLED_PAYMENT_STATUS = 'completed';
const EXCLUDED_UNCERTAIN_STATUSES = new Set(['partially_refunded', 'disputed']);

const DISPUTED_BOOKING_STATUS = 'dispute';

/** Number of milestone rows already marked paid (0 for non-milestone bookings). */
const paidMilestoneCount = (milestonePayments: unknown): number =>
  Array.isArray(milestonePayments)
    ? milestonePayments.filter((milestone) => (milestone as { status?: unknown } | null)?.status === 'paid').length
    : 0;

const toAmount = (value: unknown): number => {
  const amount = typeof value === 'string' ? Number(value) : (value as number);
  return typeof amount === 'number' && Number.isFinite(amount) && amount > 0 ? amount : 0;
};

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

export function aggregateRecordedSavings(
  bookings: SavingsBookingInput[],
): RecordedSavingsSummary {
  const groups = new Map<string, SavingsCurrencyGroup>();
  let settledBookingCount = 0;
  let unrecordedBookingCount = 0;
  let excludedUncertainCount = 0;

  const groupFor = (currency: string): SavingsCurrencyGroup => {
    let group = groups.get(currency);
    if (!group) {
      group = {
        currency,
        byType: { recurring: 0, loyalty: 0, discountCode: 0, points: 0 },
        referral: null,
        totalRecorded: 0,
        bookingCount: 0,
        coverage: 'complete',
        excludedUncertain: 0,
        unrecorded: 0,
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
  const markUnrecorded = (group: SavingsCurrencyGroup) => {
    unrecordedBookingCount += 1;
    group.unrecorded += 1;
    group.coverage = 'partial';
  };

  for (const booking of bookings || []) {
    const status = booking?.payment?.status;
    const paidMilestones = paidMilestoneCount(booking?.milestonePayments);
    const isUncertainPayment = typeof status === 'string' && EXCLUDED_UNCERTAIN_STATUSES.has(status);
    const hasSettledValue = status === SETTLED_PAYMENT_STATUS || paidMilestones > 0;

    // An open dispute leaves payment.status untouched, but the settlement is
    // no longer certain: exclude it from totals and mark coverage partial.
    if (booking?.status === DISPUTED_BOOKING_STATUS && (hasSettledValue || isUncertainPayment)) {
      markUncertain(booking?.payment?.currency);
      continue;
    }
    if (status !== SETTLED_PAYMENT_STATUS) {
      if (isUncertainPayment) {
        markUncertain(booking?.payment?.currency);
      } else if (paidMilestones > 0) {
        // Earlier milestones were paid, but the next milestone's pending
        // payment replaced their discount snapshot: settled, value unknown.
        settledBookingCount += 1;
        markUnrecorded(groupFor(normalizeCurrency(booking?.payment?.currency)));
      }
      continue;
    }
    settledBookingCount += 1;
    const group = groupFor(normalizeCurrency(booking?.payment?.currency));
    const snapshot = booking.payment?.discount;
    if (!hasSnapshot(snapshot)) {
      markUnrecorded(group);
      continue;
    }
    // Only the latest settled milestone's snapshot is recorded; any earlier
    // paid milestone makes this booking's total a lower bound.
    if (paidMilestones > 1) markUnrecorded(group);
    const parts = partsOf(snapshot!);
    const original = toAmount(snapshot!.originalAmount);
    const keys = Object.keys(parts) as (keyof SavingsByType)[];
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
    for (const { key, cents } of allocations) group.byType[key] += cents / 100;
    group.totalRecorded += totalCents / 100;
    group.bookingCount += 1;
  }

  // Round money to cents after accumulation.
  for (const group of groups.values()) {
    group.byType.recurring = Math.round(group.byType.recurring * 100) / 100;
    group.byType.loyalty = Math.round(group.byType.loyalty * 100) / 100;
    group.byType.discountCode = Math.round(group.byType.discountCode * 100) / 100;
    group.byType.points = Math.round(group.byType.points * 100) / 100;
    group.totalRecorded = Math.round(group.totalRecorded * 100) / 100;
  }

  return {
    groups: [...groups.values()],
    complete: unrecordedBookingCount === 0 && excludedUncertainCount === 0,
    settledBookingCount,
    unrecordedBookingCount,
    excludedUncertainCount,
  };
}
