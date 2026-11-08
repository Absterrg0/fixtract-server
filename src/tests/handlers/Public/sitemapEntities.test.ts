import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isPubliclyViewableProfessional,
  publicProfessionalFilter,
  publicProjectOwnerFilter,
} from '../../../utils/publicVisibility';

const { userFind, userCountDocuments, projectAggregate, connectDB } = vi.hoisted(() => ({
  userFind: vi.fn(),
  userCountDocuments: vi.fn(),
  projectAggregate: vi.fn(),
  connectDB: vi.fn(async () => undefined),
}));

vi.mock('../../../config/db', () => ({ default: connectDB }));
vi.mock('../../../models/user', () => ({
  default: { find: userFind, countDocuments: userCountDocuments, collection: { name: 'users' } },
}));
vi.mock('../../../models/project', () => ({
  default: { aggregate: projectAggregate },
}));

import { listPublicSitemapEntities, SITEMAP_ENTITY_MAX_PAGE } from '../../../handlers/Public/sitemapEntities';

const fakeRes = () => {
  const res: any = { statusCode: 200, body: undefined, headers: {} as Record<string, string> };
  res.status = vi.fn((code: number) => { res.statusCode = code; return res; });
  res.json = vi.fn((body: unknown) => { res.body = body; return res; });
  res.set = vi.fn((name: string, value: string) => { res.headers[name] = value; return res; });
  return res;
};

/** Chainable stand-in for `User.find(...).select().sort().skip().limit().lean()`. */
const queryChain = (docs: unknown[]) => {
  const chain: any = {
    select: vi.fn(() => chain),
    sort: vi.fn(() => chain),
    skip: vi.fn(() => chain),
    limit: vi.fn(() => chain),
    lean: vi.fn(async () => docs),
  };
  return chain;
};

describe('public sitemap entities handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('rejects a missing or unknown type before touching the database', async () => {
    const res = fakeRes();
    await listPublicSitemapEntities({ query: {} } as any, res);
    expect(res.statusCode).toBe(400);
    expect(connectDB).not.toHaveBeenCalled();
    expect(userFind).not.toHaveBeenCalled();
    expect(projectAggregate).not.toHaveBeenCalled();
  });

  it('queries professionals with the public profile rule and pages by skip/limit', async () => {
    const chain = queryChain([]);
    userFind.mockReturnValue(chain);
    userCountDocuments.mockResolvedValue(0);

    const res = await (async () => {
      const r = fakeRes();
      await listPublicSitemapEntities({ query: { type: 'professional', page: '3', limit: '20' } } as any, r);
      return r;
    })();

    expect(res.statusCode).toBe(200);
    expect(userFind).toHaveBeenCalledWith({
      role: 'professional',
      professionalStatus: 'approved',
      deletedAt: null,
      isAnonymized: { $ne: true },
    });
    expect(userCountDocuments).toHaveBeenCalledWith(publicProfessionalFilter());
    expect(chain.sort).toHaveBeenCalledWith({ _id: 1 });
    expect(chain.skip).toHaveBeenCalledWith(40);
    expect(chain.limit).toHaveBeenCalledWith(20);
    expect(chain.select).toHaveBeenCalledWith('_id updatedAt createdAt');
  });

  it('returns only id and updatedAt, never personal fields, and reports pagination', async () => {
    const updatedAt = new Date('2026-03-01T00:00:00.000Z');
    userFind.mockReturnValue(queryChain([
      { _id: '64b7f0c2a1b2c3d4e5f60718', updatedAt, name: 'Jane', email: 'jane@example.test', phone: '+32000', businessInfo: { description: 'x' } },
      { _id: '64b7f0c2a1b2c3d4e5f60719', createdAt: updatedAt, name: 'Mark' },
    ]));
    userCountDocuments.mockResolvedValue(5);

    const res = fakeRes();
    await listPublicSitemapEntities({ query: { type: 'professional', page: '1', limit: '2' } } as any, res);

    expect(res.body).toEqual({
      success: true,
      data: {
        type: 'professional',
        items: [
          { id: '64b7f0c2a1b2c3d4e5f60718', updatedAt },
          { id: '64b7f0c2a1b2c3d4e5f60719', updatedAt },
        ],
        pagination: { page: 1, limit: 2, total: 5, totalPages: 3, hasMore: true },
      },
    });
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toMatch(/Jane|Mark|example\.test|\+32000|businessInfo/);
    expect(res.headers['Cache-Control']).toMatch(/public/);
  });

  it('caps oversized limits and falls back for invalid paging input', async () => {
    userFind.mockReturnValue(queryChain([]));
    userCountDocuments.mockResolvedValue(0);

    const capped = fakeRes();
    await listPublicSitemapEntities({ query: { type: 'professional', limit: '99999' } } as any, capped);
    expect(capped.body.data.pagination.limit).toBe(1000);

    const fallback = fakeRes();
    await listPublicSitemapEntities({ query: { type: 'professional', page: '0', limit: 'nope' } } as any, fallback);
    expect(fallback.body.data.pagination).toMatchObject({ page: 1, limit: 500 });
  });

  it('builds the project pipeline from published status and the active-owner rule', async () => {
    projectAggregate.mockResolvedValue([{ items: [], total: [] }]);

    const res = fakeRes();
    await listPublicSitemapEntities({ query: { type: 'project', page: '2', limit: '50' } } as any, res);

    expect(res.statusCode).toBe(200);
    const pipeline = projectAggregate.mock.calls[0][0] as any[];
    expect(pipeline[0]).toEqual({ $match: { status: 'published' } });
    const lookup = pipeline.find((stage) => '$lookup' in stage).$lookup;
    expect(lookup.from).toBe('users');
    expect(lookup.pipeline[0].$match).toMatchObject(publicProjectOwnerFilter());
    expect(lookup.let.ownerId).toEqual({
      $convert: { input: '$professionalId', to: 'objectId', onError: null, onNull: null },
    });
    expect(pipeline.find((stage) => '$facet' in stage).$facet.items).toEqual([
      { $skip: 50 },
      { $limit: 50 },
      { $project: { _id: 1, updatedAt: 1, createdAt: 1 } },
    ]);
    expect(res.body.data).toEqual({
      type: 'project',
      items: [],
      pagination: { page: 2, limit: 50, total: 0, totalPages: 0, hasMore: false },
    });
  });

  it('returns only id and updatedAt for projects', async () => {
    const updatedAt = new Date('2026-04-02T00:00:00.000Z');
    projectAggregate.mockResolvedValue([{
      items: [{ _id: '64b7f0c2a1b2c3d4e5f60720', updatedAt, title: 'Secret title', professionalId: 'x' }],
      total: [{ count: 1 }],
    }]);

    const res = fakeRes();
    await listPublicSitemapEntities({ query: { type: 'project' } } as any, res);

    expect(res.body.data.items).toEqual([{ id: '64b7f0c2a1b2c3d4e5f60720', updatedAt }]);
    expect(JSON.stringify(res.body)).not.toContain('Secret title');
  });

  it('answers 500 without leaking detail when the database read fails', async () => {
    projectAggregate.mockRejectedValue(new Error('mongo down: secret connection string'));

    const res = fakeRes();
    await listPublicSitemapEntities({ query: { type: 'project' } } as any, res);

    expect(res.statusCode).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('secret connection string');
  });
});

describe('public visibility helpers', () => {
  it('treats only approved, active professionals as publicly viewable', () => {
    const base = { role: 'professional', professionalStatus: 'approved' };
    expect(isPubliclyViewableProfessional(base)).toBe(true);
    expect(isPubliclyViewableProfessional({ ...base, professionalStatus: 'pending' })).toBe(false);
    expect(isPubliclyViewableProfessional({ ...base, deletedAt: new Date() })).toBe(false);
    expect(isPubliclyViewableProfessional({ ...base, isAnonymized: true })).toBe(false);
    expect(isPubliclyViewableProfessional({ ...base, role: 'customer' })).toBe(false);
    expect(isPubliclyViewableProfessional(null)).toBe(false);
  });

  it('never reports hasMore beyond the last servable page', async () => {
    userCountDocuments.mockResolvedValue(SITEMAP_ENTITY_MAX_PAGE + 2);
    userFind.mockReturnValue(queryChain([{ _id: 'a' }]));

    const last = fakeRes();
    await listPublicSitemapEntities(
      { query: { type: 'professional', page: String(SITEMAP_ENTITY_MAX_PAGE), limit: '1' } } as any,
      last,
    );
    expect(last.body.data.items).toHaveLength(1);
    expect(last.body.data.pagination.hasMore).toBe(false);

    const before = fakeRes();
    await listPublicSitemapEntities(
      { query: { type: 'professional', page: String(SITEMAP_ENTITY_MAX_PAGE - 1), limit: '1' } } as any,
      before,
    );
    expect(before.body.data.pagination.hasMore).toBe(true);

    const beyond = fakeRes();
    await listPublicSitemapEntities(
      { query: { type: 'professional', page: String(SITEMAP_ENTITY_MAX_PAGE + 1), limit: '1' } } as any,
      beyond,
    );
    expect(beyond.statusCode).toBe(200);
    expect(beyond.body.data.items).toEqual([]);
    expect(beyond.body.data.pagination.hasMore).toBe(false);
  });
});
