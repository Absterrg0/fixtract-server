import mongoose, { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Super-admin "Reset dashboards": counting-since baselines for the admin
// counters (disputes, cancellations, support tickets, reported chats, review
// moderation) and the booking KPIs. A reset brings a counter to 0.
vi.mock('../../handlers/Stripe/payment', () => ({
  captureAndTransferPayment: vi.fn(),
  executeRefund: vi.fn(),
  RefundError: class RefundError extends Error {},
}));
vi.mock('../../services/invoiceArtifacts', () => ({ ensureBookingInvoiceArtifacts: vi.fn() }));
vi.mock('../../utils/notifications/notify', () => ({ notify: vi.fn() }));

import Booking from '../../models/booking';
import WarrantyClaim from '../../models/warrantyClaim';
import CancellationRequest from '../../models/cancellationRequest';
import ChatReport from '../../models/chatReport';
import SupportTicket from '../../models/supportTicket';
import MeetingRequest from '../../models/meetingRequest';
import AuditLog from '../../models/auditLog';
import {
  AdminDashboardBaseline,
  AdminDashboardBaselineEvent,
} from '../../models/adminDashboardBaseline';
import {
  clampKpiFrom,
  cancellationBaselineClause,
  clauseForDashboard,
  disputeBaselineClause,
  isAdminDashboardKey,
  isHistoryAllRequested,
  withBaselineClause,
} from '../../utils/adminDashboardBaselines';
import {
  getDashboardBaselines,
  resetAllDashboardBaselines,
  resetDashboardBaseline,
  undoDashboardBaseline,
} from '../../handlers/Admin/dashboardBaselines';
import { getDisputes, getDisputeAnalytics } from '../../handlers/Admin/disputeManagement';
import { listCancellationRequests } from '../../handlers/Admin/cancellationRequests';
import { listAdminWarrantyClaims, getAdminWarrantyAnalytics, adminSetWarrantyStatus } from '../../handlers/WarrantyClaim';
import { getKpiSummary } from '../../handlers/Admin/kpiDashboard';
import { computeAdminNavigationBadges } from '../../handlers/Admin/navigationBadges';
import { enforceAdminRoutePermission } from '../../utils/adminRbac/middleware';

const testUri = process.env.FIXERA_TEST_MONGODB_URI;
const hasDisposableMongo = Boolean(testUri && /test/i.test(testUri));
const describeDb = hasDisposableMongo ? describe : describe.skip;

const id = () => new Types.ObjectId();
const ALL_KEYS = ['disputes', 'cancellations', 'supportTickets', 'chatReports', 'reviewModeration', 'bookingKpis'];
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
/** Reset instant used by the filtering tests: one day ago. */
const RESET_AT = new Date(NOW - DAY);
const BEFORE = new Date(NOW - 3 * DAY); // created before the reset
const AFTER = new Date(NOW - DAY / 2); // created after the reset

const superAdmin = () => ({ _id: id(), name: 'Sara Super', email: 'super@baselines.test', role: 'admin', adminRole: 'super' }) as any;
const careAdmin = () => ({ _id: id(), name: 'Carl Care', email: 'care@baselines.test', role: 'admin', adminRole: 'care' }) as any;

/** Minimal Express-like request/response capture for handler calls. */
const makeReq = (overrides: Record<string, any> = {}) => ({
  method: 'GET',
  originalUrl: '/api/admin/platform-settings/dashboard-baselines',
  path: '/platform-settings/dashboard-baselines',
  params: {},
  query: {},
  body: {},
  headers: { 'user-agent': 'vitest' },
  ip: '127.0.0.1',
  ...overrides,
}) as any;

const call = async (handler: (req: any, res: any) => Promise<unknown>, req: any) => {
  let statusCode = 200;
  let body: any;
  const res: any = {
    statusCode: 200,
    status(code: number) { statusCode = code; res.statusCode = code; return res; },
    json(payload: unknown) { body = payload; return res; },
    set() { return res; },
    on() { return res; },
  };
  await handler(req, res);
  return { statusCode, body };
};

describe('dashboard baseline rule (pure)', () => {
  it('recognises the six resettable dashboards; warranty claims are no longer one', () => {
    expect(ALL_KEYS.every(isAdminDashboardKey)).toBe(true);
    // Escalated warranty claims are counted (and reset) under disputes.
    expect(isAdminDashboardKey('warrantyClaims')).toBe(false);
    expect(isAdminDashboardKey('kpi')).toBe(false);
    expect(isAdminDashboardKey('__proto__')).toBe(false);
    expect(isAdminDashboardKey(undefined)).toBe(false);
  });

  it('treats only history=all (any case) as show-all', () => {
    expect(isHistoryAllRequested({ history: 'all' })).toBe(true);
    expect(isHistoryAllRequested({ history: 'ALL' })).toBe(true);
    expect(isHistoryAllRequested({ history: 'open' })).toBe(false);
    expect(isHistoryAllRequested({})).toBe(false);
  });

  it('keeps open disputes and cancellations in every list clause', () => {
    expect(disputeBaselineClause(RESET_AT)).toEqual({
      $or: [{ 'dispute.raisedAt': { $gte: RESET_AT } }, { 'dispute.resolvedAt': null }],
    });
    expect(cancellationBaselineClause(RESET_AT)).toEqual({
      $or: [{ createdAt: { $gte: RESET_AT } }, { status: { $nin: ['approved', 'denied'] } }],
    });
  });

  it('adds no list clause for KPIs (they clamp the range instead), counter-only dashboards, or no baseline', () => {
    expect(clauseForDashboard('bookingKpis', RESET_AT)).toEqual({});
    expect(clauseForDashboard('supportTickets', RESET_AT)).toEqual({});
    expect(clauseForDashboard('chatReports', RESET_AT)).toEqual({});
    expect(clauseForDashboard('reviewModeration', RESET_AT)).toEqual({});
    const base = { status: 'closed' };
    expect(withBaselineClause(base, {})).toBe(base);
    expect(withBaselineClause(base, disputeBaselineClause(RESET_AT))).toEqual({
      $and: [base, disputeBaselineClause(RESET_AT)],
    });
  });

  it('clamps a KPI range start to the reset, and never widens it', () => {
    const from = new Date(NOW - 30 * DAY);
    expect(clampKpiFrom(from, RESET_AT)).toEqual(RESET_AT);
    expect(clampKpiFrom(from, null)).toBe(from);
    const later = new Date(NOW);
    expect(clampKpiFrom(later, RESET_AT)).toBe(later);
  });
});

describe('dashboard baselines permissions (route middleware)', () => {
  const adminRequest = (admin: any, method: string, path = '/platform-settings/dashboard-baselines') => ({
    method,
    path,
    params: {},
    query: {},
    admin,
  }) as any;

  it('rejects a non-super admin before any database work', async () => {
    let nextCalled = false;
    const res: any = {
      statusCode: 200,
      status(code: number) { res.statusCode = code; return res; },
      json(payload: unknown) { res.body = payload; return res; },
    };
    await enforceAdminRoutePermission(adminRequest(careAdmin(), 'GET'), res, () => { nextCalled = true; });
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ code: 'ADMIN_PERMISSION_DENIED' });
  });

  it('rejects a non-super admin on the reset writes as well', async () => {
    for (const path of [
      '/platform-settings/dashboard-baselines/reset-all',
      '/platform-settings/dashboard-baselines/disputes/reset',
      '/platform-settings/dashboard-baselines/disputes/undo',
    ]) {
      let nextCalled = false;
      const res: any = {
        statusCode: 200,
        status(code: number) { res.statusCode = code; return res; },
        json() { return res; },
      };
      await enforceAdminRoutePermission(adminRequest(careAdmin(), 'POST', path), res, () => { nextCalled = true; });
      expect(nextCalled, path).toBe(false);
      expect(res.statusCode, path).toBe(403);
    }
  });
});

describeDb('dashboard baselines (Mongo)', () => {
  beforeAll(async () => {
    await mongoose.connect(testUri!, { dbName: `fixera_dashboard_baselines_it_${Date.now()}` });
  });

  afterAll(async () => {
    await mongoose.connection.db?.dropDatabase();
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await Promise.all([
      Booking,
      WarrantyClaim,
      CancellationRequest,
      ChatReport,
      SupportTicket,
      MeetingRequest,
      AdminDashboardBaseline,
      AdminDashboardBaselineEvent,
      AuditLog,
    ].map((model) => (model as any).collection.deleteMany({})));
  });

  /** Write a baseline directly, as if a reset happened at `at` by `by`. */
  const setBaseline = (key: string, at: Date | null, by = superAdmin()) =>
    AdminDashboardBaseline.updateOne(
      { _id: key },
      { $set: { resetAt: at, resetBy: by._id, resetByName: by.name, note: 'seed', previousResetAt: null } },
      { upsert: true },
    );

  describe('permissions on the handlers', () => {
    it('denies GET and POST reset to a non-super admin and writes nothing', async () => {
      const care = careAdmin();
      const get = await call(getDashboardBaselines, makeReq({ admin: care }));
      expect(get.statusCode).toBe(403);

      const reset = await call(resetDashboardBaseline, makeReq({ method: 'POST', admin: care, params: { key: 'disputes' }, body: {} }));
      expect(reset.statusCode).toBe(403);
      const all = await call(resetAllDashboardBaselines, makeReq({ method: 'POST', admin: care, body: {} }));
      expect(all.statusCode).toBe(403);
      const undo = await call(undoDashboardBaseline, makeReq({ method: 'POST', admin: care, params: { key: 'disputes' } }));
      expect(undo.statusCode).toBe(403);

      expect(await AdminDashboardBaseline.countDocuments({})).toBe(0);
      expect(await AdminDashboardBaselineEvent.countDocuments({})).toBe(0);
    });
  });

  describe('reset, read and undo', () => {
    it('GET lists all six dashboards with no baseline by default', async () => {
      const { statusCode, body } = await call(getDashboardBaselines, makeReq({ admin: superAdmin() }));
      expect(statusCode).toBe(200);
      expect(body.data.dashboards.map((d: any) => d.key)).toEqual(ALL_KEYS);
      for (const dashboard of body.data.dashboards) {
        expect(dashboard).toMatchObject({ resetAt: null, resetBy: null, canUndo: false });
      }
    });

    it('POST reset records who reset the dashboard, the note and a history event', async () => {
      const sara = superAdmin();
      const { statusCode, body } = await call(resetDashboardBaseline, makeReq({
        method: 'POST', admin: sara, params: { key: 'disputes' }, body: { note: '  Clear test bookings  ' },
      }));
      expect(statusCode).toBe(200);
      const disputes = body.data.dashboards.find((d: any) => d.key === 'disputes');
      expect(disputes.resetAt).toBeTruthy();
      expect(disputes.resetBy).toEqual({ id: String(sara._id), name: 'Sara Super' });
      expect(disputes.note).toBe('Clear test bookings');
      expect(disputes.canUndo).toBe(true);
      expect(body.data.history[0]).toMatchObject({ dashboardKey: 'disputes', action: 'reset', actorName: 'Sara Super', note: 'Clear test bookings' });
      // Other dashboards are untouched.
      expect(body.data.dashboards.find((d: any) => d.key === 'cancellations').resetAt).toBeNull();
    });

    it('reset-all sets every dashboard to one shared timestamp and one batch id', async () => {
      const { statusCode, body } = await call(resetAllDashboardBaselines, makeReq({ method: 'POST', admin: superAdmin(), body: {} }));
      expect(statusCode).toBe(200);
      const stamps = new Set(body.data.dashboards.map((d: any) => d.resetAt));
      expect(stamps.size).toBe(1);
      expect(stamps.has(null)).toBe(false);
      const batchIds = new Set(body.data.history.map((event: any) => event.batchId));
      expect(batchIds.size).toBe(1);
      expect(batchIds.has(null)).toBe(false);
      expect(body.data.history).toHaveLength(ALL_KEYS.length);
    });

    it('rejects an unknown dashboard key and an over-long note without writing', async () => {
      const unknown = await call(resetDashboardBaseline, makeReq({ method: 'POST', admin: superAdmin(), params: { key: 'kpi' }, body: {} }));
      expect(unknown.statusCode).toBe(404);
      expect(unknown.body.code).toBe('UNKNOWN_DASHBOARD');

      const long = await call(resetDashboardBaseline, makeReq({
        method: 'POST', admin: superAdmin(), params: { key: 'disputes' }, body: { note: 'x'.repeat(501) },
      }));
      expect(long.statusCode).toBe(400);
      expect(long.body.field).toBe('note');
      expect(await AdminDashboardBaseline.countDocuments({})).toBe(0);
    });

    it('undo restores the value that the latest reset replaced, then refuses a second undo', async () => {
      const sara = superAdmin();
      await call(resetDashboardBaseline, makeReq({ method: 'POST', admin: sara, params: { key: 'disputes' }, body: { note: 'first' } }));
      const first = (await AdminDashboardBaseline.findById('disputes').lean())!.resetAt as Date;
      await new Promise((resolve) => setTimeout(resolve, 5));
      await call(resetDashboardBaseline, makeReq({ method: 'POST', admin: sara, params: { key: 'disputes' }, body: { note: 'second' } }));

      const undo = await call(undoDashboardBaseline, makeReq({ method: 'POST', admin: sara, params: { key: 'disputes' } }));
      expect(undo.statusCode).toBe(200);
      const restored = undo.body.data.dashboards.find((d: any) => d.key === 'disputes');
      expect(new Date(restored.resetAt).getTime()).toBe(first.getTime());
      expect(restored.note).toBe('first');
      expect(restored.canUndo).toBe(false);

      const again = await call(undoDashboardBaseline, makeReq({ method: 'POST', admin: sara, params: { key: 'disputes' } }));
      expect(again.statusCode).toBe(409);
      expect(again.body.code).toBe('NOTHING_TO_UNDO');
    });

    it('undo with no reset to undo is refused', async () => {
      const { statusCode, body } = await call(undoDashboardBaseline, makeReq({ method: 'POST', admin: superAdmin(), params: { key: 'cancellations' } }));
      expect(statusCode).toBe(409);
      expect(body.code).toBe('NOTHING_TO_UNDO');
    });
  });

  describe('undo guard (expectedResetAt)', () => {
    const DASHBOARD_UNDO = { method: 'POST', params: { key: 'disputes' } };
    const undoWith = (admin: any, body: Record<string, unknown>) =>
      call(undoDashboardBaseline, makeReq({ ...DASHBOARD_UNDO, admin, body }));
    const resetDisputes = (admin: any, note: string) =>
      call(resetDashboardBaseline, makeReq({ ...DASHBOARD_UNDO, admin, body: { note } }));
    const currentResetAt = async () =>
      (await AdminDashboardBaseline.findById('disputes').lean())!.resetAt as Date;
    const undoEvents = () => AdminDashboardBaselineEvent.countDocuments({ dashboardKey: 'disputes', action: 'undo' });
    const undoAudits = () => AuditLog.countDocuments({ action: 'admin.dashboard_baseline.undo' });

    /** Two resets in a row. Returns the instants of the first and the second. */
    const resetTwice = async (admin: any) => {
      await resetDisputes(admin, 'first');
      const first = await currentResetAt();
      await new Promise((resolve) => setTimeout(resolve, 5));
      await resetDisputes(admin, 'second');
      return { first, second: await currentResetAt() };
    };

    it('undo succeeds when expectedResetAt matches the current baseline', async () => {
      const sara = superAdmin();
      const { first, second } = await resetTwice(sara);
      const { statusCode, body } = await undoWith(sara, { expectedResetAt: second.toISOString() });
      expect(statusCode).toBe(200);
      const restored = body.data.dashboards.find((d: any) => d.key === 'disputes');
      expect(new Date(restored.resetAt).getTime()).toBe(first.getTime());
      expect(restored.note).toBe('first');
      expect(await undoEvents()).toBe(1);
      expect(await undoAudits()).toBe(1);
    });

    it('a mismatched expectedResetAt returns 409 BASELINE_CHANGED with the current baseline, changes nothing and writes no event', async () => {
      const sara = superAdmin();
      const bruno = { _id: id(), name: 'Bruno Other', email: 'bruno@baselines.test', role: 'admin', adminRole: 'super' } as any;
      // Sara sees the first reset; Bruno resets again before she clicks Undo.
      await resetDisputes(sara, 'seen by Sara');
      const seenBySara = await currentResetAt();
      await new Promise((resolve) => setTimeout(resolve, 5));
      await resetDisputes(bruno, 'reset by Bruno');
      const before = await AdminDashboardBaseline.findById('disputes').lean();
      const eventsBefore = await AdminDashboardBaselineEvent.countDocuments({});
      const undoAuditsBefore = await undoAudits();

      const { statusCode, body } = await undoWith(sara, { expectedResetAt: seenBySara.toISOString() });

      expect(statusCode).toBe(409);
      expect(body).toMatchObject({ success: false, code: 'BASELINE_CHANGED' });
      const shown = body.data.dashboards.find((d: any) => d.key === 'disputes');
      expect(shown).toMatchObject({ note: 'reset by Bruno', canUndo: true, resetBy: { name: 'Bruno Other' } });
      expect(new Date(shown.resetAt).getTime()).toBe((before!.resetAt as Date).getTime());

      const after = await AdminDashboardBaseline.findById('disputes').lean();
      expect(after!.note).toBe('reset by Bruno');
      expect(new Date(after!.resetAt as Date).getTime()).toBe((before!.resetAt as Date).getTime());
      expect(await AdminDashboardBaselineEvent.countDocuments({})).toBe(eventsBefore);
      expect(await undoAudits()).toBe(undoAuditsBefore);
    });

    it('an undo without expectedResetAt works as before', async () => {
      const sara = superAdmin();
      const { first } = await resetTwice(sara);
      const { statusCode, body } = await undoWith(sara, {});
      expect(statusCode).toBe(200);
      const restored = body.data.dashboards.find((d: any) => d.key === 'disputes');
      expect(new Date(restored.resetAt).getTime()).toBe(first.getTime());
    });

    it('an expectedResetAt that is not a timestamp is refused without writing', async () => {
      const sara = superAdmin();
      await resetDisputes(sara, 'only');
      const { statusCode, body } = await undoWith(sara, { expectedResetAt: 'not-a-date' });
      expect(statusCode).toBe(400);
      expect(body).toMatchObject({ code: 'VALIDATION', field: 'expectedResetAt' });
      expect(await undoEvents()).toBe(0);
    });

    it('of two concurrent undos on the same reset, only one applies', async () => {
      const sara = superAdmin();
      const { first, second } = await resetTwice(sara);
      const body = { expectedResetAt: second.toISOString() };
      const [a, b] = await Promise.all([undoWith(sara, body), undoWith(sara, body)]);

      const statuses = [a.statusCode, b.statusCode].sort();
      expect(statuses).toEqual([200, 409]);
      const loser = a.statusCode === 409 ? a : b;
      // The loser sees either the moved baseline or, if it read after the winner
      // finished, no reset left to undo. Either way it changed nothing.
      expect(['BASELINE_CHANGED', 'NOTHING_TO_UNDO']).toContain(loser.body.code);
      expect(await undoEvents()).toBe(1);
      expect(await undoAudits()).toBe(1);
      expect((await currentResetAt()).getTime()).toBe(first.getTime());
    });
  });

  describe('audit trail', () => {
    it('writes one audit entry per reset, reset-all and undo, with the note', async () => {
      const sara = superAdmin();
      await call(resetDashboardBaseline, makeReq({ method: 'POST', admin: sara, params: { key: 'disputes' }, body: { note: 'audit me' } }));
      await call(resetAllDashboardBaselines, makeReq({ method: 'POST', admin: sara, body: {} }));
      await call(undoDashboardBaseline, makeReq({ method: 'POST', admin: sara, params: { key: 'disputes' } }));

      const entries = await AuditLog.find({ action: /^admin\.dashboard_baseline\./ }).sort({ createdAt: 1 }).lean();
      expect(entries.map((e: any) => e.action)).toEqual([
        'admin.dashboard_baseline.reset',
        'admin.dashboard_baseline.reset_all',
        'admin.dashboard_baseline.undo',
      ]);
      expect(entries[0]).toMatchObject({ status: 'success', statusCode: 200, actorRole: 'admin' });
      expect(entries[0].details).toMatchObject({ keys: ['disputes'], note: 'audit me' });
      expect(entries[1].details.keys).toEqual(ALL_KEYS);
      expect(String(entries[0].actor)).toBe(String(sara._id));
    });
  });

  describe('disputes dashboard', () => {
    /**
     * Existing views: "All" = status dispute; "Open" = dispute and unresolved;
     * "Resolved" = resolvedAt set (any status).
     *
     * A: open dispute raised before the reset                → always visible
     * D: open dispute raised after the reset                 → visible
     * B: resolved dispute raised and resolved before the reset → hidden by default
     * C: resolved dispute raised and resolved after the reset  → visible
     */
    const seedDisputes = async () => {
      const customer = id();
      const base = { customer, professional: id(), project: id(), payment: { amount: 10 } };
      await Booking.collection.insertMany([
        { ...base, bookingNumber: 'BK-A-OPEN-OLD', status: 'dispute', dispute: { raisedBy: customer, reason: 'a', raisedAt: BEFORE } },
        { ...base, bookingNumber: 'BK-D-OPEN-NEW', status: 'dispute', dispute: { raisedBy: customer, reason: 'd', raisedAt: AFTER } },
        { ...base, bookingNumber: 'BK-B-RESOLVED-OLD', status: 'completed', dispute: { raisedBy: customer, reason: 'b', raisedAt: BEFORE, resolvedAt: BEFORE } },
        { ...base, bookingNumber: 'BK-C-RESOLVED-NEW', status: 'completed', dispute: { raisedBy: customer, reason: 'c', raisedAt: AFTER, resolvedAt: AFTER } },
      ]);
    };
    const numbersOf = (result: any) => result.body.data.disputes.map((d: any) => d.bookingNumber).sort();

    it('with a baseline: open disputes always stay, closed ones only since the reset, counts match the lists', async () => {
      await seedDisputes();
      await setBaseline('disputes', RESET_AT);

      const all = await call(getDisputes, makeReq({ admin: superAdmin(), query: {} }));
      expect(numbersOf(all)).toEqual(['BK-A-OPEN-OLD', 'BK-D-OPEN-NEW']);
      expect(all.body.data.pagination.total).toBe(2);
      expect(all.body.data.baseline).toMatchObject({ key: 'disputes', applied: true, showAll: false });

      const resolved = await call(getDisputes, makeReq({ admin: superAdmin(), query: { status: 'resolved' } }));
      expect(numbersOf(resolved)).toEqual(['BK-C-RESOLVED-NEW']);
      expect(resolved.body.data.pagination.total).toBe(1);

      const analytics = await call(getDisputeAnalytics, makeReq({ admin: superAdmin(), query: {} }));
      expect(analytics.body.data).toMatchObject({ totalOpen: 2, totalResolved: 1, totalDisputes: 2 });
      expect(analytics.body.data.baseline.applied).toBe(true);
    });

    it('history=all brings the closed dispute from before the reset back into the resolved list and totals', async () => {
      await seedDisputes();
      await setBaseline('disputes', RESET_AT);

      const resolved = await call(getDisputes, makeReq({ admin: superAdmin(), query: { status: 'resolved', history: 'all' } }));
      expect(numbersOf(resolved)).toEqual(['BK-B-RESOLVED-OLD', 'BK-C-RESOLVED-NEW']);
      expect(resolved.body.data.baseline).toMatchObject({ applied: false, showAll: true });

      const analytics = await call(getDisputeAnalytics, makeReq({ admin: superAdmin(), query: { history: 'all' } }));
      expect(analytics.body.data).toMatchObject({ totalOpen: 2, totalResolved: 2, totalDisputes: 2 });
    });

    it('without any baseline nothing is hidden', async () => {
      await seedDisputes();
      const all = await call(getDisputes, makeReq({ admin: superAdmin(), query: {} }));
      expect(all.body.data.pagination.total).toBe(2);
      const resolved = await call(getDisputes, makeReq({ admin: superAdmin(), query: { status: 'resolved' } }));
      expect(resolved.body.data.pagination.total).toBe(2);
      expect(all.body.data.baseline).toMatchObject({ resetAt: null, applied: false });
    });

    it('only the disputes baseline applies to the disputes list', async () => {
      await seedDisputes();
      await setBaseline('cancellations', AFTER);
      const resolved = await call(getDisputes, makeReq({ admin: superAdmin(), query: { status: 'resolved' } }));
      expect(resolved.body.data.pagination.total).toBe(2);
    });
  });

  describe('disputes compose with the recorded-dispute rule', () => {
    /**
     * Main's recorded-dispute rule hides phantom dispute sub-documents (no
     * `raisedBy`). The baseline clause is an `$or` that would admit any row with
     * `raisedAt >= reset` or `resolvedAt: null`, so it must be ANDed onto the
     * recorded filter and never replace it. Phantoms here sit inside the window
     * (after the reset, or open) to prove the clause cannot re-admit them.
     *
     * P-OPEN-OLD, P-OPEN-NEW:      phantom (no actor), open         → never shown
     * R-OPEN-OLD:                  recorded, open, raised before     → always shown
     * R-OPEN-UNDATED:              recorded, open, no raisedAt       → always shown
     * R-RESOLVED-OLD:              recorded, resolved before reset   → hidden by default
     * R-RESOLVED-NEW:              recorded, resolved after reset    → shown
     * P-RESOLVED-NEW:              phantom, resolved after reset     → never shown
     */
    const seedComposed = async () => {
      const customer = id();
      const base = { customer, professional: id(), project: id(), payment: { amount: 10 } };
      await Booking.collection.insertMany([
        { ...base, bookingNumber: 'P-OPEN-OLD', status: 'dispute', dispute: { reason: 'p', raisedAt: BEFORE } },
        { ...base, bookingNumber: 'P-OPEN-NEW', status: 'dispute', dispute: { reason: 'p', raisedAt: AFTER } },
        { ...base, bookingNumber: 'R-OPEN-OLD', status: 'dispute', dispute: { raisedBy: customer, reason: 'a', raisedAt: BEFORE } },
        { ...base, bookingNumber: 'R-OPEN-UNDATED', status: 'dispute', dispute: { raisedBy: customer, reason: 'u' } },
        { ...base, bookingNumber: 'R-RESOLVED-OLD', status: 'completed', dispute: { raisedBy: customer, reason: 'b', raisedAt: BEFORE, resolvedAt: BEFORE } },
        { ...base, bookingNumber: 'R-RESOLVED-NEW', status: 'completed', dispute: { raisedBy: customer, reason: 'c', raisedAt: AFTER, resolvedAt: AFTER } },
        { ...base, bookingNumber: 'P-RESOLVED-NEW', status: 'completed', dispute: { reason: 'p', raisedAt: AFTER, resolvedAt: AFTER } },
      ]);
    };
    const bookingNumbersOf = (result: any) => result.body.data.disputes.map((d: any) => d.bookingNumber).sort();

    it('with a baseline: phantoms never appear, recorded open work always does, and the badge counts only new work', async () => {
      await seedComposed();
      await setBaseline('disputes', RESET_AT);

      const all = await call(getDisputes, makeReq({ admin: superAdmin(), query: {} }));
      expect(bookingNumbersOf(all)).toEqual(['R-OPEN-OLD', 'R-OPEN-UNDATED']);
      expect(all.body.data.pagination.total).toBe(2);

      const open = await call(getDisputes, makeReq({ admin: superAdmin(), query: { status: 'open' } }));
      expect(bookingNumbersOf(open)).toEqual(['R-OPEN-OLD', 'R-OPEN-UNDATED']);

      const resolved = await call(getDisputes, makeReq({ admin: superAdmin(), query: { status: 'resolved' } }));
      expect(bookingNumbersOf(resolved)).toEqual(['R-RESOLVED-NEW']);
      expect(resolved.body.data.pagination.total).toBe(1);

      const analytics = await call(getDisputeAnalytics, makeReq({ admin: superAdmin(), query: {} }));
      expect(analytics.body.data).toMatchObject({ totalOpen: 2, totalResolved: 1, totalDisputes: 2 });

      // The open disputes were raised before the reset (or have no date), so the
      // counter is 0 while the list still shows them.
      const badges = await computeAdminNavigationBadges(superAdmin());
      expect(analytics.body.data.counter).toMatchObject({ total: 0, bookingDisputes: 0 });
      expect(badges.disputes).toBe(0);
    });

    it('history=all widens only the closed side: the old resolved dispute returns, phantoms still never do', async () => {
      await seedComposed();
      await setBaseline('disputes', RESET_AT);

      const resolved = await call(getDisputes, makeReq({ admin: superAdmin(), query: { status: 'resolved', history: 'all' } }));
      expect(bookingNumbersOf(resolved)).toEqual(['R-RESOLVED-NEW', 'R-RESOLVED-OLD']);

      const all = await call(getDisputes, makeReq({ admin: superAdmin(), query: { history: 'all' } }));
      expect(bookingNumbersOf(all)).toEqual(['R-OPEN-OLD', 'R-OPEN-UNDATED']);

      const analytics = await call(getDisputeAnalytics, makeReq({ admin: superAdmin(), query: { history: 'all' } }));
      expect(analytics.body.data).toMatchObject({ totalOpen: 2, totalResolved: 2, totalDisputes: 2 });
    });

    it('without a baseline the recorded rule alone applies: phantoms stay hidden, resolved history is complete', async () => {
      await seedComposed();

      const resolved = await call(getDisputes, makeReq({ admin: superAdmin(), query: { status: 'resolved' } }));
      expect(bookingNumbersOf(resolved)).toEqual(['R-RESOLVED-NEW', 'R-RESOLVED-OLD']);

      const analytics = await call(getDisputeAnalytics, makeReq({ admin: superAdmin(), query: {} }));
      expect(analytics.body.data).toMatchObject({ totalOpen: 2, totalResolved: 2, totalDisputes: 2 });
    });
  });

  describe('warranty claims (no reset of their own)', () => {
    const seedClaims = async () => {
      const base = { booking: id(), customer: id(), professional: id(), reason: 'defect', description: 'd', evidence: [] };
      await WarrantyClaim.collection.insertMany([
        { ...base, claimNumber: 'WC-OLD-CLOSED', status: 'closed', createdAt: BEFORE, openedAt: BEFORE, statusHistory: [] },
        { ...base, claimNumber: 'WC-OLD-OPEN', status: 'open', createdAt: BEFORE, openedAt: BEFORE, statusHistory: [] },
        { ...base, claimNumber: 'WC-NEW-CLOSED', status: 'closed', createdAt: AFTER, openedAt: AFTER, statusHistory: [] },
      ]);
    };

    it('refuses a warranty-claims reset or undo and writes nothing', async () => {
      const reset = await call(resetDashboardBaseline, makeReq({ method: 'POST', admin: superAdmin(), params: { key: 'warrantyClaims' }, body: {} }));
      expect(reset.statusCode).toBe(404);
      const undo = await call(undoDashboardBaseline, makeReq({ method: 'POST', admin: superAdmin(), params: { key: 'warrantyClaims' } }));
      expect(undo.statusCode).toBe(404);
      expect(await AdminDashboardBaseline.countDocuments({})).toBe(0);
      expect(await AdminDashboardBaselineEvent.countDocuments({})).toBe(0);
    });

    it('a stored warranty baseline from before no longer hides claims, and its history entry stays listed', async () => {
      await seedClaims();
      await setBaseline('warrantyClaims', RESET_AT);
      await AdminDashboardBaselineEvent.create({
        dashboardKey: 'warrantyClaims', action: 'reset', resetAt: RESET_AT, previousResetAt: null, actorName: 'Sara Super', createdAt: RESET_AT,
      });

      const list = await call(listAdminWarrantyClaims, makeReq({ user: superAdmin(), query: {} }));
      expect(list.body.data.pagination.total).toBe(3);
      expect(list.body.data.baseline).toBeUndefined();
      const analytics = await call(getAdminWarrantyAnalytics, makeReq({ user: superAdmin(), query: { lastDays: '30' } }));
      expect(analytics.body.data.summary.totalClaims).toBe(3);

      const snapshot = await call(getDashboardBaselines, makeReq({ admin: superAdmin() }));
      expect(snapshot.body.data.dashboards.map((d: any) => d.key)).not.toContain('warrantyClaims');
      expect(snapshot.body.data.history).toEqual([expect.objectContaining({ dashboardKey: 'warrantyClaims', action: 'reset' })]);
    });
  });

  describe('cancellation and refund requests dashboard', () => {
    const seedRequests = async () => {
      const base = { booking: id(), requestedBy: id(), requestedRole: 'customer', reason: 'r' };
      await CancellationRequest.collection.insertMany([
        { ...base, status: 'approved', createdAt: BEFORE, updatedAt: BEFORE },
        { ...base, status: 'pending', createdAt: BEFORE, updatedAt: BEFORE },
        { ...base, status: 'denied', createdAt: AFTER, updatedAt: AFTER },
      ]);
    };

    it('hides only finished requests from before the reset; a pending one stays', async () => {
      await seedRequests();
      await setBaseline('cancellations', RESET_AT);
      const { body } = await call(listCancellationRequests, makeReq({ admin: superAdmin(), query: {} }));
      expect(body.data.items.map((i: any) => i.status).sort()).toEqual(['denied', 'pending']);
      expect(body.data.total).toBe(2);
      expect(body.data.baseline).toMatchObject({ key: 'cancellations', applied: true });
    });

    it('history=all returns the finished request from before the reset', async () => {
      await seedRequests();
      await setBaseline('cancellations', RESET_AT);
      const { body } = await call(listCancellationRequests, makeReq({ admin: superAdmin(), query: { history: 'all' } }));
      expect(body.data.total).toBe(3);
    });
  });

  describe('booking KPI dashboard', () => {
    it('clamps the requested range start to the reset and echoes the baseline', async () => {
      await setBaseline('bookingKpis', RESET_AT);
      const from = new Date(NOW - 30 * DAY).toISOString();
      const { statusCode, body } = await call(getKpiSummary, makeReq({ admin: superAdmin(), query: { from, to: new Date(NOW).toISOString() } }));
      expect(statusCode).toBe(200);
      expect(new Date(body.data.range.from).getTime()).toBe(RESET_AT.getTime());
      expect(body.data.baseline).toMatchObject({ key: 'bookingKpis', applied: true, showAll: false });
    });

    it('a range that ends before the reset collapses to the reset instead of inverting', async () => {
      await setBaseline('bookingKpis', RESET_AT);
      const from = new Date(RESET_AT.getTime() - 20 * DAY).toISOString();
      const to = new Date(RESET_AT.getTime() - 10 * DAY).toISOString();
      const { statusCode, body } = await call(getKpiSummary, makeReq({ admin: superAdmin(), query: { from, to } }));
      expect(statusCode).toBe(200);
      const range = { from: new Date(body.data.range.from).getTime(), to: new Date(body.data.range.to).getTime() };
      expect(range.from).toBe(RESET_AT.getTime());
      expect(range.to).toBe(RESET_AT.getTime());
    });

    it('history=all keeps the requested range start', async () => {
      await setBaseline('bookingKpis', RESET_AT);
      const from = new Date(NOW - 30 * DAY).toISOString();
      const { body } = await call(getKpiSummary, makeReq({ admin: superAdmin(), query: { from, to: new Date(NOW).toISOString(), history: 'all' } }));
      expect(new Date(body.data.range.from).getTime()).toBe(new Date(from).getTime());
      expect(body.data.baseline).toMatchObject({ applied: false, showAll: true });
    });
  });

  describe('counters after a reset', () => {
    /** One item per counter that already waits on an admin (arrived before the reset). */
    const seedOldWork = async () => {
      const customer = id();
      await Promise.all([
        Booking.collection.insertMany([
          { bookingNumber: 'BK-OPEN-OLD', status: 'dispute', customer, professional: id(), project: id(), dispute: { raisedBy: customer, reason: 'x', raisedAt: BEFORE } },
          { bookingNumber: 'BK-REVIEW-OLD', status: 'completed', customerReview: { communicationLevel: 5, valueOfDelivery: 5, qualityOfService: 5, comment: 'ok', reviewedAt: BEFORE } },
        ]),
        CancellationRequest.collection.insertMany([
          { booking: id(), requestedBy: id(), requestedRole: 'professional', status: 'pending', reason: 'r', createdAt: BEFORE, updatedAt: BEFORE },
          { booking: id(), requestedBy: id(), requestedRole: 'customer', status: 'escalated', reason: 'r', createdAt: BEFORE, escalatedAt: BEFORE, updatedAt: BEFORE },
        ]),
        WarrantyClaim.collection.insertOne({
          claimNumber: 'WC-ESC-OLD', booking: id(), customer: id(), professional: id(), status: 'escalated', reason: 'defect',
          description: 'd', openedAt: BEFORE, createdAt: BEFORE, updatedAt: BEFORE, escalation: { escalatedAt: BEFORE, reason: 'declined' },
        }),
        SupportTicket.collection.insertMany([
          { kind: 'ticket', ticketNumber: 'T-OLD', status: 'open', createdAt: BEFORE, replies: [] },
          { kind: 'ticket', ticketNumber: 'T-OLD-WAITING', status: 'open', createdAt: BEFORE, replies: [{ authorRole: 'admin', body: 'a', createdAt: BEFORE }] },
        ]),
        MeetingRequest.collection.insertOne({ userId: id(), topic: 'legacy', status: 'pending', createdAt: BEFORE }),
        ChatReport.collection.insertOne({ messageId: id(), conversationId: id(), reportedBy: id(), reason: 'spam', status: 'pending', createdAt: BEFORE }),
      ]);
    };
    const COUNTER_KEYS = ['cancellationRequests', 'disputes', 'supportTickets', 'chatReports', 'reviewModeration'] as const;
    const counters = async () => {
      const counts = await computeAdminNavigationBadges(superAdmin());
      return Object.fromEntries(COUNTER_KEYS.map((key) => [key, counts[key]]));
    };

    it('reset all brings every counter to 0 while the lists keep the open items; undo brings them back', async () => {
      await seedOldWork();
      expect(await counters()).toEqual({ cancellationRequests: 1, disputes: 3, supportTickets: 2, chatReports: 1, reviewModeration: 1 });

      const sara = superAdmin();
      const reset = await call(resetAllDashboardBaselines, makeReq({ method: 'POST', admin: sara, body: {} }));
      expect(reset.statusCode).toBe(200);
      expect(await counters()).toEqual({ cancellationRequests: 0, disputes: 0, supportTickets: 0, chatReports: 0, reviewModeration: 0 });

      // Non-destructive: the open dispute, the pending cancellation and the escalations are still listed.
      const disputes = await call(getDisputes, makeReq({ admin: sara, query: {} }));
      expect(disputes.body.data.disputes.map((d: any) => d.bookingNumber)).toEqual(['BK-OPEN-OLD']);
      expect(disputes.body.data.externalDisputes.map((d: any) => d.source).sort()).toEqual(['refund', 'warranty']);
      const cancellations = await call(listCancellationRequests, makeReq({ admin: sara, query: { status: 'pending' } }));
      expect(cancellations.body.data.total).toBe(1);
      const analytics = await call(getDisputeAnalytics, makeReq({ admin: sara, query: {} }));
      expect(analytics.body.data).toMatchObject({ totalOpen: 1, escalations: { escalatedRefundRequests: 1, escalatedWarrantyClaims: 1 } });
      expect(analytics.body.data.counter).toMatchObject({ total: 0, bookingDisputes: 0, escalatedRefundRequests: 0, escalatedWarrantyClaims: 0 });
      expect(await Booking.countDocuments({})).toBe(2);

      for (const key of ['cancellations', 'disputes', 'supportTickets', 'chatReports', 'reviewModeration']) {
        const undo = await call(undoDashboardBaseline, makeReq({ method: 'POST', admin: sara, params: { key } }));
        expect(undo.statusCode).toBe(200);
      }
      expect(await counters()).toEqual({ cancellationRequests: 1, disputes: 3, supportTickets: 2, chatReports: 1, reviewModeration: 1 });
    });

    it('each counter counts work that arrives, or comes back to the admin, after its reset', async () => {
      await seedOldWork();
      for (const key of ['cancellations', 'disputes', 'supportTickets', 'chatReports', 'reviewModeration']) {
        await setBaseline(key, RESET_AT);
      }
      expect(await counters()).toEqual({ cancellationRequests: 0, disputes: 0, supportTickets: 0, chatReports: 0, reviewModeration: 0 });

      const customer = id();
      await Promise.all([
        Booking.collection.insertMany([
          { bookingNumber: 'BK-OPEN-NEW', status: 'dispute', customer, professional: id(), project: id(), dispute: { raisedBy: customer, reason: 'y', raisedAt: AFTER } },
          { bookingNumber: 'BK-REVIEW-NEW', status: 'completed', customerReview: { communicationLevel: 4, valueOfDelivery: 4, qualityOfService: 4, comment: 'fine', reviewedAt: AFTER } },
          { bookingNumber: 'BK-REVIEW-NEW-HIDDEN', status: 'completed', customerReview: { communicationLevel: 1, valueOfDelivery: 1, qualityOfService: 1, comment: 'x', reviewedAt: AFTER, isHidden: true } },
        ]),
        CancellationRequest.collection.insertMany([
          { booking: id(), requestedBy: id(), requestedRole: 'professional', status: 'pending', reason: 'r', createdAt: AFTER, updatedAt: AFTER },
          // A customer request waits on the professional: not admin work.
          { booking: id(), requestedBy: id(), requestedRole: 'customer', status: 'pending', reason: 'r', createdAt: AFTER, updatedAt: AFTER },
          // Requested before the reset, escalated after: it reaches dispute management now.
          { booking: id(), requestedBy: id(), requestedRole: 'customer', status: 'escalated', reason: 'r', createdAt: BEFORE, escalatedAt: AFTER, updatedAt: AFTER },
        ]),
        WarrantyClaim.collection.insertOne({
          claimNumber: 'WC-ESC-NEW', booking: id(), customer: id(), professional: id(), status: 'escalated', reason: 'defect',
          description: 'd', openedAt: BEFORE, createdAt: BEFORE, updatedAt: AFTER, escalation: { escalatedAt: AFTER, reason: 'declined' },
        }),
        // The customer answered the admin after the reset: the ticket is admin work again.
        SupportTicket.collection.updateOne({ ticketNumber: 'T-OLD-WAITING' }, { $push: { replies: { authorRole: 'customer', body: 'b', createdAt: AFTER } } as any }),
        ChatReport.collection.insertOne({ messageId: id(), conversationId: id(), reportedBy: id(), reason: 'spam', status: 'pending', createdAt: AFTER }),
      ]);

      expect(await counters()).toEqual({ cancellationRequests: 1, disputes: 3, supportTickets: 1, chatReports: 1, reviewModeration: 1 });
      const analytics = await call(getDisputeAnalytics, makeReq({ admin: superAdmin(), query: {} }));
      expect(analytics.body.data.counter).toMatchObject({ total: 3, bookingDisputes: 1, escalatedRefundRequests: 1, escalatedWarrantyClaims: 1 });
      // Show-all is a list option: it never changes the counter.
      const showAll = await call(getDisputeAnalytics, makeReq({ admin: superAdmin(), query: { history: 'all' } }));
      expect(showAll.body.data.counter.total).toBe(3);
    });

    it('an escalated warranty claim counts from its escalation time, never from a later save', async () => {
      await setBaseline('disputes', RESET_AT);
      const [legacy, open] = [id(), id()];
      await WarrantyClaim.collection.insertMany([
        // Escalated before escalatedAt was recorded, saved (note only) after the reset.
        { _id: legacy, claimNumber: 'WC-LEGACY', booking: id(), customer: id(), professional: id(), status: 'escalated', reason: 'defect', description: 'd', openedAt: BEFORE, createdAt: BEFORE, updatedAt: AFTER },
        { _id: open, claimNumber: 'WC-OPEN', booking: id(), customer: id(), professional: id(), status: 'open', reason: 'defect', description: 'd', openedAt: BEFORE, createdAt: BEFORE, updatedAt: BEFORE, statusHistory: [] },
      ] as any[]);
      const counter = async () => (await call(getDisputeAnalytics, makeReq({ admin: superAdmin(), query: {} }))).body.data.counter;
      expect((await counter()).escalatedWarrantyClaims).toBe(0);

      // An admin escalation records escalatedAt, so the claim is new work now.
      const admin = superAdmin();
      const set = await call(adminSetWarrantyStatus, makeReq({ method: 'POST', user: admin, admin, params: { claimId: String(open) }, body: { status: 'escalated' } }));
      expect(set.statusCode).toBe(200);
      const escalated = await WarrantyClaim.findById(open).lean();
      expect(escalated?.escalation?.escalatedAt).toBeInstanceOf(Date);
      expect((await counter()).escalatedWarrantyClaims).toBe(1);
    });

    it('a failed baseline read does not take down the badges', async () => {
      await CancellationRequest.collection.insertOne(
        { booking: id(), requestedBy: id(), requestedRole: 'professional', status: 'pending', reason: 'r', createdAt: BEFORE, updatedAt: BEFORE } as any,
      );
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const findSpy = vi.spyOn(AdminDashboardBaseline, 'find').mockImplementationOnce(() => {
        throw new Error('baseline read failed');
      });
      const counts = await computeAdminNavigationBadges(superAdmin());
      expect(findSpy).toHaveBeenCalled();
      expect(counts.cancellationRequests).toBe(1);
      expect(counts.disputes).toBe(0);
      findSpy.mockRestore();
    });
  });

  it('the disputes and cancellation clauses never hide an open item', () => {
    // Guard: open statuses are never in the excluded set.
    expect(cancellationBaselineClause(RESET_AT).$or[1]).toEqual({ status: { $nin: ['approved', 'denied'] } });
    expect(disputeBaselineClause(RESET_AT).$or[1]).toEqual({ 'dispute.resolvedAt': null });
  });
});
