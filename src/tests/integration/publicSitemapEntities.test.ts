import mongoose, { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Project from '../../models/project';
import User from '../../models/user';
import { listPublicSitemapEntities } from '../../handlers/Public/sitemapEntities';

const testUri = process.env.FIXERA_TEST_MONGODB_URI;
const hasDisposableMongo = Boolean(testUri && /test/i.test(testUri));
const describeDb = hasDisposableMongo ? describe : describe.skip;

vi.mock('../../config/db', () => ({ default: async () => undefined }));

const fakeRes = () => {
  const res: any = { statusCode: 200, body: undefined, headers: {} as Record<string, string> };
  res.status = vi.fn((code: number) => { res.statusCode = code; return res; });
  res.json = vi.fn((body: unknown) => { res.body = body; return res; });
  res.set = vi.fn((name: string, value: string) => { res.headers[name] = value; return res; });
  return res;
};

const call = async (query: Record<string, unknown>) => {
  const res = fakeRes();
  await listPublicSitemapEntities({ query } as any, res);
  return res;
};

const RECENT = new Date('2026-01-10T10:00:00.000Z');
const OLDER = new Date('2025-06-01T08:00:00.000Z');

let proSeq = 0;
/** Unique email/phone per document: the users collection has unique indexes on both. */
const pro = (overrides: Record<string, unknown> = {}) => {
  proSeq += 1;
  return {
    _id: new Types.ObjectId(),
    role: 'professional',
    professionalStatus: 'approved',
    name: `Secret Name ${proSeq}`,
    email: `pro-${proSeq}@leak.example.test`,
    phone: `+3247000${String(proSeq).padStart(4, '0')}`,
    createdAt: OLDER,
    updatedAt: RECENT,
    ...overrides,
  };
};

const project = (professionalId: Types.ObjectId, overrides: Record<string, unknown> = {}) => ({
  _id: new Types.ObjectId(),
  title: 'Kitchen renovation',
  status: 'published',
  professionalId,
  createdAt: OLDER,
  updatedAt: RECENT,
  ...overrides,
});

describeDb('public sitemap entities (disposable MongoDB)', () => {
  beforeAll(async () => {
    // Own database per suite; other integration files share the same server.
    await mongoose.connect(testUri!, { dbName: `fixera_sitemap_it_${Date.now()}` });
  });
  afterAll(async () => {
    await mongoose.connection.db?.dropDatabase();
    await mongoose.disconnect();
  });
  beforeEach(async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await User.deleteMany({});
    await Project.deleteMany({});
  });

  it('rejects an unknown type with 400', async () => {
    const res = await call({ type: 'customer' });
    expect(res.statusCode).toBe(400);
  });

  it('lists only approved, non-deleted, non-anonymized professionals and returns id + updatedAt only', async () => {
    const approved = pro();
    const pending = pro({ professionalStatus: 'pending' });
    const suspended = pro({ professionalStatus: 'suspended' });
    const rejected = pro({ professionalStatus: 'rejected' });
    const deleted = pro({ deletedAt: new Date('2026-02-01') });
    const anonymized = pro({ isAnonymized: true });
    const customer = pro({ role: 'customer' });
    await User.collection.insertMany([approved, pending, suspended, rejected, deleted, anonymized, customer] as any[]);

    const res = await call({ type: 'professional' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['Cache-Control']).toMatch(/public/);
    expect(res.body.data.type).toBe('professional');
    expect(res.body.data.items).toEqual([
      { id: String(approved._id), updatedAt: RECENT },
    ]);
    expect(res.body.data.pagination).toEqual({ page: 1, limit: 500, total: 1, totalPages: 1, hasMore: false });

    // No personal data may leave the endpoint.
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain('Secret Name');
    expect(serialized).not.toContain('@leak.example.test');
    expect(serialized).not.toContain('+3247000');
    for (const item of res.body.data.items) {
      expect(Object.keys(item).sort()).toEqual(['id', 'updatedAt']);
    }
  });

  it('lists published projects only when the owner is an active professional', async () => {
    const activeOwner = pro({ professionalStatus: 'pending' }); // detail endpoint does not gate on approval
    const deletedOwner = pro({ deletedAt: new Date('2026-02-01') });
    const anonymizedOwner = pro({ isAnonymized: true });
    const customerOwner = pro({ role: 'customer' });
    await User.collection.insertMany([activeOwner, deletedOwner, anonymizedOwner, customerOwner] as any[]);

    const live = project(activeOwner._id);
    const draft = project(activeOwner._id, { status: 'draft' });
    const archived = project(activeOwner._id, { status: 'archived' });
    const orphanedByDeletion = project(deletedOwner._id);
    const orphanedByAnonymization = project(anonymizedOwner._id);
    const notAProfessional = project(customerOwner._id);
    await Project.collection.insertMany(
      [live, draft, archived, orphanedByDeletion, orphanedByAnonymization, notAProfessional] as any[],
    );

    const res = await call({ type: 'project' });

    expect(res.statusCode).toBe(200);
    expect(res.body.data.items).toEqual([{ id: String(live._id), updatedAt: RECENT }]);
    expect(res.body.data.pagination.total).toBe(1);
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain('Kitchen renovation');
    expect(serialized).not.toContain('@leak.example.test');
  });

  it('pages through entities with a stable _id order, no duplicates and honest hasMore flags', async () => {
    const owners = Array.from({ length: 5 }, () => pro());
    await User.collection.insertMany(owners as any[]);
    const expectedIds = owners.map((owner) => String(owner._id)).sort();

    const seen: string[] = [];
    const flags: boolean[] = [];
    for (let page = 1; page <= 3; page += 1) {
      const res = await call({ type: 'professional', page: String(page), limit: '2' });
      expect(res.statusCode).toBe(200);
      expect(res.body.data.pagination).toMatchObject({ page, limit: 2, total: 5, totalPages: 3 });
      flags.push(res.body.data.pagination.hasMore);
      seen.push(...res.body.data.items.map((item: { id: string }) => item.id));
    }

    expect(flags).toEqual([true, true, false]);
    expect(seen).toEqual(expectedIds); // ascending _id, each entity exactly once
    expect(new Set(seen).size).toBe(5);

    const beyond = await call({ type: 'professional', page: '4', limit: '2' });
    expect(beyond.body.data.items).toEqual([]);
    expect(beyond.body.data.pagination.hasMore).toBe(false);
  });

  it('caps the page size and clamps invalid paging input', async () => {
    const capped = await call({ type: 'project', limit: '5000' });
    expect(capped.body.data.pagination.limit).toBe(1000);

    const fallback = await call({ type: 'project', page: 'abc', limit: '-3' });
    expect(fallback.body.data.pagination).toMatchObject({ page: 1, limit: 500 });

    // Exponent and fractional forms are not pages; they fall back instead of erroring.
    const exponent = await call({ type: 'professional', page: '1e300' });
    expect(exponent.statusCode).toBe(200);
    expect(exponent.body.data.pagination.page).toBe(1);
  });

  it('answers a page beyond the supported range with an empty page, not a 500', async () => {
    const owner = pro();
    await User.collection.insertOne(owner as any);
    await Project.collection.insertOne(project(owner._id) as any);

    for (const type of ['project', 'professional']) {
      const res = await call({ type, page: '999999999' });
      expect(res.statusCode).toBe(200);
      expect(res.body.data.items).toEqual([]);
      expect(res.body.data.pagination).toMatchObject({ page: 999999999, total: 1, hasMore: false });
    }
  });

  it('includes a published project whose legacy owner id is stored as a string', async () => {
    const owner = pro();
    await User.collection.insertOne(owner as any);
    const legacy = project(owner._id, { professionalId: String(owner._id) });
    const garbage = project(owner._id, { professionalId: 'not-an-object-id' });
    await Project.collection.insertMany([legacy, garbage] as any[]);

    const res = await call({ type: 'project' });

    expect(res.statusCode).toBe(200);
    expect(res.body.data.items).toEqual([{ id: String(legacy._id), updatedAt: RECENT }]);
  });
});
