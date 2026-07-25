import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import SiteAnnouncement from '../../models/siteAnnouncement';
import { params } from '../../utils/requestParams';
import { buildAdminListQuery } from '../../utils/siteAnnouncements/buildQueries';
import { parseAdminListFilters } from '../../utils/siteAnnouncements/parseListFilters';
import {
  parseIsActiveBody,
  parseSiteAnnouncementWriteBody,
} from '../../utils/siteAnnouncements/parseWriteBody';

export const listSiteAnnouncements = async (
  req: Request,
  res: Response,
  _next: NextFunction,
) => {
  try {
    const filters = parseAdminListFilters(req.query);
    const query = buildAdminListQuery(filters);

    const total = await SiteAnnouncement.countDocuments(query);
    const announcements = await SiteAnnouncement.find(query)
      .sort({ priority: -1, createdAt: -1 })
      .skip((filters.page - 1) * filters.limit)
      .limit(filters.limit)
      .lean();

    return res.status(200).json({
      success: true,
      data: {
        announcements,
        total,
        page: filters.page,
        limit: filters.limit,
      },
    });
  } catch (error: unknown) {
    console.error('List site announcements error:', error);
    return res.status(500).json({ success: false, msg: 'Failed to list announcements' });
  }
};

export const getSiteAnnouncement = async (
  req: Request,
  res: Response,
  _next: NextFunction,
) => {
  try {
    const { id } = params(req.params);
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, msg: 'Invalid id' });
    }

    const announcement = await SiteAnnouncement.findById(id).lean();
    if (!announcement) {
      return res.status(404).json({ success: false, msg: 'Announcement not found' });
    }

    return res.status(200).json({ success: true, data: { announcement } });
  } catch (error: unknown) {
    console.error('Get site announcement error:', error);
    return res.status(500).json({ success: false, msg: 'Failed to load announcement' });
  }
};

export const createSiteAnnouncement = async (
  req: Request,
  res: Response,
  _next: NextFunction,
) => {
  try {
    const adminId = req.admin?._id;
    if (!adminId) {
      return res.status(401).json({ success: false, msg: 'Authentication required' });
    }

    const parsed = parseSiteAnnouncementWriteBody(req.body ?? {});
    if (!parsed.ok) {
      return res.status(400).json({ success: false, msg: parsed.error });
    }

    const created = await SiteAnnouncement.create({
      ...parsed.value,
      createdBy: adminId,
    });

    return res.status(201).json({ success: true, data: { announcement: created } });
  } catch (error: unknown) {
    console.error('Create site announcement error:', error);
    return res.status(500).json({ success: false, msg: 'Failed to create announcement' });
  }
};

export const setSiteAnnouncementActive = async (
  req: Request,
  res: Response,
  _next: NextFunction,
) => {
  try {
    const { id } = params(req.params);
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, msg: 'Invalid id' });
    }

    const parsed = parseIsActiveBody(req.body ?? {});
    if (!parsed.ok) {
      return res.status(400).json({ success: false, msg: parsed.error });
    }

    const updated = await SiteAnnouncement.findByIdAndUpdate(
      id,
      { isActive: parsed.value },
      { new: true },
    );
    if (!updated) {
      return res.status(404).json({ success: false, msg: 'Announcement not found' });
    }

    return res.status(200).json({ success: true, data: { announcement: updated } });
  } catch (error: unknown) {
    console.error('Set site announcement active error:', error);
    return res
      .status(500)
      .json({ success: false, msg: 'Failed to update announcement status' });
  }
};

export const updateSiteAnnouncement = async (
  req: Request,
  res: Response,
  _next: NextFunction,
) => {
  try {
    const { id } = params(req.params);
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, msg: 'Invalid id' });
    }

    const parsed = parseSiteAnnouncementWriteBody(req.body ?? {});
    if (!parsed.ok) {
      return res.status(400).json({ success: false, msg: parsed.error });
    }

    const updated = await SiteAnnouncement.findByIdAndUpdate(id, parsed.value, {
      new: true,
    });
    if (!updated) {
      return res.status(404).json({ success: false, msg: 'Announcement not found' });
    }

    return res.status(200).json({ success: true, data: { announcement: updated } });
  } catch (error: unknown) {
    console.error('Update site announcement error:', error);
    return res.status(500).json({ success: false, msg: 'Failed to update announcement' });
  }
};

export const deleteSiteAnnouncement = async (
  req: Request,
  res: Response,
  _next: NextFunction,
) => {
  try {
    const { id } = params(req.params);
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, msg: 'Invalid id' });
    }

    const updated = await SiteAnnouncement.findByIdAndUpdate(
      id,
      { isActive: false },
      { new: true },
    );
    if (!updated) {
      return res.status(404).json({ success: false, msg: 'Announcement not found' });
    }

    return res.status(200).json({ success: true, data: { announcement: updated } });
  } catch (error: unknown) {
    console.error('Delete site announcement error:', error);
    return res.status(500).json({ success: false, msg: 'Failed to delete announcement' });
  }
};
