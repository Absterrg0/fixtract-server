/**
 * Super Admin panel rearrangement #1 / frontend F6: public CMS country
 * filtering prefers the frontend's first-party `x-fixera-content-country`
 * (effective auto-conversion country: geo inside the roll-out, else the admin
 * default country) and falls back to the platform geo headers.
 *
 * Country targeting is display filtering, not authorization: these tests pin
 * which country-targeted rows are listed, never access control.
 *
 * Real MongoDB (FIXERA_TEST_MONGODB_URI, disposable local DB; skipped otherwise),
 * real express header parsing through the real public router.
 */
import express from 'express';
import type { Server } from 'node:http';
import mongoose, { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const testUri = process.env.FIXERA_TEST_MONGODB_URI;
const describeDb = testUri ? describe : describe.skip;

vi.hoisted(() => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'cms-country-test-secret';
});

import publicRouter from '../../routes/Public';
import { CMS_CONTENT_COUNTRY_HEADER, requestCountryCode } from '../../handlers/Public/cms';

const TAG = 'cmscountry-it';

describe('requestCountryCode precedence (pure)', () => {
  const req = (headers: Record<string, string>) => ({
    get: (name: string) => headers[name.toLowerCase()],
  }) as any;

  it('prefers the first-party header, then x-vercel-ip-country, then cf-ipcountry', () => {
    expect(CMS_CONTENT_COUNTRY_HEADER).toBe('x-fixera-content-country');
    expect(requestCountryCode(req({ 'x-fixera-content-country': 'be', 'x-vercel-ip-country': 'DE', 'cf-ipcountry': 'FR' }))).toBe('BE');
    expect(requestCountryCode(req({ 'x-vercel-ip-country': 'DE', 'cf-ipcountry': 'FR' }))).toBe('DE');
    expect(requestCountryCode(req({ 'cf-ipcountry': 'FR' }))).toBe('FR');
    expect(requestCountryCode(req({}))).toBeUndefined();
  });

  it('falls through invalid values instead of trusting them', () => {
    expect(requestCountryCode(req({ 'x-fixera-content-country': 'ZZ', 'x-vercel-ip-country': 'NL' }))).toBe('NL');
    expect(requestCountryCode(req({ 'x-fixera-content-country': 'EU', 'x-vercel-ip-country': 'XX', 'cf-ipcountry': 'BE' }))).toBe('BE');
    expect(requestCountryCode(req({ 'x-fixera-content-country': 'Belgium' }))).toBeUndefined();
  });
});

describeDb('public CMS content-country header (real MongoDB)', () => {
  const app = express();
  app.set('trust proxy', 1);
  app.use('/api/public', publicRouter);
  let server: Server;
  let baseUrl = '';
  const ids = {
    global: new Types.ObjectId(),
    beOnly: new Types.ObjectId(),
    nlOnly: new Types.ObjectId(),
    beOnlyFr: new Types.ObjectId(),
    beDraft: new Types.ObjectId(),
    faqBe: new Types.ObjectId(),
    faqNl: new Types.ObjectId(),
  };
  const publishedAt = new Date('2026-10-01T10:00:00.000Z');
  const doc = (over: Record<string, any>) => ({
    type: 'blog',
    locale: 'en',
    status: 'published',
    body: '<p>QA</p>',
    excerpt: 'QA',
    tags: [TAG],
    activeCountries: [],
    publishedAt,
    createdAt: publishedAt,
    updatedAt: publishedAt,
    ...over,
  });

  beforeAll(async () => {
    await mongoose.connect(testUri!);
    const cms = mongoose.connection.collection('cmscontents');
    await cms.deleteMany({ tags: TAG });
    await cms.insertMany([
      doc({ _id: ids.global, title: 'Global guide', slug: `${TAG}-global` }),
      doc({ _id: ids.beOnly, title: 'Belgium guide', slug: `${TAG}-be`, activeCountries: ['BE'] }),
      doc({ _id: ids.nlOnly, title: 'Netherlands guide', slug: `${TAG}-nl`, activeCountries: ['NL'] }),
      doc({ _id: ids.beOnlyFr, title: 'Guide Belgique', slug: `${TAG}-be`, locale: 'fr', activeCountries: ['BE'], translatedFrom: ids.beOnly }),
      doc({ _id: ids.beDraft, title: 'Belgium draft', slug: `${TAG}-be-draft`, status: 'draft', publishedAt: undefined, activeCountries: ['BE'] }),
      doc({ _id: ids.faqBe, type: 'faq', category: 'general', title: 'BE question', slug: `${TAG}-faq-be`, activeCountries: ['BE'] }),
      doc({ _id: ids.faqNl, type: 'faq', category: 'general', title: 'NL question', slug: `${TAG}-faq-nl`, activeCountries: ['NL'] }),
    ]);
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.collection('cmscontents').deleteMany({ tags: TAG });
      await mongoose.disconnect();
    }
  });

  const get = async (path: string, headers: Record<string, string> = {}) => {
    const response = await fetch(`${baseUrl}/api/public${path}`, { headers });
    return { status: response.status, body: await response.json() };
  };
  const listSlugs = async (headers: Record<string, string>, locale = 'en') => {
    const { status, body } = await get(`/cms/blog?tag=${TAG}&locale=${locale}&limit=50`, headers);
    expect(status).toBe(200);
    return (body.data.items as any[]).map((item) => `${item.locale}:${item.slug}`).sort();
  };
  const faqTitles = async (headers: Record<string, string>) => {
    const { status, body } = await get('/cms/faq?locale=en', headers);
    expect(status).toBe(200);
    return (body.data.groups as any[])
      .flatMap((group) => group.items)
      .map((item: any) => item.title)
      .filter((title: string) => title.endsWith('question'))
      .sort();
  };

  it('default country outside the roll-out: first-party BE wins over a replaced platform geo (DE)', async () => {
    const headers = { 'x-fixera-content-country': 'BE', 'x-vercel-ip-country': 'DE' };
    expect(await listSlugs(headers)).toEqual([`en:${TAG}-be`, `en:${TAG}-global`]);
    expect((await get(`/cms/blog/${TAG}-be?locale=en`, headers)).status).toBe(200);
    expect((await get(`/cms/blog/${TAG}-nl?locale=en`, headers)).status).toBe(404);
    expect(await faqTitles(headers)).toEqual(['BE question']);
  });

  it('roll-out visitor: first-party NL shows NL-only content and hides BE-only', async () => {
    const headers = { 'x-fixera-content-country': 'NL', 'x-vercel-ip-country': 'US' };
    expect(await listSlugs(headers)).toEqual([`en:${TAG}-global`, `en:${TAG}-nl`]);
    expect((await get(`/cms/blog/${TAG}-be?locale=en`, headers)).status).toBe(404);
    expect(await faqTitles(headers)).toEqual(['NL question']);
  });

  it('falls back to platform geo headers when the first-party header is absent or invalid', async () => {
    expect(await listSlugs({ 'x-vercel-ip-country': 'NL' })).toEqual([`en:${TAG}-global`, `en:${TAG}-nl`]);
    expect(await listSlugs({ 'cf-ipcountry': 'BE' })).toEqual([`en:${TAG}-be`, `en:${TAG}-global`]);
    expect(await listSlugs({ 'x-fixera-content-country': 'ZZ', 'x-vercel-ip-country': 'NL' })).toEqual([
      `en:${TAG}-global`,
      `en:${TAG}-nl`,
    ]);
    // No usable country at all: global content only.
    expect(await listSlugs({})).toEqual([`en:${TAG}-global`]);
    expect(await faqTitles({})).toEqual([]);
  });

  it('manual locale is independent of content country (fr translation follows its source country)', async () => {
    const be = { 'x-fixera-content-country': 'BE', 'x-vercel-ip-country': 'NL' };
    // fr visitor in BE: the fr translation replaces its en source; global falls back to en.
    expect(await listSlugs(be, 'fr')).toEqual([`en:${TAG}-global`, `fr:${TAG}-be`]);
    const frDetail = await get(`/cms/blog/${TAG}-be?locale=fr`, be);
    expect(frDetail.status).toBe(200);
    expect(frDetail.body.data.locale).toBe('fr');
    // Same manual locale with content country NL: the BE-only translation stays hidden.
    const nl = { 'x-fixera-content-country': 'NL', 'x-vercel-ip-country': 'BE' };
    expect(await listSlugs(nl, 'fr')).toEqual([`en:${TAG}-global`, `en:${TAG}-nl`]);
    expect((await get(`/cms/blog/${TAG}-be?locale=fr`, nl)).status).toBe(404);
  });

  it('never lists drafts, whatever country is sent', async () => {
    for (const country of ['BE', 'NL', 'DE']) {
      const slugs = await listSlugs({ 'x-fixera-content-country': country });
      expect(slugs).not.toContain(`en:${TAG}-be-draft`);
    }
    expect((await get(`/cms/blog/${TAG}-be-draft?locale=en`, { 'x-fixera-content-country': 'BE' })).status).toBe(404);
  });
});
