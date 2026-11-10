import mongoose, { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Notification from '../../models/notification';
import { listNotifications } from '../../handlers/User/notificationInbox';
const uri = process.env.FIXERA_TEST_MONGODB_URI;
const describeDb = uri && /test/i.test(uri) ? describe : describe.skip;
const keys = ['customer.loyalty_tier_up', 'professional.leveling_up'];
const userId = new Types.ObjectId();
const call = async (query: Record<string, string>) => {
  const res = { statusCode: 200, body: undefined as any, status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.body = body; return this; } };
  await listNotifications({ user: { _id: userId }, query } as any, res as any); return res;
};
describeDb('notification event filters with stable cursor pagination', () => {
  beforeAll(async () => {
    await mongoose.connect(uri!, { dbName: `ft3_notification_test_${process.pid}_${Date.now().toString(36)}` });
    const common = { userId, category: 'system', title: 'Test', body: 'Test', clickUrl: '/', readAt: null };
    await Notification.collection.insertMany([
      ...Array.from({ length: 155 }, (_, index) => ({ ...common, eventKey: keys[index % 2], createdAt: new Date('2026-10-01') })),
      ...Array.from({ length: 400 }, () => ({ ...common, eventKey: 'customer.booking_created', createdAt: new Date('2026-11-01') })),
      { ...common, eventKey: keys[0], createdAt: new Date('2026-10-01'), readAt: new Date() },
      { ...common, userId: new Types.ObjectId(), eventKey: keys[0], createdAt: new Date('2026-10-01') },
    ] as any[]);
  });
  afterAll(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });
  it('paginates all matching unread events past newer unrelated notifications and tied timestamps', async () => {
    let before = ''; const ids: string[] = []; let pages = 0;
    do {
      const res = await call({ limit: '50', unreadOnly: 'true', eventKeys: keys.join(','), ...(before ? { before } : {}) });
      expect(res.statusCode).toBe(200);
      const data = res.body.data;
      expect(data.items.every((item: any) => keys.includes(item.eventKey) && item.readAt === null)).toBe(true);
      expect(data.unreadCount).toBe(555);
      ids.push(...data.items.map((item: any) => item.id)); before = data.nextCursor; pages++;
    } while (before);
    expect(pages).toBe(4); expect(ids).toHaveLength(155); expect(new Set(ids).size).toBe(155);
  });
  it('keeps the ordinary inbox unfiltered', async () => {
    expect((await call({ limit: '20' })).body.data.items.every((item: any) => item.eventKey === 'customer.booking_created')).toBe(true);
  });
  it('rejects malformed event filters', async () => {
    expect((await call({ eventKeys: '$where' })).statusCode).toBe(400);
  });
});
