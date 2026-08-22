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
import { buildAnnouncementTranslations } from '../../utils/siteAnnouncements/translateAnnouncement';

const DEFAULT_ANNOUNCEMENT_FREQUENCY = 'once_pageview' as const;

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
    frequency: doc.frequency ?? DEFAULT_ANNOUNCEMENT_FREQUENCY,
    autoTranslate: doc.autoTranslate === true,
    startsAt: doc.startsAt,
    endsAt: doc.endsAt,
    isActive: doc.isActive,
    priority: doc.priority,
    delaySeconds: doc.delaySeconds,
    dismissible: doc.dismissible,
    requireMarketingConsent: doc.requireMarketingConsent,
  };
}

function normalizeAnnouncementResponse<T extends Record<string, unknown>>(value: T): T & {
  frequency: string;
  autoTranslate: boolean;
  impressions: number;
  clicks: number;
  dismissals: number;
} {
  return {
    ...value,
    frequency: typeof value.frequency === 'string' ? value.frequency : DEFAULT_ANNOUNCEMENT_FREQUENCY,
    autoTranslate: value.autoTranslate === true,
    impressions: Number(value.impressions) || 0,
    clicks: Number(value.clicks) || 0,
    dismissals: Number(value.dismissals) || 0,
  } as T & {
    frequency: string;
    autoTranslate: boolean;
    impressions: number;
    clicks: number;
    dismissals: number;
  };
}

function translationFailure(res: Response, error: unknown): Response | null {
  const message = error instanceof Error ? error.message : '';
  if (!message.startsWith('Automatic announcement translation')) return null;
  return res.status(503).json({ success: false, msg: message });
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
        announcements: announcements.map((announcement) =>
          normalizeAnnouncementResponse(announcement as unknown as Record<string, unknown>),
        ),
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

    return res.status(200).json({
      success: true,
      data: {
        announcement: normalizeAnnouncementResponse(announcement as unknown as Record<string, unknown>),
      },
    });
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

    let translations;
    try {
      translations = await buildAnnouncementTranslations(parsed.value);
    } catch (error) {
      const response = translationFailure(res, error);
      if (response) return response;
      throw error;
    }

    const created = await SiteAnnouncement.create({
      ...parsed.value,
      translations,
      createdBy: adminId,
    });

    return res.status(201).json({
      success: true,
      data: {
        announcement: normalizeAnnouncementResponse(
          (created.toObject?.() ?? created) as unknown as Record<string, unknown>,
        ),
      },
    });
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

    return res.status(200).json({
      success: true,
      data: {
        announcement: normalizeAnnouncementResponse(
          (updated.toObject?.() ?? updated) as unknown as Record<string, unknown>,
        ),
      },
    });
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

    const nextAutoTranslate = parsed.value.autoTranslate ?? existing.autoTranslate === true;
    const contentChanged = ['title', 'message', 'ctaLabel', 'locale'].some((key) =>
      Object.prototype.hasOwnProperty.call(parsed.value, key),
    );
    if (nextAutoTranslate && (!existing.autoTranslate || contentChanged)) {
      let translations;
      try {
        translations = await buildAnnouncementTranslations({
          ...toWriteInput(existing),
          ...parsed.value,
          autoTranslate: true,
          title: parsed.value.title ?? existing.title,
          message: parsed.value.message ?? existing.message,
          ctaLabel:
            parsed.value.ctaLabel === null
              ? undefined
              : parsed.value.ctaLabel ?? existing.ctaLabel,
          locale: parsed.value.locale ?? existing.locale,
        });
      } catch (error) {
        const response = translationFailure(res, error);
        if (response) return response;
        throw error;
      }
      $set.translations = translations;
    } else if (parsed.value.autoTranslate === false) {
      $unset.translations = 1;
    }

    const updateDoc =
      Object.keys($unset).length > 0
        ? {
            ...(Object.keys($set).length > 0 ? { $set } : {}),
            $unset,
          }
        : $set;

    const scheduleGuard: Record<string, unknown> = { _id: id };
    if (parsed.value.startsAt && !parsed.value.endsAt) {
      scheduleGuard.endsAt = { $gt: parsed.value.startsAt };
    } else if (parsed.value.endsAt && !parsed.value.startsAt) {
      scheduleGuard.startsAt = { $lt: parsed.value.endsAt };
    }

    const updated = await SiteAnnouncement.findOneAndUpdate(scheduleGuard, updateDoc, {
      new: true,
      runValidators: true,
    });
    if (!updated) {
      return res.status(409).json({
        success: false,
        msg: 'Announcement schedule changed; reload and try again',
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        announcement: normalizeAnnouncementResponse(
          (updated.toObject?.() ?? updated) as unknown as Record<string, unknown>,
        ),
      },
    });
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

    return res.status(200).json({
      success: true,
      data: {
        announcement: normalizeAnnouncementResponse(
          (updated.toObject?.() ?? updated) as unknown as Record<string, unknown>,
        ),
      },
    });
  } catch (error: unknown) {
    console.error('Delete site announcement error:', error);
    return res.status(500).json({ success: false, msg: 'Failed to delete announcement' });
  }
};
