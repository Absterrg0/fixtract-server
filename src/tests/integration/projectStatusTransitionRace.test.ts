import mongoose, { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';

/**
 * Real-Mongo coverage for the hold/resume transition (`updateProjectStatus`)
 * racing a real archive. The archive runs through the real `archiveProject`
 * handler between the transition's status read and its save; both go through
 * the real account write fence (replica-set transaction) and the model save
 * hooks.
 */

const testUri = process.env.FIXERA_TEST_MONGODB_URI;
const hasDisposableMongo = Boolean(testUri && /test/i.test(testUri));
const describeDb = hasDisposableMongo ? describe : describe.skip;

vi.hoisted(() => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
});

vi.mock('../../handlers/Admin/favoritesAdmin', () => ({ invalidateFavoritesOverviewCache: vi.fn() }));

import Project from '../../models/project';
import User from '../../models/user';
import AccountDataGuard from '../../models/accountDataGuard';
import { archiveProject, updateProjectStatus } from '../../handlers/Project';

const response = () => {
  const res: any = { statusCode: 200, body: undefined };
  res.status = vi.fn((code: number) => { res.statusCode = code; return res; });
  res.json = vi.fn((body: any) => { res.body = body; return res; });
  return res;
};

const PRO = new Types.ObjectId();
const OTHER_PRO = new Types.ObjectId();
const HELD_AT = new Date('2026-10-20T08:00:00.000Z');
const TITLE = 'Published bathroom renovation project title';

const seedProject = async (fields: Record<string, unknown>) => {
  const _id = new Types.ObjectId();
  await Project.collection.insertOne({
    _id,
    professionalId: PRO,
    title: TITLE,
    description: 'Original description',
    category: 'Renovation',
    service: 'Painting',
    // Fields a published project carries (the save validates them).
    priceModel: 'fixed',
    media: { images: [] },
    distance: { address: 'Main street 1, Brussels', maxKmRange: 25 },
    ...fields,
  });
  return _id;
};

const setStatus = async (projectId: Types.ObjectId, status: string) => {
  const res = response();
  await updateProjectStatus(
    { user: { id: String(PRO) }, params: { id: String(projectId) }, body: { status } } as unknown as Request,
    res,
  );
  return res;
};

/** Run `between` after updateProjectStatus has read the project, before it saves. */
const commitBetweenStatusReadAndSave = (between: (projectId: string) => Promise<void>) => {
  const original = Project.findOne.bind(Project);
  return vi.spyOn(Project, 'findOne').mockImplementationOnce(((filter: any, ...rest: any[]) => {
    const read = original(filter, ...rest);
    return {
      then: (resolve: any, reject: any) => read
        .then(async (doc: any) => {
          await between(String(filter._id));
          return doc;
        })
        .then(resolve, reject),
    };
  }) as any);
};

const archiveConcurrently = () => commitBetweenStatusReadAndSave(async (projectId) => {
  const res = response();
  await archiveProject({ user: { id: String(PRO) }, params: { id: projectId } } as unknown as Request, res);
  expect(res.statusCode).toBe(200);
  expect(res.body.project.status).toBe('archived');
});

describeDb('project hold/resume transition vs archive (disposable Mongo)', () => {
  beforeAll(async () => {
    await mongoose.connect(testUri!, { dbName: 'fixera_project_status_race_test' });
    await Promise.all([Project, User, AccountDataGuard].map((model) => model.init()));
    await mongoose.connection.dropDatabase();
  });

  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    await Promise.all([
      Project.collection.deleteMany({}),
      User.collection.deleteMany({}),
      AccountDataGuard.collection.deleteMany({}),
    ]);
    await User.collection.insertMany([
      { _id: PRO, name: 'Pro', email: 'pro-status@example.test', role: 'professional', professionalStatus: 'approved' },
      { _id: OTHER_PRO, name: 'Other', email: 'other-status@example.test', role: 'professional', professionalStatus: 'approved' },
    ]);
  });

  it('returns 409 for a stale resume and keeps an archive committed after the read', async () => {
    const projectId = await seedProject({ status: 'on_hold', onHoldAt: HELD_AT });
    const spy = archiveConcurrently();

    const res = await setStatus(projectId, 'published');

    // The first read is the transition's own (owner-scoped) status read; the
    // archive handler's reads follow it.
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(spy.mock.calls[0][0]).toMatchObject({ professionalId: String(PRO) });
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ code: 'PROJECT_STATUS_CONFLICT', currentStatus: 'archived' });
    const stored: any = await Project.collection.findOne({ _id: projectId });
    expect(stored.status).toBe('archived');
    expect(stored.statusBeforeArchive).toBe('on_hold');
    expect(stored.archivedAt).toBeInstanceOf(Date);
    // Nothing from the stale transition was written behind the archive.
    expect(stored.onHoldAt).toEqual(HELD_AT);
  });

  it('returns 409 for a stale hold and keeps an archive committed after the read', async () => {
    const projectId = await seedProject({ status: 'published' });
    archiveConcurrently();

    const res = await setStatus(projectId, 'on_hold');

    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('PROJECT_STATUS_CONFLICT');
    const stored: any = await Project.collection.findOne({ _id: projectId });
    expect(stored.status).toBe('archived');
    expect(stored.statusBeforeArchive).toBe('published');
    expect(stored.onHoldAt).toBeUndefined();
  });

  it('returns 409 when the project changes owner after the read', async () => {
    const projectId = await seedProject({ status: 'on_hold', onHoldAt: HELD_AT });
    commitBetweenStatusReadAndSave(async () => {
      await Project.collection.updateOne({ _id: projectId }, { $set: { professionalId: OTHER_PRO } });
    });

    const res = await setStatus(projectId, 'published');

    expect(res.statusCode).toBe(409);
    const stored: any = await Project.collection.findOne({ _id: projectId });
    expect(stored.status).toBe('on_hold');
    expect(String(stored.professionalId)).toBe(String(OTHER_PRO));
  });

  it('still holds and resumes an uncontended project through the save hooks', async () => {
    const projectId = await seedProject({ status: 'published' });

    const held = await setStatus(projectId, 'on_hold');
    expect(held.statusCode).toBe(200);
    let stored: any = await Project.collection.findOne({ _id: projectId });
    expect(stored.status).toBe('on_hold');
    expect(stored.onHoldAt).toBeInstanceOf(Date);
    // The model pre-save hook ran (it stamps autoSaveTimestamp).
    expect(stored.autoSaveTimestamp).toBeInstanceOf(Date);

    const resumed = await setStatus(projectId, 'published');
    expect(resumed.statusCode).toBe(200);
    stored = await Project.collection.findOne({ _id: projectId });
    expect(stored.status).toBe('published');
    expect(stored.onHoldAt).toBeUndefined();
    // The response document carries no leftover save condition.
    expect((resumed.body.project as any).$where).toBeUndefined();
  });

  it('keeps the anonymization write fence: no transition for an account being removed', async () => {
    const projectId = await seedProject({ status: 'on_hold', onHoldAt: HELD_AT });
    await AccountDataGuard.collection.insertOne({ _id: PRO, state: 'anonymizing', startedAt: new Date(), writeFenceVersion: 1 });

    const res = await setStatus(projectId, 'published');

    expect(res.statusCode).toBe(500);
    const stored: any = await Project.collection.findOne({ _id: projectId });
    expect(stored.status).toBe('on_hold');
    expect(stored.onHoldAt).toEqual(HELD_AT);
  });
});
