import { readFileSync } from 'node:fs';
import mongoose, { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Admin navigation restructuring (DOCX "Pending/open task counters"): the
// seven badges count only work still waiting on an admin, gated per queue by
// the same server-side access the queue's own list endpoint enforces.
vi.mock('../../handlers/Stripe/payment', () => ({
  captureAndTransferPayment: vi.fn(),
  executeRefund: vi.fn(),
  RefundError: class RefundError extends Error {},
}));
vi.mock('../../services/invoiceArtifacts', () => ({ ensureBookingInvoiceArtifacts: vi.fn() }));
vi.mock('../../utils/notifications/notify', () => ({ notify: vi.fn() }));

import User from '../../models/user';
import Project from '../../models/project';
import ChatReport from '../../models/chatReport';
import ChatMessage from '../../models/chatMessage';
import SupportTicket from '../../models/supportTicket';
import MeetingRequest from '../../models/meetingRequest';
import Booking from '../../models/booking';
import WarrantyClaim from '../../models/warrantyClaim';
import CancellationRequest from '../../models/cancellationRequest';
import {
  ADMIN_NAVIGATION_BADGE_KEYS,
  computeAdminNavigationBadges,
  getAdminNavigationBadges,
} from '../../handlers/Admin/navigationBadges';
import { getDisputeAnalytics } from '../../handlers/Admin/disputeManagement';
import { resolveChatReport } from '../../handlers/Admin/chatModeration';
import { permissionForAdminPath } from '../../utils/adminRbac/routePermissions';

const testUri = process.env.FIXERA_TEST_MONGODB_URI;
const hasDisposableMongo = Boolean(testUri && /test/i.test(testUri));
const describeDb = hasDisposableMongo ? describe : describe.skip;

const QUEUE_MODELS = [User, Project, ChatReport, ChatMessage, SupportTicket, MeetingRequest, Booking, WarrantyClaim, CancellationRequest];
const id = () => new Types.ObjectId();
const at = (day: number) => new Date(Date.UTC(2026, 9, day, 9));
const admin = (adminRole: string, adminPermissionLevels?: Record<string, string>) =>
  ({ _id: id(), role: 'admin', adminRole, ...(adminPermissionLevels ? { adminPermissionLevels } : {}) }) as any;

const call = async (req: any) => {
  let statusCode = 200;
  let body: any;
  const headers: Record<string, string> = {};
  const res: any = {
    status(code: number) { statusCode = code; return res; },
    json(payload: unknown) { body = payload; return res; },
    set(name: string, value: string) { headers[name.toLowerCase()] = value; return res; },
  };
  await getAdminNavigationBadges(req, res);
  return { statusCode, body, headers };
};

const zeroCounts = Object.fromEntries(ADMIN_NAVIGATION_BADGE_KEYS.map((key) => [key, 0]));

const recordedDispute = (day: number) => ({
  raisedBy: id(), reason: 'Extra costs too high', description: 'customer disagrees', raisedAt: at(day), type: 'extra_costs',
});

/** One actionable and several finished/default-shaped rows per queue. */
async function seedMixedQueues() {
  const reportMessage = id();
  await Promise.all([
    User.collection.insertMany([
      { role: 'professional', email: 'p-pending@nav.test', professionalStatus: 'pending', deletedAt: null },
      { role: 'professional', email: 'p-pending-2@nav.test', professionalStatus: 'pending' },
      { role: 'professional', email: 'p-draft@nav.test', professionalStatus: 'draft' },
      { role: 'professional', email: 'p-approved@nav.test', professionalStatus: 'approved' },
      { role: 'professional', email: 'p-rejected@nav.test', professionalStatus: 'rejected' },
      { role: 'professional', email: 'p-suspended@nav.test', professionalStatus: 'suspended' },
      { role: 'professional', email: 'p-deleted@nav.test', professionalStatus: 'pending', deletedAt: at(2) },
      { role: 'professional', email: 'p-anon@nav.test', professionalStatus: 'pending', isAnonymized: true },
      { role: 'customer', email: 'c@nav.test', professionalStatus: 'pending' },
    ]),
    Project.collection.insertMany([
      { title: 'Pending', status: 'pending', professionalId: id(), submittedAt: at(3) },
      { title: 'Draft', status: 'draft', professionalId: id() },
      { title: 'Published with changes', status: 'published', professionalId: id(), reapprovalType: 'full', pendingChanges: [{ field: 'title' }] },
      { title: 'Rejected', status: 'rejected', professionalId: id() },
      { title: 'On hold', status: 'on_hold', professionalId: id() },
      { title: 'Suspended', status: 'suspended', professionalId: id() },
    ]),
    CancellationRequest.collection.insertMany(
      ['pending', 'pending', 'escalated', 'processing', 'negotiating', 'approved', 'denied'].map((status, index) => ({
        booking: id(), requestedBy: id(), requestedRole: index % 2 ? 'professional' : 'customer', status, reason: 'r',
      })),
    ),
    Booking.collection.insertMany([
      { bookingNumber: 'BK-OPEN', status: 'dispute', dispute: recordedDispute(10) },
      // Phantom default (no actor), resolved history, extra-cost completion.
      { bookingNumber: 'BK-PHANTOM', status: 'dispute', dispute: { type: 'extra_costs', raisedAt: at(1) } },
      { bookingNumber: 'BK-SETTLED', status: 'completed', dispute: { ...recordedDispute(4), resolvedAt: at(6) } },
      { bookingNumber: 'BK-EXTRA', status: 'professional_completed', extraCostTotal: 40 },
      // Published and hidden reviews are not moderation work.
      { bookingNumber: 'BK-REVIEW', status: 'completed', customerReview: { communicationLevel: 5, valueOfDelivery: 4, qualityOfService: 5, comment: 'great', reviewedAt: at(8) } },
      { bookingNumber: 'BK-HIDDEN', status: 'completed', customerReview: { communicationLevel: 1, valueOfDelivery: 1, qualityOfService: 1, comment: 'meh', reviewedAt: at(8), isHidden: true, hiddenAt: at(9) } },
    ]),
    // Separate queues: never part of the booking-dispute badge.
    WarrantyClaim.collection.insertOne({ claimNumber: 'WC-NAV', booking: id(), status: 'open', openedAt: at(5) }),
    SupportTicket.collection.insertMany([
      { kind: 'ticket', ticketNumber: 'T-NEW', status: 'open', replies: [] },
      { ticketNumber: 'T-LEGACY-NO-KIND', status: 'open' },
      { kind: 'ticket', ticketNumber: 'T-USER-LAST', status: 'in_progress', replies: [{ authorRole: 'admin', body: 'a' }, { authorRole: 'customer', body: 'b' }] },
      { kind: 'ticket', ticketNumber: 'T-ADMIN-LAST', status: 'open', replies: [{ authorRole: 'customer', body: 'a' }, { authorRole: 'admin', body: 'b' }] },
      { kind: 'ticket', ticketNumber: 'T-RESOLVED', status: 'resolved', replies: [{ authorRole: 'customer', body: 'a' }] },
      { kind: 'ticket', ticketNumber: 'T-CLOSED', status: 'closed' },
      { kind: 'meeting', ticketNumber: 'M-PENDING', status: 'open', meeting: { status: 'pending' } },
      { kind: 'meeting', ticketNumber: 'M-SCHEDULED', status: 'open', meeting: { status: 'scheduled' } },
      { kind: 'meeting', ticketNumber: 'M-DECLINED', status: 'open', meeting: { status: 'declined' } },
      { kind: 'meeting', ticketNumber: 'M-CANCELLED', status: 'closed', meeting: { status: 'cancelled' } },
      { kind: 'meeting', ticketNumber: 'M-COMPLETED', status: 'resolved', meeting: { status: 'completed' } },
    ]),
    MeetingRequest.collection.insertMany([
      { userId: id(), topic: 'legacy pending', status: 'pending' },
      { userId: id(), topic: 'legacy scheduled', status: 'scheduled' },
      { userId: id(), topic: 'legacy completed', status: 'completed' },
    ]),
    ChatMessage.collection.insertOne({ _id: reportMessage, conversationId: id(), senderId: id(), senderRole: 'customer', text: 'spam' }),
  ]);
  await ChatReport.collection.insertMany([
    { _id: id(), messageId: reportMessage, conversationId: id(), reportedBy: id(), reason: 'spam', status: 'pending' },
    { messageId: id(), conversationId: id(), reportedBy: id(), reason: 'spam', status: 'reviewed' },
    { messageId: id(), conversationId: id(), reportedBy: id(), reason: 'other', status: 'dismissed' },
  ]);
}

const EXPECTED_MIXED = {
  professionalApprovals: 2,
  projectApprovals: 1,
  cancellationRequests: 3,
  disputes: 1,
  // T-NEW, T-LEGACY-NO-KIND, T-USER-LAST, M-PENDING, legacy pending meeting
  supportTickets: 5,
  chatReports: 1,
  reviewModeration: 0,
};

describeDb('admin navigation badges (disposable MongoDB)', () => {
  beforeAll(async () => {
    await mongoose.connect(testUri!, { dbName: `fixera_nav_badges_it_${Date.now()}` });
    // Finish the background index builds first: a catalog change racing the
    // chat-report resolve transaction would make that real handler flaky.
    await Promise.all(QUEUE_MODELS.map((model) => (model as any).init()));
  });
  afterAll(async () => {
    await mongoose.connection.db?.dropDatabase();
    await mongoose.disconnect();
  });
  beforeEach(async () => {
    await Promise.all(QUEUE_MODELS.map((model) => (model as any).collection.deleteMany({})));
    vi.restoreAllMocks();
  });

  it('empty datasets: every authorized badge is 0 (a real zero, not missing)', async () => {
    const { statusCode, body, headers } = await call({ admin: admin('super') });
    expect(statusCode).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.counts).toEqual(zeroCounts);
    expect(headers['cache-control']).toBe('private, no-store');
  });

  it('counts only open/pending work per queue; finished and default-shaped rows are excluded', async () => {
    await seedMixedQueues();
    const counts = await computeAdminNavigationBadges(admin('super'));
    expect(counts).toEqual(EXPECTED_MIXED);

    // The dispute badge is the canonical "Open booking disputes" card.
    let analytics: any;
    const res: any = { status: () => res, json: (payload: any) => { analytics = payload.data; return res; } };
    await getDisputeAnalytics({ query: {} } as any, res);
    expect(counts.disputes).toBe(analytics.totalOpen);
    // Warranty/refund work is reported separately and never summed in.
    expect(analytics.separateQueues.activeWarrantyClaims).toBe(1);
  });

  it('returns only the badges each role may read (role packs, effective access)', async () => {
    await seedMixedQueues();
    const keysFor = async (user: any) => Object.keys(await computeAdminNavigationBadges(user)).sort();
    expect(await keysFor(admin('super'))).toEqual([...ADMIN_NAVIGATION_BADGE_KEYS].sort());
    expect(await keysFor(admin('care'))).toEqual(['cancellationRequests', 'chatReports', 'disputes', 'supportTickets']);
    expect(await keysFor(admin('quality'))).toEqual(['chatReports', 'professionalApprovals', 'projectApprovals', 'reviewModeration']);
    expect(await keysFor(admin('operations'))).toEqual(['projectApprovals']);
    expect(await keysFor(admin('finance'))).toEqual([]);
    expect(await keysFor(admin('marketing'))).toEqual([]);
    expect(await keysFor(admin('content_creator'))).toEqual([]);
    // A restricted admin's values are the real queue counts, not a role-filtered subset.
    expect(await computeAdminNavigationBadges(admin('care'))).toEqual({
      cancellationRequests: 3, chatReports: 1, disputes: 1, supportTickets: 5,
    });
  });

  it('explicit per-admin overrides narrow the badges; read is enough except where the list needs write', async () => {
    await seedMixedQueues();
    const narrowed = admin('care', { support: 'read', chat_reports: 'read', disputes: 'none', cancellations: 'none' });
    expect(await computeAdminNavigationBadges(narrowed)).toEqual({ supportTickets: 5, chatReports: 1 });
    // GET /projects/admin/pending requires projects.approve (write); read-only gets no count.
    expect(await computeAdminNavigationBadges(admin('quality', { projects: 'read' }))).toEqual({});
    expect(await computeAdminNavigationBadges(admin('quality', { projects: 'write' }))).toEqual({ projectApprovals: 1 });
  });

  it('badges follow status changes without any reset', async () => {
    await seedMixedQueues();
    const superAdmin = admin('super');
    expect(await computeAdminNavigationBadges(superAdmin)).toEqual(EXPECTED_MIXED);

    // Real moderation action: dismissing the pending report.
    const pendingReport = await ChatReport.findOne({ status: 'pending' }).lean();
    let resolveStatus = 200;
    let resolveBody: any;
    const res: any = { status(code: number) { resolveStatus = code; return res; }, json(payload: unknown) { resolveBody = payload; return res; } };
    await resolveChatReport({ params: { id: String(pendingReport!._id) }, body: { action: 'dismiss' }, admin: { _id: superAdmin._id } } as any, res);
    expect(resolveStatus).toBe(200);
    expect(resolveBody?.success).toBe(true);

    await Promise.all([
      User.collection.updateOne({ email: 'p-pending@nav.test' }, { $set: { professionalStatus: 'approved' } }),
      Project.collection.updateOne({ status: 'pending' }, { $set: { status: 'published' } }),
      CancellationRequest.collection.updateOne({ status: 'escalated' }, { $set: { status: 'denied' } }),
      Booking.collection.updateOne({ bookingNumber: 'BK-OPEN' }, { $set: { status: 'completed', 'dispute.resolvedAt': at(20) } }),
      SupportTicket.collection.updateOne({ ticketNumber: 'T-NEW' }, { $push: { replies: { authorRole: 'admin', body: 'on it' } } as any }),
      SupportTicket.collection.updateOne({ ticketNumber: 'M-PENDING' }, { $set: { 'meeting.status': 'scheduled' } }),
      // Reopened work counts again: a customer reply on an admin-last ticket.
      SupportTicket.collection.updateOne({ ticketNumber: 'T-ADMIN-LAST' }, { $push: { replies: { authorRole: 'customer', body: 'still broken' } } as any }),
    ]);
    expect(await computeAdminNavigationBadges(superAdmin)).toEqual({
      professionalApprovals: 1,
      projectApprovals: 0,
      cancellationRequests: 2,
      disputes: 0,
      supportTickets: 4,
      chatReports: 0,
      reviewModeration: 0,
    });
  });

  it('a failing queue is unknown (null), never a false 0, and does not hide the others', async () => {
    await seedMixedQueues();
    vi.spyOn(ChatReport, 'countDocuments').mockRejectedValueOnce(new Error('boom'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { statusCode, body } = await call({ admin: admin('care') });
    expect(statusCode).toBe(200);
    expect(body.data.counts).toEqual({ cancellationRequests: 3, chatReports: null, disputes: 1, supportTickets: 5 });
  });

  it('requires an authenticated admin and is not tied to a single queue permission', async () => {
    const { statusCode, body } = await call({});
    expect(statusCode).toBe(401);
    expect(body.success).toBe(false);
    // Any admin may ask; per-queue authorization happens inside the handler.
    expect(permissionForAdminPath('/navigation/badges')).toBeNull();
  });
});

describe('admin navigation badges route', () => {
  it('is mounted behind requireAdmin on the admin router', () => {
    const source = readFileSync(new URL('../../routes/Admin/index.ts', import.meta.url), 'utf8');
    const gate = source.indexOf('adminRouter.use(requireAdmin);');
    const route = source.indexOf("adminRouter.route('/navigation/badges').get(getAdminNavigationBadges);");
    expect(gate).toBeGreaterThan(-1);
    expect(route).toBeGreaterThan(gate);
  });
});
