import ServiceConfiguration from "../models/serviceConfiguration";
import { pruneStaleArticle47ProfessionalAnswers } from "./vatManagement";

/**
 * Shared draft write boundary for the reserved Article 47 answer, used by
 * both draft endpoints (`POST /api/user/projects` and `POST
 * /api/projects/draft`). A stale article47 answer is dropped unless the
 * CURRENT service-config classification is project dependent.
 *
 * Only an available configuration record decides: when no configuration id
 * can be resolved, the record is missing, or the lookup fails, the submitted
 * answers are left exactly as they are (no data loss). Unrelated answers are
 * always preserved, and historical bookings/invoices are untouched.
 *
 * `savedConfigurationId` is the stored draft's configuration, used when a
 * partial update omits `serviceConfigurationId`. Mutates `projectData`.
 */
export async function pruneDraftArticle47Answers(
  projectData: Record<string, any>,
  savedConfigurationId?: unknown,
): Promise<void> {
  if (!projectData || !Array.isArray(projectData.vatProfessionalAnswers)) return;
  const configurationId = projectData.serviceConfigurationId || savedConfigurationId;
  if (!configurationId) return;
  try {
    const svcConfig = await ServiceConfiguration.findById(configurationId)
      .select("vatManagement.article47Classification")
      .lean();
    if (!svcConfig) return;
    projectData.vatProfessionalAnswers = pruneStaleArticle47ProfessionalAnswers(
      projectData.vatProfessionalAnswers,
      (svcConfig as any).vatManagement?.article47Classification,
    );
  } catch {
    // Lookup failure must never destroy draft data: leave answers as-is.
  }
}
