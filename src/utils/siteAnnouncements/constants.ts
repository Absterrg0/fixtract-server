import type { AnnouncementType } from '../../models/siteAnnouncement';

export const ANNOUNCEMENT_TYPES = ['top_bar', 'modal', 'exit_intent'] as const satisfies readonly AnnouncementType[];

export const ANNOUNCEMENT_LIMITS = {
  name: { min: 2, max: 120 },
  title: { min: 2, max: 160 },
  message: { min: 2, max: 500 },
  ctaLabel: { max: 60 },
  ctaUrl: { max: 500 },
  discountCode: { max: 40 },
  locale: { max: 10 },
  delaySeconds: { min: 0, max: 120, default: 3 },
  search: { max: 64 },
  listLimit: { min: 1, max: 100, default: 50 },
  publicListLimit: 20,
} as const;

export type AnnouncementListStatus = 'active' | 'scheduled' | 'expired' | 'disabled';

export const ANNOUNCEMENT_LIST_STATUSES = [
  'active',
  'scheduled',
  'expired',
  'disabled',
] as const satisfies readonly AnnouncementListStatus[];

export function isAnnouncementType(value: string): value is AnnouncementType {
  return (ANNOUNCEMENT_TYPES as readonly string[]).includes(value);
}

export function isAnnouncementListStatus(value: string): value is AnnouncementListStatus {
  return (ANNOUNCEMENT_LIST_STATUSES as readonly string[]).includes(value);
}
