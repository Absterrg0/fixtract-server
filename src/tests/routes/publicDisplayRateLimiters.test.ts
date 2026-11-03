import express from 'express';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Route-level proof that ordinary project/professional page browsing (public
// reviews, favorite counts, view tracking) has its own bounded budgets and never
// spends the booking calendar budget. Only actual scheduling/calendar reads and
// the intentional referral validation stay on SCHEDULING_RATE_LIMIT (60).
// Handlers are stubbed; the real router and its real express-rate-limit
// instances decide 2xx vs 429.
const ok = vi.hoisted(() => (_req: any, res: any) => res.status(200).json({ success: true, data: {} }));
vi.mock('../../handlers/Project', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../handlers/Project')>();
  return {
    ...actual,
    getProjectTeamAvailability: vi.fn(ok),
    getProjectWorkingHours: vi.fn(ok),
    getProjectScheduleProposals: vi.fn(ok),
    getProjectScheduleWindow: vi.fn(ok),
    getProjectAvailableSlots: vi.fn(ok),
  };
});
vi.mock('../../handlers/Booking/reviews', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../handlers/Booking/reviews')>();
  return { ...actual, getProfessionalReviews: vi.fn(ok), getProjectReviews: vi.fn(ok) };
});
vi.mock('../../handlers/Favorites', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../handlers/Favorites')>();
  return {
    ...actual,
    getPublicProfessionalFavoriteCount: vi.fn(ok),
    getPublicProjectFavoriteCount: vi.fn(ok),
  };
});
vi.mock('../../handlers/Public/profileView', () => ({
  recordProfessionalView: vi.fn((_req: any, res: any) => res.status(200).json({ success: true })),
}));
vi.mock('../../handlers/Public/serviceView', () => ({
  recordServiceView: vi.fn((_req: any, res: any) => res.status(200).json({ success: true })),
}));
vi.mock('../../handlers/Public/marketingUnsubscribe', () => ({ unsubscribeMarketing: vi.fn(ok) }));
vi.mock('../../handlers/Public/marketingLanguages', () => ({ getMarketingLanguages: vi.fn(ok) }));
vi.mock('../../handlers/User/referralManagement', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../handlers/User/referralManagement')>();
  return { ...actual, validateReferralCodePublic: vi.fn(ok) };
});

import publicRouter, {
  MARKETING_PREFERENCES_RATE_LIMIT,
  PUBLIC_DISPLAY_RATE_LIMIT,
  SCHEDULING_RATE_LIMIT,
  VIEW_TRACKING_RATE_LIMIT,
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

const ID = '64b7f0c2a1b2c3d4e5f60718';
const send = (method: 'GET' | 'POST', path: string, ip: string) =>
  fetch(`${baseUrl}/api/public${path}`, {
    method,
    headers: { 'x-forwarded-for': ip, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
    body: method === 'POST' ? '{}' : undefined,
  });

const CALENDAR = ['availability', 'working-hours', 'schedule-proposals', 'schedule-window', 'available-slots'].map(
  (p) => (ip: string) => send('GET', `/projects/${ID}/${p}`, ip),
);
const calendar = CALENDAR[0];
const referral = (ip: string) => send('GET', '/referral/validate/ABC123', ip);
const DISPLAY = [
  (ip: string) => send('GET', `/projects/${ID}/reviews`, ip),
  (ip: string) => send('GET', `/professionals/${ID}/reviews`, ip),
  (ip: string) => send('GET', `/projects/${ID}/favorites-count`, ip),
  (ip: string) => send('GET', `/professionals/${ID}/favorites-count`, ip),
];
const MARKETING = [
  (ip: string) => send('GET', '/marketing/unsubscribe?token=x', ip),
  (ip: string) => send('POST', '/marketing/unsubscribe', ip),
  (ip: string) => send('GET', '/marketing/languages', ip),
];
const VIEWS = [
  (ip: string) => send('POST', `/professionals/${ID}/view`, ip),
  (ip: string) => send('POST', `/services/${ID}/view`, ip),
];

/** Sends `count` requests, cycling through `routes`, 50 at a time. */
async function spend(count: number, routes: Array<(ip: string) => Promise<Response>>, ip: string): Promise<number[]> {
  const statuses: number[] = [];
  for (let i = 0; i < count; i += 50) {
    const batch = await Promise.all(
      Array.from({ length: Math.min(50, count - i) }, async (_v, j) => {
        const response = await routes[(i + j) % routes.length](ip);
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

describe('public display/view-tracking rate-limit budgets', () => {
  it('display reads and view tracking advertise their own bounded budgets; calendar and referral keep 60', async () => {
    expect(SCHEDULING_RATE_LIMIT).toBe(60);
    expect(PUBLIC_DISPLAY_RATE_LIMIT).toBe(300);
    expect(VIEW_TRACKING_RATE_LIMIT).toBe(300);
    expect(MARKETING_PREFERENCES_RATE_LIMIT).toBe(60);

    const ip = '203.0.113.10';
    for (const [index, route] of DISPLAY.entries()) {
      const r = await route(ip);
      expect(r.status).toBe(200);
      expect(limitOf(r)).toBe(PUBLIC_DISPLAY_RATE_LIMIT);
      expect(remainingOf(r)).toBe(PUBLIC_DISPLAY_RATE_LIMIT - 1 - index); // one shared display budget
    }
    for (const [index, route] of VIEWS.entries()) {
      const r = await route(ip);
      expect(r.status).toBe(200);
      expect(limitOf(r)).toBe(VIEW_TRACKING_RATE_LIMIT);
      expect(remainingOf(r)).toBe(VIEW_TRACKING_RATE_LIMIT - 1 - index);
    }
    for (const [index, route] of MARKETING.entries()) {
      const r = await route(ip);
      expect(r.status).toBe(200);
      expect(limitOf(r)).toBe(MARKETING_PREFERENCES_RATE_LIMIT);
      expect(remainingOf(r)).toBe(MARKETING_PREFERENCES_RATE_LIMIT - 1 - index); // unchanged cap, own instance
    }
    // None of the requests above spent the calendar budget...
    const c = await calendar(ip);
    expect(limitOf(c)).toBe(SCHEDULING_RATE_LIMIT);
    expect(remainingOf(c)).toBe(SCHEDULING_RATE_LIMIT - 1);
    // ...while referral validation intentionally shares it.
    const ref = await referral(ip);
    expect(limitOf(ref)).toBe(SCHEDULING_RATE_LIMIT);
    expect(remainingOf(ref)).toBe(SCHEDULING_RATE_LIMIT - 2);
  });

  it('exhausting display, view and marketing-preference traffic leaves the full calendar budget of 60', async () => {
    const ip = '203.0.113.20';
    const displayStatuses = await spend(PUBLIC_DISPLAY_RATE_LIMIT, DISPLAY, ip);
    const viewStatuses = await spend(VIEW_TRACKING_RATE_LIMIT, VIEWS, ip);
    const marketingStatuses = await spend(MARKETING_PREFERENCES_RATE_LIMIT, MARKETING, ip);
    expect(displayStatuses.every((s) => s === 200)).toBe(true);
    expect(viewStatuses.every((s) => s === 200)).toBe(true);
    expect(marketingStatuses.every((s) => s === 200)).toBe(true);

    // All budgets are bounded: every display, view and marketing route is now 429 RATE_LIMITED.
    for (const route of [...DISPLAY, ...VIEWS, ...MARKETING]) {
      const over = await route(ip);
      expect(over.status).toBe(429);
      expect((await over.json()).code).toBe('RATE_LIMITED');
    }

    // The calendar on the same IP still has all 60, shared by every calendar endpoint.
    const first = await calendar(ip);
    expect(first.status).toBe(200);
    expect(remainingOf(first)).toBe(SCHEDULING_RATE_LIMIT - 1);
    const rest = await spend(SCHEDULING_RATE_LIMIT - 1, CALENDAR, ip);
    expect(rest.every((s) => s === 200)).toBe(true);
    for (const route of CALENDAR) expect((await route(ip)).status).toBe(429);
    expect((await referral(ip)).status).toBe(429);

    // Another IP is unaffected.
    expect((await DISPLAY[0]('203.0.113.21')).status).toBe(200);
  });

  it('an exhausted calendar budget does not block display reads or view tracking, and those two are independent', async () => {
    const ip = '203.0.113.30';
    const calendarStatuses = await spend(SCHEDULING_RATE_LIMIT, CALENDAR, ip);
    expect(calendarStatuses.every((s) => s === 200)).toBe(true);
    for (const route of CALENDAR) expect((await route(ip)).status).toBe(429);
    expect((await referral(ip)).status).toBe(429);

    const d = await DISPLAY[0](ip);
    const v = await VIEWS[0](ip);
    const m = await MARKETING[2](ip);
    expect([d.status, v.status, m.status]).toEqual([200, 200, 200]);
    expect(remainingOf(m)).toBe(MARKETING_PREFERENCES_RATE_LIMIT - 1);
    expect(remainingOf(d)).toBe(PUBLIC_DISPLAY_RATE_LIMIT - 1);
    expect(remainingOf(v)).toBe(VIEW_TRACKING_RATE_LIMIT - 1);

    // Exhausting view tracking leaves the display budget untouched, and vice versa.
    const ip2 = '203.0.113.31';
    await spend(VIEW_TRACKING_RATE_LIMIT, VIEWS, ip2);
    expect((await VIEWS[1](ip2)).status).toBe(429);
    const d2 = await DISPLAY[2](ip2);
    expect(d2.status).toBe(200);
    expect(remainingOf(d2)).toBe(PUBLIC_DISPLAY_RATE_LIMIT - 1);

    const ip3 = '203.0.113.32';
    await spend(PUBLIC_DISPLAY_RATE_LIMIT, DISPLAY, ip3);
    expect((await DISPLAY[1](ip3)).status).toBe(429);
    const v3 = await VIEWS[0](ip3);
    expect(v3.status).toBe(200);
    expect(remainingOf(v3)).toBe(VIEW_TRACKING_RATE_LIMIT - 1);
  });
});
