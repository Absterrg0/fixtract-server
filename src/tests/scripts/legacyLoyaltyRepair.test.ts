import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ connect: vi.fn(), disconnect: vi.fn(), repair: vi.fn() }));
vi.mock('mongoose', async importOriginal => {
  const actual = await importOriginal<typeof import('mongoose')>();
  return { ...actual, default: { ...actual.default, connect: mocks.connect, disconnect: mocks.disconnect } };
});
vi.mock('../../models/loyaltyConfig', () => ({ default: { backfillConfirmedLegacyConfig: mocks.repair } }));
import { main } from '../../scripts/migrate/backfillConfirmedLegacyLoyaltyConfig';

// Connection and repair are always mocked; never execute this script on a DB.
describe('operator legacy loyalty repair', () => {
  const args = ['--id', '507f1f77bcf86cd799439011', '--version', '7'];
  beforeEach(() => { vi.clearAllMocks(); vi.stubEnv('MONGO_URI', 'mongodb://unused.invalid/test'); mocks.repair.mockResolvedValue(true); vi.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
  it('previews without applying by default', async () => {
    await main(args);
    expect(mocks.repair).toHaveBeenCalledWith(args[1], 7, false);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('repair would proceed'));
  });
  it('applies only an explicit confirmed id, version and apply flag', async () => {
    await main([...args, '--apply']);
    expect(mocks.repair).toHaveBeenCalledWith(args[1], 7, true);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('repair applied'));
  });
  it.each([[], ['--apply'], ['--id', args[1], '--apply'], [...args, '--apply', '--dry-run'], [...args, '--unknown']])('rejects unsafe arguments %j before connecting', async input => {
    await expect(main(input)).rejects.toThrow(); expect(mocks.connect).not.toHaveBeenCalled(); expect(mocks.repair).not.toHaveBeenCalled();
  });
  it('reports guarded revisions as skipped and disconnects', async () => {
    mocks.repair.mockResolvedValue(false); await main(args);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('repair skipped'));
    expect(mocks.disconnect).toHaveBeenCalledOnce();
  });
});
