import express from 'express';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Route-level proof that the public professional profile read has its own, more generous
// budget. Handlers are stubbed so only the real router and its express-rate-limit instances
// decide 2xx vs 429.
vi.mock('../../handlers/Public/professionalProfile', () => ({
  getPublicProfessionalProfile: vi.fn((_req: any, res: any) =>
    res.status(200).json({ success: true, data: { professional: { _id: 'p' } } })),
}));
vi.mock('../../handlers/Booking/reviews', () => ({
  getProfessionalReviews: vi.fn((_req: any, res: any) =>
    res.status(200).json({ success: true, data: {} })),
  getProjectReviews: vi.fn((_req: any, res: any) =>
    res.status(200).json({ success: true, data: {} })),
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

import publicRouter, {
  PUBLIC_ENTITY_READ_RATE_LIMIT,
  SCHEDULING_RATE_LIMIT,
  SITEMAP_ENTITY_RATE_LIMIT,
} from '../../routes/Public';

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

const PROFESSIONAL_ID = '64b7f0c2a1b2c3d4e5f60730';
const profile = (ip: string) =>
  fetch(`${baseUrl}/api/public/professionals/${PROFESSIONAL_ID}`, { headers: { 'x-forwarded-for': ip } });
const reviews = (ip: string) =>
  fetch(`${baseUrl}/api/public/professionals/${PROFESSIONAL_ID}/reviews`, { headers: { 'x-forwarded-for': ip } });
const calendar = (ip: string) =>
  fetch(`${baseUrl}/api/public/projects/64b7f0c2a1b2c3d4e5f60718/availability`, { headers: { 'x-forwarded-for': ip } });

describe('public entity read budget (professional profile record)', () => {
  it('is more generous than the scheduling budget and separate from the sitemap budget', () => {
    expect(PUBLIC_ENTITY_READ_RATE_LIMIT).toBeGreaterThan(SCHEDULING_RATE_LIMIT);
    expect(PUBLIC_ENTITY_READ_RATE_LIMIT).not.toBe(SITEMAP_ENTITY_RATE_LIMIT);
    // Still capped: a finite budget, never an exemption.
    expect(Number.isFinite(PUBLIC_ENTITY_READ_RATE_LIMIT)).toBe(true);
  });

  it('serves inside the budget, returns 429 once spent, and leaves the review and calendar budgets alone', async () => {
    const ip = '203.0.113.91';
    const statuses: number[] = [];
    for (let i = 0; i < PUBLIC_ENTITY_READ_RATE_LIMIT + 1; i += 1) {
      const response = await profile(ip);
      await response.arrayBuffer();
      statuses.push(response.status);
    }
    expect(statuses.slice(0, PUBLIC_ENTITY_READ_RATE_LIMIT).every((status) => status === 200)).toBe(true);
    expect(statuses[PUBLIC_ENTITY_READ_RATE_LIMIT]).toBe(429);

    // Spending the profile budget must not block the review or booking calendar budgets.
    const reviewResponse = await reviews(ip);
    await reviewResponse.arrayBuffer();
    expect(reviewResponse.status).toBe(200);
    const calendarResponse = await calendar(ip);
    await calendarResponse.arrayBuffer();
    expect(calendarResponse.status).toBe(200);
  }, 60_000);
});
