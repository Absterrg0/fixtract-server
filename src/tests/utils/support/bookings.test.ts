import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';

const { projectFind } = vi.hoisted(() => ({ projectFind: vi.fn() }));

vi.mock('../../../models/project', () => ({
  default: { find: projectFind },
}));

vi.mock('../../../models/booking', () => ({
  default: {},
}));

import {
  buildSupportBookingOwnershipFilter,
  buildSupportBookingSnapshot,
  professionalDisplayName,
} from '../../../utils/support/bookings';

const booking = (overrides: Record<string, unknown> = {}) => ({
  _id: new Types.ObjectId('507f1f77bcf86cd799439011'),
  bookingNumber: 'BK-2026-000123',
  customer: { _id: '507f1f77bcf86cd799439012', name: 'Jan Peeters' },
  professional: {
    _id: '507f1f77bcf86cd799439013',
    name: 'Piet Janssens',
    username: 'piet',
    businessInfo: { companyName: 'Janssens Bouw' },
  },
  project: { title: 'Bathroom renovation' },
  rfqData: { serviceType: 'Plumbing' },
  ...overrides,
});

describe('support booking labels', () => {
  it('uses the exact "Booking number - Project title - Customer or Professional name" format', () => {
    const snapshot = buildSupportBookingSnapshot(booking(), '507f1f77bcf86cd799439012');
    expect(snapshot.label).toBe('BK-2026-000123 - Bathroom renovation - Janssens Bouw');
    expect(snapshot).toMatchObject({
      bookingNumber: 'BK-2026-000123',
      projectTitle: 'Bathroom renovation',
      counterpartyName: 'Janssens Bouw',
    });
  });

  it('uses the customer as counterparty for a professional participant', () => {
    const snapshot = buildSupportBookingSnapshot(booking(), '507f1f77bcf86cd799439013');
    expect(snapshot.counterpartyName).toBe('Jan Peeters');
    expect(snapshot.label).toBe('BK-2026-000123 - Bathroom renovation - Jan Peeters');
  });

  it('is based on participation, not the account role that created the ticket', () => {
    const professionalWhoBookedAsCustomer = buildSupportBookingSnapshot(
      booking(),
      '507f1f77bcf86cd799439012',
    );
    expect(professionalWhoBookedAsCustomer.counterpartyName).toBe('Janssens Bouw');
  });

  it('falls back to the RFQ service type and professional name', () => {
    const snapshot = buildSupportBookingSnapshot(
      booking({
        project: null,
        professional: { _id: 'p1', name: 'Piet Janssens', businessInfo: {} },
      }),
      '507f1f77bcf86cd799439012',
    );
    expect(snapshot.projectTitle).toBe('Plumbing');
    expect(snapshot.counterpartyName).toBe('Piet Janssens');
  });

  it('prefers company name, then name, then username', () => {
    expect(professionalDisplayName({ businessInfo: { companyName: 'Bouw BV' }, name: 'Piet', username: 'p' })).toBe('Bouw BV');
    expect(professionalDisplayName({ name: 'Piet', username: 'p' })).toBe('Piet');
    expect(professionalDisplayName({ username: 'p' })).toBe('p');
  });
});

describe('support booking ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    projectFind.mockReturnValue({
      select: () => ({ lean: async () => [{ _id: 'project-1' }] }),
    });
  });

  it('matches customer, professional and owned-project participation for every role', async () => {
    const userId = '507f1f77bcf86cd799439012';
    const filter = await buildSupportBookingOwnershipFilter(userId);
    expect(filter).toEqual({
      $or: [
        { customer: userId },
        { professional: userId },
        { project: { $in: ['project-1'] } },
      ],
    });
    expect(projectFind).toHaveBeenCalledWith({ professionalId: userId });
  });

  it('never fetches projects for an unrelated owner id', async () => {
    projectFind.mockReturnValue({ select: () => ({ lean: async () => [] }) });
    const filter = await buildSupportBookingOwnershipFilter('507f1f77bcf86cd799439014');
    expect(filter).toEqual({
      $or: [
        { customer: '507f1f77bcf86cd799439014' },
        { professional: '507f1f77bcf86cd799439014' },
      ],
    });
  });
});
