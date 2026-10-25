import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../services/stripe', () => ({
  stripe: {},
  STRIPE_CONFIG: { supportedCurrencies: [], defaultCurrency: 'EUR', environment: 'test' },
}));

import { buildCheckoutSnapshot } from '../../../handlers/Booking';
import { toHandlerError } from '../../../utils/handlerErrors';

const snapshotFor = (unit: string) => buildCheckoutSnapshot({
  project: { extraOptions: [] },
  selectedSubproject: { pricing: { type: 'unit', amount: 25, unit } },
  selectedExtraOptions: [],
  estimatedUsage: 2,
});

const thrown = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('Expected the call to throw');
};

describe('booking checkout unit validation', () => {
  it('keeps the actionable UNECE unit error as a 400', () => {
    const error = thrown(() => snapshotFor('frobnicate'));
    expect(error).toMatchObject({ name: 'UserFacingError', status: 400, code: 'VALIDATION' });
    expect((error as Error).message).toContain('Unknown booking unit "frobnicate"');
    expect((error as Error).message).toContain('UNECE');

    const mapped = toHandlerError(error, "We couldn't create your booking. Please try again.");
    expect(mapped.status).toBe(400);
    expect(mapped.body).toMatchObject({
      success: false,
      code: 'VALIDATION',
      msg: expect.stringContaining('Unknown booking unit "frobnicate"'),
    });
  });

  it('still accepts a validated unit', () => {
    expect(snapshotFor('m2')).toMatchObject({ unit: 'm²', quantity: 2, totalAmount: 50 });
  });
});
