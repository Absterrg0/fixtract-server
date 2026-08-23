import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import SiteAnnouncement from '../../models/siteAnnouncement';
import { buildPublicAnnouncementAggregationPipeline } from '../../utils/siteAnnouncements/publicAggregation';
import { parsePublicListFilters } from '../../utils/siteAnnouncements/parseListFilters';
import { isAnnouncementEventType } from '../../utils/siteAnnouncements/constants';
import { params } from '../../utils/requestParams';

const DEFAULT_ANNOUNCEMENT_FREQUENCY = 'once_pageview';

function normalizeAnnouncement<T extends Record<string, unknown>>(announcement: T): T {
  return {
    ...announcement,
    frequency:
      typeof announcement.frequency === 'string'
        ? announcement.frequency
        : DEFAULT_ANNOUNCEMENT_FREQUENCY,
  } as T;
}

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
    const pipeline = buildPublicAnnouncementAggregationPipeline(filters);
    const announcements = (await SiteAnnouncement.aggregate(pipeline)).map((announcement) =>
      normalizeAnnouncement(announcement as Record<string, unknown>),
    );

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

/** Public, rate-limited counters for announcement impressions, clicks, and dismissals. */
export const recordSiteAnnouncementEvent = async (
  req: Request,
  res: Response,
  _next: NextFunction,
) => {
  try {
    const { id } = params(req.params);
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, msg: 'Invalid id' });
    }

    const event = typeof req.body?.event === 'string' ? req.body.event.trim() : '';
    if (!isAnnouncementEventType(event)) {
      return res.status(400).json({ success: false, msg: 'event must be impression, click, or dismissal' });
    }

    const field = `${event}s` as 'impressions' | 'clicks' | 'dismissals';
    const now = new Date();
    const updated = await SiteAnnouncement.findByIdAndUpdate(
      {
        _id: id,
        isActive: true,
        startsAt: { $lte: now },
        endsAt: { $gte: now },
      },
      { $inc: { [field]: 1 } },
      { new: true, runValidators: true },
    );
    if (!updated) {
      return res.status(404).json({ success: false, msg: 'Announcement not found' });
    }

    return res.status(204).send();
  } catch (error: unknown) {
    console.error('Record site announcement event error:', error);
    return res.status(500).json({ success: false, msg: 'Failed to record announcement event' });
  }
};
