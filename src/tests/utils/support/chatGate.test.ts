import { beforeEach, describe, expect, it, vi } from 'vitest';

const { settingsFindOne, userFindById } = vi.hoisted(() => ({
  settingsFindOne: vi.fn(),
  userFindById: vi.fn(),
}));

vi.mock('../../../models/platformSettings', () => ({
  default: { findOne: settingsFindOne },
}));
vi.mock('../../../models/user', () => ({
  default: { findById: userFindById },
}));

import {
  assertSupportChatEnabled,
  assertSupportChatTargetEligible,
  assertSupportChatWriteAllowed,
  isSupportChatEnabled,
  supportChannelsForRole,
} from '../../../utils/support/settings';

let settingsResult: unknown = null;
let targetResult: unknown = null;

describe('support chat feature gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settingsResult = null;
    targetResult = { role: 'professional' };
    settingsFindOne.mockImplementation(() => ({
      select: () => ({ lean: async () => settingsResult }),
    }));
    userFindById.mockImplementation(() => ({
      select: () => ({ lean: async () => targetResult }),
    }));
  });

  it('defaults to disabled when the setting is missing or the read fails', async () => {
    expect(await isSupportChatEnabled()).toBe(false);
    settingsFindOne.mockImplementation(() => {
      throw new Error('db down');
    });
    expect(await isSupportChatEnabled()).toBe(false);
  });

  it('only treats an explicit true as enabled', async () => {
    settingsResult = { supportChatEnabled: true };
    expect(await isSupportChatEnabled()).toBe(true);
    settingsResult = { supportChatEnabled: 'true' };
    expect(await isSupportChatEnabled()).toBe(false);
  });

  it('blocks support chat when disabled', async () => {
    await expect(assertSupportChatEnabled()).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
  });

  it('blocks customer support targets while leaving professionals allowed', async () => {
    targetResult = { role: 'customer' };
    await expect(assertSupportChatTargetEligible('507f1f77bcf86cd799439012')).rejects.toMatchObject({
      status: 403,
      code: 'FORBIDDEN',
    });
    targetResult = { role: 'professional' };
    await expect(assertSupportChatTargetEligible('507f1f77bcf86cd799439012')).resolves.toBeUndefined();
  });

  it('requires both the flag and a professional target for any support write', async () => {
    settingsResult = { supportChatEnabled: false };
    await expect(assertSupportChatWriteAllowed('507f1f77bcf86cd799439012')).rejects.toMatchObject({
      status: 403,
    });
    settingsResult = { supportChatEnabled: true };
    targetResult = { role: 'customer' };
    await expect(assertSupportChatWriteAllowed('507f1f77bcf86cd799439012')).rejects.toMatchObject({
      status: 403,
    });
    targetResult = { role: 'professional' };
    await expect(assertSupportChatWriteAllowed('507f1f77bcf86cd799439012')).resolves.toBeUndefined();
  });

  it('exposes chat only to professionals when enabled', () => {
    expect(supportChannelsForRole('customer', true)).toEqual({ tickets: true, meetings: false, chat: false });
    expect(supportChannelsForRole('professional', false)).toEqual({ tickets: true, meetings: true, chat: false });
    expect(supportChannelsForRole('professional', true)).toEqual({ tickets: true, meetings: true, chat: true });
  });
});
