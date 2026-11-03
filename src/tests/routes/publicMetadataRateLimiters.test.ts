import express from 'express';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Route-level proof that the display-only tier/level colour reads (fetched on
// every full page load) have their own bounded budgets and never spend the
// booking calendar budget. Handlers are stubbed; the real router and its real
// express-rate-limit instances decide 2xx vs 429.
vi.mock('../../handlers/Project', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../handlers/Project')>();
  const ok = (_req: any, res: any) => res.status(200).json({ success: true, data: {} });
  return {
    ...actual,
    getProjectTeamAvailability: vi.fn(ok),
    getProjectWorkingHours: vi.fn(ok),
    getProjectScheduleProposals: vi.fn(ok),
    getProjectScheduleWindow: vi.fn(ok),
    getProjectAvailableSlots: vi.fn(ok),
  };
});
vi.mock('../../handlers/Public/levelTiers', () => ({
  getPublicLoyaltyTiers: vi.fn((_req: any, res: any) => res.status(200).json({ success: true, data: [] })),
  getPublicProfessionalLevels: vi.fn((_req: any, res: any) => res.status(200).json({ success: true, data: [] })),
}));
vi.mock('../../handlers/Public/siteAnnouncements', () => ({
  listPublicSiteAnnouncements: vi.fn((_req: any, res: any) =>
    res.status(200).json({ success: true, data: { announcements: [] } })),
  recordSiteAnnouncementEvent: vi.fn((_req: any, res: any) => res.status(204).send()),
}));

import publicRouter, {
  ANNOUNCEMENT_EVENT_RATE_LIMIT,
  ANNOUNCEMENT_LIST_RATE_LIMIT,
  LOYALTY_TIERS_RATE_LIMIT,
  PROFESSIONAL_LEVELS_RATE_LIMIT,
  SCHEDULING_RATE_LIMIT,
} from '../../routes/Public';

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '32kb' }));
app.use('/api/public', publicRouter);
let server: Server;
let baseUrl = '';

beforeAll(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  baseUrl = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))));

const PROJECT_ID = '64b7f0c2a1b2c3d4e5f60718';
const get = (path: string, ip: string) =>
  fetch(`${baseUrl}/api/public${path}`, { headers: { 'x-forwarded-for': ip } });
const calendar = (ip: string) => get(`/projects/${PROJECT_ID}/availability`, ip);
const workingHours = (ip: string) => get(`/projects/${PROJECT_ID}/working-hours`, ip);
const tiers = (ip: string) => get('/loyalty-tiers', ip);
const levels = (ip: string) => get('/professional-levels', ip);
const listing = (ip: string) => get('/site-announcements?country=BE&locale=en', ip);

async function spend(count: number, send: () => Promise<Response>): Promise<number[]> {
  const statuses: number[] = [];
  for (let i = 0; i < count; i += 50) {
    const batch = await Promise.all(
      Array.from({ length: Math.min(50, count - i) }, async () => {
        const response = await send();
        await response.arrayBuffer();
        return response.status;
      }),
    );
    statuses.push(...batch);
  }
  return statuses;
}

const limitOf = (response: Response) => Number(response.headers.get('ratelimit-limit'));
const remainingOf = (response: Response) => Number(response.headers.get('ratelimit-remaining'));

describe('public tier/level metadata rate-limit budgets', () => {
  it('advertises bounded budgets separate from the calendar and announcements', async () => {
    expect(SCHEDULING_RATE_LIMIT).toBe(60);
    expect(ANNOUNCEMENT_LIST_RATE_LIMIT).toBe(300);
    expect(ANNOUNCEMENT_EVENT_RATE_LIMIT).toBe(600);
    expect(LOYALTY_TIERS_RATE_LIMIT).toBe(300);
    expect(PROFESSIONAL_LEVELS_RATE_LIMIT).toBe(300);

    const ip = '198.51.100.10';
    const t = await tiers(ip);
    const l = await levels(ip);
    const c = await calendar(ip);
    expect([t.status, l.status, c.status]).toEqual([200, 200, 200]);
    expect(limitOf(t)).toBe(LOYALTY_TIERS_RATE_LIMIT);
    expect(limitOf(l)).toBe(PROFESSIONAL_LEVELS_RATE_LIMIT);
    expect(limitOf(c)).toBe(SCHEDULING_RATE_LIMIT);
    // Each read spent only its own budget.
    expect(remainingOf(t)).toBe(LOYALTY_TIERS_RATE_LIMIT - 1);
    expect(remainingOf(l)).toBe(PROFESSIONAL_LEVELS_RATE_LIMIT - 1);
    expect(remainingOf(c)).toBe(SCHEDULING_RATE_LIMIT - 1);
  });

  it('many full page loads (tiers + levels each) never spend the calendar budget', async () => {
    const ip = '198.51.100.20';
    // 300 page loads: each Navbar mount reads both endpoints once.
    const tierStatuses = await spend(LOYALTY_TIERS_RATE_LIMIT, () => tiers(ip));
    const levelStatuses = await spend(PROFESSIONAL_LEVELS_RATE_LIMIT, () => levels(ip));
    expect(tierStatuses.every((s) => s === 200)).toBe(true);
    expect(levelStatuses.every((s) => s === 200)).toBe(true);

    // Budgets are bounded: the next read of each is 429 RATE_LIMITED.
    const tierOver = await tiers(ip);
    expect(tierOver.status).toBe(429);
    expect((await tierOver.json()).code).toBe('RATE_LIMITED');
    expect((await levels(ip)).status).toBe(429);

    // The calendar on the same IP still has its full 60 budget.
    const c = await calendar(ip);
    expect(c.status).toBe(200);
    expect(remainingOf(c)).toBe(SCHEDULING_RATE_LIMIT - 1);
    const calendarStatuses = await spend(SCHEDULING_RATE_LIMIT - 1, () => calendar(ip));
    expect(calendarStatuses.every((s) => s === 200)).toBe(true);
    expect((await calendar(ip)).status).toBe(429);

    // Announcements are untouched too; another IP is unaffected.
    const a = await listing(ip);
    expect(a.status).toBe(200);
    expect(remainingOf(a)).toBe(ANNOUNCEMENT_LIST_RATE_LIMIT - 1);
    expect((await tiers('198.51.100.21')).status).toBe(200);
  });

  it('an exhausted calendar budget does not block tier/level reads, and the two metadata budgets are independent', async () => {
    const ip = '198.51.100.30';
    const calendarStatuses = await spend(SCHEDULING_RATE_LIMIT, () => calendar(ip));
    expect(calendarStatuses.every((s) => s === 200)).toBe(true);
    expect((await calendar(ip)).status).toBe(429);
    // Calendar endpoints still share their one budget.
    expect((await workingHours(ip)).status).toBe(429);

    const t = await tiers(ip);
    const l = await levels(ip);
    expect([t.status, l.status]).toEqual([200, 200]);
    expect(remainingOf(t)).toBe(LOYALTY_TIERS_RATE_LIMIT - 1);
    expect(remainingOf(l)).toBe(PROFESSIONAL_LEVELS_RATE_LIMIT - 1);

    // Exhausting tiers leaves levels with its own remaining budget.
    const ip2 = '198.51.100.31';
    await spend(LOYALTY_TIERS_RATE_LIMIT, () => tiers(ip2));
    expect((await tiers(ip2)).status).toBe(429);
    const l2 = await levels(ip2);
    expect(l2.status).toBe(200);
    expect(remainingOf(l2)).toBe(PROFESSIONAL_LEVELS_RATE_LIMIT - 1);
  });
});
