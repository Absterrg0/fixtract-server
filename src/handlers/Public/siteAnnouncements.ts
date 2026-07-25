import { Request, Response, NextFunction } from 'express';
import SiteAnnouncement from '../../models/siteAnnouncement';
import {
  ANNOUNCEMENT_LIMITS,
  buildPublicListQuery,
  parsePublicListFilters,
} from '../../utils/siteAnnouncements';

/**
 * Public active announcements for the visitor's country / locale / type.
 * Empty activeCountries = show everywhere.
 */
export const listPublicSiteAnnouncements = async (
  req: Request,
  res: Response,
  _next: NextFunction,
) => {
  try {
    const filters = parsePublicListFilters(req.query);
    const query = buildPublicListQuery(filters);

    const announcements = await SiteAnnouncement.find(query)
      .sort({ priority: -1, createdAt: -1 })
      .limit(ANNOUNCEMENT_LIMITS.publicListLimit)
      .select({
        name: 1,
        type: 1,
        title: 1,
        message: 1,
        ctaLabel: 1,
        ctaUrl: 1,
        discountCode: 1,
        activeCountries: 1,
        locale: 1,
        priority: 1,
        delaySeconds: 1,
        dismissible: 1,
        requireMarketingConsent: 1,
        startsAt: 1,
        endsAt: 1,
      })
      .lean();

    // Pick one per type (highest priority) for simpler client rendering
    const byType = new Map<string, (typeof announcements)[number]>();
    for (const item of announcements) {
      if (!byType.has(item.type)) {
        byType.set(item.type, item);
      }
    }

    return res.status(200).json({
      success: true,
      data: {
        announcements: Array.from(byType.values()),
        country: filters.countryCode ?? null,
        locale: filters.locale,
      },
    });
  } catch (error: unknown) {
    console.error('List public site announcements error:', error);
    return res.status(500).json({ success: false, msg: 'Failed to load announcements' });
  }
};
