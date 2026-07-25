import { Request, Response, NextFunction } from "express";
import mongoose from "mongoose";
import SiteAnnouncement, { AnnouncementType } from "../../models/siteAnnouncement";
import { params } from "../../utils/requestParams";

const ANNOUNCEMENT_TYPES: AnnouncementType[] = ['top_bar', 'modal', 'exit_intent'];

const parseDate = (value: unknown): Date | null => {
  if (!value) return null;
  const d = new Date(value as string);
  return isNaN(d.getTime()) ? null : d;
};

const validatePayload = (body: any): { ok: true; data: any } | { ok: false; error: string } => {
  const {
    name, type, title, message, ctaLabel, ctaUrl, discountCode,
    activeCountries, locale, startsAt, endsAt, isActive,
    priority, delaySeconds, dismissible, requireMarketingConsent,
  } = body;

  if (!name || typeof name !== 'string' || name.trim().length < 2) {
    return { ok: false, error: 'Name is required (min 2 characters)' };
  }
  if (!ANNOUNCEMENT_TYPES.includes(type)) {
    return { ok: false, error: 'Type must be top_bar, modal, or exit_intent' };
  }
  if (!title || typeof title !== 'string' || title.trim().length < 2) {
    return { ok: false, error: 'Title is required' };
  }
  if (!message || typeof message !== 'string' || message.trim().length < 2) {
    return { ok: false, error: 'Message is required' };
  }

  const from = parseDate(startsAt);
  const until = parseDate(endsAt);
  if (!from || !until) return { ok: false, error: 'startsAt and endsAt are required dates' };
  if (until <= from) return { ok: false, error: 'endsAt must be after startsAt' };

  if (activeCountries !== undefined && !Array.isArray(activeCountries)) {
    return { ok: false, error: 'activeCountries must be an array of country codes' };
  }
  if (Array.isArray(activeCountries) && !activeCountries.every((c: any) => typeof c === 'string')) {
    return { ok: false, error: 'activeCountries must contain only strings' };
  }

  if (ctaUrl !== undefined && ctaUrl !== null && ctaUrl !== '') {
    if (typeof ctaUrl !== 'string') return { ok: false, error: 'ctaUrl must be a string' };
    const trimmed = ctaUrl.trim();
    if (!(trimmed.startsWith('/') || trimmed.startsWith('https://') || trimmed.startsWith('http://'))) {
      return { ok: false, error: 'ctaUrl must be a relative path or http(s) URL' };
    }
  }

  return {
    ok: true,
    data: {
      name: name.trim(),
      type,
      title: title.trim(),
      message: message.trim(),
      ctaLabel: typeof ctaLabel === 'string' && ctaLabel.trim() ? ctaLabel.trim() : undefined,
      ctaUrl: typeof ctaUrl === 'string' && ctaUrl.trim() ? ctaUrl.trim() : undefined,
      discountCode: typeof discountCode === 'string' && discountCode.trim()
        ? discountCode.trim().toUpperCase()
        : undefined,
      activeCountries: Array.isArray(activeCountries)
        ? activeCountries.map((c: string) => c.trim().toUpperCase()).filter(Boolean)
        : [],
      locale: typeof locale === 'string' && locale.trim() ? locale.trim().toLowerCase() : 'en',
      startsAt: from,
      endsAt: until,
      isActive: typeof isActive === 'boolean' ? isActive : true,
      priority: Number.isFinite(Number(priority)) ? Number(priority) : 0,
      delaySeconds: Number.isFinite(Number(delaySeconds))
        ? Math.min(120, Math.max(0, Number(delaySeconds)))
        : 3,
      dismissible: typeof dismissible === 'boolean' ? dismissible : true,
      requireMarketingConsent: typeof requireMarketingConsent === 'boolean'
        ? requireMarketingConsent
        : true,
    },
  };
};

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const listSiteAnnouncements = async (req: Request, res: Response, _next: NextFunction) => {
  try {
    const { status, type, search, page = '1', limit = '50' } = req.query as Record<string, string>;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));
    const now = new Date();
    const query: Record<string, any> = {};

    if (type && ANNOUNCEMENT_TYPES.includes(type as AnnouncementType)) {
      query.type = type;
    }

    if (status === 'active') {
      query.isActive = true;
      query.startsAt = { $lte: now };
      query.endsAt = { $gte: now };
    } else if (status === 'scheduled') {
      query.startsAt = { $gt: now };
    } else if (status === 'expired') {
      query.endsAt = { $lt: now };
    } else if (status === 'disabled') {
      query.isActive = false;
    }

    if (search && search.trim()) {
      const safe = escapeRegExp(search.trim().slice(0, 64));
      query.$or = [
        { name: { $regex: safe, $options: 'i' } },
        { title: { $regex: safe, $options: 'i' } },
      ];
    }

    const total = await SiteAnnouncement.countDocuments(query);
    const announcements = await SiteAnnouncement.find(query)
      .sort({ priority: -1, createdAt: -1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .lean();

    return res.status(200).json({
      success: true,
      data: { announcements, total, page: pageNum, limit: limitNum },
    });
  } catch (error: any) {
    console.error('List site announcements error:', error);
    return res.status(500).json({ success: false, msg: 'Failed to list announcements' });
  }
};

export const getSiteAnnouncement = async (req: Request, res: Response, _next: NextFunction) => {
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
  } catch (error: any) {
    console.error('Get site announcement error:', error);
    return res.status(500).json({ success: false, msg: 'Failed to load announcement' });
  }
};

export const createSiteAnnouncement = async (req: Request, res: Response, _next: NextFunction) => {
  try {
    const adminId = (req as any).admin?._id;
    if (!adminId) return res.status(401).json({ success: false, msg: 'Authentication required' });

    const result = validatePayload(req.body);
    if (!result.ok) return res.status(400).json({ success: false, msg: result.error });

    const created = await SiteAnnouncement.create({ ...result.data, createdBy: adminId });
    return res.status(201).json({ success: true, data: { announcement: created } });
  } catch (error: any) {
    console.error('Create site announcement error:', error);
    return res.status(500).json({ success: false, msg: 'Failed to create announcement' });
  }
};

export const setSiteAnnouncementActive = async (req: Request, res: Response, _next: NextFunction) => {
  try {
    const { id } = params(req.params);
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, msg: 'Invalid id' });
    }

    const { isActive } = req.body;
    if (typeof isActive !== 'boolean') {
      return res.status(400).json({ success: false, msg: 'isActive must be a boolean' });
    }

    const updated = await SiteAnnouncement.findByIdAndUpdate(id, { isActive }, { new: true });
    if (!updated) return res.status(404).json({ success: false, msg: 'Announcement not found' });

    return res.status(200).json({ success: true, data: { announcement: updated } });
  } catch (error: any) {
    console.error('Set site announcement active error:', error);
    return res.status(500).json({ success: false, msg: 'Failed to update announcement status' });
  }
};

export const updateSiteAnnouncement = async (req: Request, res: Response, _next: NextFunction) => {
  try {
    const { id } = params(req.params);
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, msg: 'Invalid id' });
    }

    const result = validatePayload(req.body);
    if (!result.ok) return res.status(400).json({ success: false, msg: result.error });

    const updated = await SiteAnnouncement.findByIdAndUpdate(id, result.data, { new: true });
    if (!updated) return res.status(404).json({ success: false, msg: 'Announcement not found' });

    return res.status(200).json({ success: true, data: { announcement: updated } });
  } catch (error: any) {
    console.error('Update site announcement error:', error);
    return res.status(500).json({ success: false, msg: 'Failed to update announcement' });
  }
};

export const deleteSiteAnnouncement = async (req: Request, res: Response, _next: NextFunction) => {
  try {
    const { id } = params(req.params);
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, msg: 'Invalid id' });
    }
    const updated = await SiteAnnouncement.findByIdAndUpdate(id, { isActive: false }, { new: true });
    if (!updated) return res.status(404).json({ success: false, msg: 'Announcement not found' });
    return res.status(200).json({ success: true, data: { announcement: updated } });
  } catch (error: any) {
    console.error('Delete site announcement error:', error);
    return res.status(500).json({ success: false, msg: 'Failed to delete announcement' });
  }
};
