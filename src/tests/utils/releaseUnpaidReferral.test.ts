import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ retrieve: vi.fn(), cancel: vi.fn(), release: vi.fn(), token: vi.fn() }));
vi.mock('../../services/stripe', () => ({ stripe: { paymentIntents: { retrieve: mocks.retrieve, cancel: mocks.cancel } } }));
vi.mock('../../utils/referralDiscount', () => ({ releaseReferralReservation: mocks.release, getReferralReservationToken: mocks.token }));
import { releaseUnpaidReferral } from '../../utils/releaseUnpaidReferral';
const booking = (status = 'pending') => ({ _id: 'b1', payment: { status, stripePaymentIntentId: 'pi_1', discount: { referralReservationToken: 'pi_1' } } });
beforeEach(() => { vi.resetAllMocks(); mocks.token.mockResolvedValue('attempt-before-intent'); mocks.retrieve.mockResolvedValue({ status: 'requires_payment_method' }); mocks.cancel.mockResolvedValue({ status: 'canceled' }); });
describe('terminal unpaid checkout referral release', () => {
  it('cancels an unpaid checkout before releasing its benefit', async () => {
    await releaseUnpaidReferral(booking());
    expect(mocks.cancel).toHaveBeenCalledWith('pi_1');
    expect(mocks.release).toHaveBeenCalledWith('b1', 'pi_1');
    expect(mocks.cancel.mock.invocationCallOrder[0]).toBeLessThan(mocks.release.mock.invocationCallOrder[0]);
  });
  it('retains the binding when an earlier milestone is paid and a later checkout is pending', async () => {
    await releaseUnpaidReferral({ ...booking(), milestonePayments: [{ status: 'paid' }, { status: 'pending' }] });
    expect(mocks.retrieve).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
  });
  it('releases a reservation made before intent creation', async () => {
    await releaseUnpaidReferral({ _id: 'b1' });
    expect(mocks.release).toHaveBeenCalledWith('b1', 'attempt-before-intent');
    expect(mocks.retrieve).not.toHaveBeenCalled();
  });
  it('keeps failed unpaid checkouts releasable at terminal cancellation', async () => {
    await releaseUnpaidReferral(booking('failed'));
    expect(mocks.release).toHaveBeenCalledWith('b1', 'pi_1');
  });
  it('accepts an already cancelled intent', async () => {
    mocks.retrieve.mockResolvedValue({ status: 'canceled' });
    await releaseUnpaidReferral(booking());
    expect(mocks.release).toHaveBeenCalledWith('b1', 'pi_1');
    expect(mocks.cancel).not.toHaveBeenCalled();
  });
  it.each(['authorized', 'completed', 'partially_refunded', 'refunded'])('retains a settled %s booking', async status => {
    await releaseUnpaidReferral(booking(status));
    expect(mocks.retrieve).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
  });
  it.each(['processing', 'requires_capture', 'succeeded'])('retains an intent that is %s despite a stale pending snapshot', async status => {
    mocks.retrieve.mockResolvedValue({ status });
    await releaseUnpaidReferral(booking());
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
  });
  it('retains the binding when cancellation is unconfirmed or fails', async () => {
    mocks.cancel.mockResolvedValue({ status: 'processing' });
    await releaseUnpaidReferral(booking());
    expect(mocks.release).not.toHaveBeenCalled();
    mocks.cancel.mockRejectedValue(new Error('cancel failed'));
    await expect(releaseUnpaidReferral(booking())).rejects.toThrow('cancel failed');
    expect(mocks.release).not.toHaveBeenCalled();
  });
});
