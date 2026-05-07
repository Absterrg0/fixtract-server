import { Schema, model, Document, Types } from "mongoose";

export type CancellationRequestStatus = "pending" | "processing" | "approved" | "denied";

export interface ICancellationRequest extends Document {
  _id: Types.ObjectId;
  booking: Types.ObjectId;
  requestedBy: Types.ObjectId;
  requestedRole: "customer" | "professional";
  reason: string;
  status: CancellationRequestStatus;
  resolvedAt?: Date;
  resolvedBy?: Types.ObjectId;
  denyReason?: string;
  refundAmount?: number;
  refundedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const CancellationRequestSchema = new Schema<ICancellationRequest>(
  {
    booking: {
      type: Schema.Types.ObjectId,
      ref: "Booking",
      required: true,
    },
    requestedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    requestedRole: {
      type: String,
      enum: ["customer", "professional"],
      required: true,
    },
    reason: {
      type: String,
      required: true,
      trim: true,
      maxlength: 1000,
    },
    status: {
      type: String,
      enum: ["pending", "processing", "approved", "denied"],
      default: "pending",
      required: true,
      index: true,
    },
    resolvedAt: { type: Date },
    resolvedBy: { type: Schema.Types.ObjectId, ref: "User" },
    denyReason: { type: String, trim: true, maxlength: 500 },
    refundAmount: { type: Number, min: 0 },
    refundedAt: { type: Date },
  },
  { timestamps: true }
);

CancellationRequestSchema.index({ booking: 1, status: 1 });
CancellationRequestSchema.index(
  { booking: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ["pending", "processing"] } } }
);

const CancellationRequest = model<ICancellationRequest>(
  "CancellationRequest",
  CancellationRequestSchema
);

export default CancellationRequest;
