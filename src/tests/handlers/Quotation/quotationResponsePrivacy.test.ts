import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
const mocks = vi.hoisted(() => ({ find: vi.fn(), update: vi.fn(), save: vi.fn() }));
vi.mock('../../../models/booking', () => ({ default: { findById: mocks.find, findOneAndUpdate: mocks.update } }));
vi.mock('../../../models/platformSettings', () => ({ default: { getCurrentConfig: async () => ({ commissionPercent: 17 }) } }));
vi.mock('../../../models/conversation', () => ({ default: { findOne: async () => null } }));
vi.mock('../../../models/serviceConfiguration', () => ({ default: { findOne: () => ({ select: async () => ({
  category: 'Cleaning', service: 'Home cleaning', vatManagement: { enabled: true, article47Classification: 'movable', logicRules: [{ country: 'BE', standardRate: 21, action: 'standard_rate', priority: 0 }] },
}) }) } }));
vi.mock('../../../utils/bookingDetails/quoteTotals', async importOriginal => ({
  ...await importOriginal<any>(),
  buildQuoteCustomerTotalsWithDiscounts: async () => ({ commissionPercent: 17, professionalNetAmount: 100, customerNetAmount: 117, totalWithVat: 141.57, currency: 'EUR', recordedAt: new Date(), discount: { nested: { commission_percentage: 17 } } }),
}));
vi.mock('../../../utils/bookingDetails/quoteFirstStart', () => ({ computeQuoteFirstPossibleStartBounded: async () => null }));
vi.mock('../../../utils/notifications/notify', () => ({ notify: vi.fn() }));
vi.mock('../../../handlers/Stripe/payment', () => ({ createPaymentIntent: vi.fn() }));
vi.mock('../../../utils/support/accountGuard', () => ({ withAnonymizationWriteFence: async (_ids: any, write: any) => write(undefined) }));
import { submitQuotation, editQuotation } from '../../../handlers/Quotation';
import { bookingForViewer } from '../../../utils/invoiceVisibility';

const customerId = new Types.ObjectId();
const professionalId = new Types.ObjectId();
const bookingId = new Types.ObjectId();
const query = (value: any) => {
  const q: any = { populate: () => q, then: (resolve: any, reject: any) => Promise.resolve(value).then(resolve, reject) };
  return q;
};
const body = { scope: 'Recorded cleaning scope', description: 'Clean the house', materialsIncluded: false,
  warrantyDuration: { value: 1, unit: 'months' }, preparationDuration: { value: 1, unit: 'days' }, executionDuration: { value: 1, unit: 'days' },
  pricingLines: [{ description: 'Clean', price: 100, vatRate: 21, vatCountry: 'BE' }], totalAmount: 100, currency: 'EUR', validUntil: '2027-01-01', changeNote: 'Updated scope' };

beforeEach(() => vi.clearAllMocks());
describe.each([['submit', submitQuotation, 'rfq_accepted'], ['edit', editQuotation, 'quoted']] as const)('%s response boundary', (_name, handler, status) => {
  it('keeps professional accounting on the authorized response and strips it when serialized for the customer', async () => {
    const booking: any = { _id: bookingId, status, customer: { _id: customerId, name: 'Customer', location: { country: 'BE' } }, professional: { _id: professionalId, name: 'Professional' },
      project: { category: 'Cleaning', service: 'Home cleaning' }, location: { country: 'BE' }, quotationNumber: 'QT-1', quoteVersions: [], currentQuoteVersion: 0, statusHistory: [], save: mocks.save };
    mocks.find.mockReturnValue(query(booking));
    mocks.update.mockImplementation(async (_filter, update) => ({ ...booking, ...update.$set }));
    const res: any = { status: vi.fn(() => res), json: vi.fn(value => value) };
    const output: any = await handler({ user: { _id: professionalId, role: 'professional' }, params: { bookingId: String(bookingId) }, body } as any, res);
    expect(output.success).toBe(true);
    expect(output.data.booking.quoteVersions.at(-1).customerTotals.commissionPercent).toBe(17);
    expect(JSON.stringify(bookingForViewer(output.data.booking, 'customer'))).not.toMatch(/commissionPercent|commission_percentage/);
    expect(output.data.booking.quoteVersions.at(-1).customerTotals.professionalNetAmount).toBe(100);
  });
  it.each(['customer', 'unrelated'] as const)('denies %s from submitting/editing and returns no booking data', async role => {
    mocks.find.mockReturnValue(query({ _id: bookingId, status, customer: { _id: customerId }, professional: { _id: professionalId } }));
    const res: any = { status: vi.fn(() => res), json: vi.fn(value => value) };
    const output: any = await handler({ user: { _id: role === 'customer' ? customerId : new Types.ObjectId(), role: 'customer' }, params: { bookingId: String(bookingId) }, body } as any, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(output.data).toBeUndefined();
  });
});
