import { Request, Response } from 'express';
import {
  uploadProjectFile,
  validateImageFileBuffer,
  validateVideoFile,
  validateCertificationFile
} from '../../utils/s3Upload';
import { sendHandlerError } from '../../utils/handlerErrors';

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
    const result = await uploadProjectFile(file, userId, projectId || 'temp', 'image');

    res.status(200).json({
      success: true,
      data: result
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
    const result = await uploadProjectFile(file, userId, projectId || 'temp', 'video');

    res.status(200).json({
      success: true,
      data: result
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
    const result = await uploadProjectFile(file, userId, projectId || 'temp', 'certification');

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
    const result = await uploadProjectFile(file, userId, projectId || 'temp', 'attachment');

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
