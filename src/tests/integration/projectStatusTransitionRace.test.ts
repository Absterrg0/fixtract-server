import mongoose, { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';

/**
 * Real-Mongo coverage for the project lifecycle transitions racing each other:
 * hold/resume (`updateProjectStatus`), archive, restore and both submit
 * entrypoints. The competing write runs through the real handlers (or a direct
 * committed write) between a transition's status read and its save; both go
 * through the real account write fence (replica-set transaction, with the
 * driver's transient-error retries) and the model save hooks.
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
import {
  archiveProject,
  restoreProject,
  submitProject,
  updateProjectStatus,
} from '../../handlers/Project';
import { submitProject as submitDraftViaUserRoute } from '../../handlers/Professional/projectManagement';

const response = () => {
  const res: any = { statusCode: 200, body: undefined };
  res.status = vi.fn((code: number) => { res.statusCode = code; return res; });
  res.json = vi.fn((body: any) => { res.body = body; return res; });
  return res;
};

const PRO = new Types.ObjectId();
const OTHER_PRO = new Types.ObjectId();
const ADMIN = new Types.ObjectId();
const FINANCE_ADMIN = new Types.ObjectId();
const UNAPPROVED_PRO = new Types.ObjectId();
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


type Handler = (req: Request, res: any) => Promise<unknown>;

/** Call a lifecycle handler as `actor` for `projectId` (both id shapes the routes use). */
const callAs = async (handler: Handler, projectId: Types.ObjectId | string, actor: Types.ObjectId = PRO) => {
  const res = response();
  await handler(
    { user: { id: String(actor), _id: actor }, params: { id: String(projectId) }, body: {} } as unknown as Request,
    res,
  );
  return res;
};

/** Fields that pass every submission quality check. */
const SUBMITTABLE = {
  description: 'A complete bathroom renovation including demolition, plumbing, tiling, fixtures and final cleaning of the room.',
  subprojects: [{
    _id: new Types.ObjectId(),
    name: 'Standard package',
    description: 'Standard bathroom package',
    pricing: { type: 'fixed', amount: 4500 },
  }],
  resources: [String(PRO)],
};

/** An approved published project being resubmitted; `snapshot` overrides the approved snapshot. */
const seedResubmission = async (snapshot: Record<string, unknown> = {}) => {
  const projectId = await seedProject({ status: 'published', ...SUBMITTABLE, isResubmission: true });
  // Built the way production builds it: the hydrated document's toObject().
  const approved = (await Project.findById(projectId))!.toObject();
  await Project.collection.updateOne(
    { _id: projectId },
    { $set: { previousSnapshot: { ...approved, ...snapshot } } },
  );
  return projectId;
};

const archiveAs = (actor: Types.ObjectId = PRO) => async (projectId: string) => {
  const res = await callAs(archiveProject, projectId, actor);
  expect(res.statusCode).toBe(200);
  expect(res.body.project.status).toBe('archived');
};

/** A real owner archive committed between a transition's read and its save. */
const archiveAfterRead = () => commitBetweenStatusReadAndSave(archiveAs());

const WINNING_ARCHIVED_AT = new Date('2026-10-01T09:00:00.000Z');

describeDb('project lifecycle transitions vs concurrent writes (disposable Mongo)', () => {
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
      { _id: ADMIN, name: 'Admin', email: 'admin-status@example.test', role: 'admin' },
      { _id: FINANCE_ADMIN, name: 'Finance', email: 'finance-status@example.test', role: 'admin', adminRole: 'finance' },
      { _id: UNAPPROVED_PRO, name: 'Pending', email: 'pending-status@example.test', role: 'professional', professionalStatus: 'pending' },
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
    expect(res.body.code).toBe('PROJECT_STATUS_CONFLICT');
    // The former owner must not learn the new owner's status from the 409.
    expect(res.body.currentStatus).toBeUndefined();
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

  describe('archive', () => {
    it('returns 409 when a hold commits after its read, without archiving over it', async () => {
      const projectId = await seedProject({ status: 'published' });
      commitBetweenStatusReadAndSave(async () => {
        expect((await setStatus(projectId, 'on_hold')).statusCode).toBe(200);
      });

      const res = await callAs(archiveProject, projectId);

      expect(res.statusCode).toBe(409);
      expect(res.body).toMatchObject({ code: 'PROJECT_STATUS_CONFLICT', currentStatus: 'on_hold' });
      const stored: any = await Project.collection.findOne({ _id: projectId });
      expect(stored.status).toBe('on_hold');
      expect(stored.onHoldAt).toBeInstanceOf(Date);
      // No archive, and no stale pre-archive status, behind the hold.
      expect(stored.archivedAt).toBeUndefined();
      expect(stored.statusBeforeArchive).toBeUndefined();
    });

    it('returns 409 when a submission commits after its read (admin scope)', async () => {
      const projectId = await seedProject({ status: 'draft', ...SUBMITTABLE });
      commitBetweenStatusReadAndSave(async (id) => {
        expect((await callAs(submitProject, id)).statusCode).toBe(200);
      });

      const res = await callAs(archiveProject, projectId, ADMIN);

      expect(res.statusCode).toBe(409);
      expect(res.body).toMatchObject({ code: 'PROJECT_STATUS_CONFLICT', currentStatus: 'pending' });
      const stored: any = await Project.collection.findOne({ _id: projectId });
      expect(stored.status).toBe('pending');
      expect(stored.submittedAt).toBeInstanceOf(Date);
      expect(stored.archivedAt).toBeUndefined();
      expect(stored.statusBeforeArchive).toBeUndefined();
    });

    it('returns 409 when the project changes owner after its read', async () => {
      const projectId = await seedProject({ status: 'published' });
      commitBetweenStatusReadAndSave(async () => {
        await Project.collection.updateOne({ _id: projectId }, { $set: { professionalId: OTHER_PRO } });
      });

      const res = await callAs(archiveProject, projectId);

      expect(res.statusCode).toBe(409);
      expect(res.body.code).toBe('PROJECT_STATUS_CONFLICT');
      // The caller no longer owns it, so its status is not disclosed.
      expect(res.body.currentStatus).toBeUndefined();
      const stored: any = await Project.collection.findOne({ _id: projectId });
      expect(stored.status).toBe('published');
      expect(String(stored.professionalId)).toBe(String(OTHER_PRO));
      expect(stored.archivedAt).toBeUndefined();
    });

    it('stays idempotent when a concurrent archive wins, returning the stored archive unchanged', async () => {
      const projectId = await seedProject({ status: 'published' });
      commitBetweenStatusReadAndSave(async () => {
        await Project.collection.updateOne(
          { _id: projectId },
          { $set: { status: 'archived', statusBeforeArchive: 'published', archivedAt: WINNING_ARCHIVED_AT } },
        );
      });

      const res = await callAs(archiveProject, projectId);

      expect(res.statusCode).toBe(200);
      expect(res.body.project.status).toBe('archived');
      expect(res.body.project.archivedAt).toEqual(WINNING_ARCHIVED_AT);
      const stored: any = await Project.collection.findOne({ _id: projectId });
      expect(stored.archivedAt).toEqual(WINNING_ARCHIVED_AT);
      expect(stored.statusBeforeArchive).toBe('published');
    });

    it('archives once under truly parallel requests (transactions and retries)', async () => {
      const projectId = await seedProject({ status: 'on_hold', onHoldAt: HELD_AT });

      const results = await Promise.all([callAs(archiveProject, projectId), callAs(archiveProject, projectId)]);

      expect(results.map((r) => r.statusCode)).toEqual([200, 200]);
      const stored: any = await Project.collection.findOne({ _id: projectId });
      expect(stored.status).toBe('archived');
      expect(stored.statusBeforeArchive).toBe('on_hold');
    });
  });

  describe('restore', () => {
    it('returns 409 when a concurrent restore commits after its read', async () => {
      const projectId = await seedProject({ status: 'archived', statusBeforeArchive: 'on_hold', archivedAt: WINNING_ARCHIVED_AT, onHoldAt: HELD_AT });
      commitBetweenStatusReadAndSave(async (id) => {
        expect((await callAs(restoreProject, id)).statusCode).toBe(200);
      });

      const res = await callAs(restoreProject, projectId);

      expect(res.statusCode).toBe(409);
      expect(res.body).toMatchObject({ code: 'PROJECT_STATUS_CONFLICT', currentStatus: 'on_hold' });
      const stored: any = await Project.collection.findOne({ _id: projectId });
      expect(stored.status).toBe('on_hold');
      expect(stored.archivedAt).toBeUndefined();
    });

    it('returns 409 instead of undoing a newer archive (restore, resume, re-archive committed after its read)', async () => {
      const projectId = await seedProject({ status: 'archived', statusBeforeArchive: 'on_hold', archivedAt: WINNING_ARCHIVED_AT, onHoldAt: HELD_AT });
      commitBetweenStatusReadAndSave(async (id) => {
        expect((await callAs(restoreProject, id)).statusCode).toBe(200);
        expect((await setStatus(projectId, 'published')).statusCode).toBe(200);
        await archiveAs()(id);
      });

      const res = await callAs(restoreProject, projectId);

      // The stored project is archived again, but from a different episode:
      // the stale restore must not reopen it as on_hold.
      expect(res.statusCode).toBe(409);
      expect(res.body).toMatchObject({ code: 'PROJECT_STATUS_CONFLICT', currentStatus: 'archived' });
      const stored: any = await Project.collection.findOne({ _id: projectId });
      expect(stored.status).toBe('archived');
      expect(stored.statusBeforeArchive).toBe('published');
      expect(stored.archivedAt).toBeInstanceOf(Date);
      expect(stored.archivedAt.getTime()).toBeGreaterThan(WINNING_ARCHIVED_AT.getTime());
    });

    it('returns 409 when the project changes owner after its read (admin keeps the new owner)', async () => {
      const projectId = await seedProject({ status: 'archived', statusBeforeArchive: 'draft', archivedAt: WINNING_ARCHIVED_AT });
      commitBetweenStatusReadAndSave(async () => {
        await Project.collection.updateOne({ _id: projectId }, { $set: { professionalId: OTHER_PRO } });
      });

      const res = await callAs(restoreProject, projectId, ADMIN);

      expect(res.statusCode).toBe(409);
      expect(res.body).toMatchObject({ code: 'PROJECT_STATUS_CONFLICT', currentStatus: 'archived' });
      const stored: any = await Project.collection.findOne({ _id: projectId });
      expect(stored.status).toBe('archived');
      expect(stored.archivedAt).toEqual(WINNING_ARCHIVED_AT);
    });

    it('restores once under truly parallel requests (transactions and retries)', async () => {
      const projectId = await seedProject({ status: 'archived', statusBeforeArchive: 'rejected', archivedAt: WINNING_ARCHIVED_AT });

      const results = await Promise.all([callAs(restoreProject, projectId), callAs(restoreProject, projectId)]);

      const codes = results.map((r) => r.statusCode).sort();
      // One restore wins; the other either lost the write (409) or read the
      // already-restored project (400 "not archived"). Never two restores.
      expect(codes[0]).toBe(200);
      expect([400, 409]).toContain(codes[1]);
      const stored: any = await Project.collection.findOne({ _id: projectId });
      expect(stored.status).toBe('rejected');
      expect(stored.archivedAt).toBeUndefined();
    });
  });

  describe('submit vs concurrent archive', () => {
    const expectStillArchived = async (projectId: Types.ObjectId, statusBeforeArchive: string) => {
      const stored: any = await Project.collection.findOne({ _id: projectId });
      expect(stored.status).toBe('archived');
      expect(stored.statusBeforeArchive).toBe(statusBeforeArchive);
      expect(stored.archivedAt).toBeInstanceOf(Date);
      return stored;
    };

    it('first submission: 409, the archived draft is not reopened as pending', async () => {
      const projectId = await seedProject({ status: 'draft', ...SUBMITTABLE });
      archiveAfterRead();

      const res = await callAs(submitProject, projectId);

      expect(res.statusCode).toBe(409);
      expect(res.body).toMatchObject({ code: 'PROJECT_STATUS_CONFLICT', currentStatus: 'archived' });
      const stored = await expectStillArchived(projectId, 'draft');
      expect(stored.submittedAt).toBeUndefined();
      expect(stored.qualityChecks ?? []).toHaveLength(0);
    });

    it('auto-approved resubmission: 409, the archived project is not published', async () => {
      const projectId = await seedResubmission();
      archiveAfterRead();

      const res = await callAs(submitProject, projectId);

      expect(res.statusCode).toBe(409);
      expect(res.body).toMatchObject({ code: 'PROJECT_STATUS_CONFLICT', currentStatus: 'archived' });
      const stored = await expectStillArchived(projectId, 'published');
      // The approval bookkeeping was not applied behind the archive either.
      expect(stored.isResubmission).toBe(true);
      expect(stored.previousSnapshot).toBeTruthy();
    });

    it('resubmission for admin review: 409, no pending changes queued on the archive', async () => {
      const projectId = await seedResubmission({ category: 'Plumbing' });
      archiveAfterRead();

      const res = await callAs(submitProject, projectId);

      expect(res.statusCode).toBe(409);
      const stored = await expectStillArchived(projectId, 'published');
      expect(stored.pendingChanges ?? []).toHaveLength(0);
      expect(stored.reapprovalType).toBeUndefined();
      expect(stored.submittedAt).toBeUndefined();
    });

    it('failed quality checks: 409, no check results written onto the archive', async () => {
      const projectId = await seedProject({ status: 'draft', ...SUBMITTABLE, description: 'Too short to submit' });
      archiveAfterRead();

      const res = await callAs(submitProject, projectId);

      expect(res.statusCode).toBe(409);
      expect(res.body.code).toBe('PROJECT_STATUS_CONFLICT');
      const stored = await expectStillArchived(projectId, 'draft');
      expect(stored.qualityChecks ?? []).toHaveLength(0);
    });

    it('legacy /api/user/projects/:id/submit: 409, the archived draft is not reopened', async () => {
      const projectId = await seedProject({ status: 'draft', ...SUBMITTABLE });
      archiveAfterRead();

      const res = await callAs(submitDraftViaUserRoute, projectId);

      expect(res.statusCode).toBe(409);
      expect(res.body).toMatchObject({ success: false, code: 'PROJECT_STATUS_CONFLICT', currentStatus: 'archived' });
      const stored = await expectStillArchived(projectId, 'draft');
      expect(stored.submittedAt).toBeUndefined();
    });
  });

  describe('uncontended behaviour is unchanged', () => {
    it('archives and restores through the save hooks, idempotently, never straight back to published', async () => {
      const projectId = await seedProject({ status: 'published' });

      const archived = await callAs(archiveProject, projectId);
      expect(archived.statusCode).toBe(200);
      let stored: any = await Project.collection.findOne({ _id: projectId });
      expect(stored).toMatchObject({ status: 'archived', statusBeforeArchive: 'published' });
      expect(stored.archivedAt).toBeInstanceOf(Date);
      expect(stored.autoSaveTimestamp).toBeInstanceOf(Date);
      expect((archived.body.project as any).$where).toBeUndefined();

      const again = await callAs(archiveProject, projectId);
      expect(again.statusCode).toBe(200);
      expect((await Project.collection.findOne({ _id: projectId }) as any).archivedAt).toEqual(stored.archivedAt);

      const restored = await callAs(restoreProject, projectId);
      expect(restored.statusCode).toBe(200);
      stored = await Project.collection.findOne({ _id: projectId });
      expect(stored.status).toBe('draft');
      expect(stored.archivedAt).toBeUndefined();
      expect(stored.statusBeforeArchive).toBeUndefined();
      expect((restored.body.project as any).$where).toBeUndefined();

      expect((await callAs(restoreProject, projectId)).statusCode).toBe(400);
    });

    it('restores a held project to on_hold, including for an admin', async () => {
      const projectId = await seedProject({ status: 'on_hold', onHoldAt: HELD_AT });
      expect((await callAs(archiveProject, projectId, ADMIN)).statusCode).toBe(200);
      const restored = await callAs(restoreProject, projectId, ADMIN);
      expect(restored.statusCode).toBe(200);
      const stored: any = await Project.collection.findOne({ _id: projectId });
      expect(stored.status).toBe('on_hold');
    });

    it('keeps the actor rules: unapproved pro 403, other owner 404, admin without projects.approve 403', async () => {
      const projectId = await seedProject({ status: 'published' });
      expect((await callAs(archiveProject, projectId, UNAPPROVED_PRO)).statusCode).toBe(403);
      expect((await callAs(archiveProject, projectId, OTHER_PRO)).statusCode).toBe(404);
      expect((await callAs(archiveProject, projectId, FINANCE_ADMIN)).statusCode).toBe(403);
      expect((await callAs(restoreProject, projectId, FINANCE_ADMIN)).statusCode).toBe(403);
      expect((await callAs(submitProject, projectId, UNAPPROVED_PRO)).statusCode).toBe(403);
      const stored: any = await Project.collection.findOne({ _id: projectId });
      expect(stored.status).toBe('published');
    });

    it('submits a draft, auto-approves an unchanged resubmission and queues a structural one', async () => {
      const draftId = await seedProject({ status: 'draft', ...SUBMITTABLE });
      const submitted = await callAs(submitProject, draftId);
      expect(submitted.statusCode).toBe(200);
      expect(submitted.body.status).toBe('pending');
      let stored: any = await Project.collection.findOne({ _id: draftId });
      expect(stored.submittedAt).toBeInstanceOf(Date);
      expect(stored.autoSaveTimestamp).toBeInstanceOf(Date);

      const unchangedId = await seedResubmission();
      const approved = await callAs(submitProject, unchangedId);
      expect(approved.statusCode).toBe(200);
      expect(approved.body.message).toBe('Changes approved automatically');
      stored = await Project.collection.findOne({ _id: unchangedId });
      expect(stored.status).toBe('published');
      expect(stored.isResubmission).toBe(false);
      expect(stored.previousSnapshot).toBeUndefined();

      const structuralId = await seedResubmission({ category: 'Plumbing' });
      const queued = await callAs(submitProject, structuralId);
      expect(queued.statusCode).toBe(200);
      stored = await Project.collection.findOne({ _id: structuralId });
      expect(stored.status).toBe('pending');
      expect(stored.reapprovalType).toBe('full');
      expect(stored.pendingChanges.map((c: any) => c.field)).toContain('category');
    });

    it('stores failed quality checks with a 400, and the legacy route still submits a draft', async () => {
      const failingId = await seedProject({ status: 'draft', ...SUBMITTABLE, description: 'Too short to submit' });
      const failed = await callAs(submitProject, failingId);
      expect(failed.statusCode).toBe(400);
      let stored: any = await Project.collection.findOne({ _id: failingId });
      expect(stored.status).toBe('draft');
      expect(stored.qualityChecks.map((c: any) => c.message)).toContain('Description must be at least 100 characters long');

      const legacyId = await seedProject({ status: 'draft', ...SUBMITTABLE });
      const legacy = await callAs(submitDraftViaUserRoute, legacyId);
      expect(legacy.statusCode).toBe(200);
      stored = await Project.collection.findOne({ _id: legacyId });
      expect(stored.status).toBe('pending');
      expect(stored.submittedAt).toBeInstanceOf(Date);
    });

    it('keeps the anonymization write fence for archive, restore and submit', async () => {
      const publishedId = await seedProject({ status: 'published' });
      const archivedId = await seedProject({ status: 'archived', statusBeforeArchive: 'draft', archivedAt: WINNING_ARCHIVED_AT });
      const draftId = await seedProject({ status: 'draft', ...SUBMITTABLE });
      await AccountDataGuard.collection.insertOne({ _id: PRO, state: 'anonymizing', startedAt: new Date(), writeFenceVersion: 1 });

      expect((await callAs(archiveProject, publishedId)).statusCode).toBe(500);
      expect((await callAs(restoreProject, archivedId)).statusCode).toBe(500);
      expect((await callAs(submitProject, draftId)).statusCode).toBe(500);
      expect((await callAs(submitDraftViaUserRoute, draftId)).statusCode).toBe(500);
      expect((await Project.collection.findOne({ _id: publishedId }) as any).status).toBe('published');
      expect((await Project.collection.findOne({ _id: archivedId }) as any).status).toBe('archived');
      expect((await Project.collection.findOne({ _id: draftId }) as any).status).toBe('draft');
    });
  });
});
