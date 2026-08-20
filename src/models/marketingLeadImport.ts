import mongoose, { Document, Schema } from 'mongoose';

export const MARKETING_LEAD_IMPORT_STATUSES = ['validated', 'committed', 'failed'] as const;
export type MarketingLeadImportStatus = (typeof MARKETING_LEAD_IMPORT_STATUSES)[number];

export interface IMarketingLeadImportError {
  row: number;
  field?: string;
  message: string;
}

export interface IMarketingLeadImportRow {
  rowNumber: number;
  email: string;
  emailNormalized: string;
  firstName?: string;
  lastName?: string;
  country: string;
  locale: string;
  serviceValues: string[];
  serviceKeys: string[];
}

// Mongoose's Document already exposes an internal `errors` validation map;
// omit that member so the persisted row-error list can keep the API contract.
export interface IMarketingLeadImport extends Omit<Document, 'errors'> {
  filename: string;
  uploadedBy: mongoose.Types.ObjectId;
  uploadedAt: Date;
  status: MarketingLeadImportStatus;
  totalRows: number;
  validRows: number;
  insertedRows: number;
  updatedRows: number;
  duplicateRows: number;
  rejectedRows: number;
  plannedInsertedRows: number;
  plannedUpdatedRows: number;
  plannedDuplicateRows: number;
  errors: IMarketingLeadImportError[];
  /** Normalized rows waiting for an explicit commit; cleared after commit. */
  validatedRows: IMarketingLeadImportRow[];
  committedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const errorSchema = new Schema<IMarketingLeadImportError>(
  {
    row: { type: Number, required: true, min: 1 },
    field: { type: String, trim: true },
    message: { type: String, required: true, trim: true },
  },
  { _id: false },
);

const rowSchema = new Schema<IMarketingLeadImportRow>(
  {
    rowNumber: { type: Number, required: true, min: 1 },
    email: { type: String, required: true, trim: true },
    emailNormalized: { type: String, required: true, trim: true, lowercase: true },
    firstName: { type: String, trim: true },
    lastName: { type: String, trim: true },
    country: { type: String, required: true, trim: true, uppercase: true },
    locale: { type: String, required: true, trim: true },
    serviceValues: { type: [String], default: [] },
    serviceKeys: { type: [String], default: [] },
  },
  { _id: false },
);

const marketingLeadImportSchema = new Schema<IMarketingLeadImport>(
  {
    filename: { type: String, required: true, trim: true },
    uploadedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    uploadedAt: { type: Date, default: Date.now, index: true },
    status: { type: String, enum: MARKETING_LEAD_IMPORT_STATUSES, required: true, index: true },
    totalRows: { type: Number, default: 0, min: 0 },
    validRows: { type: Number, default: 0, min: 0 },
    insertedRows: { type: Number, default: 0, min: 0 },
    updatedRows: { type: Number, default: 0, min: 0 },
    duplicateRows: { type: Number, default: 0, min: 0 },
    rejectedRows: { type: Number, default: 0, min: 0 },
    plannedInsertedRows: { type: Number, default: 0, min: 0 },
    plannedUpdatedRows: { type: Number, default: 0, min: 0 },
    plannedDuplicateRows: { type: Number, default: 0, min: 0 },
    errors: { type: [errorSchema], default: [] },
    validatedRows: { type: [rowSchema], default: [], select: false },
    committedAt: { type: Date },
  },
  { timestamps: true },
);

marketingLeadImportSchema.index({ uploadedAt: -1 });

const MarketingLeadImport = mongoose.model<IMarketingLeadImport>(
  'MarketingLeadImport',
  marketingLeadImportSchema,
);

export default MarketingLeadImport;
