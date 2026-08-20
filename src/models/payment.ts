import { Schema, model, Document, Types } from "mongoose";
import { STRIPE_CONFIG } from "../services/stripe";
import { VatBreakdownLine } from "../Types/stripe";
import { PeppolDispatchStatus } from "../services/peppolDispatch";

const PEPPOL_DISPATCH_STATUSES: PeppolDispatchStatus[] = ["skipped", "queued", "sent", "failed"];

export type PaymentStatus =
  | "pending"
  | "authorized"
  | "completed"
  | "failed"
  | "refunded"
  | "partially_refunded"
  | "disputed";

export interface IPaymentRefund {
  amount: number;
  reason?: string;
  refundId?: string;
  refundedAt: Date;
  source: "professional" | "platform" | "mixed";
  notes?: string;
}

export interface IPayment extends Document {
  booking: Types.ObjectId;
  bookingNumber?: string;
  milestoneIndex?: number;
  milestoneTitle?: string;
  customer: Types.ObjectId;
  professional?: Types.ObjectId;
  status: PaymentStatus;
  method?: "card" | "bank_transfer" | "cash";

  currency: string;
  amount: number;
  netAmount?: number;
  vatAmount?: number;
  vatRate?: number;
  totalWithVat?: number;
  reverseCharge?: boolean;
  vatBreakdown?: VatBreakdownLine[];
  platformCommission?: number;
  professionalPayout?: number;
  extraCostAmount?: number;
  extraCostCustomerNetAmount?: number;
  extraCostVatAmount?: number;
  extraCostPlatformFee?: number;
  extraCostNetAmount?: number;
  extraCostCustomerDiscount?: number;
  extraCostPlatformCommission?: number;
  extraCostProfessionalPayout?: number;
  extraCostStatus?: "pending" | "succeeded" | "failed" | "refunded";
  extraCostPaymentSucceeded?: boolean;
  extraCostPaidAt?: Date;
  extraCostStripePaymentIntentId?: string;
  extraCostTransferId?: string;

  stripePaymentIntentId?: string;
  stripeChargeId?: string;
  stripeTransferId?: string;
  stripeDestinationPayment?: string;

  refunds: IPaymentRefund[];

  authorizedAt?: Date;
  capturedAt?: Date;
  transferredAt?: Date;
  refundedAt?: Date;
  canceledAt?: Date;

  invoiceNumber?: string;
  invoiceUrl?: string;
  invoiceUblUrl?: string;
  invoiceGeneratedAt?: Date;
  peppolDispatchStatus?: string;
  peppolDispatchReason?: string;
  peppolDispatchReference?: string;
  peppolDispatchedAt?: Date;
  supplierPeppolDispatchStatus?: string;
  supplierPeppolDispatchReason?: string;
  supplierPeppolDispatchReference?: string;
  supplierPeppolDispatchedAt?: Date;
  supplierInvoiceNumber?: string;
  supplierInvoiceUrl?: string;
  supplierInvoiceUblUrl?: string;
  supplierInvoiceGeneratedAt?: Date;
  creditNoteNumber?: string;
  creditNoteUrl?: string;
  creditNoteUblUrl?: string;
  creditNoteGeneratedAt?: Date;
  creditNoteRelatedInvoiceNumber?: string;
  creditNotePeppolDispatchStatus?: string;
  creditNotePeppolDispatchReference?: string;

  metadata?: Record<string, any>;

  createdAt: Date;
  updatedAt: Date;
}

const PaymentRefundSchema = new Schema<IPaymentRefund>(
  {
    amount: { type: Number, required: true },
    reason: { type: String, maxlength: 500 },
    refundId: { type: String },
    refundedAt: { type: Date, default: Date.now },
    source: {
      type: String,
      enum: ["professional", "platform", "mixed"],
      default: "platform",
      required: true,
    },
    notes: { type: String, maxlength: 1000 },
  },
  { _id: false }
);

const SUPPORTED_CURRENCIES = STRIPE_CONFIG.supportedCurrencies.length
  ? STRIPE_CONFIG.supportedCurrencies
  : [STRIPE_CONFIG.defaultCurrency || "EUR"];
const DEFAULT_CURRENCY = SUPPORTED_CURRENCIES.includes(STRIPE_CONFIG.defaultCurrency)
  ? STRIPE_CONFIG.defaultCurrency
  : SUPPORTED_CURRENCIES[0];

const PaymentSchema = new Schema<IPayment>(
  {
    booking: { type: Schema.Types.ObjectId, ref: "Booking", required: true },
    bookingNumber: { type: String },
    milestoneIndex: { type: Number },
    milestoneTitle: { type: String, maxlength: 200 },
    customer: { type: Schema.Types.ObjectId, ref: "User", required: true },
    professional: { type: Schema.Types.ObjectId, ref: "User" },
    status: {
      type: String,
      enum: ["pending", "authorized", "completed", "failed", "refunded", "partially_refunded", "disputed"],
      default: "pending",
      required: true,
    },
    method: {
      type: String,
      enum: ["card", "bank_transfer", "cash"],
    },

    currency: { type: String, enum: SUPPORTED_CURRENCIES, default: DEFAULT_CURRENCY },
    amount: { type: Number, required: true },
    netAmount: { type: Number },
    vatAmount: { type: Number },
    vatRate: { type: Number },
    totalWithVat: { type: Number },
    reverseCharge: { type: Boolean },
    vatBreakdown: [{
      description: { type: String, required: true },
      netAmount: { type: Number, required: true },
      vatRate: { type: Number, required: true },
      vatAmount: { type: Number, required: true },
      totalAmount: { type: Number, required: true },
      vatCountry: { type: String },
      vatLabel: { type: String },
    }],
    platformCommission: { type: Number },
    professionalPayout: { type: Number },
    extraCostAmount: { type: Number },
    extraCostCustomerNetAmount: { type: Number },
    extraCostVatAmount: { type: Number },
    extraCostPlatformFee: { type: Number },
    extraCostNetAmount: { type: Number },
    extraCostCustomerDiscount: { type: Number },
    extraCostPlatformCommission: { type: Number },
    extraCostProfessionalPayout: { type: Number },
    extraCostStatus: { type: String, enum: ["pending", "succeeded", "failed", "refunded"] },
    extraCostPaymentSucceeded: { type: Boolean },
    extraCostPaidAt: { type: Date },
    extraCostStripePaymentIntentId: { type: String },
    extraCostTransferId: { type: String },

    stripePaymentIntentId: { type: String },
    stripeChargeId: { type: String },
    stripeTransferId: { type: String },
    stripeDestinationPayment: { type: String },

    refunds: { type: [PaymentRefundSchema], default: [] },

    authorizedAt: { type: Date },
    capturedAt: { type: Date },
    transferredAt: { type: Date },
    refundedAt: { type: Date },
    canceledAt: { type: Date },

    invoiceNumber: { type: String },
    invoiceUrl: { type: String },
    invoiceUblUrl: { type: String },
    invoiceGeneratedAt: { type: Date },
    peppolDispatchStatus: { type: String, enum: PEPPOL_DISPATCH_STATUSES },
    peppolDispatchReason: { type: String },
    peppolDispatchReference: { type: String },
    peppolDispatchedAt: { type: Date },
    supplierPeppolDispatchStatus: { type: String, enum: PEPPOL_DISPATCH_STATUSES },
    supplierPeppolDispatchReason: { type: String },
    supplierPeppolDispatchReference: { type: String },
    supplierPeppolDispatchedAt: { type: Date },
    supplierInvoiceNumber: { type: String },
    supplierInvoiceUrl: { type: String },
    supplierInvoiceUblUrl: { type: String },
    supplierInvoiceGeneratedAt: { type: Date },
    creditNoteNumber: { type: String },
    creditNoteUrl: { type: String },
    creditNoteUblUrl: { type: String },
    creditNoteGeneratedAt: { type: Date },
    creditNoteRelatedInvoiceNumber: { type: String },
    creditNotePeppolDispatchStatus: { type: String, enum: PEPPOL_DISPATCH_STATUSES },
    creditNotePeppolDispatchReference: { type: String },

    metadata: { type: Schema.Types.Mixed },
  },
  {
    timestamps: true,
  }
);

PaymentSchema.index({ booking: 1, milestoneIndex: 1 }, { unique: true, sparse: true });
// Ensure only one non-milestone payment per booking
PaymentSchema.index(
  { booking: 1 },
  { unique: true, partialFilterExpression: { milestoneIndex: null } }
);
PaymentSchema.index({ status: 1 });
PaymentSchema.index({ customer: 1, status: 1 });
PaymentSchema.index({ professional: 1, status: 1 });
PaymentSchema.index({ bookingNumber: 1 });

const Payment = model<IPayment>("Payment", PaymentSchema);

export default Payment;
