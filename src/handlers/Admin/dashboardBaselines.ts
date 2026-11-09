import { randomUUID } from 'node:crypto';
import { Request, Response } from 'express';
import type { IUser } from '../../models/user';
import {
  AdminDashboardBaseline,
  AdminDashboardBaselineEvent,
  type IAdminDashboardBaselineEvent,
} from '../../models/adminDashboardBaseline';
import { resolveAdminRole } from '../../utils/adminRbac/rolePermissions';
import { auditLog } from '../../utils/auditLogger';
import { ADMIN_DASHBOARD_KEYS, isAdminDashboardKey } from '../../utils/adminDashboardBaselines';
import type { AdminDashboardBaselineKey } from '../../models/adminDashboardBaseline';

/**
 * Super-admin "Reset dashboards" (Platform settings). Resets move a dashboard's
 * counting baseline forward; they never delete or edit source records.
 *
 * The route prefix `/platform-settings` already requires a super admin in
 * enforceAdminRoutePermission. Each handler checks again, so the endpoints stay
 * super-only if they are ever mounted elsewhere.
 */

const MAX_NOTE_LENGTH = 500;
const HISTORY_LIMIT = 50;

const isSuperAdmin = (req: Request): boolean =>
  resolveAdminRole((req as any).admin?.adminRole) === 'super';

const denySuper = (res: Response) =>
  res.status(403).json({
    success: false,
    msg: 'Only a super admin can reset dashboards',
    code: 'ADMIN_PERMISSION_DENIED',
  });

const actorOf = (req: Request) => {
  const admin = (req as any).admin as IUser | undefined;
  return {
    id: admin?._id ?? null,
    name: String(admin?.name || admin?.email || '').slice(0, 200),
  };
};

/** Trimmed note or `undefined`; throws a validation message for bad input. */
const parseNote = (value: unknown): string => {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new Error('note must be a string');
  const trimmed = value.trim();
  if (trimmed.length > MAX_NOTE_LENGTH) throw new Error(`note must be at most ${MAX_NOTE_LENGTH} characters`);
  return trimmed;
};

const serializeEvent = (event: any) => ({
  dashboardKey: event.dashboardKey,
  action: event.action,
  resetAt: event.resetAt ? new Date(event.resetAt).toISOString() : null,
  previousResetAt: event.previousResetAt ? new Date(event.previousResetAt).toISOString() : null,
  actorName: event.actorName || '',
  note: event.note || '',
  batchId: event.batchId || null,
  createdAt: event.createdAt ? new Date(event.createdAt).toISOString() : null,
});

/** Snapshot of every dashboard's baseline plus the recent reset history. */
async function buildSnapshot() {
  const [docs, latestEvents, recentEvents] = await Promise.all([
    AdminDashboardBaseline.find({ _id: { $in: [...ADMIN_DASHBOARD_KEYS] } }).lean(),
    // Latest event per dashboard decides whether undo is available.
    AdminDashboardBaselineEvent.aggregate<{ _id: string; action: string }>([
      { $sort: { createdAt: -1, _id: -1 } },
      { $group: { _id: '$dashboardKey', action: { $first: '$action' } } },
    ]),
    AdminDashboardBaselineEvent.find({}).sort({ createdAt: -1, _id: -1 }).limit(HISTORY_LIMIT).lean(),
  ]);

  const byKey = new Map<string, any>();
  for (const doc of docs as any[]) byKey.set(String(doc._id), doc);
  const latestAction = new Map<string, string>(latestEvents.map((row) => [String(row._id), row.action]));

  const dashboards = ADMIN_DASHBOARD_KEYS.map((key) => {
    const doc = byKey.get(key);
    const resetAt = doc?.resetAt ? new Date(doc.resetAt).toISOString() : null;
    return {
      key,
      resetAt,
      resetBy: resetAt && doc?.resetBy ? { id: String(doc.resetBy), name: doc.resetByName || '' } : null,
      note: resetAt ? (doc?.note || '') : '',
      canUndo: latestAction.get(key) === 'reset',
    };
  });

  return {
    dashboards,
    history: (recentEvents as IAdminDashboardBaselineEvent[]).map(serializeEvent),
    generatedAt: new Date().toISOString(),
  };
}

/** GET /api/admin/platform-settings/dashboard-baselines (super only). */
export const getDashboardBaselines = async (req: Request, res: Response) => {
  if (!isSuperAdmin(req)) return denySuper(res);
  try {
    const data = await buildSnapshot();
    return res.status(200).json({ success: true, data });
  } catch (error: any) {
    console.error('[Admin] dashboard baselines read failed:', error?.message || error);
    return res.status(500).json({ success: false, msg: 'Failed to load dashboard baselines' });
  }
};

/**
 * Apply a reset to the given dashboards with one shared timestamp. Writes one
 * history event per dashboard and returns the new baseline values.
 */
async function applyReset(req: Request, keys: AdminDashboardBaselineKey[], note: string) {
  const actor = actorOf(req);
  const resetAt = new Date();
  const batchId = keys.length > 1 ? randomUUID() : null;
  // Read the old values once so every event records what it replaced.
  const stored = await AdminDashboardBaseline.find({ _id: { $in: keys } }).select('_id resetAt').lean();
  const previousByKey = new Map<string, Date | null>();
  for (const key of keys) {
    const doc = (stored as any[]).find((row) => row._id === key);
    previousByKey.set(key, doc?.resetAt ? new Date(doc.resetAt) : null);
  }

  for (const key of keys) {
    const previousResetAt = previousByKey.get(key) ?? null;
    await AdminDashboardBaseline.updateOne(
      { _id: key },
      {
        $set: {
          resetAt,
          resetBy: actor.id,
          resetByName: actor.name,
          note,
          previousResetAt,
        },
      },
      { upsert: true },
    );
    await AdminDashboardBaselineEvent.create({
      dashboardKey: key,
      action: 'reset',
      resetAt,
      previousResetAt,
      actor: actor.id,
      actorName: actor.name,
      note,
      batchId,
      createdAt: resetAt,
    });
  }
  return { resetAt, batchId, keys };
}

const validateNoteOr400 = (req: Request, res: Response): string | null => {
  try {
    return parseNote((req.body as any)?.note);
  } catch (error: any) {
    res.status(400).json({ success: false, msg: error.message, code: 'VALIDATION', field: 'note' });
    return null;
  }
};

/** POST /api/admin/platform-settings/dashboard-baselines/:key/reset (super only). */
export const resetDashboardBaseline = async (req: Request, res: Response) => {
  if (!isSuperAdmin(req)) return denySuper(res);
  const key = String(req.params.key || '');
  if (!isAdminDashboardKey(key)) {
    return res.status(404).json({ success: false, msg: 'Unknown dashboard', code: 'UNKNOWN_DASHBOARD' });
  }
  const note = validateNoteOr400(req, res);
  if (note === null) return;

  try {
    const result = await applyReset(req, [key], note);
    await auditLog({
      req,
      action: 'admin.dashboard_baseline.reset',
      status: 'success',
      statusCode: 200,
      details: { keys: result.keys, resetAt: result.resetAt.toISOString(), note, batchId: result.batchId },
    });
    const data = await buildSnapshot();
    return res.status(200).json({ success: true, data });
  } catch (error: any) {
    console.error('[Admin] dashboard reset failed:', error?.message || error);
    return res.status(500).json({ success: false, msg: 'Failed to reset dashboard' });
  }
};

/** POST /api/admin/platform-settings/dashboard-baselines/reset-all (super only). */
export const resetAllDashboardBaselines = async (req: Request, res: Response) => {
  if (!isSuperAdmin(req)) return denySuper(res);
  const note = validateNoteOr400(req, res);
  if (note === null) return;

  try {
    const result = await applyReset(req, [...ADMIN_DASHBOARD_KEYS], note);
    await auditLog({
      req,
      action: 'admin.dashboard_baseline.reset_all',
      status: 'success',
      statusCode: 200,
      details: { keys: result.keys, resetAt: result.resetAt.toISOString(), note, batchId: result.batchId },
    });
    const data = await buildSnapshot();
    return res.status(200).json({ success: true, data });
  } catch (error: any) {
    console.error('[Admin] dashboard reset-all failed:', error?.message || error);
    return res.status(500).json({ success: false, msg: 'Failed to reset dashboards' });
  }
};

/**
 * Optional `expectedResetAt` from the undo body: `undefined` when the field is
 * absent, `null` when the caller expects no baseline, otherwise the instant.
 * Throws for anything that is not an ISO timestamp.
 */
const parseExpectedResetAt = (value: unknown): Date | null | undefined => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') throw new Error('expectedResetAt must be an ISO timestamp');
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('expectedResetAt must be an ISO timestamp');
  return date;
};

const sameInstant = (a: Date | null, b: Date | null): boolean => {
  if (!a || !b) return a === b;
  return a.getTime() === b.getTime();
};

/** 409 for an undo aimed at a baseline that changed since the admin saw it. Returns the current snapshot. */
const sendBaselineChanged = async (res: Response) =>
  res.status(409).json({
    success: false,
    msg: 'This dashboard was reset again. Refresh before undoing.',
    code: 'BASELINE_CHANGED',
    data: await buildSnapshot(),
  });

/**
 * POST /api/admin/platform-settings/dashboard-baselines/:key/undo (super only).
 * Restores the baseline that the latest reset replaced. Only available while the
 * latest event for the dashboard is a reset; an undo is itself recorded.
 *
 * An optional body field `expectedResetAt` names the reset the admin is undoing.
 * If the baseline has moved on since, the undo is refused with 409
 * `BASELINE_CHANGED` and nothing is written. The write itself is conditional on
 * the `resetAt` it read, so two concurrent undos cannot both apply.
 */
export const undoDashboardBaseline = async (req: Request, res: Response) => {
  if (!isSuperAdmin(req)) return denySuper(res);
  const key = String(req.params.key || '');
  if (!isAdminDashboardKey(key)) {
    return res.status(404).json({ success: false, msg: 'Unknown dashboard', code: 'UNKNOWN_DASHBOARD' });
  }
  let expectedResetAt: Date | null | undefined;
  try {
    expectedResetAt = parseExpectedResetAt((req.body as any)?.expectedResetAt);
  } catch (error: any) {
    return res.status(400).json({ success: false, msg: error.message, code: 'VALIDATION', field: 'expectedResetAt' });
  }

  try {
    const current = await AdminDashboardBaseline.findById(key).select('resetAt').lean();
    const currentResetAt = current?.resetAt ? new Date(current.resetAt) : null;
    if (expectedResetAt !== undefined && !sameInstant(expectedResetAt, currentResetAt)) {
      return sendBaselineChanged(res);
    }

    const latest = (await AdminDashboardBaselineEvent.find({ dashboardKey: key })
      .sort({ createdAt: -1, _id: -1 })
      .limit(1)
      .lean())[0] as IAdminDashboardBaselineEvent | undefined;

    if (!latest || latest.action !== 'reset') {
      return res.status(409).json({
        success: false,
        msg: 'There is no reset to undo for this dashboard',
        code: 'NOTHING_TO_UNDO',
      });
    }

    const restoreAt = latest.previousResetAt ? new Date(latest.previousResetAt) : null;
    // Who set the restored value: the reset event that wrote it, if any.
    const restoredFrom = restoreAt
      ? (await AdminDashboardBaselineEvent.find({ dashboardKey: key, action: 'reset', resetAt: restoreAt })
        .sort({ createdAt: -1, _id: -1 })
        .limit(1)
        .lean())[0] as IAdminDashboardBaselineEvent | undefined
      : undefined;

    const actor = actorOf(req);
    const undoAt = new Date();
    // Conditional write: it applies only while the baseline still holds the value
    // read above. A reset or undo that landed in between matches nothing, so this
    // undo changes nothing and the caller is told to refresh.
    const applied = await AdminDashboardBaseline.findOneAndUpdate(
      { _id: key, resetAt: currentResetAt },
      {
        $set: {
          resetAt: restoreAt,
          resetBy: restoredFrom?.actor ?? null,
          resetByName: restoredFrom?.actorName ?? '',
          note: restoredFrom?.note ?? '',
          previousResetAt: null,
        },
      },
    );
    if (!applied) return sendBaselineChanged(res);

    await AdminDashboardBaselineEvent.create({
      dashboardKey: key,
      action: 'undo',
      resetAt: restoreAt,
      previousResetAt: latest.resetAt ?? null,
      actor: actor.id,
      actorName: actor.name,
      note: '',
      batchId: null,
      createdAt: undoAt,
    });

    await auditLog({
      req,
      action: 'admin.dashboard_baseline.undo',
      status: 'success',
      statusCode: 200,
      details: {
        keys: [key],
        restoredResetAt: restoreAt ? restoreAt.toISOString() : null,
        undoneResetAt: latest.resetAt ? new Date(latest.resetAt).toISOString() : null,
      },
    });
    const data = await buildSnapshot();
    return res.status(200).json({ success: true, data });
  } catch (error: any) {
    console.error('[Admin] dashboard undo failed:', error?.message || error);
    return res.status(500).json({ success: false, msg: 'Failed to undo dashboard reset' });
  }
};
