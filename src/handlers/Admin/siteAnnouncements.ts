import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import SiteAnnouncement, { type ISiteAnnouncement } from '../../models/siteAnnouncement';
import { params } from '../../utils/requestParams';
import { buildAdminListQuery } from '../../utils/siteAnnouncements/buildQueries';
import { parseAdminListFilters } from '../../utils/siteAnnouncements/parseListFilters';
import {
  parseIsActiveBody,
  parseSiteAnnouncementPatchBody,
  parseSiteAnnouncementWriteBody,
} from '../../utils/siteAnnouncements/parseWriteBody';
import type { SiteAnnouncementWriteInput } from '../../utils/siteAnnouncements/types';

function toWriteInput(doc: ISiteAnnouncement): SiteAnnouncementWriteInput {
  return {
    name: doc.name,
    type: doc.type,
    title: doc.title,
    message: doc.message,
    ctaLabel: doc.ctaLabel,
    ctaUrl: doc.ctaUrl,
    discountCode: doc.discountCode,
    activeCountries: [...doc.activeCountries],
    locale: doc.locale,
    startsAt: doc.startsAt,
    endsAt: doc.endsAt,
    isActive: doc.isActive,
    priority: doc.priority,
    delaySeconds: doc.delaySeconds,
    dismissible: doc.dismissible,
    requireMarketingConsent: doc.requireMarketingConsent,
  };
}

export const listSiteAnnouncements = async (
  req: Request,
  res: Response,
  _next: NextFunction,
) => {
  try {
    const filters = parseAdminListFilters(req.query);
    const query = buildAdminListQuery(filters);

    const [total, announcements] = await Promise.all([
      SiteAnnouncement.countDocuments(query),
      SiteAnnouncement.find(query)
        .sort({ priority: -1, createdAt: -1 })
        .skip((filters.page - 1) * filters.limit)
        .limit(filters.limit)
        .lean(),
    ]);

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
      { new: true, runValidators: true },
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

    const existing = await SiteAnnouncement.findById(id);
    if (!existing) {
      return res.status(404).json({ success: false, msg: 'Announcement not found' });
    }

    const parsed = parseSiteAnnouncementPatchBody(req.body ?? {}, toWriteInput(existing));
    if (!parsed.ok) {
      return res.status(400).json({ success: false, msg: parsed.error });
    }

    const $set: Record<string, unknown> = {};
    const $unset: Record<string, 1> = {};
    for (const [key, value] of Object.entries(parsed.value)) {
      if (value === null && (key === 'ctaLabel' || key === 'ctaUrl' || key === 'discountCode')) {
        $unset[key] = 1;
      } else if (value !== undefined) {
        $set[key] = value;
      }
    }
    const updateDoc =
      Object.keys($unset).length > 0
        ? {
            ...(Object.keys($set).length > 0 ? { $set } : {}),
            $unset,
          }
        : $set;

    const updated = await SiteAnnouncement.findByIdAndUpdate(id, updateDoc, {
      new: true,
      runValidators: true,
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
      { new: true, runValidators: true },
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
