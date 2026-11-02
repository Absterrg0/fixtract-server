/**
 * Recorded vs phantom booking activity.
 *
 * Until this change the Booking schema defaulted `customerReview.reviewedAt`,
 * `professionalReview.reviewedAt`, `cancellation.cancelledAt`,
 * `dispute.raisedAt` (and `dispute.type`) to "now". Every booking built by
 * `new Booking()` or hydrated from a sparse record therefore looked
 * reviewed, cancelled and disputed at its creation time, and `save()`
 * persisted those values.
 *
 * The defaults are gone, but stored bookings still carry them. Every writer
 * of a real dispute/cancellation/review records an actor or content, so the
 * predicates below decide by that evidence instead of by the timestamp.
 */

type AnyRecord = Record<string, any>;

const asRecord = (value: unknown): AnyRecord | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as AnyRecord) : null;

const present = (value: unknown): boolean => {
  if (value == null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
};

const finiteNumber = (value: unknown): boolean => typeof value === "number" && Number.isFinite(value);

export const hasRecordedDispute = (booking: unknown): boolean => {
  const dispute = asRecord(asRecord(booking)?.dispute);
  if (!dispute) return false;
  return present(dispute.raisedBy) || present(dispute.reason) || present(dispute.description)
    || present(dispute.resolvedAt) || present(dispute.slaDeadline);
};

export const hasRecordedCancellation = (booking: unknown): boolean => {
  const cancellation = asRecord(asRecord(booking)?.cancellation);
  if (!cancellation) return false;
  return present(cancellation.cancelledBy) || present(cancellation.reason)
    || present(cancellation.adminResolutionNote) || finiteNumber(cancellation.refundAmount);
};

export const hasRecordedCustomerReview = (booking: unknown): boolean => {
  const review = asRecord(asRecord(booking)?.customerReview);
  if (!review) return false;
  return finiteNumber(review.communicationLevel) || finiteNumber(review.valueOfDelivery)
    || finiteNumber(review.qualityOfService) || present(review.comment)
    || present(review.images) || present(review.reply?.comment);
};

export const hasRecordedProfessionalReview = (booking: unknown): boolean => {
  const review = asRecord(asRecord(booking)?.professionalReview);
  if (!review) return false;
  return finiteNumber(review.rating) || present(review.comment);
};

/**
 * Plain copy of `booking` without phantom review/cancellation/dispute
 * sub-objects. Recorded activity is returned untouched.
 */
export const withoutPhantomBookingActivity = <T>(booking: T): T => {
  const source = booking && typeof (booking as any).toObject === "function"
    ? (booking as any).toObject()
    : booking;
  const record = asRecord(source);
  if (!record) return booking;
  const next: AnyRecord = { ...record };
  if ("dispute" in next && !hasRecordedDispute(next)) delete next.dispute;
  if ("cancellation" in next && !hasRecordedCancellation(next)) delete next.cancellation;
  if ("customerReview" in next && !hasRecordedCustomerReview(next)) delete next.customerReview;
  if ("professionalReview" in next && !hasRecordedProfessionalReview(next)) delete next.professionalReview;
  return next as T;
};

/** Mongo filters that only match recorded activity (legacy phantom values excluded). */
export const RECORDED_DISPUTE_FILTER = Object.freeze({
  "dispute.raisedAt": { $exists: true },
  "dispute.raisedBy": { $exists: true, $ne: null },
});

export const RECORDED_CUSTOMER_REVIEW_FILTER = Object.freeze({
  "customerReview.reviewedAt": { $exists: true },
  "customerReview.communicationLevel": { $exists: true, $ne: null },
});

/** Aggregation expression: true when the row carries a recorded dispute. */
export const RECORDED_DISPUTE_EXPR = {
  $and: [
    { $ne: [{ $ifNull: ["$dispute.raisedAt", null] }, null] },
    { $ne: [{ $ifNull: ["$dispute.raisedBy", null] }, null] },
  ],
};

/** Aggregation expression: true when the row carries a recorded customer review. */
export const RECORDED_CUSTOMER_REVIEW_EXPR = {
  $and: [
    { $ne: [{ $ifNull: ["$customerReview.reviewedAt", null] }, null] },
    { $ne: [{ $ifNull: ["$customerReview.communicationLevel", null] }, null] },
  ],
};

/**
 * Mongo update clearing the legacy phantom values for one booking, or null
 * when nothing is phantom. Used by the cleanup migration.
 */
export const phantomBookingActivityUnset = (booking: unknown): Record<string, ""> | null => {
  const record = asRecord(booking);
  if (!record) return null;
  const unset: Record<string, ""> = {};
  if (record.dispute != null && !hasRecordedDispute(record)) unset.dispute = "";
  if (record.cancellation != null && !hasRecordedCancellation(record)) unset.cancellation = "";
  if (record.customerReview != null && !hasRecordedCustomerReview(record)) unset.customerReview = "";
  if (record.professionalReview != null && !hasRecordedProfessionalReview(record)) unset.professionalReview = "";
  return Object.keys(unset).length > 0 ? unset : null;
};
