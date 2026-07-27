import { Request, Response } from 'express';
import mongoose from 'mongoose';
import AuditLog from '../../models/auditLog';
import { buildCsv } from '../../utils/csv';

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const EXPORT_MAX = 10000;

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const parseDate = (value: unknown): Date | null => {
  if (typeof value !== 'string' || !value.trim()) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

const buildAuditLogQuery = (query: Request['query']): Record<string, any> => {
  const { action, actor, actorEmail, targetType, targetId, status, from, until } = query;
  const out: Record<string, any> = {};

  if (typeof action === 'string' && action.trim()) {
    out.action = action.trim();
  }

  if (typeof actor === 'string' && mongoose.Types.ObjectId.isValid(actor)) {
    out.actor = new mongoose.Types.ObjectId(actor);
  }

  if (typeof actorEmail === 'string' && actorEmail.trim().length >= 2) {
    out.actorEmail = new RegExp(escapeRegex(actorEmail.trim().toLowerCase()), 'i');
  }

  if (typeof targetType === 'string' && targetType.trim()) {
    out.targetType = targetType.trim();
  }

  if (typeof targetId === 'string' && mongoose.Types.ObjectId.isValid(targetId)) {
    out.targetId = new mongoose.Types.ObjectId(targetId);
  }

  if (typeof status === 'string' && (status === 'success' || status === 'failure')) {
    out.status = status;
  }

  const fromDate = parseDate(from);
  const untilDate = parseDate(until);
  if (
    untilDate &&
    untilDate.getUTCHours() === 0 &&
    untilDate.getUTCMinutes() === 0 &&
    untilDate.getUTCSeconds() === 0 &&
    untilDate.getUTCMilliseconds() === 0
  ) {
    untilDate.setUTCHours(23, 59, 59, 999);
  }
  if (fromDate || untilDate) {
    out.createdAt = {};
    if (fromDate) out.createdAt.$gte = fromDate;
    if (untilDate) out.createdAt.$lte = untilDate;
  }

  return out;
};

export const listAuditLogs = async (req: Request, res: Response) => {
  try {
    const { page, limit } = req.query;

    const pageNumber = Math.max(Math.floor(Number(page) || 1), 1);
    const limitNumber = Math.min(Math.max(Math.floor(Number(limit) || DEFAULT_LIMIT), 1), MAX_LIMIT);
    const skip = (pageNumber - 1) * limitNumber;

    const query = buildAuditLogQuery(req.query);

    const [logs, totalCount] = await Promise.all([
      AuditLog.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNumber)
        .lean(),
      AuditLog.countDocuments(query),
    ]);

    return res.json({
      success: true,
      data: {
        logs,
        pagination: {
          page: pageNumber,
          limit: limitNumber,
          total: totalCount,
          totalPages: Math.max(1, Math.ceil(totalCount / limitNumber)),
        },
      },
    });
  } catch (error: any) {
    console.error('[ADMIN][AUDIT_LOGS] Failed to list logs', error);
    return res.status(500).json({
      success: false,
      msg: error?.message || 'Failed to load audit logs',
    });
  }
};

export const getAuditLogStats = async (req: Request, res: Response) => {
  try {
    const query = buildAuditLogQuery(req.query);

    const [total, failures, uniqueActors] = await Promise.all([
      AuditLog.countDocuments(query),
      AuditLog.countDocuments({ ...query, status: 'failure' }),
      AuditLog.distinct('actor', query),
    ]);

    return res.json({
      success: true,
      data: {
        total,
        failures,
        uniqueActors: uniqueActors.filter(Boolean).length,
      },
    });
  } catch (error: any) {
    console.error('[ADMIN][AUDIT_LOGS][STATS] Failed', error);
    return res.status(500).json({ success: false, msg: error?.message || 'Failed to load audit stats' });
  }
};

export const getAuditLogFilterOptions = async (_req: Request, res: Response) => {
  try {
    const [actions, targetTypes] = await Promise.all([
      AuditLog.distinct('action'),
      AuditLog.distinct('targetType'),
    ]);
    return res.json({
      success: true,
      data: {
        actions: (actions as string[]).filter(Boolean).sort(),
        targetTypes: (targetTypes as string[]).filter(Boolean).sort(),
      },
    });
  } catch (error: any) {
    console.error('[ADMIN][AUDIT_LOGS][OPTIONS] Failed', error);
    return res.status(500).json({ success: false, msg: error?.message || 'Failed to load audit filter options' });
  }
};

export const exportAuditLogs = async (req: Request, res: Response) => {
  try {
    const query = buildAuditLogQuery(req.query);
    const format = String(req.query.format || 'csv').toLowerCase();
    const logs = await AuditLog.find(query)
      .sort({ createdAt: -1 })
      .limit(EXPORT_MAX)
      .lean();

    const headers = [
      'Created at',
      'Actor email',
      'Actor role',
      'Action',
      'Target type',
      'Target id',
      'Method',
      'Path',
      'Status',
      'Status code',
      'IP',
      'Error',
    ];
    const rows = logs.map((log: any) => [
      log.createdAt ? new Date(log.createdAt).toISOString() : '',
      log.actorEmail || '',
      log.actorRole || '',
      log.action || '',
      log.targetType || '',
      log.targetId ? String(log.targetId) : '',
      log.method || '',
      log.path || '',
      log.status || '',
      log.statusCode ?? '',
      log.ip || '',
      log.errorMessage || '',
    ]);

    const stamp = new Date().toISOString().slice(0, 10);
    if (format === 'json') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="audit-logs-${stamp}.json"`);
      return res.send(JSON.stringify({ success: true, count: logs.length, logs }, null, 2));
    }

    const csv = buildCsv(headers, rows);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="audit-logs-${stamp}.csv"`);
    return res.send(csv);
  } catch (error: any) {
    console.error('[ADMIN][AUDIT_LOGS][EXPORT] Failed', error);
    return res.status(500).json({ success: false, msg: error?.message || 'Failed to export audit logs' });
  }
};
