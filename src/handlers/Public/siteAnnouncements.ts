import { Request, Response, NextFunction } from "express";
import SiteAnnouncement, { AnnouncementType } from "../../models/siteAnnouncement";

const ANNOUNCEMENT_TYPES: AnnouncementType[] = ['top_bar', 'modal', 'exit_intent'];

/**
 * Public active announcements for the visitor's country / locale / type.
 * Empty activeCountries = show everywhere.
 */
export const listPublicSiteAnnouncements = async (req: Request, res: Response, _next: NextFunction) => {
  try {
    const {
      country,
      locale = 'en',
      type,
    } = req.query as Record<string, string>;

    const now = new Date();
    const query: Record<string, any> = {
      isActive: true,
      startsAt: { $lte: now },
      endsAt: { $gte: now },
    };

    if (type && ANNOUNCEMENT_TYPES.includes(type as AnnouncementType)) {
      query.type = type;
    }

    if (locale && typeof locale === 'string') {
      // Soft match: prefer requested locale, always allow 'en' fallback content
      const loc = locale.trim().toLowerCase().slice(0, 10) || 'en';
      query.locale = { $in: [loc, 'en'] };
    }

    const countryCode = typeof country === 'string' ? country.trim().toUpperCase().slice(0, 2) : '';
    if (countryCode && /^[A-Z]{2}$/.test(countryCode)) {
      query.$or = [
        { activeCountries: { $size: 0 } },
        { activeCountries: countryCode },
      ];
    }

    const announcements = await SiteAnnouncement.find(query)
      .sort({ priority: -1, createdAt: -1 })
      .limit(20)
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
    const byType: Record<string, typeof announcements[number]> = {};
    for (const item of announcements) {
      if (!byType[item.type]) byType[item.type] = item;
    }

    return res.status(200).json({
      success: true,
      data: {
        announcements: Object.values(byType),
        country: countryCode || null,
        locale: (locale || 'en').toLowerCase(),
      },
    });
  } catch (error: any) {
    console.error('List public site announcements error:', error);
    return res.status(500).json({ success: false, msg: 'Failed to load announcements' });
  }
};
