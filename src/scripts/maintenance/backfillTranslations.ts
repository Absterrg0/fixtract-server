/**
 * Machine-translates existing content that was created before auto-translation
 * was enabled (or while AZURE_TRANSLATOR_KEY was not set):
 *
 * - CMS originals (blogs, news, FAQ, ...) with a missing or stale nl/fr/en
 *   version — same rules as a save (manual translations are never touched);
 * - the service catalogue and every visible project's customer-facing text
 *   (translation memory, see src/utils/contentTranslation).
 *
 * Idempotent: up-to-date CMS translations and known strings are skipped, so it
 * can be re-run until it reports nothing left.
 *
 *   npm run maintenance:backfill-translations              # queue + translate
 *   DRY_RUN=1 npm run maintenance:backfill-translations    # counts only
 *   SCOPE=cms|content npm run maintenance:backfill-translations
 *
 * Env: MONGODB_URI (or MONGO_URI), AZURE_TRANSLATOR_KEY, optional
 * AZURE_TRANSLATOR_REGION / AZURE_TRANSLATOR_ENDPOINT.
 */
import dotenv from "dotenv";
import mongoose from "mongoose";

import ContentTranslation from "../../models/contentTranslation";
import { isTranslatorConfigured } from "../../utils/cms/azureTranslator";
import {
  loadCmsTranslationOverview,
  processQueuedCmsTranslations,
  queueCmsTranslationBackfill,
} from "../../utils/cms/translationBackfill";
import { drainContentTranslationQueue } from "../../utils/contentTranslation/queue";
import { backfillContentTranslations } from "../../utils/contentTranslation/sources";

dotenv.config();

/** Time per drain round; rounds repeat until nothing is left (or no progress). */
const ROUND_BUDGET_MS = 240_000;

async function contentCounts() {
  const rows = (await ContentTranslation.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }])) as Array<{
    _id: string;
    count: number;
  }>;
  return Object.fromEntries(rows.map((row) => [row._id, row.count]));
}

async function main() {
  const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!mongoUri) throw new Error("MONGODB_URI or MONGO_URI not found in environment variables");
  const dryRun = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";
  const scope = (process.env.SCOPE || "all").toLowerCase();
  if (!["all", "cms", "content"].includes(scope)) throw new Error("SCOPE must be all, cms or content");
  if (!dryRun && !isTranslatorConfigured()) {
    throw new Error("AZURE_TRANSLATOR_KEY is not set: nothing can be translated (use DRY_RUN=1 for counts)");
  }

  await mongoose.connect(mongoUri);
  try {
    if (scope !== "content") {
      console.log("[cms] before:", await loadCmsTranslationOverview());
      if (!dryRun) {
        console.log("[cms] queued:", await queueCmsTranslationBackfill());
        for (;;) {
          const round = await processQueuedCmsTranslations({ budgetMs: ROUND_BUDGET_MS });
          console.log("[cms] round:", round);
          if (round.remaining === 0 || round.processed === 0) break;
        }
        console.log("[cms] after:", await loadCmsTranslationOverview());
      }
    }

    if (scope !== "cms") {
      console.log("[content] before:", await contentCounts());
      if (!dryRun) {
        console.log("[content] queued:", await backfillContentTranslations());
        for (;;) {
          const round = await drainContentTranslationQueue({ budgetMs: ROUND_BUDGET_MS });
          console.log("[content] round:", round);
          // An exhausted round budget is a normal end; only provider refusals stop.
          if (round.claimed === 0 || (round.stoppedBy && round.stoppedBy !== "budget_exceeded")) break;
        }
        console.log("[content] after:", await contentCounts());
      }
    }
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error("Translation backfill failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
