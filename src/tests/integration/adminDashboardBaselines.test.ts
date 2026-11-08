import mongoose, { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Super-admin "Reset dashboards": counting-since baselines for the booking-flow
// dashboards (disputes, warranty claims, cancellations/refunds, booking KPIs).
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
  warrantyBaselineClause,
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
import { listAdminWarrantyClaims, getAdminWarrantyAnalytics } from '../../handlers/WarrantyClaim';
import { getKpiSummary } from '../../handlers/Admin/kpiDashboard';
import { computeAdminNavigationBadges } from '../../handlers/Admin/navigationBadges';
import { enforceAdminRoutePermission } from '../../utils/adminRbac/middleware';

const testUri = process.env.FIXERA_TEST_MONGODB_URI;
const hasDisposableMongo = Boolean(testUri && /test/i.test(testUri));
const describeDb = hasDisposableMongo ? describe : describe.skip;

const id = () => new Types.ObjectId();
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
  it('recognises only the four booking-flow dashboards', () => {
    expect(['disputes', 'warrantyClaims', 'cancellations', 'bookingKpis'].every(isAdminDashboardKey)).toBe(true);
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

  it('keeps open disputes, warranty claims and cancellations in every clause', () => {
    expect(disputeBaselineClause(RESET_AT)).toEqual({
      $or: [{ 'dispute.raisedAt': { $gte: RESET_AT } }, { 'dispute.resolvedAt': null }],
    });
    expect(warrantyBaselineClause(RESET_AT)).toEqual({
      $or: [{ createdAt: { $gte: RESET_AT } }, { status: { $ne: 'closed' } }],
    });
    expect(cancellationBaselineClause(RESET_AT)).toEqual({
      $or: [{ createdAt: { $gte: RESET_AT } }, { status: { $nin: ['approved', 'denied'] } }],
    });
  });

  it('adds no clause for KPIs (they clamp the range instead) and when no baseline is set', () => {
    expect(clauseForDashboard('bookingKpis', RESET_AT)).toEqual({});
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
    it('GET lists all four dashboards with no baseline by default', async () => {
      const { statusCode, body } = await call(getDashboardBaselines, makeReq({ admin: superAdmin() }));
      expect(statusCode).toBe(200);
      expect(body.data.dashboards.map((d: any) => d.key).sort()).toEqual(['bookingKpis', 'cancellations', 'disputes', 'warrantyClaims']);
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
      expect(body.data.dashboards.find((d: any) => d.key === 'warrantyClaims').resetAt).toBeNull();
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
      expect(body.data.history).toHaveLength(4);
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
      expect(entries[1].details.keys).toHaveLength(4);
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

  describe('warranty claims dashboard', () => {
    const seedClaims = async () => {
      const base = { booking: id(), customer: id(), professional: id(), reason: 'defect', description: 'd', evidence: [] };
      await WarrantyClaim.collection.insertMany([
        { ...base, claimNumber: 'WC-OLD-CLOSED', status: 'closed', createdAt: BEFORE, openedAt: BEFORE, statusHistory: [] },
        { ...base, claimNumber: 'WC-OLD-OPEN', status: 'open', createdAt: BEFORE, openedAt: BEFORE, statusHistory: [] },
        { ...base, claimNumber: 'WC-NEW-CLOSED', status: 'closed', createdAt: AFTER, openedAt: AFTER, statusHistory: [] },
      ]);
    };

    it('hides only closed claims from before the reset; open claims stay', async () => {
      await seedClaims();
      await setBaseline('warrantyClaims', RESET_AT);
      const { body } = await call(listAdminWarrantyClaims, makeReq({ user: superAdmin(), query: {} }));
      expect(body.data.claims.map((c: any) => c.claimNumber).sort()).toEqual(['WC-NEW-CLOSED', 'WC-OLD-OPEN']);
      expect(body.data.pagination.total).toBe(2);
      expect(body.data.baseline).toMatchObject({ key: 'warrantyClaims', applied: true });
    });

    it('history=all brings back the old closed claim', async () => {
      await seedClaims();
      await setBaseline('warrantyClaims', RESET_AT);
      const { body } = await call(listAdminWarrantyClaims, makeReq({ user: superAdmin(), query: { history: 'all' } }));
      expect(body.data.pagination.total).toBe(3);
    });

    it('analytics totals count only claims since the reset when no show-all is set', async () => {
      await seedClaims();
      await setBaseline('warrantyClaims', RESET_AT);
      const { body } = await call(getAdminWarrantyAnalytics, makeReq({ user: superAdmin(), query: { lastDays: '30' } }));
      expect(body.data.summary.totalClaims).toBe(1);
      expect(body.data.baseline.applied).toBe(true);

      const all = await call(getAdminWarrantyAnalytics, makeReq({ user: superAdmin(), query: { lastDays: '30', history: 'all' } }));
      expect(all.body.data.summary.totalClaims).toBe(3);
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

    it('history=all keeps the requested range start', async () => {
      await setBaseline('bookingKpis', RESET_AT);
      const from = new Date(NOW - 30 * DAY).toISOString();
      const { body } = await call(getKpiSummary, makeReq({ admin: superAdmin(), query: { from, to: new Date(NOW).toISOString(), history: 'all' } }));
      expect(new Date(body.data.range.from).getTime()).toBe(new Date(from).getTime());
      expect(body.data.baseline).toMatchObject({ applied: false, showAll: true });
    });
  });

  describe('navigation badges', () => {
    it('keeps open disputes and pending cancellations counted after a reset, and drops nothing open', async () => {
      const customer = id();
      await Booking.collection.insertMany([
        { bookingNumber: 'BK-OPEN-OLD', status: 'dispute', customer, professional: id(), project: id(), dispute: { raisedBy: customer, reason: 'x', raisedAt: BEFORE } },
      ]);
      await CancellationRequest.collection.insertMany([
        { booking: id(), requestedBy: id(), requestedRole: 'customer', status: 'pending', reason: 'r', createdAt: BEFORE, updatedAt: BEFORE },
        { booking: id(), requestedBy: id(), requestedRole: 'customer', status: 'approved', reason: 'r', createdAt: BEFORE, updatedAt: BEFORE },
      ]);
      await setBaseline('disputes', AFTER);
      await setBaseline('cancellations', AFTER);

      const counts = await computeAdminNavigationBadges(superAdmin());
      expect(counts.disputes).toBe(1);
      expect(counts.cancellationRequests).toBe(1);
    });
  });

  it('the disputes and cancellation clauses never hide an open item', () => {
    // Guard: open statuses are never in the excluded set.
    expect(cancellationBaselineClause(RESET_AT).$or[1]).toEqual({ status: { $nin: ['approved', 'denied'] } });
    expect(warrantyBaselineClause(RESET_AT).$or[1]).toEqual({ status: { $ne: 'closed' } });
  });
});
