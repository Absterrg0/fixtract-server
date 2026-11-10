import mongoose, { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';

/**
 * Real-Mongo coverage for both project draft write boundaries
 * (`POST /api/user/projects` -> saveProjectDraft and `POST /api/projects/draft`
 * -> createOrUpdateDraft): the archived guard is part of the write itself,
 * and both apply the same reserved Article 47 answer pruning. The account
 * write fence runs for real (replica-set transaction).
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
import ServiceConfiguration from '../../models/serviceConfiguration';
import AccountDataGuard from '../../models/accountDataGuard';
import { saveProjectDraft } from '../../handlers/Professional/projectManagement';
import { createOrUpdateDraft } from '../../handlers/Project';
import { ARTICLE_47_FIELD_NAME } from '../../utils/vatCountries';

const response = () => {
  const res: any = { statusCode: 200, body: undefined };
  res.status = vi.fn((code: number) => { res.statusCode = code; return res; });
  res.json = vi.fn((body: any) => { res.body = body; return res; });
  return res;
};

const PRO = new Types.ObjectId();
const ARTICLE_47 = { fieldName: ARTICLE_47_FIELD_NAME, value: 'yes' };
const OTHER = { fieldName: 'other_question', value: 'kept' };
// Project titles have a 30-character minimum.
const ORIGINAL_TITLE = 'Original project title for the draft tests';
const SAVED_TITLE = 'Saved project title from a live draft edit';

type DraftEndpoint = {
  name: string;
  save: (projectId: Types.ObjectId, body: Record<string, unknown>) => Promise<any>;
};

const endpoints: DraftEndpoint[] = [
  {
    name: 'POST /api/user/projects (saveProjectDraft)',
    save: async (projectId, body) => {
      const res = response();
      await saveProjectDraft({ user: { _id: PRO }, body: { _id: String(projectId), ...body } } as unknown as Request, res);
      return res;
    },
  },
  {
    name: 'POST /api/projects/draft (createOrUpdateDraft)',
    save: async (projectId, body) => {
      const res = response();
      await createOrUpdateDraft({ user: { id: String(PRO) }, body: { id: String(projectId), ...body } } as unknown as Request, res);
      return res;
    },
  },
];

const seedProject = async (fields: Record<string, unknown> = {}) => {
  const _id = new Types.ObjectId();
  await Project.collection.insertOne({
    _id,
    professionalId: PRO,
    status: 'draft',
    title: ORIGINAL_TITLE,
    description: 'Original description',
    category: 'Renovation',
    service: 'Painting',
    ...fields,
  });
  return _id;
};

const seedConfig = async (classification?: string) => {
  const _id = new Types.ObjectId();
  await ServiceConfiguration.collection.insertOne({
    _id,
    category: 'Renovation',
    service: 'Painting',
    vatManagement: classification ? { enabled: true, article47Classification: classification } : { enabled: true },
  });
  return String(_id);
};

/** Commit an archive between the handler's status read and its write. */
const archiveBeforeNextDraftWrite = () => {
  const original = Project.findOneAndUpdate.bind(Project);
  return vi.spyOn(Project, 'findOneAndUpdate').mockImplementationOnce(((filter: any, ...rest: any[]) => {
    const archived = Project.collection.updateOne(
      { _id: new Types.ObjectId(String(filter._id)) },
      { $set: { status: 'archived', statusBeforeArchive: 'draft', archivedAt: new Date('2026-11-03T10:00:00.000Z') } },
    );
    // A thenable query keeps the handler's `await` contract.
    return { then: (resolve: any, reject: any) => archived.then(() => original(filter, ...rest)).then(resolve, reject) };
  }) as any);
};

describeDb('project draft write boundaries (disposable Mongo)', () => {
  beforeAll(async () => {
    await mongoose.connect(testUri!, { dbName: 'fixera_project_draft_boundaries_test' });
    await Promise.all([Project, User, ServiceConfiguration, AccountDataGuard].map((model) => model.init()));
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
      ServiceConfiguration.collection.deleteMany({}),
      AccountDataGuard.collection.deleteMany({}),
    ]);
    await User.collection.insertOne({
      _id: PRO,
      name: 'Pro',
      email: 'pro-draft@example.test',
      role: 'professional',
      professionalStatus: 'approved',
      stripe: { accountId: 'acct_draft', onboardingCompleted: true },
    });
  });

  for (const endpoint of endpoints) {
    describe(endpoint.name, () => {
      it('returns 409 and keeps the archive when it commits between the status read and the write', async () => {
        const projectId = await seedProject();
        const spy = archiveBeforeNextDraftWrite();

        const res = await endpoint.save(projectId, { title: 'Autosaved title from the editor tab, long enough', status: 'published' });

        // The concurrent archive makes the fenced transaction hit a write
        // conflict, so the driver may retry the write; every attempt's filter
        // carries the status predicate.
        expect(spy.mock.calls.length).toBeGreaterThanOrEqual(1);
        for (const [filter] of spy.mock.calls) {
          expect(filter).toMatchObject({ status: { $ne: 'archived' } });
        }
        expect(res.statusCode).toBe(409);
        expect(res.body.code).toBe('PROJECT_ARCHIVED');
        const stored: any = await Project.collection.findOne({ _id: projectId });
        expect(stored.status).toBe('archived');
        expect(stored.statusBeforeArchive).toBe('draft');
        expect(stored.archivedAt).toBeInstanceOf(Date);
        // Neither status nor content was rewritten behind the archive.
        expect(stored.title).toBe(ORIGINAL_TITLE);
        expect(stored.autoSaveTimestamp).toBeUndefined();
      });

      it('still rejects an already archived project before writing, and saves a live draft', async () => {
        const archivedId = await seedProject({ status: 'archived', statusBeforeArchive: 'draft', archivedAt: new Date() });
        const rejected = await endpoint.save(archivedId, { title: 'Rejected edit of an archived project title' });
        expect(rejected.statusCode).toBe(400);
        expect(rejected.body.code).toBe('PROJECT_ARCHIVED');
        expect((await Project.collection.findOne({ _id: archivedId }) as any).title).toBe(ORIGINAL_TITLE);

        const liveId = await seedProject();
        const saved = await endpoint.save(liveId, { title: SAVED_TITLE });
        expect(saved.statusCode).toBe(200);
        const stored: any = await Project.collection.findOne({ _id: liveId });
        expect(stored.title).toBe(SAVED_TITLE);
        expect(stored.status).toBe('draft');
      });

      it('prunes the reserved answer only against an available non-project-dependent config', async () => {
        const answersAfter = async (projectFields: Record<string, unknown>, body: Record<string, unknown>) => {
          const projectId = await seedProject(projectFields);
          const res = await endpoint.save(projectId, { vatProfessionalAnswers: [ARTICLE_47, OTHER], ...body });
          expect(res.statusCode).toBe(200);
          const stored: any = await Project.collection.findOne({ _id: projectId });
          return stored.vatProfessionalAnswers.map((answer: any) => answer.fieldName);
        };

        const immovable = await seedConfig('immovable');
        const movable = await seedConfig('movable');
        const projectDependent = await seedConfig('project_dependent');
        const legacyUnclassified = await seedConfig();

        expect(await answersAfter({}, { serviceConfigurationId: immovable })).toEqual(['other_question']);
        expect(await answersAfter({}, { serviceConfigurationId: movable })).toEqual(['other_question']);
        expect(await answersAfter({}, { serviceConfigurationId: projectDependent }))
          .toEqual([ARTICLE_47_FIELD_NAME, 'other_question']);
        // A legacy config without a classification resolves to the default
        // (immovable), the same rule the booking VAT preview uses.
        expect(await answersAfter({}, { serviceConfigurationId: legacyUnclassified })).toEqual(['other_question']);
        // A partial update without the config uses the saved draft's config.
        expect(await answersAfter({ serviceConfigurationId: movable }, {})).toEqual(['other_question']);
        expect(await answersAfter({ serviceConfigurationId: projectDependent }, {}))
          .toEqual([ARTICLE_47_FIELD_NAME, 'other_question']);
        // No resolvable config, or a missing record: answers are kept as sent.
        expect(await answersAfter({}, {})).toEqual([ARTICLE_47_FIELD_NAME, 'other_question']);
        expect(await answersAfter({}, { serviceConfigurationId: String(new Types.ObjectId()) }))
          .toEqual([ARTICLE_47_FIELD_NAME, 'other_question']);
      });
    });
  }
});
