/**
 * "Translate all existing content" for the CMS.
 *
 * CMS auto-translation runs when an original is created or saved. Content
 * written before the feature was deployed (or while AZURE_TRANSLATOR_KEY was
 * not set) therefore has no nl/fr version until someone re-saves it. The
 * backfill queues every original that still needs a translation, using the
 * same machinery as a save:
 *
 * 1. `syncCmsTranslations(..., { translate: false })` per original (no
 *    provider call) decides which locales are missing or stale;
 * 2. originals with pending locales get `translationRun.requested`;
 * 3. one background drain processes the requested originals one by one with
 *    the regular lease ({@link processCmsTranslationQueue}). Whatever is left
 *    when the time budget runs out is picked up by the next drain (the admin
 *    overview read schedules one) or by the maintenance script.
 *
 * Idempotent: originals whose translations are up to date are not queued, and
 * manual translations are never overwritten (no force).
 */
import CmsContent from "../../models/cmsContent";
import { isTranslatorConfigured } from "./azureTranslator";
import { syncCmsTranslations, targetLocalesFor } from "./syncTranslations";
import { processCmsTranslationQueue, TRANSLATION_INVOCATION_BUDGET_MS } from "./translationQueue";

const NO_TIMESTAMPS = { timestamps: false } as const;

/** Originals: neither a machine translation nor a translation of another doc. */
export const CMS_ORIGINAL_FILTER = { autoTranslated: { $ne: true }, translatedFrom: null } as const;

export interface CmsBackfillQueueSummary {
  sources: number;
  queued: number;
}

/** Marks every original with a missing/stale translation as wanting a run. */
export async function queueCmsTranslationBackfill(): Promise<CmsBackfillQueueSummary> {
  const summary: CmsBackfillQueueSummary = { sources: 0, queued: 0 };
  for await (const doc of CmsContent.find(CMS_ORIGINAL_FILTER).cursor()) {
    summary.sources += 1;
    let results;
    try {
      results = await syncCmsTranslations(doc, { translate: false });
    } catch (err) {
      console.error(`[cmsBackfill] sync failed for ${String(doc._id)}:`, err);
      continue;
    }
    if (!results.some((result) => result.status === "pending")) continue;
    await CmsContent.updateOne(
      { _id: doc._id },
      { $set: { "translationRun.requested": true, "translationRun.requestedAt": new Date() } },
      NO_TIMESTAMPS
    );
    summary.queued += 1;
  }
  return summary;
}

export interface CmsBackfillDrainSummary {
  processed: number;
  remaining: number;
}

/**
 * Processes requested originals one at a time until none is left or the
 * budget is spent. Originals another worker holds are skipped (that worker
 * re-checks the request when it finishes).
 */
export async function processQueuedCmsTranslations(
  options: { budgetMs?: number } = {}
): Promise<CmsBackfillDrainSummary> {
  const deadline = Date.now() + (options.budgetMs ?? TRANSLATION_INVOCATION_BUDGET_MS);
  const attempted = new Set<string>();
  let processed = 0;
  while (isTranslatorConfigured() && Date.now() < deadline) {
    const now = new Date();
    const next = (await CmsContent.findOne({
      "translationRun.requested": true,
      _id: { $nin: Array.from(attempted) },
      $or: [{ "translationRun.leaseUntil": null }, { "translationRun.leaseUntil": { $lte: now } }],
    })
      .sort({ "translationRun.requestedAt": 1 })
      .select("_id")
      .lean()) as { _id: unknown } | null;
    if (!next) break;
    attempted.add(String(next._id));
    await processCmsTranslationQueue(String(next._id), {
      budgetMs: Math.max(0, deadline - Date.now()),
      maxRuns: 1,
    });
    processed += 1;
  }
  const remaining = await CmsContent.countDocuments({ "translationRun.requested": true });
  return { processed, remaining };
}

export interface CmsTranslationOverview {
  /** False when AZURE_TRANSLATOR_KEY is not set on the API: nothing is translated. */
  enabled: boolean;
  sources: number;
  /** Originals that lack a linked translation in at least one other locale. */
  missing: number;
  queued: number;
  running: number;
}

/** Site-wide translation coverage of the CMS, for the admin overview card. */
export async function loadCmsTranslationOverview(): Promise<CmsTranslationOverview> {
  const now = new Date();
  const sources = (await CmsContent.find(CMS_ORIGINAL_FILTER).select("_id locale").lean()) as Array<{
    _id: unknown;
    locale: string;
  }>;
  const linked = (await CmsContent.aggregate([
    { $match: { translatedFrom: { $in: sources.map((doc) => doc._id) } } },
    { $group: { _id: "$translatedFrom", locales: { $addToSet: "$locale" } } },
  ])) as Array<{ _id: unknown; locales: string[] }>;
  const localesBySource = new Map(linked.map((row) => [String(row._id), new Set(row.locales)]));
  const missing = sources.filter((doc) => {
    const have = localesBySource.get(String(doc._id)) ?? new Set<string>();
    return targetLocalesFor(doc.locale).some((locale) => !have.has(locale));
  }).length;
  const [queued, running] = await Promise.all([
    CmsContent.countDocuments({ "translationRun.requested": true }),
    CmsContent.countDocuments({ "translationRun.leaseUntil": { $gt: now } }),
  ]);
  return { enabled: isTranslatorConfigured(), sources: sources.length, missing, queued, running };
}
