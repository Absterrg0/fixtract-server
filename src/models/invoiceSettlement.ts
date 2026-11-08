import { Schema } from 'mongoose';
import { PEPPOL_DISPATCH_STATUSES, type PeppolDispatchStatus } from '../constants/peppol';

export type InvoiceSideSettlement = {
  netAmount: number;
  vatAmount: number;
  totalWithVat: number;
  /** Cumulative customer refund already represented by the issued invoice. */
  refundAmount: number;
};
export type InvoiceSettlementBasis = { customer?: InvoiceSideSettlement; supplier?: InvoiceSideSettlement };
export type RefundCreditDispatch = {
  status: PeppolDispatchStatus;
  reason?: string;
  reference?: string;
  provider?: string;
  attempts?: number;
  dispatchedAt?: Date;
  lastAttemptAt?: Date;
};
export type RefundCreditFact = {
  key: string;
  side: 'customer' | 'supplier';
  refundAmount: number;
  netAmount: number;
  vatAmount: number;
  invoiceNumber: string;
  invoiceUrl?: string;
  invoiceUblUrl?: string;
  generatedAt: Date;
  dispatch?: RefundCreditDispatch;
};
const side = new Schema<InvoiceSideSettlement>({
  netAmount: Number, vatAmount: Number, totalWithVat: Number, refundAmount: Number,
}, { _id: false });
export const InvoiceSettlementBasisSchema = new Schema<InvoiceSettlementBasis>({ customer: side, supplier: side }, { _id: false });
const dispatch = new Schema<RefundCreditDispatch>({
  status: { type: String, enum: PEPPOL_DISPATCH_STATUSES, required: true },
  reason: String, reference: String, provider: String, attempts: Number,
  dispatchedAt: Date, lastAttemptAt: Date,
}, { _id: false });
export const RefundCreditFactSchema = new Schema<RefundCreditFact>({
  key: { type: String, required: true }, side: { type: String, enum: ['customer', 'supplier'], required: true },
  refundAmount: Number, netAmount: Number, vatAmount: Number, invoiceNumber: String,
  invoiceUrl: String, invoiceUblUrl: String, generatedAt: Date, dispatch,
}, { _id: false });
