import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';

const { ticketCreate, nextSequence, insertMany, deleteMany, reservedKeys } = vi.hoisted(() => ({
  ticketCreate: vi.fn(),
  nextSequence: vi.fn(),
  insertMany: vi.fn(),
  deleteMany: vi.fn(),
  reservedKeys: new Set<string>(),
}));

vi.mock('../../../models/supportTicket', () => ({
  default: { create: ticketCreate },
}));

vi.mock('../../../models/calendarReservation', () => ({
  default: { insertMany, deleteMany },
}));

vi.mock('../../../utils/counterSequence', () => ({
  getNextSequence: nextSequence,
}));

vi.mock('../../../utils/support/calendarReservations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../utils/support/calendarReservations')>();
  return {
    ...actual,
    // The real transaction only serializes Mongo; unit tests just run the body.
    withCalendarTransaction: vi.fn(async (fn: (session: unknown) => Promise<unknown>) => fn({})),
  };
});

import {
  buildCalendarReservationKey,
  buildCalendarReservationKeysForInterval,
  releaseCalendarReservations,
  reserveCalendarKeys,
} from '../../../utils/support/calendarReservations';
import {
  buildSupportMeetingSlotKeys,
  createReservedSupportMeetingRecord,
  createSupportTicketRecord,
  meetingSlotKeysReleaseUpdate,
} from '../../../utils/support/meetingReservation';

const professionalId = '507f1f77bcf86cd799439012';
const adminId = '507f1f77bcf86cd799439013';
const start = new Date('2026-11-04T08:30:00.000Z');

const meetingInput = {
  userId: professionalId,
  kind: 'meeting' as const,
  subject: 'Support meeting',
  description: 'Need help',
  reason: 'technical_problem',
  userType: 'professional' as const,
  locale: 'en' as const,
  meeting: { scheduledAt: start },
};

describe('support ticket numbering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    nextSequence.mockResolvedValue('SUP-2026-000001');
    ticketCreate.mockImplementation(async ([doc]: any[]) => [{ _id: doc._id || new Types.ObjectId(), ...doc }]);
  });

  it('uses the atomic SUP-YYYY counter and stores the number', async () => {
    const year = new Date().getUTCFullYear();
    const created = await createSupportTicketRecord(meetingInput);
    expect(nextSequence).toHaveBeenCalledWith(`ticketNumber-${year}`, `SUP-${year}`);
    expect(ticketCreate).toHaveBeenCalledWith(
      [expect.objectContaining({ ticketNumber: 'SUP-2026-000001' })],
      undefined,
    );
    expect(created.ticketNumber).toBe('SUP-2026-000001');
  });

  it('retries a rare ticket-number collision with the next counter value', async () => {
    nextSequence
      .mockResolvedValueOnce('SUP-2026-000001')
      .mockResolvedValueOnce('SUP-2026-000002');
    ticketCreate
      .mockRejectedValueOnce({ code: 11000, keyPattern: { ticketNumber: 1 }, message: 'ticketNumber dup' })
      .mockImplementationOnce(async ([doc]: any[]) => [doc]);

    const created = await createSupportTicketRecord(meetingInput);
    expect(nextSequence).toHaveBeenCalledTimes(2);
    expect(created.ticketNumber).toBe('SUP-2026-000002');
  });

  it('turns a duplicate slotKeys write into a safe 409, never a second booking', async () => {
    ticketCreate.mockRejectedValueOnce({
      code: 11000,
      keyPattern: { 'meeting.slotKeys': 1 },
      message: 'slotKeys dup',
    });
    await expect(createSupportTicketRecord(meetingInput)).rejects.toMatchObject({
      status: 409,
      code: 'SLOT_UNAVAILABLE',
    });
  });
});

describe('atomic meeting reservations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reservedKeys.clear();
    nextSequence.mockResolvedValue('SUP-2026-000001');
    deleteMany.mockResolvedValue({ deletedCount: 0 });
    insertMany.mockImplementation(async (docs: any[]) => {
      for (const doc of docs) {
        if (reservedKeys.has(doc.key)) {
          const error: any = new Error('E11000 duplicate key');
          error.code = 11000;
          throw error;
        }
      }
      for (const doc of docs) reservedKeys.add(doc.key);
      return docs;
    });
    ticketCreate.mockImplementation(async ([doc]: any[]) => [doc]);
  });

  it('builds admin and professional keys from the same UTC instant', () => {
    expect(buildSupportMeetingSlotKeys(adminId, professionalId, start)).toEqual([
      `admin:${adminId}:2026-11-04T08:30:00.000Z`,
      `professional:${professionalId}:2026-11-04T08:30:00.000Z`,
    ]);
  });

  it('rejects concurrent duplicate reservations and creates only one ticket', async () => {
    const [first, second] = await Promise.allSettled([
      createReservedSupportMeetingRecord(meetingInput, { adminId, professionalId, start }),
      createReservedSupportMeetingRecord(meetingInput, { adminId, professionalId, start }),
    ]);

    expect([first.status, second.status].sort()).toEqual(['fulfilled', 'rejected']);
    const rejected = first.status === 'rejected' ? first : second;
    expect(rejected.status === 'rejected' && rejected.reason).toMatchObject({
      status: 409,
      code: 'SLOT_UNAVAILABLE',
    });
    expect(ticketCreate).toHaveBeenCalledTimes(1);
    expect(reservedKeys.size).toBe(4); // two 15-minute buckets x admin + professional
  });

  it('allows adjacent start times', async () => {
    const next = new Date(start.getTime() + 30 * 60 * 1000);
    await createReservedSupportMeetingRecord(meetingInput, { adminId, professionalId, start });
    await createReservedSupportMeetingRecord(meetingInput, { adminId, professionalId, start: next });
    expect(ticketCreate).toHaveBeenCalledTimes(2);
    expect(reservedKeys.size).toBe(8);
  });

  it('detects partial overlaps between a legacy 09:15 meeting and a 09:30 support slot', async () => {
    const legacyStart = new Date('2026-11-04T09:15:00.000Z');
    const legacyEnd = new Date('2026-11-04T09:45:00.000Z');
    await reserveCalendarKeys({
      sourceType: 'meeting_request',
      sourceId: new Types.ObjectId(),
      keys: buildCalendarReservationKeysForInterval({
        role: 'professional',
        userId: professionalId,
        startAt: legacyStart,
        endAt: legacyEnd,
      }),
    });
    await expect(reserveCalendarKeys({
      sourceType: 'support',
      sourceId: new Types.ObjectId(),
      keys: buildCalendarReservationKeysForInterval({
        role: 'professional',
        userId: professionalId,
        startAt: new Date('2026-11-04T09:30:00.000Z'),
        endAt: new Date('2026-11-04T10:00:00.000Z'),
      }),
    })).rejects.toMatchObject({ status: 409, code: 'SLOT_UNAVAILABLE' });
  });

  it('maps duplicate reservation keys to SLOT_UNAVAILABLE', async () => {
    const key = buildCalendarReservationKey({
      role: 'professional',
      userId: professionalId,
      startAt: start,
      endAt: new Date(start.getTime() + 30 * 60 * 1000),
    });
    await reserveCalendarKeys({ sourceType: 'meeting', sourceId: new Types.ObjectId(), keys: [key] });
    await expect(
      reserveCalendarKeys({ sourceType: 'support', sourceId: new Types.ObjectId(), keys: [key] }),
    ).rejects.toMatchObject({ status: 409, code: 'SLOT_UNAVAILABLE' });
  });

  it('releases both ticket slotKeys and shared reservations on cancellation', async () => {
    const ticket: any = {
      _id: new Types.ObjectId('507f1f77bcf86cd799439011'),
      meeting: { slotKeys: ['admin:a:2026-11-04T08:30:00.000Z'] },
      markModified: vi.fn(),
    };
    expect(meetingSlotKeysReleaseUpdate()).toEqual({
      $unset: { 'meeting.slotKeys': 1 },
    });

    await releaseCalendarReservations('support', ticket._id);
    expect(deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({ sourceType: 'support', sourceId: ticket._id }),
      undefined,
    );
  });
});
