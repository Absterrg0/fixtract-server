import express from 'express';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Route-level proof that the marketing announcement budgets are independent of the
// booking calendar budget. Handlers are stubbed so only the real router and its
// real express-rate-limit instances decide 2xx vs 429.
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
vi.mock('../../handlers/Public/siteAnnouncements', () => ({
  listPublicSiteAnnouncements: vi.fn((_req: any, res: any) =>
    res.status(200).json({ success: true, data: { announcements: [] } })),
  recordSiteAnnouncementEvent: vi.fn((_req: any, res: any) => res.status(204).send()),
}));

import publicRouter, {
  ANNOUNCEMENT_EVENT_RATE_LIMIT,
  ANNOUNCEMENT_LIST_RATE_LIMIT,
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
const ANNOUNCEMENT_ID = '64b7f0c2a1b2c3d4e5f60719';

const calendar = (ip: string) =>
  fetch(`${baseUrl}/api/public/projects/${PROJECT_ID}/availability`, { headers: { 'x-forwarded-for': ip } });
const listing = (ip: string) =>
  fetch(`${baseUrl}/api/public/site-announcements?country=BE&locale=en`, { headers: { 'x-forwarded-for': ip } });
const event = (ip: string, kind = 'impression') =>
  fetch(`${baseUrl}/api/public/site-announcements/${ANNOUNCEMENT_ID}/event`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ event: kind }),
  });

/** Sends `count` requests and returns their statuses (batched to keep sockets bounded). */
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

describe('public rate-limit budget isolation', () => {
  it('uses distinct, larger budgets for announcement listing and events', async () => {
    expect(SCHEDULING_RATE_LIMIT).toBe(60);
    expect(ANNOUNCEMENT_LIST_RATE_LIMIT).toBeGreaterThan(SCHEDULING_RATE_LIMIT);
    expect(ANNOUNCEMENT_EVENT_RATE_LIMIT).toBeGreaterThan(SCHEDULING_RATE_LIMIT);

    const ip = '203.0.113.10';
    const [cal, list, evt] = await Promise.all([calendar(ip), listing(ip), event(ip)]);
    expect(cal.headers.get('ratelimit-limit')).toBe(String(SCHEDULING_RATE_LIMIT));
    expect(list.headers.get('ratelimit-limit')).toBe(String(ANNOUNCEMENT_LIST_RATE_LIMIT));
    expect(evt.headers.get('ratelimit-limit')).toBe(String(ANNOUNCEMENT_EVENT_RATE_LIMIT));
    // Each counter started from a fresh budget for this IP.
    expect(cal.headers.get('ratelimit-remaining')).toBe(String(SCHEDULING_RATE_LIMIT - 1));
    expect(list.headers.get('ratelimit-remaining')).toBe(String(ANNOUNCEMENT_LIST_RATE_LIMIT - 1));
    expect(evt.headers.get('ratelimit-remaining')).toBe(String(ANNOUNCEMENT_EVENT_RATE_LIMIT - 1));
  });

  it('exhausting the announcement event budget leaves the booking calendar and listing usable', async () => {
    const ip = '203.0.113.20';
    const statuses = await spend(ANNOUNCEMENT_EVENT_RATE_LIMIT, () => event(ip));
    expect(statuses.every((status) => status === 204)).toBe(true);

    const blocked = await event(ip, 'click');
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toMatchObject({ code: 'RATE_LIMITED' });

    const cal = await calendar(ip);
    expect(cal.status).toBe(200);
    expect(cal.headers.get('ratelimit-remaining')).toBe(String(SCHEDULING_RATE_LIMIT - 1));
    expect((await listing(ip)).status).toBe(200);
    // The event budget is per IP: another visitor is unaffected.
    expect((await event('203.0.113.21')).status).toBe(204);
  });

  it('exhausting the announcement listing budget leaves the booking calendar and events usable', async () => {
    const ip = '203.0.113.30';
    const statuses = await spend(ANNOUNCEMENT_LIST_RATE_LIMIT, () => listing(ip));
    expect(statuses.every((status) => status === 200)).toBe(true);
    expect((await listing(ip)).status).toBe(429);

    expect((await calendar(ip)).status).toBe(200);
    expect((await event(ip)).status).toBe(204);
  });

  it('exhausting the booking calendar budget does not block announcements, and announcement traffic never spent it', async () => {
    const ip = '203.0.113.40';
    // Heavy marketing traffic first: a calendar budget shared with it would now be gone.
    await spend(SCHEDULING_RATE_LIMIT * 2, () => listing(ip));
    await spend(SCHEDULING_RATE_LIMIT * 2, () => event(ip));
    const statuses = await spend(SCHEDULING_RATE_LIMIT, () => calendar(ip));
    expect(statuses.every((status) => status === 200)).toBe(true);

    const blocked = await calendar(ip);
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toMatchObject({ code: 'RATE_LIMITED' });
    // The calendar endpoints still share one budget with each other (anti-abuse kept).
    expect((await fetch(`${baseUrl}/api/public/projects/${PROJECT_ID}/working-hours`, {
      headers: { 'x-forwarded-for': ip },
    })).status).toBe(429);

    expect((await listing(ip)).status).toBe(200);
    expect((await event(ip, 'dismissal')).status).toBe(204);
  });
});
