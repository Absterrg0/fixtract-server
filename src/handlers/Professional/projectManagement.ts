import { Request, Response } from 'express';
import Project from '../../models/project';
import User from '../../models/user';
import { pruneDraftArticle47Answers } from '../../utils/projectDraftVatAnswers';
import Favorite from '../../models/favorite';
import { invalidateFavoritesOverviewCache } from '../Admin/favoritesAdmin';
import { normalizePreparationDuration } from '../../utils/projectDurations';
import { withAnonymizationWriteFence } from '../../utils/support/accountGuard';
import {
  canonicalizeProjectMedia,
  withSignedProjectMedia,
  withSignedProjectMediaList,
} from '../../utils/projectMedia';
import {
  isLostProjectTransition,
  PROJECT_STATUS_CONFLICT,
  projectTransitionGuard,
  saveProjectWithFence,
} from '../../utils/projectConditionalSave';

/**
 * Save project draft (create or update)
 * @route POST /api/user/projects
 */
export const saveProjectDraft = async (req: Request, res: Response) => {
  try {
    const userId = String(req.user?._id);
    const projectData = normalizePreparationDuration(req.body);
    if (projectData && projectData.media) {
      projectData.media = canonicalizeProjectMedia(projectData.media);
    }
    const professional = await User.findById(userId).select('role professionalStatus');

    if (!professional || professional.role !== 'professional') {
      return res.status(403).json({
        success: false,
        message: 'Only approved professionals can manage projects'
      });
    }

    if (professional.professionalStatus !== 'approved') {
      return res.status(403).json({
        success: false,
        message: 'Professional approval is required before creating projects',
        code: 'PROFESSIONAL_APPROVAL_REQUIRED'
      });
    }

    let project;

    // Write boundary for reserved VAT answers (shared with POST
    // /api/projects/draft): see pruneDraftArticle47Answers.
    let savedConfigurationId: unknown;
    if (projectData._id) {
      const savedDraft = await Project.findOne({ _id: projectData._id, professionalId: userId })
        .select('status serviceConfigurationId')
        .lean();
      // Archived projects are read-only until restored: a draft save must not
      // rewrite their status or content behind the archive metadata.
      if (savedDraft?.status === 'archived') {
        return res.status(400).json({
          success: false,
          message: 'Archived projects must be restored before editing',
          code: 'PROJECT_ARCHIVED',
        });
      }
      // A partial update may omit the configuration; the saved draft's config
      // still decides whether the reserved answer is authoritative.
      savedConfigurationId = savedDraft?.serviceConfigurationId;
    }
    // Archive bookkeeping is owned by the archive/restore endpoints.
    delete (projectData as any).archivedAt;
    delete (projectData as any).statusBeforeArchive;
    await pruneDraftArticle47Answers(projectData as any, savedConfigurationId);

    if (projectData._id) {
      // Update existing draft
      // The archived check above is a read; the status predicate makes it
      // part of the write so an archive committed in between is never
      // reopened or overwritten.
      project = await withAnonymizationWriteFence([userId], async (session) =>
        Project.findOneAndUpdate(
          { _id: projectData._id, professionalId: userId, status: { $ne: 'archived' } },
          { ...projectData, autoSaveTimestamp: new Date() },
          { new: true, runValidators: true, ...(session ? { session } : {}) },
        ));
      if (!project && await Project.exists({ _id: projectData._id, professionalId: userId, status: 'archived' })) {
        return res.status(409).json({
          success: false,
          message: 'This project was archived while you were editing. Restore it before editing.',
          code: 'PROJECT_ARCHIVED',
        });
      }
    } else {
      // Create new draft
      project = await withAnonymizationWriteFence([userId], async (session) => {
        const [created] = await Project.create([{
          ...projectData,
          professionalId: userId,
          status: 'draft',
          autoSaveTimestamp: new Date()
        }], session ? { session } : undefined);
        return created;
      });
    }

    res.status(200).json({
      success: true,
      data: project ? await withSignedProjectMedia(project) : project
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: "We couldn't save your project. Please try again.",
    });
  }
};

/**
 * Get project by ID
 * @route GET /api/user/projects/:id
 */
export const getProject = async (req: Request, res: Response) => {
  try {
    const userId = String(req.user?._id);
    const { id } = req.params;
    const professional = await User.findById(userId).select('role professionalStatus');

    if (!professional || professional.role !== 'professional') {
      return res.status(403).json({
        success: false,
        message: 'Only approved professionals can view this project'
      });
    }

    if (professional.professionalStatus !== 'approved') {
      return res.status(403).json({
        success: false,
        message: 'Professional approval is required before viewing projects',
        code: 'PROFESSIONAL_APPROVAL_REQUIRED'
      });
    }

    const project = await Project.findOne({
      _id: id,
      professionalId: userId
    });

    if (!project) {
      return res.status(404).json({
        success: false,
        message: 'Project not found'
      });
    }

    res.status(200).json({
      success: true,
      data: await withSignedProjectMedia(project)
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: "We couldn't load this project. Please try again.",
    });
  }
};

/**
 * Get all projects for professional
 * @route GET /api/user/projects
 */
export const getAllProjects = async (req: Request, res: Response) => {
  try {
    const userId = String(req.user?._id);
    const { status } = req.query;
    const professional = await User.findById(userId).select('role professionalStatus');

    if (!professional || professional.role !== 'professional') {
      return res.status(403).json({
        success: false,
        message: 'Only approved professionals can view projects'
      });
    }

    if (professional.professionalStatus !== 'approved') {
      return res.status(403).json({
        success: false,
        message: 'Professional approval is required before viewing projects',
        code: 'PROFESSIONAL_APPROVAL_REQUIRED'
      });
    }

    const filter: any = { professionalId: userId };
    if (status) filter.status = status;

    const projects = await Project.find(filter)
      .sort({ updatedAt: -1 });

    res.status(200).json({
      success: true,
      data: await withSignedProjectMediaList(projects)
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: "We couldn't load your projects. Please try again.",
    });
  }
};

/**
 * Submit project for approval
 * @route POST /api/user/projects/:id/submit
 */
export const submitProject = async (req: Request, res: Response) => {
  try {
    const userId = String(req.user?._id);
    const { id } = req.params;
    const professional = await User.findById(userId).select('role professionalStatus');

    if (!professional || professional.role !== 'professional') {
      return res.status(403).json({
        success: false,
        message: 'Only approved professionals can submit projects'
      });
    }

    if (professional.professionalStatus !== 'approved') {
      return res.status(403).json({
        success: false,
        message: 'Professional approval is required before submitting projects',
        code: 'PROFESSIONAL_APPROVAL_REQUIRED'
      });
    }

    const project = await Project.findOne({
      _id: id,
      professionalId: userId,
      status: 'draft'
    });

    if (!project) {
      return res.status(404).json({
        success: false,
        message: 'Draft project not found'
      });
    }

    // Perform quality checks here
    const qualityChecks = performQualityChecks(project);

    // Submit only the draft read above: an archive (or other transition)
    // committed meanwhile wins with a 409 instead of being reopened.
    const expected = projectTransitionGuard(project);
    project.status = 'pending';
    project.submittedAt = new Date();
    project.qualityChecks = qualityChecks;
    try {
      await saveProjectWithFence(project, userId, expected);
    } catch (error) {
      if (!isLostProjectTransition(error)) throw error;
      const latest = await Project.findOne({ _id: id, professionalId: userId }).select('status').lean();
      return res.status(409).json({
        success: false,
        message: 'Project status changed while submitting; reload and try again',
        code: PROJECT_STATUS_CONFLICT,
        ...(latest ? { currentStatus: (latest as any).status } : {}),
      });
    }

    res.status(200).json({
      success: true,
      message: 'Project submitted for approval',
      data: project
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: "We couldn't submit your project. Please try again.",
    });
  }
};

/**
 * Delete project draft
 * @route DELETE /api/user/projects/:id
 */
export const deleteProject = async (req: Request, res: Response) => {
  try {
    const userId = String(req.user?._id);
    const { id } = req.params;
    const professional = await User.findById(userId).select('role professionalStatus');

    if (!professional || professional.role !== 'professional') {
      return res.status(403).json({
        success: false,
        message: 'Only approved professionals can delete projects'
      });
    }

    if (professional.professionalStatus !== 'approved') {
      return res.status(403).json({
        success: false,
        message: 'Professional approval is required before deleting projects',
        code: 'PROFESSIONAL_APPROVAL_REQUIRED'
      });
    }

    const project = await Project.findOneAndDelete({
      _id: id,
      professionalId: userId,
      status: 'draft'
    });

    if (!project) {
      return res.status(404).json({
        success: false,
        message: 'Draft project not found'
      });
    }

    try {
      await Favorite.deleteMany({ targetType: 'project', targetId: project._id });
    } catch (cleanupErr) {
      console.warn('Favorite cleanup failed after project delete', { projectId: project._id, error: cleanupErr });
    } finally {
      invalidateFavoritesOverviewCache();
    }

    res.status(200).json({
      success: true,
      message: 'Project deleted successfully'
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: "We couldn't delete your project. Please try again.",
    });
  }
};

/**
 * Get projects assigned to an employee
 * @route GET /api/user/employee/projects
 */
export const getEmployeeAssignedProjects = async (req: Request, res: Response) => {
  try {
    const userId = String(req.user?._id);
    const user = req.user;

    // Verify user is an employee
    if (user?.role !== 'employee') {
      return res.status(403).json({
        success: false,
        message: 'Only employees can access this endpoint'
      });
    }

    // Find projects where the employee is in the resources array
    const projects = await Project.find({
      resources: userId,
      status: { $in: ['published', 'on_hold'] } // Only show published or on-hold projects
    })
      .select('title description category service professionalId status createdAt updatedAt')
      .sort({ updatedAt: -1 });

    res.status(200).json({
      success: true,
      data: projects
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: "We couldn't load your assigned projects. Please try again.",
    });
  }
};

// Helper function for quality checks
function performQualityChecks(project: any) {
  const checks: Array<{
    category: string;
    status: 'passed' | 'failed' | 'warning';
    message: string;
    checkedAt: Date;
  }> = [];

  // Example checks
  if (project.description.length < 100) {
    checks.push({
      category: 'description',
      status: 'warning' as const,
      message: 'Description is very short',
      checkedAt: new Date()
    });
  }

  if (project.media?.images?.length === 0) {
    checks.push({
      category: 'media',
      status: 'warning' as const,
      message: 'No images uploaded',
      checkedAt: new Date()
    });
  }

  return checks;
}
