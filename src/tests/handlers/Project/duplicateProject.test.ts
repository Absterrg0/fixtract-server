import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

const mocks = vi.hoisted(() => ({
  findOne: vi.fn(),
  constructed: [] as Record<string, unknown>[],
}));

vi.mock('../../../models/project', () => {
  // Constructor stand-in: records the payload the handler builds the copy from.
  function Project(this: any, payload: Record<string, unknown>) {
    mocks.constructed.push(payload);
    Object.assign(this, payload);
    this.save = vi.fn(async () => this);
  }
  (Project as any).findOne = mocks.findOne;
  return { default: Project };
});
vi.mock('../../../models/user', () => ({ default: { findById: vi.fn() } }));
vi.mock('../../../models/booking', () => ({ default: {} }));
vi.mock('../../../utils/support/accountGuard', () => ({
  withAnonymizationWriteFence: vi.fn(async (_ids: unknown, work: (session: null) => unknown) => work(null)),
  ACCOUNT_WRITE_FENCE_CODE: 'ACCOUNT_WRITE_FENCE',
}));

import { duplicateProject } from '../../../handlers/Project';

const mockRes = () => {
  const res: any = { statusCode: 200, body: undefined };
  res.status = vi.fn((code: number) => { res.statusCode = code; return res; });
  res.json = vi.fn((body: unknown) => { res.body = body; return res; });
  return res as Response & { statusCode: number; body: any };
};

describe('duplicateProject', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.constructed.length = 0;
  });

  it('copies an archived project as a clean draft without archive metadata', async () => {
    const archivedSource = {
      _id: 'proj1',
      professionalId: 'pro1',
      title: 'Bathroom renovation in Antwerp, full service',
      status: 'archived',
      archivedAt: new Date('2026-10-20T10:00:00.000Z'),
      statusBeforeArchive: 'published',
      approvedAt: new Date('2026-09-01T10:00:00.000Z'),
    };
    mocks.findOne.mockImplementation(() => {
      const query: any = {
        select: vi.fn(() => ({ lean: vi.fn(async () => ({ _id: 'proj1' })) })),
        session: vi.fn(async () => ({ toObject: () => ({ ...archivedSource }) })),
      };
      return query;
    });

    const res = mockRes();
    await duplicateProject({ params: { id: 'proj1' }, user: { id: 'pro1' } } as unknown as Request, res);

    expect(res.statusCode).toBe(200);
    expect(mocks.constructed).toHaveLength(1);
    const copy = mocks.constructed[0];
    expect(copy.status).toBe('draft');
    expect(copy.title).toBe('Bathroom renovation in Antwerp, full service (Copy)');
    expect(copy.archivedAt).toBeUndefined();
    expect(copy.statusBeforeArchive).toBeUndefined();
    expect(copy.approvedAt).toBeUndefined();
    expect(copy._id).toBeUndefined();
  });
});
