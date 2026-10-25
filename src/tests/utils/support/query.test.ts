import { describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import User from '../../../models/user';
import {
  buildLegacyMeetingRequestFilter,
  buildSupportTicketFilter,
  escapeSupportRegex,
  findSupportMatchingUserIds,
  mergeSupportItemsPage,
  paginationMeta,
  parseSupportListQuery,
} from '../../../utils/support/query';

describe('support list query parsing', () => {
  it('parses a full admin filter set and normalizes reason labels', () => {
    const parsed = parseSupportListQuery({
      q: 'SUP-2026-000001',
      type: 'meeting',
      status: 'scheduled',
      requesterRole: 'professional',
      reason: 'Payment / payout',
      booking: 'with',
      meeting: 'with',
      meetingFrom: '2026-11-01',
      meetingTo: '2026-11-30',
      page: '2',
      limit: '200',
    });

    expect(parsed).toMatchObject({
      page: 2,
      limit: 50,
      kind: 'meeting',
      status: 'scheduled',
      userType: 'professional',
      reason: 'payment_payout',
      bookingMode: 'with',
      meetingMode: 'with',
    });
    expect(parsed.skip).toBe(50);
    expect(parsed.meetingFrom?.toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(parsed.meetingTo?.toISOString()).toBe('2026-11-30T23:59:59.999Z');
  });

  it('accepts a booking number/ObjectId reference', () => {
    expect(parseSupportListQuery({ booking: 'BK-2026-000123' }).bookingRef).toBe('BK-2026-000123');
    expect(parseSupportListQuery({ booking: ' BK-2026-000123 ' }).bookingRef).toBe('BK-2026-000123');
    const id = new Types.ObjectId().toString();
    expect(parseSupportListQuery({ booking: id }).bookingRef).toBe(id);
  });

  it('treats padded booking/meeting mode aliases as modes, not references', () => {
    const parsed = parseSupportListQuery({ booking: ' with ', meeting: ' without ' });
    expect(parsed.bookingMode).toBe('with');
    expect(parsed.meetingMode).toBe('without');
    expect(parsed.bookingRef).toBeUndefined();
  });

  it('rejects invalid enums and oversized search text', () => {
    expect(() => parseSupportListQuery({ status: 'nope' })).toThrow(/Invalid support status/);
    expect(() => parseSupportListQuery({ reason: 'nope' })).toThrow(/Invalid support reason/);
    expect(() => parseSupportListQuery({ userType: 'admin' })).toThrow(/Invalid requester role/);
    expect(() => parseSupportListQuery({ q: 'x'.repeat(101) })).toThrow(/100 characters/);
    expect(() => parseSupportListQuery({ meeting: 'maybe' })).toThrow(/Invalid meeting filter/);
  });

  it('rejects an unbounded page instead of building a huge fetch limit', () => {
    expect(() => parseSupportListQuery({ page: '100000000' })).toThrow(/Page must be between 1 and 200/);
    expect(parseSupportListQuery({ page: '200', limit: '50' })).toMatchObject({
      page: 200,
      limit: 50,
      skip: 9950,
    });
  });

  it('escapes regex metacharacters so q is literal', () => {
    expect(escapeSupportRegex('.*[abc]')).toBe('\\.\\*\\[abc\\]');
  });

  it('rejects a user search that matches an unbounded account set', async () => {
    const spy = vi.spyOn(User, 'find').mockReturnValue({
      select: () => ({
        limit: () => ({
          lean: async () => Array.from({ length: 2001 }, () => ({ _id: new Types.ObjectId() })),
        }),
      }),
    } as any);
    await expect(findSupportMatchingUserIds('a')).rejects.toMatchObject({
      status: 400,
      code: 'VALIDATION',
      field: 'q',
    });
    spy.mockRestore();
  });
});

describe('support Mongo filters', () => {
  it('combines search, status, user type, reason, booking and meeting filters', () => {
    const userId = new Types.ObjectId();
    const parsed = parseSupportListQuery({
      q: 'jan',
      status: 'scheduled',
      userType: 'professional',
      reason: 'booking',
      booking: 'with',
      meetingFrom: '2026-11-01',
    });
    const filter = buildSupportTicketFilter(parsed, [userId]);
    const serialized = JSON.stringify(filter);

    expect(filter).toHaveProperty('$and');
    expect(serialized).toContain('"kind":"meeting"');
    expect(serialized).toContain('"meeting.status":"scheduled"');
    expect(serialized).toContain('"userType":"professional"');
    expect(serialized).toContain('"reason":"booking"');
    expect(serialized).toContain('"booking.bookingId"');
    expect(serialized).toContain(userId.toString());
    expect(serialized).toContain('ticketNumber');
    expect(serialized).toContain('subject');
  });

  it('keeps ticket-status filters to tickets so scheduled meetings do not appear as "open"', () => {
    const filter = buildSupportTicketFilter(parseSupportListQuery({ status: 'open' }));
    expect(filter).toEqual({ kind: { $ne: 'meeting' }, status: 'open' });
    const meetingFilter = buildSupportTicketFilter(parseSupportListQuery({ status: 'scheduled' }));
    expect(meetingFilter).toEqual({ kind: 'meeting', 'meeting.status': 'scheduled' });
  });

  it('includes historical tickets with no kind in the ticket list', () => {
    const filter = buildSupportTicketFilter(parseSupportListQuery({ kind: 'ticket' }));
    expect(filter).toEqual({ kind: { $ne: 'meeting' } });
    const meetingFilter = buildSupportTicketFilter(parseSupportListQuery({ kind: 'meeting' }));
    expect(meetingFilter).toEqual({ kind: 'meeting' });
  });

  it('treats historical tickets without userType as professional', () => {
    const filter = buildSupportTicketFilter(parseSupportListQuery({ userType: 'professional' }));
    expect(JSON.stringify(filter)).toContain('$exists');
    const customerFilter = buildSupportTicketFilter(parseSupportListQuery({ userType: 'customer' }));
    expect(customerFilter).toEqual({ userType: 'customer' });
  });

  it('filters tickets without a booking and without a meeting date', () => {
    const filter = buildSupportTicketFilter(
      parseSupportListQuery({ booking: 'without', meeting: 'without' }),
    );
    const serialized = JSON.stringify(filter);
    expect(serialized).toContain('booking');
    expect(serialized).toContain('meeting.scheduledAt');
    expect(serialized).toContain('$ne');
  });
});

describe('legacy MeetingRequest filters', () => {
  it('is included for meeting/professional searches and q searches', () => {
    const userId = new Types.ObjectId();
    const parsed = parseSupportListQuery({
      q: 'SUP-2026',
      status: 'scheduled',
      userType: 'professional',
      kind: 'meeting',
    });
    const filter = buildLegacyMeetingRequestFilter(parsed, [userId]);
    expect(filter).not.toBeNull();
    const serialized = JSON.stringify(filter);
    expect(serialized).toContain('"status":"scheduled"');
    expect(serialized).toContain(userId.toString());
    expect(serialized).toContain('topic');
  });

  it('is excluded when the filter can only match new support rows', () => {
    expect(buildLegacyMeetingRequestFilter(parseSupportListQuery({ kind: 'ticket' }))).toBeNull();
    expect(buildLegacyMeetingRequestFilter(parseSupportListQuery({ status: 'open' }))).toBeNull();
    expect(buildLegacyMeetingRequestFilter(parseSupportListQuery({ userType: 'customer' }))).toBeNull();
    expect(buildLegacyMeetingRequestFilter(parseSupportListQuery({ reason: 'booking' }))).toBeNull();
    expect(buildLegacyMeetingRequestFilter(parseSupportListQuery({ booking: 'with' }))).toBeNull();
  });

  it('includes legacy rows for booking=without because they have no booking field', () => {
    const filter = buildLegacyMeetingRequestFilter(parseSupportListQuery({ booking: 'without' }));
    expect(filter).not.toBeNull();
    expect(JSON.stringify(filter)).not.toContain('booking');
  });

  it('returns a plain filter with no filters for professional meeting lists', () => {
    expect(buildLegacyMeetingRequestFilter(parseSupportListQuery({ kind: 'meeting' }))).toEqual({});
  });

  it('paginates merge totals consistently', () => {
    expect(paginationMeta(1, 20, 0)).toEqual({ page: 1, limit: 20, total: 0, totalPages: 0 });
    expect(paginationMeta(2, 20, 41)).toEqual({ page: 2, limit: 20, total: 41, totalPages: 3 });
  });

  it('merges new tickets and legacy meetings with stable updatedAt order and no duplicates', () => {
    const merged = mergeSupportItemsPage(
      [
        { _id: 'b', updatedAt: '2026-10-24T10:00:00.000Z' },
        { _id: 'd', updatedAt: '2026-10-24T08:00:00.000Z' },
      ],
      [
        { _id: 'a', updatedAt: '2026-10-24T11:00:00.000Z' },
        { _id: 'c', updatedAt: '2026-10-24T09:00:00.000Z' },
      ],
      0,
      3,
    );
    expect(merged.map((item) => item._id)).toEqual(['a', 'b', 'c']);
    const page2 = mergeSupportItemsPage(
      [
        { _id: 'b', updatedAt: '2026-10-24T10:00:00.000Z' },
        { _id: 'd', updatedAt: '2026-10-24T08:00:00.000Z' },
      ],
      [
        { _id: 'a', updatedAt: '2026-10-24T11:00:00.000Z' },
        { _id: 'c', updatedAt: '2026-10-24T09:00:00.000Z' },
      ],
      3,
      3,
    );
    expect(page2.map((item) => item._id)).toEqual(['d']);
  });
});
