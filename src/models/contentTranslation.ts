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
 *
 * The identity is the text alone, not (text, source language): a professional
 * string's language is only known after the background detection, and the
 * read paths (search cards of many projects at once) look strings up without
 * knowing each project's language. Identical text written in two of en/nl/fr
 * with different meanings therefore shares the first detected source
 * language; an admin can correct such a row with a manual override.
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

/**
 * The language detected for one `detectGroup` (project). Written once with an
 * atomic upsert, so concurrent drains that claimed different rows of the same
 * project all use the first decision instead of their own detection result.
 * Short-lived: a later edit of the project is detected afresh.
 */
export interface IContentLanguageDecision extends Document {
  group: string;
  language: string;
  createdAt: Date;
}

/** How long a group's detected language is reused (seconds). */
export const CONTENT_LANGUAGE_DECISION_TTL_S = 3_600;

const ContentLanguageDecisionSchema = new Schema<IContentLanguageDecision>({
  group: { type: String, required: true, unique: true },
  language: { type: String, required: true },
  createdAt: { type: Date, default: Date.now, expires: CONTENT_LANGUAGE_DECISION_TTL_S },
});

export const ContentLanguageDecision = model<IContentLanguageDecision>(
  "ContentLanguageDecision",
  ContentLanguageDecisionSchema
);
