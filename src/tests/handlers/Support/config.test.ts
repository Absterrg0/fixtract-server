import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

const { connect, chatEnabled, channels, bookings } = vi.hoisted(() => ({
  connect: vi.fn(async () => undefined),
  chatEnabled: vi.fn(async () => false),
  channels: vi.fn(),
  bookings: vi.fn(async () => []),
}));

vi.mock('../../../config/db', () => ({ default: connect }));
vi.mock('../../../utils/support/settings', () => ({
  isSupportChatEnabled: chatEnabled,
  supportChannelsForRole: channels,
}));
vi.mock('../../../utils/support/bookings', () => ({ listSupportBookingOptions: bookings }));

import { getSupportCapabilities } from '../../../handlers/Support/config';

const mockRes = () => {
  const res = {
    statusCode: 200,
    body: undefined as any,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res as Response & { statusCode: number; body: any };
};

describe('support capabilities for manual meeting links', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    channels.mockReturnValue({ tickets: true, meetings: true, chat: false });
  });

  it('advertises meeting booking as available in manual-link mode', async () => {
    const res = mockRes();
    await getSupportCapabilities(
      {
        user: { _id: 'p1', role: 'professional', name: 'Piet', email: 'piet@example.com' },
      } as unknown as Request,
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toMatchObject({
      role: 'professional',
      canPlanMeeting: true,
      meetingProviderAvailable: true,
      meetingBookingAvailable: true,
      meetingLinkMode: 'manual',
      meetingLinkSuppliedByAdmin: true,
      meetingConfirmationRequiresLink: true,
      meetingDurationMinutes: 30,
    });
  });

  it('keeps meetings unavailable to customers while leaving the manual-link flags truthful', async () => {
    const res = mockRes();
    await getSupportCapabilities(
      {
        user: { _id: 'c1', role: 'customer', name: 'Jan', email: 'jan@example.com' },
      } as unknown as Request,
      res,
    );
    expect(res.body.data).toMatchObject({
      role: 'customer',
      canPlanMeeting: false,
      meetingBookingAvailable: true,
      meetingLinkMode: 'manual',
    });
  });
});
