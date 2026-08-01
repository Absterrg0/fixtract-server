import type { PipelineStage } from 'mongoose';
import { buildPublicListQuery } from './buildQueries';
import type { PublicListFilters } from './types';

/** Mongo aggregation pipeline for one winner per announcement type. */
export function buildPublicAnnouncementAggregationPipeline(
  filters: PublicListFilters,
  now: Date = new Date(),
): PipelineStage[] {
  const query = buildPublicListQuery(filters, now);
  const localeBase = filters.locale.split('-')[0] || filters.locale;

  return [
    { $match: query },
    {
      $addFields: {
        localeExact: {
          $cond: [{ $in: ['$locale', [filters.locale, localeBase]] }, 1, 0],
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
        updatedAt: 1,
      },
    },
  ];
}
