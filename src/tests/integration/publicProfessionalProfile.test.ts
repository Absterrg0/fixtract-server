import mongoose, { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import User from '../../models/user';
import { getPublicProfessionalProfile } from '../../handlers/Public/professionalProfile';

const testUri = process.env.FIXERA_TEST_MONGODB_URI;
const hasDisposableMongo = Boolean(testUri && /test/i.test(testUri));
const describeDb = hasDisposableMongo ? describe : describe.skip;

vi.mock('../../config/db', () => ({ default: async () => undefined }));

const fakeRes = () => {
  const res: any = { statusCode: 200, body: undefined };
  res.status = vi.fn((code: number) => { res.statusCode = code; return res; });
  res.json = vi.fn((body: unknown) => { res.body = body; return res; });
  return res;
};

const call = async (id: string) => {
  const res = fakeRes();
  await getPublicProfessionalProfile({ params: { id } } as any, res);
  return res;
};

let seq = 0;
/** Unique email/phone per document: the users collection has unique indexes on both. */
const pro = (overrides: Record<string, unknown> = {}) => {
  seq += 1;
  return {
    _id: new Types.ObjectId(),
    role: 'professional',
    professionalStatus: 'approved',
    name: `Visible Pro ${seq}`,
    email: `profile-${seq}@leak.example.test`,
    phone: `+3247100${String(seq).padStart(4, '0')}`,
    businessInfo: { description: 'Tiling and plastering', city: 'Ghent', country: 'BE', website: 'https://pro.example.test' },
    profileImage: 'https://cdn.example.test/pro.png',
    serviceCategories: ['tiling'],
    createdAt: new Date('2025-06-01T08:00:00.000Z'),
    ...overrides,
  };
};

describeDb('public professional profile record (disposable MongoDB)', () => {
  beforeAll(async () => {
    // Own database per suite; other integration files share the same server.
    await mongoose.connect(testUri!, { dbName: `fixera_profile_it_${Date.now()}` });
  });
  afterAll(async () => {
    await mongoose.connection.db?.dropDatabase();
    await mongoose.disconnect();
  });
  beforeEach(async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await User.deleteMany({});
  });

  it('returns 400 for a malformed id without touching the database', async () => {
    const res = await call('not-an-id');
    expect(res.statusCode).toBe(400);
  });

  it('returns the public profile fields for an approved, live professional', async () => {
    const approved = pro();
    await User.collection.insertOne(approved as any);

    const res = await call(approved._id.toString());
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    const profile = res.body.data.professional;
    // The fake response does not serialise, so compare the id in its string form.
    expect(String(profile._id)).toBe(approved._id.toString());
    expect(profile.name).toBe(approved.name);
    expect(profile.businessInfo).toMatchObject({ city: 'Ghent', country: 'BE', description: 'Tiling and plastering' });
    expect(profile.profileImage).toBe('https://cdn.example.test/pro.png');
    expect(profile.serviceCategories).toEqual(['tiling']);
  });

  it('never returns contact details, internal status or review data', async () => {
    const approved = pro();
    await User.collection.insertOne(approved as any);

    const res = await call(approved._id.toString());
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain(approved.email);
    expect(serialized).not.toContain(approved.phone);
    for (const key of ['email', 'phone', 'role', 'professionalStatus', 'deletedAt', 'isAnonymized', 'ratingsSummary', 'reviews', 'projects']) {
      expect(res.body.data.professional).not.toHaveProperty(key);
    }
  });

  it('returns 404 for every professional who is not publicly viewable', async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['pending', { professionalStatus: 'pending' }],
      ['suspended', { professionalStatus: 'suspended' }],
      ['soft-deleted', { deletedAt: new Date('2026-01-02T00:00:00.000Z') }],
      ['anonymized', { isAnonymized: true }],
      ['customer role', { role: 'customer' }],
    ];
    for (const [label, overrides] of cases) {
      const doc = pro(overrides);
      await User.collection.insertOne(doc as any);
      const res = await call(doc._id.toString());
      expect(res.statusCode, label).toBe(404);
    }
  });

  it('returns 404 for an id that does not exist', async () => {
    const res = await call(new Types.ObjectId().toString());
    expect(res.statusCode).toBe(404);
  });
});
