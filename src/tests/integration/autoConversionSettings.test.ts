import mongoose, { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import PlatformSettings from '../../models/platformSettings';
import {
  getPlatformSettings,
  updateAutoConversionSetting,
  updatePlatformSettings,
} from '../../handlers/Admin/platformSettings';
import { getPublicAutoConversion } from '../../handlers/Public/autoConversion';
import { enforceAdminRoutePermission } from '../../utils/adminRbac/middleware';

const testUri = process.env.FIXERA_TEST_MONGODB_URI;
const hasDisposableMongo = Boolean(testUri && /test/i.test(testUri));
const describeDb = hasDisposableMongo ? describe : describe.skip;

vi.mock('../../config/db', () => ({ default: async () => undefined }));

const superAdmin = { _id: new Types.ObjectId(), role: 'admin', adminRole: 'super' };
const staffAdmin = { _id: new Types.ObjectId(), role: 'admin', adminRole: 'operations' };

const fakeRes = () => {
  const res: any = { statusCode: 200, body: undefined, headers: {} as Record<string, string> };
  res.status = vi.fn((code: number) => { res.statusCode = code; return res; });
  res.json = vi.fn((body: unknown) => { res.body = body; return res; });
  res.set = vi.fn((name: string, value: string) => { res.headers[name] = value; return res; });
  return res;
};

describeDb('auto-conversion platform setting (disposable MongoDB)', () => {
  beforeAll(async () => {
    // Own database: other integration files run in parallel on the same server.
    await mongoose.connect(testUri!, { dbName: `fixera_auto_conversion_it_${Date.now()}` });
  });
  afterAll(async () => {
    await mongoose.connection.db?.dropDatabase();
    await mongoose.disconnect();
  });
  beforeEach(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await PlatformSettings.deleteMany({});
  });

  it('public endpoint reports not configured and does not create the settings document', async () => {
    const res = fakeRes();
    await getPublicAutoConversion({} as any, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual({ configured: false, enabledCountries: [], defaultCountry: 'BE' });
    expect(res.headers['Cache-Control']).toMatch(/public/);
    expect(await PlatformSettings.countDocuments()).toBe(0);
  });

  it('super admin saves the roll-out; admin and public reads return it; other settings keep it', async () => {
    const patch = fakeRes();
    await updateAutoConversionSetting({ admin: superAdmin, body: { enabledCountries: ['nl', 'BE', 'be'], defaultCountry: 'be' } } as any, patch);
    expect(patch.statusCode).toBe(200);
    expect(patch.body).toEqual({ success: true, data: { enabledCountries: ['BE', 'NL'], defaultCountry: 'BE' } });

    const admin = fakeRes();
    await getPlatformSettings({ admin: superAdmin } as any, admin, vi.fn());
    expect(admin.body.data.autoConversion).toMatchObject({ enabledCountries: ['BE', 'NL'], defaultCountry: 'BE' });
    expect(admin.body.data.autoConversion.configuredAt).toBeInstanceOf(Date);

    const put = fakeRes();
    await updatePlatformSettings({ admin: superAdmin, body: { commissionPercent: 12 } } as any, put, vi.fn());
    expect(put.statusCode).toBe(200);
    expect(put.body.data.autoConversion.enabledCountries).toEqual(['BE', 'NL']);

    const pub = fakeRes();
    await getPublicAutoConversion({} as any, pub);
    expect(pub.body.data).toEqual({ configured: true, enabledCountries: ['BE', 'NL'], defaultCountry: 'BE' });
  });

  it('an empty list still marks the roll-out configured', async () => {
    await updateAutoConversionSetting({ admin: superAdmin, body: { enabledCountries: [], defaultCountry: 'FR' } } as any, fakeRes());
    const pub = fakeRes();
    await getPublicAutoConversion({} as any, pub);
    expect(pub.body.data).toEqual({ configured: true, enabledCountries: [], defaultCountry: 'FR' });
  });

  it('rejects invalid codes with 400 and leaves the stored value unchanged', async () => {
    await updateAutoConversionSetting({ admin: superAdmin, body: { enabledCountries: ['BE'] } } as any, fakeRes());
    const bad = fakeRes();
    await updateAutoConversionSetting({ admin: superAdmin, body: { enabledCountries: ['BE', 'XX'] } } as any, bad);
    expect(bad.statusCode).toBe(400);
    expect(bad.body).toMatchObject({ code: 'VALIDATION', field: 'enabledCountries', invalid: ['XX'] });
    const stored: any = await PlatformSettings.findById('platform-settings').lean();
    expect(stored.autoConversion.enabledCountries).toEqual(['BE']);
  });

  it('only a super admin can change it (handler and route guard)', async () => {
    const res = fakeRes();
    await updateAutoConversionSetting({ admin: staffAdmin, body: { enabledCountries: ['BE'] } } as any, res);
    expect(res.statusCode).toBe(403);
    expect(await PlatformSettings.countDocuments()).toBe(0);

    const guard = fakeRes();
    const next = vi.fn();
    await enforceAdminRoutePermission({ path: '/platform-settings/auto-conversion', admin: staffAdmin } as any, guard, next);
    expect(next).not.toHaveBeenCalled();
    expect(guard.statusCode).toBe(403);
  });
});
