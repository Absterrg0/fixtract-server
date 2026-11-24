/**
 * Background machine translation of catalogue and project text.
 *
 * Saves never wait for Azure. A save (project submit/approval, catalogue
 * create/update, backfill) only upserts missing source strings into the
 * translation memory (`ContentTranslation`, status `pending`) — cheap DB work —
 * and schedules a drain after the response through Vercel `waitUntil` (the
 * same pattern as the CMS and announcement queues).
 *
 * Draining:
 * - Rows are claimed in batches with a per-row lease (`claimId/leaseUntil`),
 *   so concurrent drains never translate the same row twice, and a drain that
 *   dies leaves rows that the next drain (any later save, the admin status
 *   read, the backfill, or the maintenance script) picks up again.
 * - Professional text is queued with `from: "auto"`. Its language is detected
 *   once per project (`detectGroup`) from the longest texts — pros may write
 *   in Dutch or French — and a row is never translated into its own language.
 *   Catalogue text is English (the seeded catalogue).
 * - Writes are conditional on the claim and on `mode != "manual"`, so an admin
 *   override is never replaced.
 *
 * Read paths never call this module's provider code; they only look rows up
 * (see ./localize.ts).
 */
import { randomUUID } from "crypto";
import { waitUntil } from "@vercel/functions";

import ContentTranslation, { type ContentTranslationOrigin } from "../../models/contentTranslation";
import {
  detectLanguages,
  isTranslatorConfigured,
  translateTexts,
  TranslatorError,
} from "../cms/azureTranslator";
import { CONTENT_LOCALES, contentTextHash, isContentLocale, isTranslatableText } from "./texts";

export const CONTENT_TRANSLATION_LEASE_MS = 150_000;
/** Time one invocation may spend draining (function maxDuration is 300 s). */
export const CONTENT_TRANSLATION_BUDGET_MS = 200_000;
export const CONTENT_TRANSLATION_BATCH_SIZE = 200;
/** Attempts before a row is parked as `failed` (non-transient provider errors only). */
export const CONTENT_TRANSLATION_MAX_ATTEMPTS = 3;
/** How many characters of a project's text are sent to language detection. */
const DETECT_SAMPLE_CHARS = 1_000;

/** Provider failures that stop the whole drain: nothing else would succeed now. */
const STOP_CODES = new Set(["not_configured", "auth", "quota_exceeded", "rate_limited", "budget_exceeded", "timeout"]);
/** Failures that do not count as an attempt of the row (retried by a later drain). */
const TRANSIENT_CODES = new Set(["rate_limited", "budget_exceeded", "timeout", "not_configured"]);

export interface QueuedText {
  text: string;
  /** "en" / "nl" / "fr", or "auto" to detect. */
  from: string;
  detectGroup?: string;
}

/**
 * Upserts source strings that the translation memory does not know yet.
 * Existing rows (any status, manual or machine) are left untouched, so this is
 * idempotent and safe to call on every save. Returns how many rows were added.
 */
export async function enqueueContentTexts(
  items: QueuedText[],
  origin: ContentTranslationOrigin
): Promise<number> {
  const byHash = new Map<string, QueuedText>();
  for (const item of items) {
    if (!isTranslatableText(item.text)) continue;
    const hash = contentTextHash(item.text);
    if (!byHash.has(hash)) byHash.set(hash, { ...item, text: item.text.trim() });
  }
  if (byHash.size === 0) return 0;

  const existing = await ContentTranslation.find({ hash: { $in: Array.from(byHash.keys()) } })
    .select("hash")
    .lean();
  for (const row of existing) byHash.delete(String((row as any).hash));
  if (byHash.size === 0) return 0;

  const result = await ContentTranslation.bulkWrite(
    Array.from(byHash.entries()).map(([hash, item]) => ({
      updateOne: {
        filter: { hash },
        update: {
          $setOnInsert: {
            hash,
            text: item.text,
            from: isContentLocale(item.from) ? item.from : "auto",
            ...(item.detectGroup ? { detectGroup: item.detectGroup } : {}),
            translations: {},
            mode: "machine",
            status: "pending",
            origin,
            attempts: 0,
          },
        },
        upsert: true,
      },
    })),
    { ordered: false }
  );
  return result.upsertedCount ?? 0;
}

// ---------------------------------------------------------------- scheduling

const inFlight = new Set<Promise<void>>();

/** Resolves once every scheduled background drain has settled (tests). */
export async function waitForContentTranslationJobs(): Promise<void> {
  while (inFlight.size > 0) {
    await Promise.allSettled(Array.from(inFlight));
  }
}

/** Runs `work` after the response (Vercel waitUntil), then drains the queue. */
export function scheduleContentTranslationWork(work?: () => Promise<unknown>): Promise<void> {
  const job = (async () => {
    if (work) await work();
    if (isTranslatorConfigured()) await drainContentTranslationQueue();
  })().catch((err) => {
    console.error("[contentTranslations] background run crashed:", err);
  });
  inFlight.add(job);
  void job.finally(() => inFlight.delete(job));
  try {
    waitUntil(job);
  } catch (err) {
    console.warn("[contentTranslations] waitUntil unavailable; background run continues unmanaged:", err);
  }
  return job;
}

// ---------------------------------------------------------------- draining

export interface DrainSummary {
  claimed: number;
  translated: number;
  failed: number;
  stoppedBy?: string;
}

function errorCodeOf(err: unknown): string {
  return err instanceof TranslatorError ? err.code : "internal";
}

/** Longest texts first, joined up to the sample size: one detection call per project. */
function detectionSample(texts: string[]): string {
  let sample = "";
  for (const text of [...texts].sort((a, b) => b.length - a.length)) {
    if (sample.length >= DETECT_SAMPLE_CHARS) break;
    sample += (sample ? "\n" : "") + text;
  }
  return sample.slice(0, DETECT_SAMPLE_CHARS);
}

/**
 * Resolves `from: "auto"` rows of the claimed batch: one detection per
 * detectGroup (all queued rows of that group get the result), per-row
 * detection for rows without a group. Unsupported languages are parked as
 * failed. Mutates `rows` in place.
 */
async function resolveAutoLanguages(rows: Array<Record<string, any>>, claimId: string, deadline: number) {
  const auto = rows.filter((row) => row.from === "auto");
  if (auto.length === 0) return;

  const groups = new Map<string, Array<Record<string, any>>>();
  for (const row of auto) {
    const key = row.detectGroup ? `g:${row.detectGroup}` : `r:${String(row._id)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }
  const keys = Array.from(groups.keys());
  const samples = keys.map((key) => detectionSample(groups.get(key)!.map((row) => String(row.text))));
  const languages = await detectLanguages(samples, { deadline });

  for (let i = 0; i < keys.length; i += 1) {
    const language = languages[i];
    const group = groups.get(keys[i])!;
    if (isContentLocale(language)) {
      for (const row of group) row.from = language;
      const groupId = keys[i].startsWith("g:") ? keys[i].slice(2) : undefined;
      // Every not-yet-detected row of the same project shares the language.
      await ContentTranslation.updateMany(
        groupId
          ? { detectGroup: groupId, from: "auto" }
          : { _id: { $in: group.map((row) => row._id) }, from: "auto" },
        { $set: { from: language } }
      );
    } else {
      for (const row of group) row.from = null;
      await ContentTranslation.updateMany(
        { _id: { $in: group.map((row) => row._id) }, claimId },
        {
          $set: { status: "failed", errorCode: "unsupported_language", ...(language ? { from: language } : {}) },
          $unset: { claimId: 1, leaseUntil: 1 },
        }
      );
    }
  }
}

/** Claims up to `limit` pending rows whose lease is free. */
async function claimBatch(limit: number): Promise<{ claimId: string; rows: Array<Record<string, any>> }> {
  const now = new Date();
  const claimId = randomUUID();
  const free = { $or: [{ leaseUntil: null }, { leaseUntil: { $lte: now } }] };
  const candidates = await ContentTranslation.find({ status: "pending", ...free })
    .select("_id")
    .sort({ createdAt: 1 })
    .limit(limit)
    .lean();
  if (candidates.length === 0) return { claimId, rows: [] };
  await ContentTranslation.updateMany(
    { _id: { $in: candidates.map((row) => row._id) }, status: "pending", ...free },
    { $set: { claimId, leaseUntil: new Date(now.getTime() + CONTENT_TRANSLATION_LEASE_MS) } }
  );
  const rows = (await ContentTranslation.find({ claimId }).lean()) as Array<Record<string, any>>;
  return { claimId, rows };
}

async function releaseWithError(rows: Array<Record<string, any>>, claimId: string, code: string) {
  if (rows.length === 0) return;
  const countsAsAttempt = !TRANSIENT_CODES.has(code);
  await ContentTranslation.bulkWrite(
    rows.map((row) => {
      const attempts = Number(row.attempts || 0) + (countsAsAttempt ? 1 : 0);
      const failed = attempts >= CONTENT_TRANSLATION_MAX_ATTEMPTS;
      return {
        updateOne: {
          filter: { _id: row._id, claimId },
          update: {
            $set: { attempts, errorCode: code, status: failed ? "failed" : "pending" },
            $unset: { claimId: 1, leaseUntil: 1 },
          },
        },
      };
    }),
    { ordered: false }
  );
}

/**
 * Translates one claimed batch. Returns the stop code when the provider
 * refuses work that would fail for every later batch as well.
 */
async function translateBatch(
  rows: Array<Record<string, any>>,
  claimId: string,
  deadline: number
): Promise<{ translated: number; failed: number; stopCode?: string }> {
  try {
    await resolveAutoLanguages(rows, claimId, deadline);
  } catch (err) {
    const code = errorCodeOf(err);
    if (!(err instanceof TranslatorError)) console.error("[contentTranslations] detection crashed:", err);
    await releaseWithError(rows, claimId, code);
    return { translated: 0, failed: 0, stopCode: STOP_CODES.has(code) ? code : undefined };
  }

  const workable = rows.filter((row) => isContentLocale(row.from));
  // (from, to) → rows still missing that target.
  const jobs = new Map<string, Array<Record<string, any>>>();
  for (const row of workable) {
    for (const to of CONTENT_LOCALES) {
      if (to === row.from || row.translations?.[to]) continue;
      const key = `${row.from}>${to}`;
      if (!jobs.has(key)) jobs.set(key, []);
      jobs.get(key)!.push(row);
    }
  }

  const results = new Map<string, Record<string, string>>();
  const errors = new Map<string, string>();
  let stopCode: string | undefined;
  for (const [key, jobRows] of jobs) {
    if (stopCode) {
      for (const row of jobRows) errors.set(String(row._id), stopCode);
      continue;
    }
    const [from, to] = key.split(">");
    try {
      const translated = await translateTexts(
        jobRows.map((row) => String(row.text)),
        { from, to, html: false, deadline }
      );
      jobRows.forEach((row, i) => {
        const text = translated[i];
        if (typeof text === "string" && text.trim()) {
          const id = String(row._id);
          results.set(id, { ...(results.get(id) || {}), [to]: text.trim() });
        } else {
          errors.set(String(row._id), "provider_error");
        }
      });
    } catch (err) {
      const code = errorCodeOf(err);
      if (!(err instanceof TranslatorError)) console.error("[contentTranslations] translate crashed:", err);
      for (const row of jobRows) errors.set(String(row._id), code);
      if (STOP_CODES.has(code)) stopCode = code;
    }
  }

  let translated = 0;
  let failed = 0;
  const now = new Date();
  const operations: any[] = [];
  const errored: Array<Record<string, any>> = [];
  for (const row of workable) {
    const id = String(row._id);
    const fresh = results.get(id) || {};
    const error = errors.get(id);
    const set: Record<string, unknown> = {};
    for (const [locale, text] of Object.entries(fresh)) set[`translations.${locale}`] = text;
    if (error) {
      // Keep what did translate; the row stays queued for the missing locales.
      if (Object.keys(set).length) {
        operations.push({
          updateOne: { filter: { _id: row._id, claimId, mode: { $ne: "manual" } }, update: { $set: set } },
        });
      }
      errored.push(row);
      continue;
    }
    operations.push({
      updateOne: {
        filter: { _id: row._id, claimId },
        update: {
          $set: { ...(row.mode === "manual" ? {} : set), status: "done", translatedAt: now },
          $unset: { claimId: 1, leaseUntil: 1, errorCode: 1 },
        },
      },
    });
    translated += 1;
  }
  if (operations.length) await ContentTranslation.bulkWrite(operations, { ordered: false });

  // Group errored rows by code so each gets its own attempt accounting.
  const byCode = new Map<string, Array<Record<string, any>>>();
  for (const row of errored) {
    const code = errors.get(String(row._id)) || "internal";
    if (!byCode.has(code)) byCode.set(code, []);
    byCode.get(code)!.push(row);
  }
  for (const [code, codeRows] of byCode) {
    await releaseWithError(codeRows, claimId, code);
    if (!TRANSIENT_CODES.has(code)) {
      failed += codeRows.filter((row) => Number(row.attempts || 0) + 1 >= CONTENT_TRANSLATION_MAX_ATTEMPTS).length;
    }
  }
  return { translated, failed, stopCode };
}

/**
 * Translates pending rows until none are left, the budget is spent or the
 * provider refuses (auth, quota, rate limit). Safe to run concurrently.
 */
export async function drainContentTranslationQueue(
  options: { budgetMs?: number; batchSize?: number } = {}
): Promise<DrainSummary> {
  const summary: DrainSummary = { claimed: 0, translated: 0, failed: 0 };
  if (!isTranslatorConfigured()) return { ...summary, stoppedBy: "not_configured" };
  const deadline = Date.now() + (options.budgetMs ?? CONTENT_TRANSLATION_BUDGET_MS);
  const batchSize = options.batchSize ?? CONTENT_TRANSLATION_BATCH_SIZE;

  while (Date.now() < deadline) {
    const { claimId, rows } = await claimBatch(batchSize);
    if (rows.length === 0) break;
    summary.claimed += rows.length;
    const outcome = await translateBatch(rows, claimId, deadline);
    summary.translated += outcome.translated;
    summary.failed += outcome.failed;
    if (outcome.stopCode) {
      summary.stoppedBy = outcome.stopCode;
      break;
    }
  }
  return summary;
}
