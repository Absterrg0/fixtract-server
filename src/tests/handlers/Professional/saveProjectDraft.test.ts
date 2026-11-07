import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

const mocks = vi.hoisted(() => ({
  userFindById: vi.fn(),
  projectFindOne: vi.fn(),
  projectFindOneAndUpdate: vi.fn(),
  serviceConfigFindById: vi.fn(),
}));

vi.mock('../../../models/user', () => ({
  default: { findById: mocks.userFindById },
}));

vi.mock('../../../models/project', () => ({
  default: {
    findOne: mocks.projectFindOne,
    findOneAndUpdate: mocks.projectFindOneAndUpdate,
    create: vi.fn(),
  },
}));

vi.mock('../../../models/serviceConfiguration', () => ({
  default: { findById: mocks.serviceConfigFindById },
}));

vi.mock('../../../models/favorite', () => ({ default: {} }));
vi.mock('../../../handlers/Admin/favoritesAdmin', () => ({ invalidateFavoritesOverviewCache: vi.fn() }));
vi.mock('../../../utils/support/accountGuard', () => ({
  withAnonymizationWriteFence: vi.fn(async (_ids: string[], work: (session: unknown) => unknown) => work(null)),
}));

import { saveProjectDraft } from '../../../handlers/Professional/projectManagement';

const PRO_ID = '507f1f77bcf86cd799439011';
const ARTICLE_47_ANSWER = { fieldName: 'article47_immovable', value: 'yes' };
const OTHER_ANSWER = { fieldName: 'other_question', value: 'kept' };

const mockRes = () => {
  const res: any = {
    statusCode: 200,
    body: undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res as Response & { statusCode: number; body: any };
};

const leanQuery = (value: unknown) => ({ select: vi.fn(() => ({ lean: vi.fn(async () => value) })) });

describe('saveProjectDraft', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.userFindById.mockReturnValue({
      select: vi.fn(async () => ({ role: 'professional', professionalStatus: 'approved' })),
    });
    mocks.projectFindOneAndUpdate.mockImplementation(async (_filter: unknown, update: unknown) => update);
  });

  it('rejects edits to an archived project instead of reopening it', async () => {
    mocks.projectFindOne.mockReturnValue(leanQuery({ status: 'archived', serviceConfigurationId: 'cfg1' }));
    const res = mockRes();
    await saveProjectDraft(
      { user: { _id: PRO_ID }, body: { _id: 'proj1', status: 'published' } } as unknown as Request,
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('PROJECT_ARCHIVED');
    expect(mocks.projectFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it('prunes against the saved configuration when a partial update omits it', async () => {
    mocks.projectFindOne.mockReturnValue(leanQuery({ status: 'draft', serviceConfigurationId: 'cfg1' }));
    mocks.serviceConfigFindById.mockReturnValue(leanQuery({ vatManagement: { article47Classification: 'movable' } }));
    const res = mockRes();
    await saveProjectDraft(
      {
        user: { _id: PRO_ID },
        body: { _id: 'proj1', vatProfessionalAnswers: [ARTICLE_47_ANSWER, OTHER_ANSWER] },
      } as unknown as Request,
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(mocks.serviceConfigFindById).toHaveBeenCalledWith('cfg1');
    const update = mocks.projectFindOneAndUpdate.mock.calls[0][1];
    expect(update.vatProfessionalAnswers).toEqual([OTHER_ANSWER]);
  });

  it('preserves answers when the configuration record cannot be found', async () => {
    mocks.projectFindOne.mockReturnValue(leanQuery({ status: 'draft', serviceConfigurationId: 'cfg-missing' }));
    mocks.serviceConfigFindById.mockReturnValue(leanQuery(null));
    const res = mockRes();
    await saveProjectDraft(
      {
        user: { _id: PRO_ID },
        body: { _id: 'proj1', vatProfessionalAnswers: [ARTICLE_47_ANSWER, OTHER_ANSWER], archivedAt: '2026-01-01' },
      } as unknown as Request,
      res,
    );
    expect(res.statusCode).toBe(200);
    const update = mocks.projectFindOneAndUpdate.mock.calls[0][1];
    expect(update.vatProfessionalAnswers).toEqual([ARTICLE_47_ANSWER, OTHER_ANSWER]);
    // Archive bookkeeping cannot be written through the draft endpoint.
    expect(update).not.toHaveProperty('archivedAt');
  });
});
