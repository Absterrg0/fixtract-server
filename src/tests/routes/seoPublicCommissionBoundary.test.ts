import express from 'express';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The SEO endpoints (`/api/public/sitemap/entities` and `/api/public/professionals/:id`) must sit
// behind main's final JSON boundary, `commissionVisibility`, exactly as src/index.ts mounts it:
// `/api` first, then `/api/public`. The models are stubbed with data that carries professional
// amounts and commission keys. A handler or projection regression would pass those keys through,
// so an anonymous response that still contains them means the boundary did not run.

const { userFind, userCountDocuments, userFindOne, projectAggregate, connectDB } = vi.hoisted(() => ({
  userFind: vi.fn(),
  userCountDocuments: vi.fn(),
  userFindOne: vi.fn(),
  projectAggregate: vi.fn(),
  connectDB: vi.fn(async () => undefined),
}));

vi.mock('../../config/db', () => ({ default: connectDB }));
vi.mock('../../models/user', () => ({
  default: {
    find: userFind,
    countDocuments: userCountDocuments,
    findOne: userFindOne,
    collection: { name: 'users' },
  },
}));
vi.mock('../../models/project', () => ({
  default: { aggregate: projectAggregate },
}));

import { commissionVisibility } from '../../middlewares/commissionVisibility';
import publicRouter from '../../routes/Public';
import { PUBLIC_PROFESSIONAL_PROFILE_FIELDS } from '../../handlers/Public/professionalProfile';

/** Keys a customer or anonymous caller must never receive: commission, rate and professional-side amounts. */
const FORBIDDEN_KEYS = new Set([
  'platformCommission',
  'platformCommissionAmount',
  'commissionPercent',
  'commissionRate',
  'commissionReduction',
  'referredProfessionalCommissionReduction',
  'professionalNetAmount',
  'professionalAmount',
  'professionalPayout',
  'amount',
  'price',
  'priceRange',
  'additionalCost',
  'bookedPrice',
]);

/** Every key at any depth of a JSON body, so a nested leak cannot hide. */
const collectKeys = (value: unknown, found: string[] = []): string[] => {
  if (Array.isArray(value)) value.forEach((item) => collectKeys(item, found));
  else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      found.push(key);
      collectKeys(child, found);
    }
  }
  return found;
};

/** A professional record as a regression would hand it back: the public fields plus leaked internals. */
const leakingProfessional = {
  _id: '66a000000000000000000001',
  name: 'Public Pro',
  username: 'public-pro',
  hourlyRate: 45,
  createdAt: new Date('2025-06-01T08:00:00.000Z'),
  platformCommission: 13,
  commissionPercent: 13,
  commissionReduction: 2,
  referredProfessionalCommissionReduction: 1,
  professionalNetAmount: 980.5,
  professionalPayout: 980.5,
};

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.set('trust proxy', 1);
  // Same order as src/index.ts: the boundary on /api, then the public router on /api/public.
  app.use('/api', commissionVisibility);
  app.use('/api/public', publicRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))));

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  connectDB.mockResolvedValue(undefined);
  // Profile read: `findOne(...).select(...).lean()`. The stub ignores the projection on purpose.
  userFindOne.mockImplementation(() => ({
    select: () => ({ lean: async () => ({ ...leakingProfessional }) }),
  }));
  // Sitemap, professionals: `find(...).select().sort().skip().limit().lean()`.
  const chain: any = {
    select: vi.fn(() => chain),
    sort: vi.fn(() => chain),
    skip: vi.fn(() => chain),
    limit: vi.fn(() => chain),
    lean: vi.fn(async () => [{ _id: '66a000000000000000000001', updatedAt: new Date('2026-01-02T00:00:00.000Z'), ...leakingProfessional }]),
  };
  userFind.mockImplementation(() => chain);
  userCountDocuments.mockResolvedValue(1);
  // Sitemap, projects: one `$facet` document. The projection in the handler keeps only `_id` and dates.
  projectAggregate.mockResolvedValue([{
    items: [{ _id: '66b000000000000000000001', updatedAt: new Date('2026-01-03T00:00:00.000Z'), professionalNetAmount: 500, platformCommission: 13, amount: 600 }],
    total: [{ count: 1 }],
  }]);
});

describe('SEO public endpoints behind commissionVisibility', () => {
  it('the profile projection requests no commission or professional amount field', () => {
    for (const forbidden of ['commission', 'professionalNetAmount', 'professionalPayout', 'platformCommission']) {
      expect(PUBLIC_PROFESSIONAL_PROFILE_FIELDS).not.toContain(forbidden);
    }
  });

  it('withholds commission and professional amounts from an anonymous professional profile read', async () => {
    const response = await fetch(`${base}/api/public/professionals/66a000000000000000000001`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.data.professional.name).toBe('Public Pro');

    const keys = collectKeys(body);
    expect(keys.filter((key) => FORBIDDEN_KEYS.has(key) || /commission/i.test(key))).toEqual([]);
    expect(JSON.stringify(body)).not.toMatch(/980\.5|platformCommission|commissionPercent/);
  });

  it('returns only id and updatedAt per professional on the sitemap, with no leaked fields', async () => {
    const response = await fetch(`${base}/api/public/sitemap/entities?type=professional&page=1&limit=10`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.items).toEqual([{ id: '66a000000000000000000001', updatedAt: '2026-01-02T00:00:00.000Z' }]);

    const keys = collectKeys(body);
    expect(keys.filter((key) => FORBIDDEN_KEYS.has(key) || /commission/i.test(key))).toEqual([]);
    expect(JSON.stringify(body)).not.toMatch(/980\.5|platformCommission|commissionPercent/);
  });

  it('returns only id and updatedAt per project on the sitemap, with no price or commission fields', async () => {
    const response = await fetch(`${base}/api/public/sitemap/entities?type=project&page=1&limit=10`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.items).toEqual([{ id: '66b000000000000000000001', updatedAt: '2026-01-03T00:00:00.000Z' }]);

    const keys = collectKeys(body);
    expect(keys.filter((key) => FORBIDDEN_KEYS.has(key) || /commission/i.test(key))).toEqual([]);
    expect(JSON.stringify(body)).not.toMatch(/500|600|platformCommission/);
  });
});
