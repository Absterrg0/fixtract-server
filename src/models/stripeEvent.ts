import { Schema, model, Document, Types } from "mongoose";

type StripeEventProcessingStatus = "processing" | "processed" | "failed";

export interface IStripeEvent extends Document {
  eventId: string;
  eventType: string;
  status: StripeEventProcessingStatus;
  attempts: number;
  stripeCreatedAt?: Date;
  firstSeenAt: Date;
  lastAttemptAt: Date;
  processedAt?: Date;
  lastError?: string;
  /**
   * Durable manual-reconciliation item. Set when a handled event was
   * deliberately not applied but may represent money that needs an operator
   * (for example a superseded PaymentIntent that still succeeded). Records
   * carrying it have no `expiresAt`, so the 90-day TTL never removes them.
   * Operators query open items with
   * `{ "reconciliation.required": true, "reconciliation.resolvedAt": null }`
   * and close one by setting `resolvedAt` (and optionally `resolvedBy`/`note`).
   *
   * Current items are their own record, one per PaymentIntent, with
   * `eventId = "reconciliation:<reason>:<paymentIntentId>"`; the unique
   * `eventId` index makes the item idempotent across concurrent deliveries.
   * `sourceEventId` names the Stripe event that raised it. Items written by
   * the earlier per-event version sit on the delivered event's own record
   * (no `sourceEventId`) and are kept as they are; see
   * `npm run check:stripe-reconciliation` (read-only).
   */
  reconciliation?: IStripeEventReconciliation;
  expiresAt?: Date;
}

export interface IStripeEventReconciliation {
  required: boolean;
  reason: "superseded_payment_intent_succeeded";
  bookingId: Types.ObjectId;
  paymentIntentId: string;
  currentPaymentIntentId?: string;
  chargeId?: string;
  /** Major currency units, as charged by the provider. */
  amount?: number;
  currency?: string;
  /** Stripe event that raised the item (absent on legacy per-event items). */
  sourceEventId?: string;
  detectedAt: Date;
  resolvedAt?: Date | null;
  resolvedBy?: Types.ObjectId;
  note?: string;
}

const StripeEventSchema = new Schema<IStripeEvent>(
  {
    eventId: { type: String, required: true, unique: true, index: true },
    eventType: { type: String, required: true },
    status: {
      type: String,
      enum: ["processing", "processed", "failed"],
      default: "processing",
      required: true,
    },
    attempts: { type: Number, default: 1, min: 1 },
    stripeCreatedAt: { type: Date },
    firstSeenAt: { type: Date, default: Date.now },
    lastAttemptAt: { type: Date, default: Date.now },
    processedAt: { type: Date },
    lastError: { type: String, maxlength: 2000 },
    reconciliation: {
      type: new Schema<IStripeEventReconciliation>(
        {
          required: { type: Boolean, required: true },
          reason: { type: String, enum: ["superseded_payment_intent_succeeded"], required: true },
          bookingId: { type: Schema.Types.ObjectId, ref: "Booking", required: true },
          paymentIntentId: { type: String, required: true },
          currentPaymentIntentId: { type: String },
          chargeId: { type: String },
          amount: { type: Number },
          currency: { type: String },
          sourceEventId: { type: String },
          detectedAt: { type: Date, required: true },
          resolvedAt: { type: Date, default: null },
          resolvedBy: { type: Schema.Types.ObjectId, ref: "User" },
          note: { type: String, maxlength: 2000 },
        },
        { _id: false },
      ),
      default: undefined,
    },
    // Retain event records for 90 days to preserve durable dedup while limiting storage growth.
    expiresAt: {
      type: Date,
      default: () => new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
    },
  },
  { timestamps: true }
);

StripeEventSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
// Operator queue of open manual-reconciliation items (see `reconciliation`).
StripeEventSchema.index(
  { "reconciliation.required": 1, "reconciliation.resolvedAt": 1, "reconciliation.detectedAt": 1 },
  { partialFilterExpression: { "reconciliation.required": true } },
);
// Lookup by intent (legacy-item check, operator search). Deliberately not
// unique: legacy per-event items may already hold duplicates, and uniqueness
// per intent comes from the deterministic item `eventId` instead.
StripeEventSchema.index(
  { "reconciliation.paymentIntentId": 1 },
  { partialFilterExpression: { "reconciliation.required": true } },
);

const StripeEvent = model<IStripeEvent>("StripeEvent", StripeEventSchema);

export default StripeEvent;

