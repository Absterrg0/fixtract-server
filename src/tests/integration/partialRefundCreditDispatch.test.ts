import mongoose, { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ dispatch: vi.fn(), download: vi.fn(), upload: vi.fn() }));
vi.mock('../../models/platformSettings', () => ({ default: { getCurrentConfig: async () => ({
  companyAddress: { name: 'Test platform', country: 'BE' }, companyVatNumber: 'BE0123456789',
}) } }));
vi.mock('../../services/peppolDispatch', () => ({ maybeDispatchPeppolInvoice: mocks.dispatch }));
vi.mock('../../utils/s3Upload', () => ({ downloadBufferFromS3: mocks.download,
  uploadBufferToS3: mocks.upload, presignS3Url: vi.fn() }));
vi.mock('../../utils/notifications/notify', () => ({ notify: vi.fn() }));
import '../../models/user';
import '../../models/project';
import Booking from '../../models/booking';
import Payment from '../../models/payment';
import { ensurePartialRefundCreditArtifacts } from '../../services/invoiceArtifacts';

const uri = process.env.FIXERA_TEST_MONGODB_URI;
const describeDb = uri && /test/i.test(uri) ? describe : describe.skip;

describeDb('partial-credit dispatch metadata with isolated Mongo', () => {
  beforeAll(async () => { await mongoose.connect(uri!, { dbName: `credit_dispatch_test_${process.pid}_${Date.now()}` }); });
  afterAll(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });

  it('persists independent credit states in Booking and Payment without rewriting amounts or the latest mirror', async () => {
    const bookingId = new Types.ObjectId();
    const fact = (invoiceNumber: string, status: string) => ({
      key: invoiceNumber, side: 'customer', refundAmount: 10.5, netAmount: 8.68, vatAmount: 1.82,
      invoiceNumber, invoiceUrl: `s3://${invoiceNumber}.pdf`, invoiceUblUrl: `s3://${invoiceNumber}.xml`,
      generatedAt: new Date('2026-10-29'), dispatch: { status, reference: `odoo-${invoiceNumber}` },
    });
    const ledger = [fact('FIRST', 'queued'), fact('LATEST', 'queued')];
    const payment = {
      netAmount: 100, vatAmount: 21, totalWithVat: 121, vatRate: 21, currency: 'EUR',
      status: 'partially_refunded', refundAmount: 21,
      invoiceNumber: 'FIX-ORIGINAL', invoiceUrl: 's3://invoice.pdf',
      creditNoteNumber: 'LATEST', creditNoteUrl: 's3://LATEST.pdf',
      creditNotePeppolDispatchStatus: 'queued', creditNotePeppolDispatchReference: 'odoo-LATEST',
      invoiceSettlementBasis: { customer: { netAmount: 100, vatAmount: 21, totalWithVat: 121, refundAmount: 0 } },
      refundCreditLedger: ledger,
    };
    // Insert minimal fixtures without invoking unrelated account/payment workflows.
    await Booking.collection.insertOne({ _id: bookingId, bookingNumber: 'TEST-CREDIT-DISPATCH',
      location: { country: 'BE' }, payment, quote: { amount: 100 }, quoteVersions: [] } as any);
    await Payment.collection.insertOne({ booking: bookingId, milestoneIndex: null, ...payment } as any);
    mocks.download.mockResolvedValue(Buffer.from('<CreditNote>original</CreditNote>'));
    mocks.dispatch.mockImplementation(async ({ invoiceNumber }) => ({
      status: invoiceNumber === 'FIRST' ? 'queued' : 'sent', provider: 'odoo', attempts: 0,
      reference: `odoo-${invoiceNumber}`, reason: invoiceNumber === 'FIRST' ? 'Delivery in progress' : undefined,
    }));
    expect(await ensurePartialRefundCreditArtifacts(String(bookingId))).toBe('busy');
    expect(mocks.dispatch.mock.calls.map(([args]) => args.invoiceNumber)).toEqual(['FIRST', 'LATEST']);
    const firstBooking = await Booking.findById(bookingId).select('+payment.refundCreditLedger');
    expect(firstBooking?.payment.refundCreditLedger?.map(entry => entry.dispatch?.status)).toEqual(['queued', 'sent']);
    mocks.dispatch.mockClear();
    mocks.dispatch.mockResolvedValue({ status: 'sent', reference: 'odoo-FIRST', provider: 'odoo', attempts: 0 });
    expect(await ensurePartialRefundCreditArtifacts(String(bookingId))).toBe('credited');
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
    expect(mocks.dispatch).toHaveBeenCalledWith(expect.objectContaining({ invoiceNumber: 'FIRST' }));
    const booking = await Booking.findById(bookingId).select('+payment.refundCreditLedger');
    const basePayment = await Payment.findOne({ booking: bookingId }).select('+refundCreditLedger');
    for (const persisted of [booking?.payment, basePayment]) {
      expect(persisted?.creditNoteNumber).toBe('LATEST');
      expect(persisted?.creditNotePeppolDispatchStatus).toBe('sent');
      expect(persisted?.creditNotePeppolDispatchReference).toBe('odoo-LATEST');
      expect(persisted?.refundCreditLedger).toHaveLength(2);
      persisted?.refundCreditLedger?.forEach((entry, index) => {
        expect(entry).toMatchObject({ ...ledger[index], dispatch: {
          status: 'sent', reference: `odoo-${entry.invoiceNumber}`, provider: 'odoo', attempts: 0, lastAttemptAt: expect.any(Date),
        } });
      });
    }
    mocks.dispatch.mockClear();
    expect(await ensurePartialRefundCreditArtifacts(String(bookingId))).toBe('credited');
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
  });
});
