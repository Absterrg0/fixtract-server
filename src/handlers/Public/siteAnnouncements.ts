import { Request, Response, NextFunction } from 'express';
import SiteAnnouncement from '../../models/siteAnnouncement';
import {
  buildPublicListQuery,
} from '../../utils/siteAnnouncements/buildQueries';
import { parsePublicListFilters } from '../../utils/siteAnnouncements/parseListFilters';

/**
 * Public active announcements for the visitor's country / locale / type.
 * Empty activeCountries = show everywhere.
 *
 * Selection: highest priority per type, preferring an exact locale match over
 * the English fallback before creation-time tie-break. Type reduction happens
 * in MongoDB so one type cannot crowd out the others via a global candidate cap.
 */
export const listPublicSiteAnnouncements = async (
  req: Request,
  res: Response,
  _next: NextFunction,
) => {
  try {
    const filters = parsePublicListFilters(req.query);
    const query = buildPublicListQuery(filters);

    const announcements = await SiteAnnouncement.aggregate([
      { $match: query },
      {
        $addFields: {
          localeExact: {
            $cond: [{ $eq: ['$locale', filters.locale] }, 1, 0],
          },
        },
      },
      { $sort: { priority: -1, localeExact: -1, createdAt: -1 } },
      {
        $group: {
          _id: '$type',
          doc: { $first: '$$ROOT' },
        },
      },
      { $replaceRoot: { newRoot: '$doc' } },
      {
        $project: {
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
        },
      },
    ]);

    return res.status(200).json({
      success: true,
      data: {
        announcements,
        country: filters.countryCode ?? null,
        locale: filters.locale,
      },
    });
  } catch (error: unknown) {
    console.error('List public site announcements error:', error);
    return res.status(500).json({ success: false, msg: 'Failed to load announcements' });
  }
};
