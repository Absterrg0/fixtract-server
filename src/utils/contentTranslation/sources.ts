/**
 * Queues the customer-facing text of projects and catalogue entries for
 * background translation (see ./queue.ts). Used by the save handlers, the
 * admin backfill endpoint and the maintenance script.
 */
import mongoose, { type Types } from "mongoose";

import Project from "../../models/project";
import ServiceConfiguration from "../../models/serviceConfiguration";
import { isTranslatorConfigured } from "../cms/azureTranslator";
import { enqueueContentTexts, scheduleContentTranslationWork } from "./queue";
import { collectProjectTexts, collectServiceConfigurationTexts } from "./texts";

type Id = Types.ObjectId | string;

/** Project states whose text customers can see now or after approval. */
export const TRANSLATED_PROJECT_STATUSES = ["published", "pending", "on_hold"] as const;

const PROJECT_TEXT_FIELDS =
  "title description priceModel areaOfWork serviceConfigurationId subprojects extraOptions termsConditions faq rfqQuestions postBookingQuestions customConfirmationMessage";

/** Queues one catalogue entry's text (English source). Returns rows added. */
export async function enqueueServiceConfigurationTexts(config: Record<string, any>): Promise<number> {
  const texts = collectServiceConfigurationTexts(config);
  return enqueueContentTexts(texts.map((text) => ({ text, from: "en" })), "catalogue");
}

/**
 * Queues one project's text. Strings that appear verbatim in the project's
 * catalogue entry are English catalogue text; everything else is the
 * professional's own writing, queued for language detection per project.
 */
export async function enqueueProjectTexts(
  project: Record<string, any>,
  catalogueTexts?: Set<string>
): Promise<number> {
  let catalogue = catalogueTexts;
  if (!catalogue) {
    catalogue = new Set<string>();
    const configId = project.serviceConfigurationId;
    if (configId && mongoose.Types.ObjectId.isValid(String(configId))) {
      const config = await ServiceConfiguration.findById(configId).lean();
      if (config) {
        for (const text of collectServiceConfigurationTexts(config as Record<string, any>)) catalogue.add(text);
      }
    }
  }
  // Free-text professional answers are not queued: only catalogue option text.
  const texts = collectProjectTexts(project, { inputValues: catalogue });
  const fromCatalogue = texts.filter((text) => catalogue!.has(text));
  const own = texts.filter((text) => !catalogue!.has(text));
  const added =
    (await enqueueContentTexts(fromCatalogue.map((text) => ({ text, from: "en" })), "catalogue")) +
    (await enqueueContentTexts(
      own.map((text) => ({ text, from: "auto", detectGroup: String(project._id) })),
      "project"
    ));
  return added;
}

/**
 * After the response: queue the project's text (and its catalogue entry's
 * VAT questions) and translate. No-op without AZURE_TRANSLATOR_KEY. Never
 * throws; a failure only means the backfill picks the project up later.
 */
export function requestProjectContentTranslation(projectId: Id | null | undefined): void {
  if (!projectId || !isTranslatorConfigured()) return;
  void scheduleContentTranslationWork(async () => {
    const project = await Project.findById(projectId).select(PROJECT_TEXT_FIELDS).lean();
    if (!project) return;
    const configId = (project as any).serviceConfigurationId;
    // One snapshot of the catalogue entry: queued, and used to classify the
    // project's strings (no second lookup in enqueueProjectTexts).
    const catalogue = new Set<string>();
    if (configId && mongoose.Types.ObjectId.isValid(String(configId))) {
      const config = await ServiceConfiguration.findById(configId).lean();
      if (config) {
        await enqueueServiceConfigurationTexts(config as Record<string, any>);
        for (const text of collectServiceConfigurationTexts(config as Record<string, any>)) catalogue.add(text);
      }
    }
    await enqueueProjectTexts(project as Record<string, any>, catalogue);
  });
}

/** After the response: queue one catalogue entry's text and translate. */
export function requestServiceConfigurationContentTranslation(configId: Id | null | undefined): void {
  if (!configId || !isTranslatorConfigured()) return;
  void scheduleContentTranslationWork(async () => {
    const config = await ServiceConfiguration.findById(configId).lean();
    if (config) await enqueueServiceConfigurationTexts(config as Record<string, any>);
  });
}

export interface ContentBackfillSummary {
  serviceConfigurations: number;
  projects: number;
  queued: number;
}

/**
 * Queues every catalogue entry and every visible project (idempotent: known
 * strings are skipped). Translation itself happens in the drain.
 */
export async function backfillContentTranslations(): Promise<ContentBackfillSummary> {
  const summary: ContentBackfillSummary = { serviceConfigurations: 0, projects: 0, queued: 0 };
  const catalogueById = new Map<string, Set<string>>();

  for await (const config of ServiceConfiguration.find({}).lean().cursor()) {
    summary.serviceConfigurations += 1;
    summary.queued += await enqueueServiceConfigurationTexts(config as Record<string, any>);
    catalogueById.set(String((config as any)._id), new Set(collectServiceConfigurationTexts(config as any)));
  }

  for await (const project of Project.find({ status: { $in: TRANSLATED_PROJECT_STATUSES } })
    .select(PROJECT_TEXT_FIELDS)
    .lean()
    .cursor()) {
    summary.projects += 1;
    const catalogue = catalogueById.get(String((project as any).serviceConfigurationId || "")) ?? new Set<string>();
    summary.queued += await enqueueProjectTexts(project as Record<string, any>, catalogue);
  }
  return summary;
}
