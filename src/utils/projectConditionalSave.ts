import mongoose from "mongoose";
import { withAnonymizationWriteFence } from "./support/accountGuard";

/** Response code for a project transition that lost a race with another write. */
export const PROJECT_STATUS_CONFLICT = "PROJECT_STATUS_CONFLICT";

/**
 * Document save inside the anonymization write fence (model save hooks run).
 * `expected` adds conditions to the save's own update filter (Mongoose
 * `doc.$where`), so a transition read earlier writes only if the stored
 * project still matches; otherwise the save throws DocumentNotFoundError (or
 * VersionError when it also bumps the version) and nothing is written.
 */
export const saveProjectWithFence = async (project: any, userId: string, expected?: Record<string, unknown>) =>
  withAnonymizationWriteFence(
    [userId, (project as any).professionalId?._id || (project as any).professionalId],
    async (session) => {
      const previousWhere = project.$where;
      if (expected) project.$where = { ...(previousWhere || {}), ...expected };
      try {
        await project.save(session ? { session } : undefined);
      } finally {
        if (expected) project.$where = previousWhere;
      }
      return project;
    },
  );

/**
 * The stored state a lifecycle transition was decided from: its status and
 * owner. Capture it right after the read, before mutating the document, and
 * pass it to `saveProjectWithFence` so the write applies only to that state.
 */
export const projectTransitionGuard = (project: any): Record<string, unknown> => ({
  status: project.status,
  professionalId: project.professionalId?._id || project.professionalId,
});

/**
 * True when a conditional save matched no stored document: Mongoose reports
 * DocumentNotFoundError, or VersionError when the save also bumps the version
 * (array paths changed). Either way nothing was written.
 */
export const isLostProjectTransition = (error: unknown) =>
  error instanceof mongoose.Error.DocumentNotFoundError || error instanceof mongoose.Error.VersionError;
