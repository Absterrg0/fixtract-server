/**
 * Catalogue / project text machine translation (translation memory):
 * queueing, language detection, locale selection + fallback on the public
 * project page and search, admin backfill + status endpoints, and the CMS
 * "translate all existing content" backfill.
 *
 * REAL MongoDB (own database, dropped afterwards) and a LOCAL 127.0.0.1 HTTP
 * fixture speaking the Translator v3 /translate and /detect wire format.
 * Nothing leaves the machine. Skipped without FIXERA_TEST_MONGODB_URI.
 */
import cookieParser from 'cookie-parser';
import express from 'express';
import http, { type Server } from 'node:http';
import jwt from 'jsonwebtoken';
import mongoose, { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const testUri = process.env.FIXERA_TEST_MONGODB_URI;
const describeDb = testUri ? describe : describe.skip;

const FIXTURE_KEY = 'local-fixture-translator-key-not-a-secret';
vi.hoisted(() => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'content-translate-test-secret';
  process.env.AZURE_TRANSLATOR_KEY = '';
  process.env.AZURE_TRANSLATOR_REGION = '';
});

import adminRouter from '../../routes/Admin';
import publicRouter from '../../routes/Public';
import searchRouter from '../../routes/Search';
import { localizeApiResponses } from '../../i18n/middleware';
import CmsContent from '../../models/cmsContent';
import ContentTranslation, { ContentLanguageDecision } from '../../models/contentTranslation';
import Project from '../../models/project';
import ServiceConfiguration from '../../models/serviceConfiguration';
import User from '../../models/user';
import { translatorTiming } from '../../utils/cms/azureTranslator';
import {
  loadCmsTranslationOverview,
  processQueuedCmsTranslations,
  queueCmsTranslationBackfill,
} from '../../utils/cms/translationBackfill';
import { waitForCmsTranslationJobs } from '../../utils/cms/translationQueue';
import { loadContentTranslations } from '../../utils/contentTranslation/localize';
import {
  drainContentTranslationQueue,
  enqueueContentTexts,
  waitForContentTranslationJobs,
} from '../../utils/contentTranslation/queue';
import {
  backfillContentTranslations,
  enqueueProjectTexts,
  requestProjectContentTranslation,
} from '../../utils/contentTranslation/sources';
import { contentTextHash } from '../../utils/contentTranslation/texts';
import { waitForAdminTranslationJobs } from '../../handlers/Admin/contentTranslations';

const DUTCH_RE = /\b(het|de|een|schilderen|woonkamer|muren)\b/i;

const fixture = {
  translate: [] as Array<{ from: string; to: string; texts: string[] }>,
  detect: [] as string[][],
  failStatus: 0,
  /** Fails only /detect with this status. */
  failDetectStatus: 0,
  /** Overrides the detected language of a text. */
  detectAs: undefined as undefined | ((text: string) => string | undefined),
  /** Runs before a /translate answer (sees the claimed rows). */
  beforeTranslate: undefined as undefined | (() => Promise<void>),
};

const translatorServer = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const chunks: Buffer[] = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const texts = (JSON.parse(Buffer.concat(chunks).toString('utf8') || '[]') as Array<{ Text: string }>).map(
      (e) => e.Text,
    );
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.headers['ocp-apim-subscription-key'] !== FIXTURE_KEY) {
      return send(401, { error: { code: 401000, message: 'not authorized' } });
    }
    // 403001 is Azure's "quota used up" code.
    if (fixture.failStatus) return send(fixture.failStatus, { error: { code: fixture.failStatus === 403 ? 403001 : fixture.failStatus * 1000, message: 'boom' } });
    if (url.pathname.endsWith('/detect')) {
      if (fixture.failDetectStatus) {
        return send(fixture.failDetectStatus, { error: { code: fixture.failDetectStatus * 1000, message: 'boom' } });
      }
      fixture.detect.push(texts);
      return send(200, texts.map((text) => ({
        language: fixture.detectAs?.(text) ?? (DUTCH_RE.test(text) ? 'nl' : 'en'),
        score: 1,
      })));
    }
    const to = url.searchParams.get('to') || '';
    const from = url.searchParams.get('from') || '';
    void (fixture.beforeTranslate?.() ?? Promise.resolve()).then(() => {
      fixture.translate.push({ from, to, texts });
      send(200, texts.map((text) => ({ translations: [{ to, text: `${to}:${text}` }] })));
    });
  });
});

const app = express();
app.use(cookieParser());
app.use(express.json());
app.use(localizeApiResponses);
app.use('/api/admin', adminRouter);
app.use('/api/public', publicRouter);
app.use('/api/search', searchRouter);
let apiServer: Server;
let api = '';

const cookieFor = (user: { _id: unknown }) =>
  `auth-token=${jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET!, { expiresIn: '1h' })}`;
let superCookie = '';
let careCookie = '';
let professionalId: Types.ObjectId;
let configId: Types.ObjectId;

const call = async (
  method: string,
  path: string,
  options: { cookie?: string; body?: unknown; language?: string } = {},
) => {
  const headers: Record<string, string> = {};
  if (options.cookie) headers.cookie = options.cookie;
  if (options.language) headers['accept-language'] = options.language;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${api}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  expect(text).not.toContain(FIXTURE_KEY);
  return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : undefined };
};

const configureTranslator = (on: boolean) => {
  process.env.AZURE_TRANSLATOR_KEY = on ? FIXTURE_KEY : '';
};

const CATALOGUE = {
  category: 'Interior',
  service: 'Painting',
  pricingOptions: [{ name: 'Total price', pricingType: 'fixed_price' }],
  projectTypes: ['Refurbishment', 'New Build'],
  includedItems: [{ name: 'Wall preparation', isDynamic: false }],
  extraOptions: [{ name: 'Ceiling painting', isCustomizable: false }],
  conditionsAndWarnings: [{ text: 'Empty room required', type: 'condition' }],
  vatManagement: {
    enabled: true,
    reducedVatQuestions: [
      { question: 'Is the home older than 10 years?', fieldName: 'homeAge', answerType: 'yes_no', isRequired: true },
    ],
    professionalVatQuestions: [],
    logicRules: [],
  },
  isActive: true,
  activeCountries: ['BE'],
};

let projectSeq = 0;
async function insertProject(over: Record<string, unknown> = {}) {
  projectSeq += 1;
  const doc = {
    professionalId,
    category: 'Interior',
    service: 'Painting',
    serviceConfigurationId: String(configId),
    title: `Professional interior painting for your home ${projectSeq}`,
    description: 'We paint walls and ceilings with care and leave the room clean.',
    priceModel: 'Total price',
    status: 'published',
    distance: { address: 'Brussels', useCompanyAddress: false, maxKmRange: 50, noBorders: false },
    media: { images: [] },
    subprojects: [
      {
        name: 'Standard package',
        description: 'Two coats on all walls',
        projectType: ['Refurbishment'],
        pricing: { type: 'fixed', amount: 500 },
        included: [{ name: 'Wall preparation', isCustom: false }, { name: 'Furniture protection', isCustom: true }],
        materialsIncluded: false,
        materials: [],
      },
    ],
    extraOptions: [{ name: 'Ceiling painting', price: 100, isCustom: false }],
    termsConditions: [{ name: 'Access', description: 'The room must be accessible', type: 'condition' }],
    rfqQuestions: [{ question: 'Which colour do you want?', type: 'text', isRequired: false, options: [] }],
    faq: [],
    postBookingQuestions: [],
    resources: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
  const inserted = await Project.collection.insertOne(doc as any);
  return { ...doc, _id: inserted.insertedId };
}

describeDb('catalogue/project content translation (real MongoDB, local translator fixture)', () => {
  beforeAll(async () => {
    translatorTiming.sleep = async () => undefined;
    await mongoose.connect(testUri!, { dbName: `fixera_content_tr_it_${Date.now()}` });
    await Promise.all([ContentTranslation.init(), CmsContent.init()]);
    const mk = (role: string, extra: Record<string, unknown> = {}) =>
      User.create({
        name: `ct ${role}`,
        email: `${role}-${new Types.ObjectId().toHexString()}@content-tr.example`,
        phone: `+3249${Math.floor(Math.random() * 1e7)}`,
        password: 'not-used-hash',
        isEmailVerified: true,
        accountStatus: 'active',
        ...extra,
        role: extra.role ?? 'admin',
      });
    superCookie = cookieFor(await mk('super', { adminRole: 'super' }));
    careCookie = cookieFor(await mk('care', { adminRole: 'care' }));
    const pro = await mk('pro', { role: 'professional', professionalStatus: 'approved', username: `pro${Date.now()}` });
    professionalId = pro._id as Types.ObjectId;
    configId = (await ServiceConfiguration.create(CATALOGUE))._id as Types.ObjectId;

    await new Promise<void>((resolve) => translatorServer.listen(0, '127.0.0.1', resolve));
    const tAddr = translatorServer.address();
    if (!tAddr || typeof tAddr === 'string') throw new Error('fixture did not bind');
    process.env.AZURE_TRANSLATOR_ENDPOINT = `http://127.0.0.1:${tAddr.port}/`;

    apiServer = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => apiServer.once('listening', resolve));
    const aAddr = apiServer.address();
    if (!aAddr || typeof aAddr === 'string') throw new Error('api did not bind');
    api = `http://127.0.0.1:${aAddr.port}`;
  });

  afterAll(async () => {
    await waitForContentTranslationJobs();
    await waitForAdminTranslationJobs();
    await waitForCmsTranslationJobs();
    configureTranslator(false);
    await new Promise<void>((resolve) => (apiServer ? apiServer.close(() => resolve()) : resolve()));
    await new Promise<void>((resolve) => translatorServer.close(() => resolve()));
    if (mongoose.connection.name?.startsWith('fixera_content_tr_it_')) await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await waitForContentTranslationJobs();
    await waitForAdminTranslationJobs();
    await waitForCmsTranslationJobs();
    await ContentTranslation.deleteMany({});
    await Project.deleteMany({});
    fixture.translate.length = 0;
    fixture.detect.length = 0;
    fixture.failStatus = 0;
    fixture.failDetectStatus = 0;
    fixture.detectAs = undefined;
    fixture.beforeTranslate = undefined;
    translatorTiming.now = () => Date.now();
    await ContentLanguageDecision.deleteMany({});
    configureTranslator(true);
  });

  it('queues a project idempotently: catalogue text as English, professional text for detection', async () => {
    const project = await insertProject();
    const first = await enqueueProjectTexts(project);
    expect(first).toBeGreaterThan(5);
    expect(await enqueueProjectTexts(project)).toBe(0);

    const byText = new Map((await ContentTranslation.find({}).lean()).map((row) => [row.text, row]));
    expect(byText.get('Wall preparation')).toMatchObject({ from: 'en', origin: 'catalogue', status: 'pending' });
    expect(byText.get('Refurbishment')).toMatchObject({ from: 'en', origin: 'catalogue' });
    expect(byText.get('Total price')).toMatchObject({ from: 'en' });
    expect(byText.get('Furniture protection')).toMatchObject({
      from: 'auto',
      origin: 'project',
      detectGroup: String(project._id),
    });
    expect(byText.get(project.title)).toMatchObject({ from: 'auto' });
    // Values the booking flow matches on are never queued.
    expect(byText.has('fixed')).toBe(false);
    expect(fixture.translate).toHaveLength(0);
  });

  it('drains: detects the professional language once per project and never translates into it', async () => {
    const dutch = await insertProject({
      title: 'Wij schilderen de muren van je woonkamer professioneel en snel',
      description: 'Het schilderen van een woonkamer met twee lagen verf.',
      subprojects: [
        {
          name: 'Basispakket',
          description: 'Twee lagen op de muren',
          projectType: ['Refurbishment'],
          pricing: { type: 'fixed', amount: 400 },
          included: [{ name: 'Wall preparation', isCustom: false }],
        },
      ],
    });
    await enqueueProjectTexts(dutch);
    const summary = await drainContentTranslationQueue();
    expect(summary.stoppedBy).toBeUndefined();
    expect(fixture.detect).toHaveLength(1);

    const title = await ContentTranslation.findOne({ text: dutch.title }).lean();
    expect(title).toMatchObject({ from: 'nl', status: 'done' });
    expect(title?.translations).toEqual({ en: `en:${dutch.title}`, fr: `fr:${dutch.title}` });
    // Short professional text of the same project shares the detected language.
    expect(await ContentTranslation.findOne({ text: 'Basispakket' }).lean()).toMatchObject({ from: 'nl' });
    const catalogue = await ContentTranslation.findOne({ text: 'Wall preparation' }).lean();
    expect(catalogue).toMatchObject({ from: 'en', status: 'done' });
    expect(catalogue?.translations).toEqual({ nl: 'nl:Wall preparation', fr: 'fr:Wall preparation' });
    expect(fixture.translate.every((request) => request.from !== request.to)).toBe(true);
    expect(fixture.translate.some((request) => request.from === 'nl' && request.to === 'nl')).toBe(false);

    // Nothing left: a second drain claims nothing and calls nobody.
    const before = fixture.translate.length;
    expect((await drainContentTranslationQueue()).claimed).toBe(0);
    expect(fixture.translate).toHaveLength(before);
  });

  it('serves only the request locale, skips text already in that language and falls back to the source', async () => {
    await enqueueContentTexts([{ text: 'Wall preparation', from: 'en' }], 'catalogue');
    await enqueueContentTexts([{ text: 'Het schilderen van de muren', from: 'nl' }], 'project');
    await drainContentTranslationQueue();
    const texts = ['Wall preparation', 'Het schilderen van de muren', 'Not translated yet', '12'];

    const nl = await loadContentTranslations(texts, 'nl');
    expect(nl).toEqual({ locale: 'nl', texts: { 'Wall preparation': 'nl:Wall preparation' } });
    const en = await loadContentTranslations(texts, 'en');
    expect(en).toEqual({ locale: 'en', texts: { 'Het schilderen van de muren': 'en:Het schilderen van de muren' } });
    const fr = await loadContentTranslations(texts, 'fr');
    expect(Object.keys(fr!.texts).sort()).toEqual(['Het schilderen van de muren', 'Wall preparation']);
    expect(await loadContentTranslations(['Not translated yet'], 'nl')).toBeUndefined();
    expect(await loadContentTranslations(texts, null)).toBeUndefined();
  });

  it('never overwrites a manual override and keeps a row queued after a provider failure', async () => {
    await enqueueContentTexts([{ text: 'Empty room required', from: 'en' }], 'catalogue');
    await ContentTranslation.updateOne(
      { text: 'Empty room required' },
      { $set: { mode: 'manual', 'translations.nl': 'Lege kamer vereist' } },
    );
    await enqueueContentTexts([{ text: 'Ceiling painting', from: 'en' }], 'catalogue');

    fixture.failStatus = 401;
    // A provider-wide refusal is not the rows' fault: no attempt is charged.
    for (let i = 0; i < 3; i += 1) {
      const refused = await drainContentTranslationQueue();
      expect(refused.stoppedBy).toBe('auth');
    }
    expect(await ContentTranslation.countDocuments({ status: 'pending', leaseUntil: null, attempts: 0 })).toBe(2);
    fixture.failStatus = 403;
    expect((await drainContentTranslationQueue()).stoppedBy).toBe('quota_exceeded');
    expect(await ContentTranslation.countDocuments({ status: 'pending', attempts: 0 })).toBe(2);

    fixture.failStatus = 400;
    for (let i = 0; i < 3; i += 1) await drainContentTranslationQueue();
    expect(await ContentTranslation.findOne({ text: 'Ceiling painting' }).lean()).toMatchObject({
      status: 'failed',
      errorCode: 'provider_error',
      attempts: 3,
    });

    fixture.failStatus = 0;
    await ContentTranslation.updateMany({}, { $set: { status: 'pending', attempts: 0 } });
    await drainContentTranslationQueue();
    const manual = await ContentTranslation.findOne({ text: 'Empty room required' }).lean();
    expect(manual?.translations?.nl).toBe('Lege kamer vereist');
    expect(manual?.status).toBe('done');
  });

  it('a detection failure only affects rows that needed detection', async () => {
    await enqueueContentTexts([{ text: 'Wall preparation', from: 'en' }], 'catalogue');
    await enqueueContentTexts([{ text: 'Wij schilderen de muren', from: 'auto', detectGroup: 'p-detect-fail' }], 'project');

    fixture.failDetectStatus = 400;
    const summary = await drainContentTranslationQueue();
    expect(summary.stoppedBy).toBeUndefined();
    expect(await ContentTranslation.findOne({ text: 'Wall preparation' }).lean()).toMatchObject({ status: 'done', attempts: 0 });
    // The drain retries the undetected row until it is parked; the known row
    // was translated on the first claim and never charged.
    expect(await ContentTranslation.findOne({ text: 'Wij schilderen de muren' }).lean()).toMatchObject({
      status: 'failed',
      from: 'auto',
      attempts: 3,
      errorCode: 'provider_error',
    });
    expect(summary.failed).toBe(1);

    // Provider-wide stop during detection: known rows are released uncharged.
    await enqueueContentTexts([{ text: 'Ceiling painting', from: 'en' }], 'catalogue');
    await enqueueContentTexts([{ text: 'Het schilderen van het plafond', from: 'auto', detectGroup: 'p-auth' }], 'project');
    fixture.failDetectStatus = 401;
    expect((await drainContentTranslationQueue()).stoppedBy).toBe('auth');
    for (const text of ['Ceiling painting', 'Het schilderen van het plafond']) {
      expect(await ContentTranslation.findOne({ text }).lean()).toMatchObject({ status: 'pending', attempts: 0 });
    }
    expect(await ContentTranslation.countDocuments({ claimId: { $exists: true } })).toBe(0);
  });

  it('counts rows that detection parks as unsupported', async () => {
    fixture.detectAs = () => 'de';
    await enqueueContentTexts([{ text: 'Wir streichen die Wände', from: 'auto', detectGroup: 'p-de' }], 'project');
    const summary = await drainContentTranslationQueue();
    expect(summary).toMatchObject({ claimed: 1, translated: 0, failed: 1 });
    expect(await ContentTranslation.findOne({ text: 'Wir streichen die Wände' }).lean()).toMatchObject({
      status: 'failed',
      errorCode: 'unsupported_language',
      from: 'de',
    });
  });

  it("uses a project's persisted language decision instead of its own detection", async () => {
    // Another drain already decided French for this project.
    await ContentLanguageDecision.create({ group: 'p-decided', language: 'fr' });
    await enqueueContentTexts([{ text: 'Wij schilderen de muren', from: 'auto', detectGroup: 'p-decided' }], 'project');
    await drainContentTranslationQueue();
    expect(fixture.detect).toHaveLength(0);
    const row = await ContentTranslation.findOne({ text: 'Wij schilderen de muren' }).lean();
    expect(row).toMatchObject({ from: 'fr', status: 'done' });
    expect(Object.keys(row!.translations || {}).sort()).toEqual(['en', 'nl']);

    // The first detection of a project is persisted for concurrent drains.
    await enqueueContentTexts([{ text: 'Het schilderen van de muren', from: 'auto', detectGroup: 'p-new' }], 'project');
    await drainContentTranslationQueue();
    expect((await ContentLanguageDecision.findOne({ group: 'p-new' }).lean())?.language).toBe('nl');
  });

  it('a claim stays leased until after the drain deadline', async () => {
    await enqueueContentTexts([{ text: 'Wall preparation', from: 'en' }], 'catalogue');
    let leaseUntil: Date | undefined;
    fixture.beforeTranslate = async () => {
      leaseUntil ??= (await ContentTranslation.findOne({ text: 'Wall preparation' }).lean())?.leaseUntil;
    };
    const started = Date.now();
    await drainContentTranslationQueue({ budgetMs: 400_000 });
    expect(leaseUntil!.getTime()).toBeGreaterThanOrEqual(started + 400_000);
  });

  it('public project page: contentTranslations in the request locale, original values unchanged', async () => {
    const project = await insertProject();
    requestProjectContentTranslation(project._id);
    await waitForContentTranslationJobs();

    const nl = await call('GET', `/api/public/projects/${project._id}`, { language: 'nl' });
    expect(nl.status).toBe(200);
    expect(nl.headers.get('vary') || '').toMatch(/accept-language/i);
    const body = nl.body.project;
    expect(body.title).toBe(project.title);
    expect(body.subprojects[0].pricing.type).toBe('fixed');
    expect(body.vatManagement.reducedVatQuestions[0].question).toBe('Is the home older than 10 years?');
    expect(body.contentTranslations.locale).toBe('nl');
    expect(body.contentTranslations.texts).toMatchObject({
      [project.title]: `nl:${project.title}`,
      'Standard package': 'nl:Standard package',
      'Wall preparation': 'nl:Wall preparation',
      Refurbishment: 'nl:Refurbishment',
      'Ceiling painting': 'nl:Ceiling painting',
      'Which colour do you want?': 'nl:Which colour do you want?',
      'Is the home older than 10 years?': 'nl:Is the home older than 10 years?',
    });
    // No other locale leaks into the response.
    expect(JSON.stringify(nl.body)).not.toContain('fr:');

    const en = await call('GET', `/api/public/projects/${project._id}`, { language: 'en' });
    expect(en.body.project.contentTranslations).toBeUndefined();
    const none = await call('GET', `/api/public/projects/${project._id}`);
    expect(none.body.project.contentTranslations).toBeUndefined();
  });

  it('search results carry card and facet translations', async () => {
    const project = await insertProject();
    await enqueueProjectTexts(project);
    await drainContentTranslationQueue();
    const res = await call('GET', '/api/search?type=projects&limit=10', { language: 'fr' });
    expect(res.status).toBe(200);
    expect(res.body.results.some((card: any) => card.title === project.title)).toBe(true);
    expect(res.body.contentTranslations.locale).toBe('fr');
    expect(res.body.contentTranslations.texts[project.title]).toBe(`fr:${project.title}`);
    expect(res.body.contentTranslations.texts.Refurbishment).toBe('fr:Refurbishment');
  });

  it('read paths never call the provider', async () => {
    const project = await insertProject();
    expect((await call('GET', `/api/public/projects/${project._id}`, { language: 'nl' })).status).toBe(200);
    const search = await call('GET', '/api/search?type=projects&limit=10', { language: 'nl' });
    expect(search.status).toBe(200);
    expect(search.body.results.some((card: any) => card.title === project.title)).toBe(true);
    await waitForContentTranslationJobs();
    expect(fixture.translate).toHaveLength(0);
    expect(fixture.detect).toHaveLength(0);
    expect(await ContentTranslation.countDocuments({})).toBe(0);
  });

  it('backfill queues the catalogue and visible projects only, idempotently', async () => {
    await insertProject();
    const draft = await insertProject({ status: 'draft', title: 'A draft project that customers cannot see yet' });
    const first = await backfillContentTranslations();
    expect(first.serviceConfigurations).toBe(1);
    expect(first.projects).toBe(1);
    expect(first.queued).toBeGreaterThan(0);
    expect(await ContentTranslation.exists({ text: draft.title })).toBeNull();
    const second = await backfillContentTranslations();
    expect(second.queued).toBe(0);
  });

  it('admin endpoints: status for any admin, backfill for super admins only, disabled without a key', async () => {
    await insertProject();
    const status = await call('GET', '/api/admin/content-translations/status', { cookie: careCookie });
    expect(status.status).toBe(200);
    expect(status.body.data).toMatchObject({ enabled: true, pending: 0 });

    const denied = await call('POST', '/api/admin/content-translations/backfill', { cookie: careCookie, body: {} });
    expect(denied.status).toBe(403);

    const started = await call('POST', '/api/admin/content-translations/backfill', { cookie: superCookie, body: {} });
    expect(started.status).toBe(202);
    await waitForContentTranslationJobs();
    expect(await ContentTranslation.countDocuments({ status: 'done' })).toBeGreaterThan(5);
    expect(await ContentTranslation.countDocuments({ status: 'pending' })).toBe(0);

    const row = await ContentTranslation.findOne({ text: 'Wall preparation' }).lean();
    const override = await call('PUT', `/api/admin/content-translations/${row!._id}`, {
      cookie: superCookie,
      body: { translations: { nl: 'Voorbereiding van de muren' } },
    });
    expect(override.status).toBe(200);
    expect(override.body.data).toMatchObject({ mode: 'manual', translations: { nl: 'Voorbereiding van de muren' } });

    configureTranslator(false);
    const disabled = await call('GET', '/api/admin/content-translations/status', { cookie: superCookie });
    expect(disabled.body.data.enabled).toBe(false);
    expect(disabled.body.data.disabledReason).toMatch(/AZURE_TRANSLATOR_KEY/);
    const refused = await call('POST', '/api/admin/content-translations/backfill', { cookie: superCookie, body: {} });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('TRANSLATOR_NOT_CONFIGURED');
  });

  it('without a key, saves queue nothing and pages are served as before', async () => {
    configureTranslator(false);
    const project = await insertProject();
    requestProjectContentTranslation(project._id);
    await waitForContentTranslationJobs();
    expect(await ContentTranslation.countDocuments({})).toBe(0);
    const res = await call('GET', `/api/public/projects/${project._id}`, { language: 'nl' });
    expect(res.status).toBe(200);
    expect(res.body.project.contentTranslations).toBeUndefined();
  });

  describe('CMS backfill: content created before auto-translation', () => {
    const legacyDoc = (slug: string, over: Record<string, unknown> = {}) => ({
      type: 'blog',
      title: `Legacy post ${slug}`,
      slug,
      locale: 'en',
      body: '<p>Painting tips for every room.</p>',
      excerpt: 'Tips',
      status: 'published',
      publishedAt: new Date('2026-04-21T15:13:15.303Z'),
      author: professionalId,
      ...over,
    });

    beforeEach(async () => {
      await CmsContent.deleteMany({});
    });

    it('translates existing originals once, leaves manual translations alone, and reports coverage', async () => {
      const a = await CmsContent.collection.insertOne(legacyDoc('legacy-a') as any);
      await CmsContent.collection.insertOne(legacyDoc('legacy-b') as any);
      // Hand-written Dutch version of legacy-a already exists.
      await CmsContent.collection.insertOne(
        legacyDoc('legacy-a', { locale: 'nl', title: 'Handgeschreven', translatedFrom: a.insertedId, autoTranslated: false }) as any,
      );

      const before = await loadCmsTranslationOverview();
      expect(before).toMatchObject({ enabled: true, sources: 2, missing: 2, queued: 0 });

      const queued = await queueCmsTranslationBackfill();
      expect(queued).toEqual({ sources: 2, queued: 2 });
      const drained = await processQueuedCmsTranslations();
      expect(drained.remaining).toBe(0);

      const rows = await CmsContent.find({ translatedFrom: { $ne: null } }).lean();
      const locales = rows.map((row) => `${row.slug}:${row.locale}:${row.autoTranslated ? 'machine' : 'manual'}`).sort();
      expect(locales).toEqual([
        'legacy-a:fr:machine',
        'legacy-a:nl:manual',
        'legacy-b:fr:machine',
        'legacy-b:nl:machine',
      ]);
      expect(rows.find((row) => row.locale === 'nl' && row.slug === 'legacy-a')?.title).toBe('Handgeschreven');
      // Machine translations follow the source's publication.
      expect(rows.filter((row) => row.autoTranslated).every((row) => row.status === 'published')).toBe(true);

      const after = await loadCmsTranslationOverview();
      expect(after).toMatchObject({ sources: 2, missing: 0, queued: 0 });
      expect(await queueCmsTranslationBackfill()).toEqual({ sources: 2, queued: 0 });

      // Public CMS API now returns the Dutch version.
      const list = await call('GET', '/api/public/cms/blog?locale=nl');
      const slugs = (list.body.data.items as any[]).map((item) => `${item.slug}:${item.locale}`).sort();
      expect(slugs).toEqual(['legacy-a:nl', 'legacy-b:nl']);
    });

    it('an original whose run ran out of time stays requested for the next drain', async () => {
      await CmsContent.collection.insertOne(legacyDoc('legacy-budget') as any);
      expect(await queueCmsTranslationBackfill()).toEqual({ sources: 1, queued: 1 });
      // After the first provider call, the clock jumps past every deadline.
      fixture.beforeTranslate = async () => {
        translatorTiming.now = () => Date.now() + 60 * 60_000;
      };
      const first = await processQueuedCmsTranslations();
      expect(first).toEqual({ processed: 1, remaining: 1 });
      const source = await CmsContent.findOne({ slug: 'legacy-budget', locale: 'en' }).lean();
      expect(source?.translationRun?.requested).toBe(true);
      expect((source?.translationResults as any[]).some((r) => r.errorCode === 'budget_exceeded')).toBe(true);

      fixture.beforeTranslate = undefined;
      translatorTiming.now = () => Date.now();
      expect(await processQueuedCmsTranslations()).toEqual({ processed: 1, remaining: 0 });
      expect((await loadCmsTranslationOverview()).missing).toBe(0);
    });

    it('admin overview + backfill endpoint (super admin only; clear message without a key)', async () => {
      await CmsContent.collection.insertOne(legacyDoc('legacy-c') as any);
      const overview = await call('GET', '/api/admin/cms/translation-backfill', { cookie: superCookie });
      expect(overview.body.data).toMatchObject({ enabled: true, sources: 1, missing: 1 });

      expect((await call('POST', '/api/admin/cms/translation-backfill', { cookie: careCookie })).status).toBe(403);
      const started = await call('POST', '/api/admin/cms/translation-backfill', { cookie: superCookie });
      expect(started.status).toBe(202);
      await waitForAdminTranslationJobs();
      expect((await loadCmsTranslationOverview()).missing).toBe(0);

      configureTranslator(false);
      const disabled = await call('GET', '/api/admin/cms/translation-backfill', { cookie: superCookie });
      expect(disabled.body.data).toMatchObject({ enabled: false });
      expect(disabled.body.data.disabledReason).toMatch(/AZURE_TRANSLATOR_KEY/);
      const refused = await call('POST', '/api/admin/cms/translation-backfill', { cookie: superCookie });
      expect(refused.status).toBe(409);
    });
  });
});

it('hash keys trim whitespace', () => {
  expect(contentTextHash('  Wall preparation ')).toBe(contentTextHash('Wall preparation'));
});
