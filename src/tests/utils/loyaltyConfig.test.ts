import { afterEach, describe, expect, it, vi } from 'vitest';
import LoyaltyConfig, { defaultLoyaltyTiers } from '../../models/loyaltyConfig';
afterEach(() => vi.restoreAllMocks());
describe('explicit legacy loyalty repair', () => {
  it('never restores an admin-removed tier during reads', async () => {
    const config = { tiers: defaultLoyaltyTiers().slice(0, 3), save: vi.fn() };
    vi.spyOn(LoyaltyConfig, 'findOne').mockResolvedValue(config as any);
    expect(await LoyaltyConfig.getCurrentConfig()).toBe(config);
    expect(config.save).not.toHaveBeenCalled();
    expect(config.tiers).toHaveLength(3);
  });
  it('repairs only a confirmed legacy revision, bounds Gold and records completion atomically', async () => {
    const tiers = defaultLoyaltyTiers().slice(0, 3);
    delete tiers[2].maxSpendingAmount;
    const find = vi.spyOn(LoyaltyConfig, 'findOne').mockReturnValue({ lean: async () => ({ _id: '507f1f77bcf86cd799439011', tiers }) } as any);
    const update = vi.spyOn(LoyaltyConfig.collection, 'updateOne').mockResolvedValue({ modifiedCount: 1 } as any);
    expect(await LoyaltyConfig.backfillConfirmedLegacyConfig('507f1f77bcf86cd799439011', 7)).toBe(true);
    expect(find).toHaveBeenCalledWith({ _id: '507f1f77bcf86cd799439011', version: 7, legacyTierBackfilledAt: { $exists: false } });
    const mutation = update.mock.calls[0][1] as any;
    expect(mutation.$set.tiers.map((tier: any) => tier.name)).toEqual(['Bronze', 'Silver', 'Gold', 'Platinum']);
    expect(mutation.$set.tiers[2].maxSpendingAmount).toBe(9999.99);
    expect(mutation.$set.legacyTierBackfilledAt).toBeInstanceOf(Date);
    find.mockReturnValueOnce({ lean: async () => null } as any);
    expect(await LoyaltyConfig.backfillConfirmedLegacyConfig('507f1f77bcf86cd799439011', 8)).toBe(false);
    expect(update).toHaveBeenCalledOnce();
    expect((update.mock.calls[0][0] as any).tiers[2]).not.toHaveProperty('maxSpendingAmount');
    expect(update.mock.calls[0][0]).toMatchObject({ _id: '507f1f77bcf86cd799439011', version: 7, legacyTierBackfilledAt: { $exists: false } });
    expect(mutation.$inc).toEqual({ version: 1 });
  });
  it('refuses customized thresholds', async () => {
    const tiers = defaultLoyaltyTiers().slice(0, 3); tiers[2].minSpendingAmount = 12000;
    vi.spyOn(LoyaltyConfig, 'findOne').mockReturnValue({ lean: async () => ({ tiers }) } as any);
    const update = vi.spyOn(LoyaltyConfig.collection, 'updateOne');
    await expect(LoyaltyConfig.backfillConfirmedLegacyConfig('507f1f77bcf86cd799439011', 1)).rejects.toThrow('reconciled');
    expect(update).not.toHaveBeenCalled();
  });
  it('previews eligibility without any write', async () => {
    const tiers = defaultLoyaltyTiers().slice(0, 3); delete tiers[2].maxSpendingAmount;
    vi.spyOn(LoyaltyConfig, 'findOne').mockReturnValue({ lean: async () => ({ tiers }) } as any);
    const update = vi.spyOn(LoyaltyConfig.collection, 'updateOne');
    expect(await LoyaltyConfig.backfillConfirmedLegacyConfig('507f1f77bcf86cd799439011', 7, false)).toBe(true);
    expect(update).not.toHaveBeenCalled();
  });

});
