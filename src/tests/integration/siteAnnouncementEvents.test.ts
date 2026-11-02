import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import mongoose, { Types } from 'mongoose';
import express from 'express';
import type { Server } from 'node:http';

import publicRouter from '../../routes/Public';
import SiteAnnouncement from '../../models/siteAnnouncement';

const testUri = process.env.FIXERA_TEST_MONGODB_URI;
const hasDisposableMongo = Boolean(testUri && /test/i.test(testUri) && /^mongodb:\/\/(127\.0\.0\.1|localhost)/.test(testUri));
const describeDb = hasDisposableMongo ? describe : describe.skip;

const DAY = 24 * 60 * 60 * 1000;
let server: Server;
let baseUrl = '';
let ipCounter = 0;

const postEvent = (id: string, event: string) =>
  fetch(`${baseUrl}/api/public/site-announcements/${id}/event`, {
    method: 'POST',
    // A fresh IP per request so these assertions never depend on rate-limit state.
    headers: { 'content-type': 'application/json', 'x-forwarded-for': `198.18.0.${(ipCounter += 1)}` },
    body: JSON.stringify({ event }),
  });

const makeAnnouncement = (overrides: Record<string, unknown> = {}) =>
  SiteAnnouncement.create({
    name: 'it-announcement',
    type: 'modal',
    title: 'Local test',
    message: 'Local test message',
    startsAt: new Date(Date.now() - DAY),
    endsAt: new Date(Date.now() + DAY),
    isActive: true,
    createdBy: new Types.ObjectId(),
    ...overrides,
  });

const counters = async (id: unknown) =>
  SiteAnnouncement.findById(id).select('impressions clicks dismissals').lean();

describeDb('public site announcement events (real Mongo)', () => {
  beforeAll(async () => {
    await mongoose.connect(testUri!, { dbName: `fixera_announcement_events_it_${Date.now()}` });
    const app = express();
    app.set('trust proxy', 1);
    app.use(express.json());
    app.use('/api/public', publicRouter);
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await SiteAnnouncement.deleteMany({});
  });

  it('increments exactly the posted counter on a live announcement', async () => {
    const live = await makeAnnouncement();
    expect((await postEvent(String(live._id), 'impression')).status).toBe(204);
    expect((await postEvent(String(live._id), 'impression')).status).toBe(204);
    expect((await postEvent(String(live._id), 'click')).status).toBe(204);
    expect((await postEvent(String(live._id), 'dismissal')).status).toBe(204);
    expect(await counters(live._id)).toMatchObject({ impressions: 2, clicks: 1, dismissals: 1 });
  });

  it.each([
    ['an inactive', { isActive: false }],
    ['an expired', { startsAt: new Date(Date.now() - 3 * DAY), endsAt: new Date(Date.now() - DAY) }],
    ['a not-yet-started', { startsAt: new Date(Date.now() + DAY), endsAt: new Date(Date.now() + 3 * DAY) }],
  ])('refuses events for %s announcement and stores nothing', async (_label, overrides) => {
    const announcement = await makeAnnouncement(overrides);
    for (const kind of ['impression', 'click', 'dismissal']) {
      expect((await postEvent(String(announcement._id), kind)).status).toBe(404);
    }
    expect(await counters(announcement._id)).toMatchObject({ impressions: 0, clicks: 0, dismissals: 0 });
  });

  it('rejects unknown ids and event types', async () => {
    const live = await makeAnnouncement();
    expect((await postEvent('not-an-id', 'impression')).status).toBe(400);
    expect((await postEvent(String(live._id), 'view')).status).toBe(400);
    expect((await postEvent(String(new Types.ObjectId()), 'impression')).status).toBe(404);
    expect(await counters(live._id)).toMatchObject({ impressions: 0, clicks: 0, dismissals: 0 });
  });
});
