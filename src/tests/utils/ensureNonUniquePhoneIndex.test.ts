import { beforeEach, describe, expect, it, vi } from 'vitest';

const { indexes, dropIndex, createIndex } = vi.hoisted(() => ({
  indexes: vi.fn(),
  dropIndex: vi.fn(),
  createIndex: vi.fn(),
}));

vi.mock('../../models/user', () => ({
  default: {
    collection: {
      indexes,
      dropIndex,
      createIndex,
    },
  },
}));

describe('ensureNonUniquePhoneIndex', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    indexes.mockResolvedValue([
      { name: '_id_', key: { _id: 1 } },
      { name: 'phone_1', key: { phone: 1 }, unique: true },
      { name: 'email_1', key: { email: 1 }, unique: true },
    ]);
    dropIndex.mockResolvedValue('phone_1');
    createIndex.mockResolvedValue('phone_1');
  });

  it('drops only the unique phone index and recreates a non-unique lookup index', async () => {
    const { ensureNonUniquePhoneIndex } = await import('../../utils/ensureNonUniquePhoneIndex');
    await ensureNonUniquePhoneIndex();

    expect(dropIndex).toHaveBeenCalledTimes(1);
    expect(dropIndex).toHaveBeenCalledWith('phone_1');
    expect(createIndex).toHaveBeenCalledWith({ phone: 1 }, { background: true });
  });

  it('ignores a concurrent IndexNotFound when another instance already dropped the index', async () => {
    dropIndex.mockRejectedValue({ code: 27, codeName: 'IndexNotFound' });
    const { ensureNonUniquePhoneIndex } = await import('../../utils/ensureNonUniquePhoneIndex');
    await ensureNonUniquePhoneIndex();

    expect(createIndex).toHaveBeenCalledWith({ phone: 1 }, { background: true });
  });

  it('does not touch the unique email index', async () => {
    const { ensureNonUniquePhoneIndex } = await import('../../utils/ensureNonUniquePhoneIndex');
    await ensureNonUniquePhoneIndex();

    expect(dropIndex).not.toHaveBeenCalledWith('email_1');
  });
});
