import express from 'express';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Route-level proof that the sitemap entity endpoint has its own budget. The handler is
// stubbed so only the real router and its real express-rate-limit instances decide 2xx vs 429.
vi.mock('../../handlers/Public/sitemapEntities', () => ({
  listPublicSitemapEntities: vi.fn((_req: any, res: any) =>
    res.status(200).json({ success: true, data: { type: 'project', items: [], pagination: {} } })),
}));
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

import publicRouter, { SCHEDULING_RATE_LIMIT, SITEMAP_ENTITY_RATE_LIMIT } from '../../routes/Public';

const app = express();
app.set('trust proxy', 1);
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

const sitemap = (ip: string) =>
  fetch(`${baseUrl}/api/public/sitemap/entities?type=project`, { headers: { 'x-forwarded-for': ip } });
const calendar = (ip: string) =>
  fetch(`${baseUrl}/api/public/projects/64b7f0c2a1b2c3d4e5f60718/availability`, { headers: { 'x-forwarded-for': ip } });

describe('public sitemap entity route budget', () => {
  it('has its own budget, separate from the booking calendar budget', () => {
    expect(SITEMAP_ENTITY_RATE_LIMIT).toBe(120);
    expect(SITEMAP_ENTITY_RATE_LIMIT).not.toBe(SCHEDULING_RATE_LIMIT);
  });

  it('serves requests inside the budget and returns 429 once it is spent', async () => {
    const ip = '203.0.113.77';
    const statuses: number[] = [];
    for (let i = 0; i < SITEMAP_ENTITY_RATE_LIMIT + 1; i += 1) {
      const response = await sitemap(ip);
      await response.arrayBuffer();
      statuses.push(response.status);
    }
    expect(statuses.slice(0, SITEMAP_ENTITY_RATE_LIMIT).every((status) => status === 200)).toBe(true);
    expect(statuses[SITEMAP_ENTITY_RATE_LIMIT]).toBe(429);

    // Spending the sitemap budget must not block the booking calendar for the same IP.
    const other = await calendar(ip);
    await other.arrayBuffer();
    expect(other.status).toBe(200);
  });
});
