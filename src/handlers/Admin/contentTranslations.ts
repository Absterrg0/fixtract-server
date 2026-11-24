/**
 * Admin endpoints for site-wide machine translation:
 *
 * CMS (blogs, news, FAQ, ...):
 * - GET  /api/admin/cms/translation-backfill  coverage overview (+ resumes a stalled drain)
 * - POST /api/admin/cms/translation-backfill  super admin: translate all existing content
 *
 * Catalogue + project text (translation memory):
 * - GET  /api/admin/content-translations/status    counts per status (+ resumes a stalled drain)
 * - POST /api/admin/content-translations/backfill  super admin: queue every catalogue entry and visible project
 * - GET  /api/admin/content-translations           list rows (search / status filter)
 * - PUT  /api/admin/content-translations/:id       super admin: manual override of one row
 *
 * Provider work always runs after the response (Vercel waitUntil).
 */
import { Request, Response } from "express";
import mongoose from "mongoose";
import { waitUntil } from "@vercel/functions";

import ContentTranslation, { CONTENT_TRANSLATION_STATUSES } from "../../models/contentTranslation";
import { resolveAdminRole } from "../../utils/adminRbac/rolePermissions";
import { isTranslatorConfigured } from "../../utils/cms/azureTranslator";
import {
  loadCmsTranslationOverview,
  processQueuedCmsTranslations,
  queueCmsTranslationBackfill,
} from "../../utils/cms/translationBackfill";
import { scheduleContentTranslationWork } from "../../utils/contentTranslation/queue";
import { backfillContentTranslations } from "../../utils/contentTranslation/sources";
import { CONTENT_LOCALES } from "../../utils/contentTranslation/texts";
import { escapeRegExp } from "../../utils/escapeRegExp";

/** Shown wherever auto-translation is off; names the missing setting. */
export const TRANSLATOR_DISABLED_MESSAGE =
  "Auto-translation is disabled: AZURE_TRANSLATOR_KEY is not set on the API server.";

const inFlight = new Set<Promise<void>>();

/** Resolves once every background job started here has settled (tests). */
export async function waitForAdminTranslationJobs(): Promise<void> {
  while (inFlight.size > 0) {
    await Promise.allSettled(Array.from(inFlight));
  }
}

function runInBackground(label: string, work: () => Promise<unknown>): void {
  const job = work()
    .then(() => undefined)
    .catch((err) => {
      console.error(`[${label}] background job crashed:`, err);
    });
  inFlight.add(job);
  void job.finally(() => inFlight.delete(job));
  try {
    waitUntil(job);
  } catch (err) {
    console.warn(`[${label}] waitUntil unavailable; job continues unmanaged:`, err);
  }
}

function isSuperAdmin(req: Request): boolean {
  return resolveAdminRole((req.admin as any)?.adminRole) === "super";
}

function denyUnlessSuper(req: Request, res: Response): boolean {
  if (isSuperAdmin(req)) return false;
  res.status(403).json({
    success: false,
    msg: "Only a super admin can run site-wide translation jobs",
    code: "ADMIN_PERMISSION_DENIED",
  });
  return true;
}

function translatorDisabled(res: Response): Response {
  return res.status(409).json({
    success: false,
    msg: TRANSLATOR_DISABLED_MESSAGE,
    code: "TRANSLATOR_NOT_CONFIGURED",
  });
}

// ------------------------------------------------------------------ CMS

/** GET /api/admin/cms/translation-backfill */
export const getCmsTranslationOverview = async (_req: Request, res: Response) => {
  try {
    const overview = await loadCmsTranslationOverview();
    // A drain that ran out of time (or died) leaves requested originals:
    // reading the overview resumes it, like the per-document status read.
    if (overview.enabled && overview.queued > 0 && overview.running === 0) {
      runInBackground("cmsBackfill", () => processQueuedCmsTranslations());
    }
    return res.status(200).json({
      success: true,
      data: { ...overview, ...(overview.enabled ? {} : { disabledReason: TRANSLATOR_DISABLED_MESSAGE }) },
    });
  } catch (error) {
    console.error("CMS translation overview error:", error);
    return res.status(500).json({ success: false, msg: "Failed to load translation status" });
  }
};

/** POST /api/admin/cms/translation-backfill */
export const runCmsTranslationBackfill = async (req: Request, res: Response) => {
  try {
    if (denyUnlessSuper(req, res)) return;
    if (!isTranslatorConfigured()) return translatorDisabled(res);
    runInBackground("cmsBackfill", async () => {
      await queueCmsTranslationBackfill();
      await processQueuedCmsTranslations();
    });
    const overview = await loadCmsTranslationOverview();
    return res.status(202).json({ success: true, data: overview });
  } catch (error) {
    console.error("CMS translation backfill error:", error);
    return res.status(500).json({ success: false, msg: "Translation sync failed" });
  }
};

// ------------------------------------------------- catalogue / projects

async function contentTranslationCounts() {
  const now = new Date();
  const [byStatus, running] = await Promise.all([
    ContentTranslation.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
    ContentTranslation.countDocuments({ leaseUntil: { $gt: now } }),
  ]);
  const counts = { pending: 0, done: 0, failed: 0 };
  for (const row of byStatus as Array<{ _id: keyof typeof counts; count: number }>) {
    if (row._id in counts) counts[row._id] = row.count;
  }
  return { ...counts, running };
}

/** GET /api/admin/content-translations/status */
export const getContentTranslationStatus = async (_req: Request, res: Response) => {
  try {
    const enabled = isTranslatorConfigured();
    const counts = await contentTranslationCounts();
    if (enabled && counts.pending > 0 && counts.running === 0) {
      void scheduleContentTranslationWork();
    }
    return res.status(200).json({
      success: true,
      data: { enabled, ...counts, ...(enabled ? {} : { disabledReason: TRANSLATOR_DISABLED_MESSAGE }) },
    });
  } catch (error) {
    console.error("Content translation status error:", error);
    return res.status(500).json({ success: false, msg: "Failed to load translation status" });
  }
};

/** POST /api/admin/content-translations/backfill */
export const runContentTranslationBackfill = async (req: Request, res: Response) => {
  try {
    if (denyUnlessSuper(req, res)) return;
    if (!isTranslatorConfigured()) return translatorDisabled(res);
    // Retry rows parked as failed (e.g. after a quota or key problem was fixed).
    if (req.body?.retryFailed === true) {
      await ContentTranslation.updateMany(
        { status: "failed", mode: { $ne: "manual" } },
        { $set: { status: "pending", attempts: 0 }, $unset: { errorCode: 1 } }
      );
    }
    void scheduleContentTranslationWork(() => backfillContentTranslations());
    return res.status(202).json({ success: true, data: { enabled: true, ...(await contentTranslationCounts()) } });
  } catch (error) {
    console.error("Content translation backfill error:", error);
    return res.status(500).json({ success: false, msg: "Translation sync failed" });
  }
};

/** GET /api/admin/content-translations?status=&q=&page= */
export const listContentTranslations = async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, Number.parseInt(String(req.query.page ?? "1"), 10) || 1);
    const limit = 50;
    const filter: Record<string, unknown> = {};
    const status = String(req.query.status ?? "");
    if ((CONTENT_TRANSLATION_STATUSES as readonly string[]).includes(status)) filter.status = status;
    const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 100) : "";
    if (q) filter.text = { $regex: escapeRegExp(q), $options: "i" };
    const [items, total] = await Promise.all([
      ContentTranslation.find(filter)
        .select("text from translations mode status origin errorCode attempts translatedAt updatedAt")
        .sort({ updatedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      ContentTranslation.countDocuments(filter),
    ]);
    return res.status(200).json({ success: true, data: { items, total, page, limit } });
  } catch (error) {
    console.error("List content translations error:", error);
    return res.status(500).json({ success: false, msg: "Failed to load translation status" });
  }
};

/** PUT /api/admin/content-translations/:id  body: { translations: { nl?, fr?, en? } } */
export const updateContentTranslation = async (req: Request, res: Response) => {
  try {
    if (denyUnlessSuper(req, res)) return;
    const id = String(req.params.id || "");
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, msg: "Invalid translation ID" });
    }
    const input = req.body?.translations;
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return res.status(400).json({ success: false, msg: "translations must be an object" });
    }
    const set: Record<string, unknown> = {};
    const unset: Record<string, unknown> = {};
    for (const locale of CONTENT_LOCALES) {
      if (!(locale in input)) continue;
      const value = input[locale];
      if (value === null || (typeof value === "string" && !value.trim())) unset[`translations.${locale}`] = 1;
      else if (typeof value === "string" && value.length <= 5_000) set[`translations.${locale}`] = value.trim();
      else return res.status(400).json({ success: false, msg: "translations must be an object" });
    }
    const updated = await ContentTranslation.findByIdAndUpdate(
      id,
      {
        $set: { ...set, mode: "manual", status: "done", translatedAt: new Date() },
        $unset: { ...unset, errorCode: 1, claimId: 1, leaseUntil: 1 },
      },
      { new: true }
    )
      .select("text from translations mode status origin")
      .lean();
    if (!updated) return res.status(404).json({ success: false, msg: "Translation not found" });
    return res.status(200).json({ success: true, data: updated });
  } catch (error) {
    console.error("Update content translation error:", error);
    return res.status(500).json({ success: false, msg: "Translation sync failed" });
  }
};
