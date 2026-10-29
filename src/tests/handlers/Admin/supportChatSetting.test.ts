import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

const { getCurrentConfig } = vi.hoisted(() => ({ getCurrentConfig: vi.fn() }));

vi.mock('../../../models/platformSettings', () => ({ default: { getCurrentConfig } }));
vi.mock('../../../config/db', () => ({ default: vi.fn(async () => undefined) }));
vi.mock('../../../services/odooAccounting', () => ({ listOdooCompanies: vi.fn() }));
vi.mock('../../../utils/vatValidation', () => ({
  validateVATNumberFormat: () => true,
  normalizeVATNumberFormat: (value: string) => value,
}));

import {
  getPlatformSettings,
  updatePlatformSettings,
  updateSupportChatSetting,
} from '../../../handlers/Admin/platformSettings';

const mockRes = () => {
  const res = {
    statusCode: 200,
    body: undefined as any,
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

const config = () => ({
  commissionPercent: 10,
  companyVatNumber: '',
  companyAddress: {},
  eInvoicing: { peppolEnabled: false, provider: 'manual' },
  supportChatEnabled: false,
  lastModified: new Date(),
  version: 1,
  save: vi.fn(async () => undefined),
});

describe('support chat platform setting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getCurrentConfig.mockResolvedValue(config());
  });

  it('defaults to false and exposes the boolean with the existing settings', async () => {
    const res = mockRes();
    await getPlatformSettings({ admin: { role: 'admin', adminRole: 'super' } } as Request, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.data.supportChatEnabled).toBe(false);
    expect(res.body.data.commissionPercent).toBe(10);
  });

  it('lets a superadmin toggle the setting', async () => {
    const current = config();
    getCurrentConfig.mockResolvedValue(current);
    const res = mockRes();
    await updateSupportChatSetting(
      {
        admin: { _id: 'a1', role: 'admin', adminRole: 'super' },
        body: { enabled: true },
      } as unknown as Request,
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(current.supportChatEnabled).toBe(true);
    expect(current.save).toHaveBeenCalled();
    expect(res.body.data).toEqual({ supportChatEnabled: true });
  });

  it('rejects ordinary staff even if they reach the handler directly', async () => {
    const res = mockRes();
    await updateSupportChatSetting(
      {
        admin: { _id: 'a1', role: 'admin', adminRole: 'care' },
        body: { enabled: true },
      } as unknown as Request,
      res,
    );
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('ADMIN_PERMISSION_DENIED');
  });

  it('cannot be toggled through the general settings PUT by ordinary staff', async () => {
    const res = mockRes();
    await updatePlatformSettings(
      {
        admin: { _id: 'a1', role: 'admin', adminRole: 'care' },
        body: { commissionPercent: 10, supportChatEnabled: true },
      } as unknown as Request,
      res,
    );
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('ADMIN_PERMISSION_DENIED');
    expect(getCurrentConfig).not.toHaveBeenCalled();
  });

  it('rejects non-boolean values', async () => {
    const res = mockRes();
    await updateSupportChatSetting(
      {
        admin: { _id: 'a1', role: 'admin', adminRole: 'super' },
        body: { enabled: 'yes' },
      } as unknown as Request,
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body.field).toBe('enabled');
  });
});
