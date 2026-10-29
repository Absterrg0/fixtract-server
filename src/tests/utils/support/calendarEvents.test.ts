import { beforeEach, describe, expect, it, vi } from 'vitest';

const { ticketFind, legacyFind } = vi.hoisted(() => ({
  ticketFind: vi.fn(),
  legacyFind: vi.fn(),
}));

vi.mock('../../../models/supportTicket', () => ({ default: { find: ticketFind } }));
vi.mock('../../../models/meetingRequest', () => ({ default: { find: legacyFind } }));

import { listSupportCalendarEvents } from '../../../utils/support/calendarEvents';

const chain = (docs: unknown[]) => {
  const query: any = {
    select: () => query,
    sort: () => query,
    populate: () => query,
    lean: async () => docs,
  };
  return query;
};

const start = new Date('2026-11-04T08:30:00.000Z');
const end = new Date('2026-11-04T09:00:00.000Z');

describe('support calendar event feed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns real meetings and legacy rows without any admin identity to the owner', async () => {
    ticketFind.mockReturnValue(chain([
      {
        _id: 't1',
        userId: 'p1',
        ticketNumber: 'SUP-2026-000001',
        subject: 'Support meeting',
        status: 'open',
        meeting: {
          status: 'pending',
          scheduledAt: start,
          durationMinutes: 30,
          timeZone: 'Europe/Brussels',
          adminId: { _id: 'a1', name: 'Admin One' },
        },
      },
      {
        _id: 't2',
        userId: 'p1',
        ticketNumber: 'SUP-2026-000002',
        subject: 'Confirmed meeting',
        status: 'open',
        meeting: {
          status: 'scheduled',
          scheduledAt: new Date('2026-11-05T08:30:00.000Z'),
          durationMinutes: 30,
          timeZone: 'Europe/Brussels',
          meetingLink: 'https://meet.example/room',
        },
      },
    ]));
    legacyFind.mockReturnValue(chain([
      {
        _id: 'mr1',
        userId: 'p1',
        topic: 'Old meeting',
        status: 'scheduled',
        scheduledAt: new Date('2026-11-06T08:30:00.000Z'),
        durationMinutes: 45,
      },
    ]));

    const events = await listSupportCalendarEvents({
      viewer: 'professional',
      userId: 'p1',
      from: new Date('2026-11-01T00:00:00.000Z'),
      to: new Date('2026-11-08T00:00:00.000Z'),
      timeZone: 'Europe/Brussels',
    });

    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({
      id: 't1',
      status: 'pending',
      start: start.toISOString(),
      end: end.toISOString(),
      meetingLink: null,
      legacy: false,
    });
    expect(events[1]).toMatchObject({
      id: 't2',
      status: 'scheduled',
      meetingLink: 'https://meet.example/room',
    });
    expect(events[2]).toMatchObject({
      id: 'mr1',
      ticketNumber: null,
      legacy: true,
      meetingLink: null,
      durationMinutes: 45,
    });
    expect(JSON.stringify(events)).not.toContain('adminId');
    expect(JSON.stringify(events)).not.toContain('Admin One');
  });

  it('gives the admin feed the assigned admin and requester but never notes', async () => {
    ticketFind.mockReturnValue(chain([{
      _id: 't1',
      userId: { _id: 'p1', name: 'Piet', email: 'piet@example.com', role: 'professional' },
      ticketNumber: 'SUP-2026-000001',
      subject: 'Support meeting',
      status: 'open',
      internalNotes: [{ body: 'SECRET NOTE' }],
      meeting: {
        status: 'scheduled',
        scheduledAt: start,
        durationMinutes: 30,
        timeZone: 'Europe/Brussels',
        meetingLink: 'https://meet.example/room',
        adminId: { _id: 'a1', name: 'Admin One' },
        slotKeys: ['admin:a1:...'],
      },
    }]));
    legacyFind.mockReturnValue(chain([]));

    const events = await listSupportCalendarEvents({
      viewer: 'admin',
      from: new Date('2026-11-01T00:00:00.000Z'),
      to: new Date('2026-11-08T00:00:00.000Z'),
      timeZone: 'UTC',
    });

    expect(events[0]).toMatchObject({
      id: 't1',
      admin: { id: 'a1', name: 'Admin One' },
      user: { id: 'p1', name: 'Piet', email: 'piet@example.com' },
    });
    expect(JSON.stringify(events)).not.toContain('SECRET NOTE');
    expect(JSON.stringify(events)).not.toContain('slotKeys');
  });

  it('keeps only genuine https links in calendar events', async () => {
    ticketFind.mockReturnValue(chain([{
      _id: 't1',
      userId: 'p1',
      ticketNumber: 'SUP-2026-000001',
      subject: 'Support meeting',
      status: 'open',
      meeting: {
        status: 'scheduled',
        scheduledAt: start,
        durationMinutes: 30,
        meetingLink: 'javascript:alert(1)',
      },
    }]));
    legacyFind.mockReturnValue(chain([]));

    const [event] = await listSupportCalendarEvents({
      viewer: 'professional',
      userId: 'p1',
      from: new Date('2026-11-01T00:00:00.000Z'),
      to: new Date('2026-11-08T00:00:00.000Z'),
      timeZone: 'UTC',
    });
    expect(event.meetingLink).toBeNull();
  });
});
