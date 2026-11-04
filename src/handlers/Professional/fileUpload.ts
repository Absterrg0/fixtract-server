import { Request, Response } from 'express';
import {
  uploadProjectFile,
  validateImageFileBuffer,
  validateVideoFile,
  validateCertificationFile
} from '../../utils/s3Upload';
import { sendHandlerError } from '../../utils/handlerErrors';
import { projectMediaSignatureExpiresAt, signProjectMediaUrl } from '../../utils/projectMedia';

/** Upload keys embed the project id as one path segment; reject anything else. */
const safeProjectFolder = (value: unknown): string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : 'temp';

/**
 * Project media is private. `url` is the stable object URL to store in
 * `media.images` / `media.videos`; `signedUrl` is a time-limited URL for
 * previewing the upload right away.
 */
const withPreviewUrl = async (result: { url: string; key: string }, userId: string) => {
  const now = new Date();
  const signed = await signProjectMediaUrl(result.url, userId, now);
  const signedUrl = typeof signed === 'string' && signed !== result.url ? signed : null;
  return {
    ...result,
    signedUrl,
    signedUrlExpiresAt: signedUrl ? projectMediaSignatureExpiresAt(now).toISOString() : null,
  };
};

/**
 * Upload project image
 * @route POST /api/user/projects/upload/image
 */
export const uploadProjectImage = async (req: Request, res: Response) => {
  try {
    const file = req.file;
    const userId = String(req.user?._id);
    const { projectId } = req.body;

    if (!file) {
      return res.status(400).json({
        success: false,
        message: 'No file uploaded'
      });
    }

    // Validate image
    const validation = await validateImageFileBuffer(file);
    if (!validation.valid) {
      return res.status(400).json({
        success: false,
        message: validation.error
      });
    }

    // Upload to S3
    const result = await uploadProjectFile(file, userId, safeProjectFolder(projectId), 'image');

    res.status(200).json({
      success: true,
      data: await withPreviewUrl(result, userId)
    });
  } catch (error: any) {
    return sendHandlerError(res, error, "We couldn't upload the image. Please try again.");
  }
};

/**
 * Upload project video
 * @route POST /api/user/projects/upload/video
 */
export const uploadProjectVideo = async (req: Request, res: Response) => {
  try {
    const file = req.file;
    const userId = String(req.user?._id);
    const { projectId } = req.body;

    if (!file) {
      return res.status(400).json({
        success: false,
        message: 'No file uploaded'
      });
    }

    // Validate video
    const validation = validateVideoFile(file);
    if (!validation.valid) {
      return res.status(400).json({
        success: false,
        message: validation.error
      });
    }

    // Upload to S3
    const result = await uploadProjectFile(file, userId, safeProjectFolder(projectId), 'video');

    res.status(200).json({
      success: true,
      data: await withPreviewUrl(result, userId)
    });
  } catch (error: any) {
    return sendHandlerError(res, error, "We couldn't upload the video. Please try again.");
  }
};

/**
 * Upload certification
 * @route POST /api/user/projects/upload/certification
 */
export const uploadCertification = async (req: Request, res: Response) => {
  try {
    const file = req.file;
    const userId = String(req.user?._id);
    const { projectId, certificationType } = req.body;

    if (!file) {
      return res.status(400).json({
        success: false,
        message: 'No file uploaded'
      });
    }

    // Validate certification file
    const validation = validateCertificationFile(file);
    if (!validation.valid) {
      return res.status(400).json({
        success: false,
        message: validation.error
      });
    }

    // Upload to S3
    const result = await uploadProjectFile(file, userId, safeProjectFolder(projectId), 'certification');

    res.status(200).json({
      success: true,
      data: {
        ...result,
        certificationType
      }
    });
  } catch (error: any) {
    return sendHandlerError(res, error, "We couldn't upload the certification. Please try again.");
  }
};

/**
 * Upload question attachment
 * @route POST /api/user/projects/upload/attachment
 */
export const uploadQuestionAttachment = async (req: Request, res: Response) => {
  try {
    const file = req.file;
    const userId = String(req.user?._id);
    const { projectId, questionId } = req.body;

    if (!file) {
      return res.status(400).json({
        success: false,
        message: 'No file uploaded'
      });
    }

    // Upload to S3
    const result = await uploadProjectFile(file, userId, safeProjectFolder(projectId), 'attachment');

    res.status(200).json({
      success: true,
      data: {
        ...result,
        questionId
      }
    });
  } catch (error: any) {
    return sendHandlerError(res, error, "We couldn't upload the attachment. Please try again.");
  }
};
