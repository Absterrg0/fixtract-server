import { Schema, model, Document } from "mongoose";

/**
 * Translation memory for customer-facing catalogue and project text
 * (service configuration items, project/subproject titles, descriptions,
 * included items, RFQ questions, ...).
 *
 * One row per distinct source string (keyed by `hash`), shared by every
 * project and catalogue entry that shows that exact text, so a catalogue item
 * copied into hundreds of projects is translated once. Rows are filled in the
 * background (utils/contentTranslation/queue.ts); read paths only look rows up
 * and never call the provider.
 */
export const CONTENT_TRANSLATION_STATUSES = ["pending", "done", "failed"] as const;
export type ContentTranslationStatus = (typeof CONTENT_TRANSLATION_STATUSES)[number];

/** Where the text was seen first; informational (admin counts). */
export const CONTENT_TRANSLATION_ORIGINS = ["catalogue", "project"] as const;
export type ContentTranslationOrigin = (typeof CONTENT_TRANSLATION_ORIGINS)[number];

export interface IContentTranslation extends Document {
  hash: string;
  text: string;
  /**
   * Source language (en / nl / fr), or "auto" until the background run has
   * detected it. A row whose detected language is not one of ours stays
   * "auto"-free with that code and is marked failed (`unsupported_language`).
   */
  from: string;
  /** Project the text was first queued for; groups "auto" rows for one detection call. */
  detectGroup?: string;
  translations: { en?: string; nl?: string; fr?: string };
  /** `manual` rows were set by an admin and are never overwritten by the machine. */
  mode: "machine" | "manual";
  status: ContentTranslationStatus;
  origin: ContentTranslationOrigin;
  errorCode?: string;
  attempts: number;
  claimId?: string;
  leaseUntil?: Date;
  translatedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const ContentTranslationSchema = new Schema<IContentTranslation>(
  {
    hash: { type: String, required: true, unique: true },
    text: { type: String, required: true },
    from: { type: String, required: true, default: "auto" },
    detectGroup: { type: String },
    translations: {
      en: { type: String },
      nl: { type: String },
      fr: { type: String },
    },
    mode: { type: String, enum: ["machine", "manual"], default: "machine" },
    status: { type: String, enum: CONTENT_TRANSLATION_STATUSES, default: "pending" },
    origin: { type: String, enum: CONTENT_TRANSLATION_ORIGINS, default: "project" },
    errorCode: { type: String },
    attempts: { type: Number, default: 0 },
    claimId: { type: String },
    leaseUntil: { type: Date },
    translatedAt: { type: Date },
  },
  { timestamps: true }
);

ContentTranslationSchema.index({ status: 1, leaseUntil: 1 });

const ContentTranslation = model<IContentTranslation>("ContentTranslation", ContentTranslationSchema);

export default ContentTranslation;
